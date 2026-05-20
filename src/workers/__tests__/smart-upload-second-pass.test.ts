/**
 * Smart Upload Second-Pass Worker — Integration Test
 *
 * Exercises processSecondPass with an initially low-confidence extraction
 * and a mocked verification LLM that returns corrected, higher-confidence
 * results.
 *
 * GAP 10 (DoD §11.3)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock pdf-lib to avoid cross-realm instanceof Uint8Array issues in Vitest
vi.mock('pdf-lib', () => ({
  PDFDocument: {
    load: vi.fn().mockResolvedValue({ getPageCount: () => 3 }),
  },
}));

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@/lib/db', () => ({
  prisma: {
    smartUploadSession: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    musicFile: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
    musicAssignment: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
  },
}));

vi.mock('@/lib/services/storage', () => ({
  downloadFile: vi.fn(),
  uploadFile: vi.fn().mockResolvedValue('mock-etag'),
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

vi.mock('@/lib/services/pdf-renderer', () => ({
  renderPdfPageBatch: vi.fn().mockResolvedValue(['b64p1', 'b64p2', 'b64p3']),
  renderPdfHeaderCropBatch: vi.fn().mockResolvedValue([]),
  clearRenderCache: vi.fn(),
}));

vi.mock('@/lib/services/pdf-splitter', () => ({
  splitPdfByCuttingInstructions: vi.fn().mockResolvedValue([
    {
      instruction: { partName: 'Flute', instrument: 'Flute', section: 'Woodwinds', transposition: 'C', partNumber: 1, pageRange: [1, 1] },
      buffer: Buffer.from('part1'),
      fileName: 'Flute.pdf',
      pageCount: 1,
    },
    {
      instruction: { partName: 'Clarinet', instrument: 'Clarinet', section: 'Woodwinds', transposition: 'Bb', partNumber: 2, pageRange: [2, 3] },
      buffer: Buffer.from('part2'),
      fileName: 'Clarinet.pdf',
      pageCount: 2,
    },
  ]),
}));

vi.mock('@/lib/smart-upload/prompts', () => ({
  buildVerificationPrompt: vi.fn().mockReturnValue('verification-prompt'),
  buildAdjudicatorPrompt: vi.fn().mockReturnValue('adjudicator-prompt'),
  DEFAULT_VERIFICATION_SYSTEM_PROMPT: 'default-system',
  DEFAULT_ADJUDICATOR_SYSTEM_PROMPT: 'default-adj-system',
}));

vi.mock('@/lib/jobs/smart-upload', () => ({
  queueSmartUploadSecondPass: vi.fn().mockResolvedValue({ id: 'sp' }),
  queueSmartUploadAutoCommit: vi.fn().mockResolvedValue({ id: 'ac' }),
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
// Imports
// ---------------------------------------------------------------------------
import { prisma } from '@/lib/db';
import { downloadFile } from '@/lib/services/storage';
import { callVisionModel } from '@/lib/llm';
import { buildAdapterConfigForStep, loadSmartUploadRuntimeConfig } from '@/lib/llm/config-loader';

const { processSecondPass } = await import('@/workers/smart-upload-worker');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fake PDF buffer — pdf-lib is mocked so any bytes work */
const FAKE_PDF = Buffer.from('%PDF-1.4 fake-test-content');

