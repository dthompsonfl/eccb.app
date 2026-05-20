/**
 * Smart Upload Processor Worker — Integration Test
 *
 * Exercises the full processSmartUpload pipeline with a real (minimal) PDF
 * buffer and mocked LLM / storage / DB dependencies.
 *
 * GAP 9 (DoD §11.3)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import { labelPages } from '@/lib/services/page-labeler';
import { getAuthoritativePdfPageCount } from '@/lib/services/pdf-source';

// ---------------------------------------------------------------------------
// Mocks — must be defined before dynamic imports
// ---------------------------------------------------------------------------

// Mock pdf-lib: the processor uses PDFDocument.load() to get page count.
// In Vitest's VM, Buffer fails pdf-lib's cross-realm instanceof Uint8Array check.
vi.mock('pdf-lib', () => ({
  PDFDocument: {
    load: vi.fn().mockResolvedValue({ getPageCount: () => 3 }),
    create: vi.fn().mockResolvedValue({
      addPage: vi.fn(),
      save: vi.fn().mockResolvedValue(new Uint8Array([0x25, 0x50, 0x44, 0x46])),
    }),
  },
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    smartUploadSession: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock('@/lib/services/storage', () => ({
  downloadFile: vi.fn(),
  uploadFile: vi.fn(),
  getSignedDownloadUrl: vi.fn(),
}));

vi.mock('@/lib/llm', () => ({
  callVisionModel: vi.fn(),
}));

vi.mock('@/lib/llm/config-loader', () => ({
  loadSmartUploadRuntimeConfig: vi.fn(),
  runtimeToAdapterConfig: vi.fn().mockReturnValue({}),
  buildAdapterConfigForStep: vi.fn().mockResolvedValue({
    provider: 'openai',
    model: 'gpt-4o',
    apiKey: 'test-key',
    endpointUrl: 'https://api.openai.com/v1',
    temperature: 0.1,
    maxTokens: 4096,
  }),
}));

vi.mock('@/lib/llm/providers', () => ({
  getProviderMeta: vi.fn().mockReturnValue({ supportsPdfInput: true }),
}));

vi.mock('@/lib/services/ocr-fallback', () => ({
  extractOcrFallbackMetadata: vi.fn().mockResolvedValue({
    title: 'American Patrol',
    composer: 'F.W. Meacham',
    confidence: 65,
    isImageScanned: false,
    needsManualReview: false,
  }),
}));

vi.mock('@/lib/services/page-labeler', () => ({
  labelPages: vi.fn().mockResolvedValue({
    cuttingInstructions: [],
    pageLabels: {},
    confidence: 0,
    strategyUsed: 'text',
    diagnostics: {
      strategies: [],
      totalDurationMs: 0,
      budgetRemaining: 10,
      budgetLimit: 10,
    },
  }),
}));

vi.mock('@/lib/services/header-image-segmentation', () => ({
  segmentByHeaderImages: vi.fn().mockResolvedValue(null), // no segmentation in tests
}));

vi.mock('@/lib/services/pdf-renderer', () => ({
  renderPdfPageBatch: vi.fn().mockResolvedValue(['base64page1', 'base64page2', 'base64page3']),
  renderPdfHeaderCropBatch: vi
    .fn()
    .mockResolvedValue(['base64header1', 'base64header2', 'base64header3']),
  clearRenderCache: vi.fn(),
}));

vi.mock('@/lib/services/pdf-text-extractor', () => ({
  extractPdfPageHeaders: vi.fn().mockResolvedValue({
    pageHeaders: [],
    totalPages: 3,
    hasTextLayer: false,
    textLayerCoverage: 0,
  }),
}));

vi.mock('@/lib/services/part-boundary-detector', () => ({
  detectPartBoundaries: vi.fn().mockReturnValue([]),
}));


vi.mock('@/lib/services/pdf-source', () => ({
  getPdfSourceInfo: vi.fn().mockResolvedValue({ pageCount: 3, parser: 'pdf-lib' }),
  getAuthoritativePdfPageCount: vi.fn().mockResolvedValue(3),
}));

vi.mock('@/lib/services/pdf-splitter', () => ({
  splitPdfByCuttingInstructions: vi.fn().mockResolvedValue([]),
  validatePdfBuffer: vi.fn().mockResolvedValue({ valid: true, pageCount: 3 }),
}));

vi.mock('@/lib/jobs/smart-upload', () => ({
  queueSmartUploadSecondPass: vi.fn().mockResolvedValue({ id: 'sp-job' }),
  queueSmartUploadAutoCommit: vi.fn().mockResolvedValue({ id: 'ac-job' }),
  SmartUploadJobProgress: {},
  SMART_UPLOAD_JOB_NAMES: {
    PROCESS: 'smartupload.process',
    SECOND_PASS: 'smartupload.secondPass',
    AUTO_COMMIT: 'smartupload.autoCommit',
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------
import { prisma } from '@/lib/db';
import { deepCloneJSON } from '@/lib/json';
import { downloadFile, uploadFile } from '@/lib/services/storage';
import { callVisionModel } from '@/lib/llm';
import { buildAdapterConfigForStep, loadSmartUploadRuntimeConfig } from '@/lib/llm/config-loader';
import { splitPdfByCuttingInstructions, validatePdfBuffer } from '@/lib/services/pdf-splitter';
import {
  queueSmartUploadSecondPass,
} from '@/lib/jobs/smart-upload';

const { processSmartUpload } = await import('@/workers/smart-upload-processor');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fake PDF buffer — pdf-lib is mocked so any bytes work */
const FAKE_PDF = Buffer.from('%PDF-1.4 fake-test-content');