function makeJob(sessionId: string) {
  return {
    id: 'sp-job-1',
    data: { sessionId },
    updateProgress: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function makeLlmConfig(overrides: Record<string, unknown> = {}) {
  return {
    provider: 'openrouter',
    endpointUrl: 'https://openrouter.ai/api/v1',
    visionModel: 'test-vision',
    verificationModel: 'test-verify',
    adjudicatorModel: 'test-adj',
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
    enableOcrFirst: true,
    enforceOcrSplitting: false,
    ...overrides,
  };
}

const SESSION_ID = 'second-pass-session-1';

/** A low-confidence first-pass extraction with overlapping ranges */
const FIRST_PASS_EXTRACTION = {
  title: 'American Patrol',
  composer: 'F.W. Meacham',
  confidenceScore: 55,
  fileType: 'FULL_SCORE',
  isMultiPart: true,
  parts: [
    { instrument: 'Flute', partName: 'Flute', section: 'Woodwinds', transposition: 'C', partNumber: 1 },
    { instrument: 'Clarinet', partName: 'Clarinet', section: 'Woodwinds', transposition: 'Bb', partNumber: 2 },
  ],
  cuttingInstructions: [
    { partName: 'Flute', instrument: 'Flute', section: 'Woodwinds', transposition: 'C', partNumber: 1, pageRange: [1, 2] },
    { partName: 'Clarinet', instrument: 'Clarinet', section: 'Woodwinds', transposition: 'Bb', partNumber: 2, pageRange: [2, 3] },
  ],
};

/** Corrected verification LLM response — matches first pass instruments, high confidence */
const VERIFICATION_RESPONSE = JSON.stringify({
  title: 'American Patrol',
  composer: 'F.W. Meacham',
  confidenceScore: 92,
  verificationConfidence: 92,
  corrections: null,
  fileType: 'FULL_SCORE',
  isMultiPart: true,
  parts: [
    { instrument: 'Flute', partName: 'Flute', section: 'Woodwinds', transposition: 'C', partNumber: 1 },
    { instrument: 'Clarinet', partName: 'Clarinet', section: 'Woodwinds', transposition: 'Bb', partNumber: 2 },
  ],
  cuttingInstructions: [
    { partName: 'Flute', instrument: 'Flute', section: 'Woodwinds', transposition: 'C', partNumber: 1, pageRange: [1, 1] },
    { partName: 'Clarinet', instrument: 'Clarinet', section: 'Woodwinds', transposition: 'Bb', partNumber: 2, pageRange: [2, 3] },
  ],
});

// =============================================================================
// Tests
// =============================================================================

describe('processSecondPass — integration', () => {

  beforeEach(async () => {
    vi.clearAllMocks();

    vi.mocked(prisma.smartUploadSession.findUnique).mockResolvedValue({
      uploadSessionId: SESSION_ID,
      storageKey: `smart-upload/${SESSION_ID}/original.pdf`,
      uploadedBy: 'user-1',
      fileName: 'american-patrol.pdf',
      routingDecision: 'auto_parse_second_pass',
      parseStatus: 'NOT_PARSED',
      secondPassStatus: 'QUEUED',
      extractedMetadata: FIRST_PASS_EXTRACTION,
      parsedParts: null,
      cuttingInstructions: FIRST_PASS_EXTRACTION.cuttingInstructions,
      confidenceScore: 55,
    } as any);

    vi.mocked(prisma.smartUploadSession.update).mockResolvedValue({} as any);

    vi.mocked(downloadFile).mockImplementation(() =>
      Promise.resolve({
        stream: new Readable({
          read() {
            this.push(FAKE_PDF);
            this.push(null);
          },
        }) as unknown as NodeJS.ReadableStream,
        metadata: { contentType: 'application/pdf', size: FAKE_PDF.length },
      }),
    );

    vi.mocked(loadSmartUploadRuntimeConfig).mockResolvedValue(makeLlmConfig() as any);

    // Mock callVisionModel to return the corrected verification response
    // The second pass calls callVisionModel (via callVerificationLLM helper)
    vi.mocked(callVisionModel).mockResolvedValue({
      content: VERIFICATION_RESPONSE,
      usage: { promptTokens: 500, completionTokens: 300 },
    });
  });

  it('updates secondPassStatus to IN_PROGRESS then COMPLETE', async () => {
    const job = makeJob(SESSION_ID);
    await processSecondPass(job);

    const updateCalls = vi.mocked(prisma.smartUploadSession.update).mock.calls;

    // First update should set IN_PROGRESS
    const inProgressUpdate = updateCalls.find(
      (call) => (call[0] as any).data?.secondPassStatus === 'IN_PROGRESS'
    );
    expect(inProgressUpdate).toBeDefined();

    // Should eventually set COMPLETE
    const completeUpdate = updateCalls.find(
      (call) => (call[0] as any).data?.secondPassStatus === 'COMPLETE'
    );
    expect(completeUpdate).toBeDefined();
  });

  it('stores secondPassRaw for audit', async () => {
    const job = makeJob(SESSION_ID);
    await processSecondPass(job);

    const updateCalls = vi.mocked(prisma.smartUploadSession.update).mock.calls;
    // Find an update that includes secondPassRaw
    const rawUpdate = updateCalls.find(
      (call) => (call[0] as any).data?.secondPassRaw !== undefined
    );
    expect(rawUpdate).toBeDefined();
  });

  it('sets secondPassStatus to FAILED on error', async () => {
    vi.mocked(callVisionModel).mockRejectedValue(new Error('LLM timeout'));

    const job = makeJob(SESSION_ID);
    await expect(processSecondPass(job)).rejects.toThrow('LLM timeout');

    const updateCalls = vi.mocked(prisma.smartUploadSession.update).mock.calls;
    const failedUpdate = updateCalls.find(
      (call) => (call[0] as any).data?.secondPassStatus === 'FAILED'
    );
    expect(failedUpdate).toBeDefined();
  });

  it('routes verification calls through the configured glm-ocr provider', async () => {
    vi.mocked(buildAdapterConfigForStep).mockResolvedValueOnce({
      provider: 'glm-ocr',
      model: 'zai-org/GLM-OCR',
      apiKey: '',
      endpointUrl: 'http://glm-ocr:8090/v1',
      systemPrompt: 'glm-system',
      userPrompt: undefined,
      modelParams: { top_p: 0.9 },
    } as any);

    const job = makeJob(SESSION_ID);
    await processSecondPass(job);

    expect(callVisionModel).toHaveBeenCalled();
    const adapterConfig = vi.mocked(callVisionModel).mock.calls[0][0] as Record<string, string>;
    expect(adapterConfig.llm_provider).toBe('glm-ocr');
    expect(adapterConfig.llm_endpoint_url).toBe('http://glm-ocr:8090/v1');
    expect(adapterConfig.llm_vision_model).toBe('zai-org/GLM-OCR');
  });

  it('rejects sessions not in QUEUED or FAILED status', async () => {
    vi.mocked(prisma.smartUploadSession.findUnique).mockResolvedValue({
      uploadSessionId: SESSION_ID,
      secondPassStatus: 'COMPLETE',
      extractedMetadata: FIRST_PASS_EXTRACTION,
    } as any);

    const job = makeJob(SESSION_ID);
    await expect(processSecondPass(job)).rejects.toThrow(
      /not eligible/i
    );
  });

  it('throws when session is not found', async () => {
    vi.mocked(prisma.smartUploadSession.findUnique).mockResolvedValue(null);

    const job = makeJob('nonexistent');
    await expect(processSecondPass(job)).rejects.toThrow(/not found/i);
  });
});