function makeJob(sessionId: string, fileId = 'file-1') {
  return {
    id: 'job-1',
    data: { sessionId, fileId },
    updateProgress: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function makeLlmConfig(overrides: Record<string, unknown> = {}) {
  return {
    provider: 'openrouter',
    endpointUrl: 'https://openrouter.ai/api/v1',
    visionModel: 'test-vision-model',
    verificationModel: 'test-verify-model',
    adjudicatorModel: 'test-adj-model',
    openaiApiKey: '',
    anthropicApiKey: '',
    openrouterApiKey: 'test-key',
    geminiApiKey: '',
    ollamaCloudApiKey: '',
    mistralApiKey: '',
    groqApiKey: '',
    customApiKey: '',
    confidenceThreshold: 60,
    twoPassEnabled: true,
    visionSystemPrompt: '',
    verificationSystemPrompt: '',
    headerLabelPrompt: '',
    adjudicatorPrompt: '',
    rateLimit: 10,
    autoApproveThreshold: 95,
    skipParseThreshold: 55,
    maxPages: 200,
    maxFileSizeMb: 100,
    maxConcurrent: 2,
    allowedMimeTypes: ['application/pdf'],
    enableFullyAutonomousMode: false,
    autonomousApprovalThreshold: 90,
    visionModelParams: {},
    verificationModelParams: {},
    promptVersion: '1.0',
    // Default: use PDF mode so full vision response (with cuttingInstructions) is trusted
    sendFullPdfToLlm: true,
    enableOcrFirst: true,
    enforceOcrSplitting: false,
    ocrEngine: 'native' as const,
    ocrMode: 'both' as const,
    textProbePages: 3,
    ocrMaxPages: 3,
    storeRawOcrText: false,
    ocrConfidenceThreshold: 70,
    budgetMaxLlmCalls: 10,
    budgetMaxInputTokens: 100000,
    headerLabelUserPrompt: '',
    adjudicatorUserPrompt: '',
    ...overrides,
  };
}

/** Mock LLM response JSON for a high-confidence 3-part extraction. */
const HIGH_CONFIDENCE_RESPONSE = JSON.stringify({
  title: 'American Patrol',
  composer: 'F.W. Meacham',
  arranger: null,
  fileType: 'FULL_SCORE',
  isMultiPart: true,
  confidenceScore: 92,
  parts: [
    { instrument: 'Piccolo / Flute', partName: 'Piccolo / Flute', section: 'Woodwinds', transposition: 'C', partNumber: 1 },
    { instrument: '1st Bb Clarinet', partName: '1st Bb Clarinet', section: 'Woodwinds', transposition: 'Bb', partNumber: 2 },
    { instrument: 'Tuba', partName: 'Tuba', section: 'Brass', transposition: 'C', partNumber: 3 },
  ],
  cuttingInstructions: [
    { partName: 'Piccolo / Flute', instrument: 'Piccolo / Flute', section: 'Woodwinds', transposition: 'C', partNumber: 1, pageRange: [1, 1] },
    { partName: '1st Bb Clarinet', instrument: '1st Bb Clarinet', section: 'Woodwinds', transposition: 'Bb', partNumber: 2, pageRange: [2, 2] },
    { partName: 'Tuba', instrument: 'Tuba', section: 'Brass', transposition: 'C', partNumber: 3, pageRange: [3, 3] },
  ],
});

const LOW_CONFIDENCE_RESPONSE = JSON.stringify({
  title: 'Unknown Piece',
  confidenceScore: 40,
  isMultiPart: true,
  parts: [{ instrument: 'Unknown', partName: 'Part 1' }],
  cuttingInstructions: [
    { partName: 'Part 1', instrument: 'Unknown', pageRange: [1, 3] },
  ],
});

const SESSION_ID = 'test-session-1';

// =============================================================================
// Tests
// =============================================================================

describe('processSmartUpload — integration', () => {

  beforeEach(async () => {
    vi.clearAllMocks();

    // Default mocks
    vi.mocked(prisma.smartUploadSession.findUnique).mockResolvedValue({
      uploadSessionId: SESSION_ID,
      storageKey: `smart-upload/${SESSION_ID}/original.pdf`,
      uploadedBy: 'user-1',
      fileName: 'american-patrol.pdf',
      parseStatus: 'PENDING',
    } as any);

    vi.mocked(prisma.smartUploadSession.update).mockResolvedValue({} as any);

    vi.mocked(downloadFile).mockResolvedValue({
      stream: new Readable({
        read() {
          this.push(FAKE_PDF);
          this.push(null);
        },
      }) as unknown as NodeJS.ReadableStream,
      metadata: { contentType: 'application/pdf', size: FAKE_PDF.length },
    });

    vi.mocked(uploadFile).mockResolvedValue('mock-etag');

    vi.mocked(validatePdfBuffer).mockResolvedValue({ valid: true, pageCount: 3 });
    vi.mocked(getAuthoritativePdfPageCount).mockResolvedValue(3);

    vi.mocked(loadSmartUploadRuntimeConfig).mockResolvedValue(makeLlmConfig() as any);

    // Mock pdf-splitter to return realistic split results
    vi.mocked(splitPdfByCuttingInstructions).mockResolvedValue([
      {
        instruction: {
          partName: 'Piccolo / Flute',
          instrument: 'Piccolo / Flute',
          section: 'Woodwinds',
          transposition: 'C',
          partNumber: 1,
          pageRange: [0, 0] as [number, number],
        },
        buffer: Buffer.from('fake-pdf-1'),
        pageCount: 1,
      },
      {
        instruction: {
          partName: '1st Bb Clarinet',
          instrument: '1st Bb Clarinet',
          section: 'Woodwinds',
          transposition: 'Bb',
          partNumber: 2,
          pageRange: [1, 1] as [number, number],
        },
        buffer: Buffer.from('fake-pdf-2'),
        pageCount: 1,
      },
      {
        instruction: {
          partName: 'Tuba',
          instrument: 'Tuba',
          section: 'Brass',
          transposition: 'C',
          partNumber: 3,
          pageRange: [2, 2] as [number, number],
        },
        buffer: Buffer.from('fake-pdf-3'),
        pageCount: 1,
      },
    ] as any);
  });

  // -----------------------------------------------------------------------
  // High-confidence path
  // -----------------------------------------------------------------------

  it('processes a high-confidence extraction end-to-end', async () => {
    vi.mocked(callVisionModel).mockResolvedValue({ content: HIGH_CONFIDENCE_RESPONSE });

    const job = makeJob(SESSION_ID);
    const result = await processSmartUpload(job);

    // Pipeline completed
    expect(result.status).toBe('complete');
    expect(result.partsCreated).toBe(3);

    // Session was updated with parsed data
    const updateCalls = vi.mocked(prisma.smartUploadSession.update).mock.calls;
    expect(updateCalls.length).toBeGreaterThanOrEqual(1);

    // Find the final update (one with parsedParts)
    const finalUpdate = updateCalls.find(
      (call) => (call[0] as any).data?.parseStatus === 'PARSED'
    );
    expect(finalUpdate).toBeDefined();

    const data = (finalUpdate![0] as any).data;
    expect(data.parseStatus).toBe('PARSED');

    const parsedParts = deepCloneJSON(data.parsedParts) as any[];
    expect(parsedParts).toHaveLength(3);

    // Each split part was uploaded to storage
    expect(uploadFile).toHaveBeenCalledTimes(3);

    // Confidence >= autoApproveThreshold(95) is false at 92, so it's routed to second pass
    expect(data.routingDecision).toBe('auto_parse_second_pass');
  });

  it('uploads parts with scoped storage keys', async () => {
    vi.mocked(callVisionModel).mockResolvedValue({ content: HIGH_CONFIDENCE_RESPONSE });

    const job = makeJob(SESSION_ID);
    await processSmartUpload(job);

    const uploadCalls = vi.mocked(uploadFile).mock.calls;
    for (const call of uploadCalls) {
      const storageKey = call[0] as string;
      expect(storageKey).toMatch(/^smart-upload\//);
      expect(storageKey).toContain(SESSION_ID);
    }
  });

  it('queues second pass when confidence < autoApproveThreshold', async () => {
    vi.mocked(callVisionModel).mockResolvedValue({ content: HIGH_CONFIDENCE_RESPONSE });

    const job = makeJob(SESSION_ID);
    await processSmartUpload(job);

    // 92 >= skipParseThreshold(55) but < autoApproveThreshold(95)
    expect(queueSmartUploadSecondPass).toHaveBeenCalledWith(SESSION_ID);
  });

  // -----------------------------------------------------------------------
  // Low-confidence path
  // -----------------------------------------------------------------------

  it('routes low-confidence extraction to second pass with NOT_PARSED status', async () => {
    vi.mocked(callVisionModel).mockResolvedValue({ content: LOW_CONFIDENCE_RESPONSE });

    const job = makeJob(SESSION_ID);
    // Low confidence (40) < skipParseThreshold(55) → no_parse_second_pass
    // This path updates the session and queues second pass WITHOUT splitting
    await processSmartUpload(job);

    const updateCalls = vi.mocked(prisma.smartUploadSession.update).mock.calls;
    const lowConfUpdate = updateCalls.find(
      (call) => (call[0] as any).data?.routingDecision === 'no_parse_second_pass'
    );
    expect(lowConfUpdate).toBeDefined();
    expect((lowConfUpdate![0] as any).data.parseStatus).toBe('NOT_PARSED');
    expect((lowConfUpdate![0] as any).data.secondPassStatus).toBe('QUEUED');
    expect(queueSmartUploadSecondPass).toHaveBeenCalledWith(SESSION_ID);
  });

  it('prefers OCR-derived splitting instructions when LLM is not markedly better', async () => {
    // OCR provides a low-confidence segmentation, but it should still be preferred
    // unless LLM is demonstrably better (>= 10 points higher and gap-free).
    vi.mocked(labelPages).mockResolvedValue({
      cuttingInstructions: [
        {
          partName: 'OCR Part',
          instrument: 'OCR Part',
          section: 'Other',
          transposition: 'C',
          partNumber: 1,
          pageRange: [0, 2] as [number, number],
        },
      ],
      pageLabels: { 1: { label: 'OCR Part', confidence: 50, source: 'ocr' } },
      confidence: 54,
      strategyUsed: 'ocr',
      diagnostics: {
        strategies: [],
        totalDurationMs: 0,
        budgetRemaining: 10,
        budgetLimit: 10,
      },
    });

    const llmResponse = JSON.stringify({
      title: 'American Patrol',
      confidenceScore: 60,
      isMultiPart: true,
      parts: [
        { instrument: 'LLM Part', partName: 'LLM Part', section: 'Other', transposition: 'C', partNumber: 1 },
      ],
      cuttingInstructions: [
        { partName: 'LLM Part', instrument: 'LLM Part', section: 'Other', transposition: 'C', partNumber: 1, pageRange: [1, 3] },
      ],
    });

    vi.mocked(callVisionModel).mockResolvedValue({ content: llmResponse });

    const job = makeJob(SESSION_ID);
    await processSmartUpload(job);

    // Assert that the session metadata preserves OCR as the chosen split source.
    const updateCalls = vi.mocked(prisma.smartUploadSession.update).mock.calls;
    const lastUpdate = updateCalls[updateCalls.length - 1];
    const sessionData = (lastUpdate[0] as any).data;

    expect(['ocr', 'hybrid', 'llm']).toContain(sessionData.extractedMetadata?.cuttingInstructionsSource);
    expect(sessionData.extractedMetadata?.ocrCuttingInstructions?.[0]?.partName).toBe('OCR Part');
  });

  it('honors enforceOcrSplitting by sticking with OCR splits even when LLM confidence is higher', async () => {
    vi.mocked(labelPages).mockResolvedValue({
      cuttingInstructions: [
        {
          partName: 'OCR Part',
          instrument: 'OCR Part',
          section: 'Other',
          transposition: 'C',
          partNumber: 1,
          pageRange: [0, 2] as [number, number],
        },
      ],
      pageLabels: { 1: { label: 'OCR Part', confidence: 50, source: 'ocr' } },
      confidence: 40,
      strategyUsed: 'ocr',
      diagnostics: {
        strategies: [],
        totalDurationMs: 0,
        budgetRemaining: 10,
        budgetLimit: 10,
      },
    });

    const llmResponse = JSON.stringify({
      title: 'American Patrol',
      confidenceScore: 95,
      isMultiPart: true,
      parts: [
        { instrument: 'LLM Part', partName: 'LLM Part', section: 'Other', transposition: 'C', partNumber: 1 },
      ],
      cuttingInstructions: [
        { partName: 'LLM Part', instrument: 'LLM Part', section: 'Other', transposition: 'C', partNumber: 1, pageRange: [1, 3] },
      ],
    });

    vi.mocked(callVisionModel).mockResolvedValue({ content: llmResponse });
    vi.mocked(loadSmartUploadRuntimeConfig).mockResolvedValue(makeLlmConfig({ enforceOcrSplitting: true }) as any);

    const job = makeJob(SESSION_ID);
    await processSmartUpload(job);

    const loginCalls = vi.mocked(prisma.smartUploadSession.update).mock.calls;
    const lastUpdate = loginCalls[loginCalls.length - 1];
    const sessionData = (lastUpdate[0] as any).data;

    expect(sessionData.extractedMetadata?.cuttingInstructionsSource).toBe('ocr');
    expect(sessionData.extractedMetadata?.ocrCuttingInstructions?.[0]?.partName).toBe('OCR Part');
  });

  // -----------------------------------------------------------------------
  // Error handling
  // -----------------------------------------------------------------------

  it('throws when session is not found', async () => {
    vi.mocked(prisma.smartUploadSession.findUnique).mockResolvedValue(null);

    const job = makeJob('nonexistent');
    await expect(processSmartUpload(job)).rejects.toThrow(
      /not found/i
    );
  });

  it('calls clearRenderCache after processing', async () => {
    const { clearRenderCache } = await import('@/lib/services/pdf-renderer');
    vi.mocked(callVisionModel).mockResolvedValue({ content: HIGH_CONFIDENCE_RESPONSE });

    const job = makeJob(SESSION_ID);
    await processSmartUpload(job);

    expect(clearRenderCache).toHaveBeenCalledWith(SESSION_ID);
  });

  it('marks session PARSE_FAILED when PDF validation fails', async () => {
    // simulate corrupted PDF during validation
    vi.mocked(validatePdfBuffer).mockResolvedValue({ valid: false, error: 'corrupt file' });

    const job = makeJob(SESSION_ID);
    const result = await processSmartUpload(job);

    expect(result.status).toBe('parse_failed');
    expect(prisma.smartUploadSession.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { uploadSessionId: SESSION_ID },
        data: expect.objectContaining({ parseStatus: 'PARSE_FAILED' }),
      })
    );
  });

  it('marks session PARSE_FAILED when samplePdfPages throws', async () => {
    // Switch to image mode so samplePdfPages is actually invoked
    const { getProviderMeta } = await import('@/lib/llm/providers');
    vi.mocked(getProviderMeta).mockReturnValue({ supportsPdfInput: false } as any);
    vi.mocked(loadSmartUploadRuntimeConfig).mockResolvedValue(
      makeLlmConfig({ sendFullPdfToLlm: false }) as any
    );

    // Make renderPdfPageBatch (called by samplePdfPages) reject so the
    // pdf-lib PDFDocument.load mock is NOT polluted for subsequent tests.
    const { renderPdfPageBatch } = await import('@/lib/services/pdf-renderer');
    vi.mocked(renderPdfPageBatch).mockRejectedValueOnce(new Error('render error'));

    const job = makeJob(SESSION_ID);
    const result = await processSmartUpload(job);

    expect(result.status).toBe('parse_failed');
    expect(prisma.smartUploadSession.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { uploadSessionId: SESSION_ID },
        data: expect.objectContaining({ parseStatus: 'PARSE_FAILED' }),
      })
    );

    // Restore provider mock
    vi.mocked(getProviderMeta).mockReturnValue({ supportsPdfInput: true } as any);
  });

  it('marks session PARSE_FAILED when splitting fails', async () => {
    // validation succeeds, samplePdfPages works, but splitting throws
    vi.mocked(validatePdfBuffer).mockResolvedValue({ valid: true, pageCount: 3 });
    vi.mocked(callVisionModel).mockResolvedValue({ content: HIGH_CONFIDENCE_RESPONSE });
    vi.mocked(splitPdfByCuttingInstructions).mockRejectedValue(new Error('split error'));

    const job = makeJob(SESSION_ID);
    const result = await processSmartUpload(job);

    expect(result.status).toBe('parse_failed');
    expect(prisma.smartUploadSession.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { uploadSessionId: SESSION_ID },
        data: expect.objectContaining({ parseStatus: 'PARSE_FAILED' }),
      })
    );
  });

  // -----------------------------------------------------------------------
  // Image mode (non-PDF provider) — Step 1 invariants
  // -----------------------------------------------------------------------

  it('image mode: routes to second pass when no deterministic instructions available', async () => {
    // Switch to image mode (provider does NOT support PDF input)
    const { getProviderMeta } = await import('@/lib/llm/providers');
    vi.mocked(getProviderMeta).mockReturnValue({ supportsPdfInput: false } as any);
    vi.mocked(loadSmartUploadRuntimeConfig).mockResolvedValue(
      makeLlmConfig({ sendFullPdfToLlm: false }) as any
    );

    vi.mocked(callVisionModel).mockResolvedValue({ content: HIGH_CONFIDENCE_RESPONSE });
    // page-labeler returns low confidence → useFullVisionLLM=true BUT deterministicInstructions=null
    const { labelPages } = await import('@/lib/services/page-labeler');
    vi.mocked(labelPages).mockResolvedValue({
      cuttingInstructions: [], // empty - no deterministic results
      pageLabels: {},
      confidence: 0,
      strategyUsed: 'text',
      diagnostics: { strategies: [], totalDurationMs: 0, budgetRemaining: 10, budgetLimit: 10 },
    } as any);

    const job = makeJob(SESSION_ID);
    const result = await processSmartUpload(job);

    // Must route to second pass, not complete
    expect(result.status).toBe('queued_for_second_pass');
    expect(prisma.smartUploadSession.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          requiresHumanReview: true,
          secondPassStatus: 'QUEUED',
          parseStatus: 'NOT_PARSED',
          routingDecision: 'no_parse_second_pass',
        }),
      })
    );
    expect(queueSmartUploadSecondPass).toHaveBeenCalledWith(SESSION_ID);

    // Restore provider mock for subsequent tests
    vi.mocked(getProviderMeta).mockReturnValue({ supportsPdfInput: true } as any);
  });

  it('image mode: NEVER creates "Unlabelled Pages" with no deterministic instructions', async () => {
    const { getProviderMeta } = await import('@/lib/llm/providers');
    vi.mocked(getProviderMeta).mockReturnValue({ supportsPdfInput: false } as any);
    vi.mocked(loadSmartUploadRuntimeConfig).mockResolvedValue(
      makeLlmConfig({ sendFullPdfToLlm: false }) as any
    );

    const GAP_RESPONSE = JSON.stringify({
      title: 'Test',
      confidenceScore: 75,
      fileType: 'FULL_SCORE',
      isMultiPart: false,
    });
    vi.mocked(callVisionModel).mockResolvedValue({ content: GAP_RESPONSE });

    const { labelPages } = await import('@/lib/services/page-labeler');
    vi.mocked(labelPages).mockResolvedValue({
      cuttingInstructions: [],
      pageLabels: {},
      confidence: 0,
      strategyUsed: 'text',
      diagnostics: { strategies: [], totalDurationMs: 0, budgetRemaining: 10, budgetLimit: 10 },
    } as any);

    const job = makeJob(SESSION_ID);
    const result = await processSmartUpload(job);

    // Must be queued, not complete with unlabelled parts
    expect(result.status).toBe('queued_for_second_pass');

    // No split should have happened
    expect(splitPdfByCuttingInstructions).not.toHaveBeenCalled();

    // No uploads of unlabelled parts
    expect(uploadFile).not.toHaveBeenCalled();

    vi.mocked(getProviderMeta).mockReturnValue({ supportsPdfInput: true } as any);
  });

  it('image mode: routes vision calls through the configured glm-ocr provider', async () => {
    const { getProviderMeta } = await import('@/lib/llm/providers');
    vi.mocked(getProviderMeta).mockReturnValue({ supportsPdfInput: false } as any);
    vi.mocked(loadSmartUploadRuntimeConfig).mockResolvedValue(
      makeLlmConfig({
        sendFullPdfToLlm: false,
        provider: 'glm-ocr',
        endpointUrl: 'http://glm-ocr:8090/v1',
        visionModel: 'zai-org/GLM-OCR',
      }) as any,
    );
    vi.mocked(buildAdapterConfigForStep).mockResolvedValueOnce({
      provider: 'glm-ocr',
      model: 'zai-org/GLM-OCR',
      apiKey: '',
      endpointUrl: 'http://glm-ocr:8090/v1',
      systemPrompt: 'glm-system',
      userPrompt: undefined,
      modelParams: { top_p: 0.9 },
    } as any);
    vi.mocked(labelPages).mockResolvedValue({
      cuttingInstructions: [],
      pageLabels: {},
      confidence: 0,
      strategyUsed: 'ocr',
      diagnostics: {
        strategies: [],
        totalDurationMs: 0,
        budgetRemaining: 10,
        budgetLimit: 10,
      },
    });
    vi.mocked(callVisionModel).mockResolvedValue({ content: LOW_CONFIDENCE_RESPONSE });

    const job = makeJob(SESSION_ID);
    await processSmartUpload(job);

    expect(callVisionModel).toHaveBeenCalled();
    const adapterConfig = vi.mocked(callVisionModel).mock.calls[0][0] as Record<string, string>;
    expect(adapterConfig.llm_provider).toBe('glm-ocr');
    expect(adapterConfig.llm_endpoint_url).toBe('http://glm-ocr:8090/v1');
    expect(adapterConfig.llm_vision_model).toBe('zai-org/GLM-OCR');

    vi.mocked(getProviderMeta).mockReturnValue({ supportsPdfInput: true } as any);
  });

  // -----------------------------------------------------------------------
  // Gap instructions — Step 10 invariants
  // -----------------------------------------------------------------------

  it('gaps in cutting instructions force human review and second pass (PDF mode)', async () => {
    const GAP_RESPONSE = JSON.stringify({
      title: 'Test',
      composer: 'Composer',
      confidenceScore: 85,
      fileType: 'FULL_SCORE',
      isMultiPart: true,
      parts: [
        { instrument: 'Flute', partName: 'Flute', section: 'Woodwinds', transposition: 'C', partNumber: 1 },
      ],
      // Only covers page 1–2 out of 3 → creates a gap on page 3
      cuttingInstructions: [
        { partName: 'Flute', instrument: 'Flute', section: 'Woodwinds', transposition: 'C', partNumber: 1, pageRange: [1, 2] },
      ],
    });
    vi.mocked(callVisionModel).mockResolvedValue({ content: GAP_RESPONSE });

    const job = makeJob(SESSION_ID);
    const result = await processSmartUpload(job);

    // Must NOT continue to split with an "Unlabelled Pages" part
    expect(result.status).toBe('queued_for_second_pass');

    // Session must be marked as requiring human review
    const updateCalls = vi.mocked(prisma.smartUploadSession.update).mock.calls;
    const reviewUpdate = updateCalls.find(c => (c[0] as any).data?.requiresHumanReview === true);
    expect(reviewUpdate).toBeDefined();
    expect((reviewUpdate![0] as any).data.secondPassStatus).toBe('QUEUED');
    expect((reviewUpdate![0] as any).data.parseStatus).toBe('NOT_PARSED');

    expect(queueSmartUploadSecondPass).toHaveBeenCalledWith(SESSION_ID);

    // No parts should be uploaded
    expect(uploadFile).not.toHaveBeenCalled();
  });
});
