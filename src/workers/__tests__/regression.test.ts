/**
 * Smart Upload Regression Tests (DoD §7.3)
 *
 * Regression scenarios required by the Definition of Done:
 *   - Scanned PDF with no extractable text layer
 *   - "Condensed title / instrumentation layout" PDF (AmericanPatrol-style)
 *     where the first page contains only a title block and the LLM must infer
 *     part labels from subsequent header crops
 *   - Multi-part PDF with frequent instrument changes per page
 *
 * All tests use mocked LLM and storage dependencies.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import { parseSmartUploadJsonArray, parseSmartUploadJsonField } from '@/lib/smart-upload/persistence';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('pdf-lib', () => ({
  PDFDocument: {
    load: vi.fn().mockResolvedValue({ getPageCount: () => 12 }),
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
  uploadFile: vi.fn().mockResolvedValue('mock-etag'),
}));

vi.mock('@/lib/llm', () => ({
  callVisionModel: vi.fn(),
}));

vi.mock('@/lib/smart-upload/runtime-config', () => ({
  loadSmartUploadRuntimeConfig: vi.fn(),
  runtimeToAdapterConfig: vi.fn().mockReturnValue({}),
  buildAdapterConfigForStep: vi.fn().mockResolvedValue({
    provider: 'openai',
    model: 'gpt-4o',
    apiKey: 'test-key',
    baseUrl: 'https://api.openai.com/v1',
    temperature: 0.1,
    maxTokens: 4096,
  }),
  loadSmartUploadSettingsSnapshot: vi.fn().mockResolvedValue({
    source: 'SystemSetting',
    schema: 'smart-upload-runtime-config/v1',
    keys: {},
    hash: 'test-settings-hash',
    capturedAt: '2026-01-01T00:00:00.000Z',
  }),
  buildSmartUploadSettingsSnapshotSummary: vi.fn().mockReturnValue({
    source: 'SystemSetting',
    schema: 'smart-upload-runtime-config/v1',
    hash: 'test-settings-hash',
    capturedAt: '2026-01-01T00:00:00.000Z',
  }),

}));

vi.mock('@/lib/services/pdf-renderer', () => ({
  renderPdfPageBatch: vi.fn().mockResolvedValue(Array.from({ length: 12 }, (_, i) => `page${i}`)),
  renderPdfHeaderCropBatch: vi.fn().mockResolvedValue(Array.from({ length: 12 }, (_, i) => `crop${i}`)),
  clearRenderCache: vi.fn(),
}));

vi.mock('@/lib/services/pdf-text-extractor', () => ({
  extractPdfPageHeaders: vi.fn(),
}));

vi.mock('@/lib/services/part-boundary-detector', () => ({
  detectPartBoundaries: vi.fn(),
}));

vi.mock('@/lib/services/pdf-splitter', () => ({
  splitPdfByCuttingInstructions: vi.fn(),
  validatePdfBuffer: vi.fn().mockResolvedValue({ valid: true, pageCount: 12 }),
}));

vi.mock('@/lib/jobs/smart-upload', () => ({
  queueSmartUploadSecondPass: vi.fn().mockResolvedValue({ id: 'sp-1' }),
  queueSmartUploadAutoCommit: vi.fn().mockResolvedValue({ id: 'ac-1' }),
  SmartUploadJobProgress: {},
  SMART_UPLOAD_JOB_NAMES: {
    PROCESS: 'smartupload.process',
    SECOND_PASS: 'smartupload.secondPass',
    AUTO_COMMIT: 'smartupload.autoCommit',
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Providers — report PDF-capable so canSendPdf=true (PDF mode) is exercised
vi.mock('@/lib/llm/providers', () => ({
  getProviderMeta: vi.fn().mockReturnValue({ supportsPdfInput: true }),
}));

// OCR fallback — no extractable text for these scanned-PDF scenarios
vi.mock('@/lib/services/ocr-fallback', () => ({
  extractOcrFallbackMetadata: vi.fn().mockResolvedValue({
    title: null, composer: null, confidence: 0, rawText: '', pageCount: 0,
  }),
}));

// Page labeler — low confidence → useFullVisionLLM=true (falls through to LLM)
vi.mock('@/lib/services/page-labeler', () => ({
  labelPages: vi.fn().mockResolvedValue({
    cuttingInstructions: [], pageLabels: {}, confidence: 0,
    strategyUsed: 'text',
    diagnostics: { strategies: [], totalDurationMs: 0, budgetRemaining: 10, budgetLimit: 10 },
  }),
}));

// Header-image segmentation — no segments for scanned test PDFs
vi.mock('@/lib/services/header-image-segmentation', () => ({
  segmentByHeaderImages: vi.fn().mockResolvedValue(null),
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { prisma } from '@/lib/db';
import { downloadFile, uploadFile } from '@/lib/services/storage';
import { callVisionModel } from '@/lib/llm';
import { loadSmartUploadRuntimeConfig } from '@/lib/smart-upload/runtime-config';
import { loadSmartUploadRuntimeConfig as _cfg } from '@/lib/smart-upload/runtime-config';
import { splitPdfByCuttingInstructions } from '@/lib/services/pdf-splitter';
import { extractPdfPageHeaders } from '@/lib/services/pdf-text-extractor';
import { detectPartBoundaries } from '@/lib/services/part-boundary-detector';
import { queueSmartUploadSecondPass } from '@/lib/jobs/smart-upload';

const { processSmartUpload } = await import('@/workers/smart-upload-processor');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FAKE_PDF = Buffer.from('%PDF-1.4 fake');
const SESSION = 'regression-session';

function makeJob() {
  return {
    id: 'reg-job',
    data: { sessionId: SESSION, fileId: 'f1' },
    updateProgress: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function baseCfg(overrides: Record<string, unknown> = {}) {
  return {
    provider: 'ollama',
    endpointUrl: 'http://localhost:11434',
    visionModel: 'llama3.2-vision',
    verificationModel: 'qwen2.5:7b',
    adjudicatorModel: 'qwen2.5:7b',
    openaiApiKey: '', anthropicApiKey: '', openrouterApiKey: '',
    geminiApiKey: '', ollamaCloudApiKey: '', mistralApiKey: '', groqApiKey: '', customApiKey: '',
    confidenceThreshold: 60, twoPassEnabled: false,
    rateLimit: 10, autoApproveThreshold: 90, skipParseThreshold: 55,
    autonomousApprovalThreshold: 90, maxPages: 200, maxFileSizeMb: 100,
    maxConcurrent: 2, maxPagesPerPart: 12, allowedMimeTypes: ['application/pdf'],
    enableFullyAutonomousMode: false,
    visionModelParams: {}, verificationModelParams: {},
    promptVersion: '1.0',
    // PDF mode: provider mock returns supportsPdfInput:true, so send full PDF to LLM
    sendFullPdfToLlm: true,
    enableOcrFirst: true,
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

function makeStream() {
  return new Readable({
    read() { this.push(FAKE_PDF); this.push(null); },
  }) as unknown as NodeJS.ReadableStream;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  vi.mocked(prisma.smartUploadSession.findUnique).mockResolvedValue({
    uploadSessionId: SESSION,
    storageKey: `smart-upload/${SESSION}/original.pdf`,
    uploadedBy: 'user-1',
    fileName: 'test.pdf',
    parseStatus: 'NOT_PARSED',
  } as any);
  vi.mocked(prisma.smartUploadSession.update).mockResolvedValue({} as any);
  vi.mocked(downloadFile).mockResolvedValue({ stream: makeStream(), metadata: { contentType: 'application/pdf', size: FAKE_PDF.length } });
  vi.mocked(uploadFile).mockResolvedValue('etag');
  vi.mocked(loadSmartUploadRuntimeConfig).mockResolvedValue(baseCfg() as any);
});

// ---------------------------------------------------------------------------
// Scenario 1: Scanned PDF with no text layer
// ---------------------------------------------------------------------------

describe('Regression: scanned PDF with no text layer', () => {
  beforeEach(() => {
    // No text layer — extractPdfPageHeaders returns hasTextLayer: false
    vi.mocked(extractPdfPageHeaders).mockResolvedValue({
      hasTextLayer: false,
      pageHeaders: [],
      textLayerCoverage: 0,
    } as any);

    // detectPartBoundaries returns empty (should not be called when no text layer)
    vi.mocked(detectPartBoundaries).mockReturnValue({
      segments: [],
      cuttingInstructions: [],
      segmentationConfidence: 0,
    } as any);
  });

  it('falls back to LLM vision analysis when no text layer present', async () => {
    vi.mocked(callVisionModel).mockResolvedValue({
      content: JSON.stringify({
        title: 'Scanned Score',
        composer: 'Unknown',
        confidenceScore: 72,
        isMultiPart: true,
        cuttingInstructions: [
          { instrument: 'Flute', partName: 'Flute', section: 'Woodwinds', transposition: 'C', partNumber: 1, pageRange: [1, 4] },
          { instrument: 'Clarinet', partName: 'Bb Clarinet', section: 'Woodwinds', transposition: 'Bb', partNumber: 2, pageRange: [5, 8] },
          { instrument: 'Tuba', partName: 'Tuba', section: 'Brass', transposition: 'C', partNumber: 3, pageRange: [9, 12] },
        ],
      }),
    });

    vi.mocked(splitPdfByCuttingInstructions).mockResolvedValue([
      { instruction: { partName: 'Flute', instrument: 'Flute', section: 'Woodwinds', transposition: 'C', partNumber: 1, pageRange: [0, 3] }, buffer: Buffer.from('f1'), pageCount: 4 },
      { instruction: { partName: 'Bb Clarinet', instrument: 'Clarinet', section: 'Woodwinds', transposition: 'Bb', partNumber: 2, pageRange: [4, 7] }, buffer: Buffer.from('f2'), pageCount: 4 },
      { instruction: { partName: 'Tuba', instrument: 'Tuba', section: 'Brass', transposition: 'C', partNumber: 3, pageRange: [8, 11] }, buffer: Buffer.from('f3'), pageCount: 4 },
    ] as any);

    const result = await processSmartUpload(makeJob());

    // Pipeline completes
    expect(result.status).toBe('complete');
    expect(result.partsCreated).toBe(3);

    // Parts were uploaded
    expect(uploadFile).toHaveBeenCalledTimes(3);

    // Low confidence (72 < autoApproveThreshold 90) → second pass queued
    expect(queueSmartUploadSecondPass).toHaveBeenCalledWith(SESSION);
  });

  it('routes low-confidence scanned PDF to second pass', async () => {
    vi.mocked(callVisionModel).mockResolvedValue({
      content: JSON.stringify({
        title: 'Blurry Score',
        confidenceScore: 35, // below skipParseThreshold
        isMultiPart: true,
        cuttingInstructions: [
          { instrument: 'Unknown', partName: 'Unknown Part', section: 'Other', transposition: 'C', partNumber: 1, pageRange: [1, 12] },
        ],
      }),
    });

    await processSmartUpload(makeJob());

    // 35 < skipParseThreshold(55) → no_parse_second_pass, NOT_PARSED
    const updateCalls = vi.mocked(prisma.smartUploadSession.update).mock.calls;
    const lowConfUpdate = updateCalls.find((c) => (c[0] as any).data?.routingDecision === 'no_parse_second_pass');
    expect(lowConfUpdate).toBeDefined();
    expect((lowConfUpdate![0] as any).data.parseStatus).toBe('NOT_PARSED');
    expect(queueSmartUploadSecondPass).toHaveBeenCalledWith(SESSION);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: AmericanPatrol-style condensed title/instrumentation layout
// ---------------------------------------------------------------------------

describe('Regression: AmericanPatrol condensed title layout', () => {
  it('correctly detects parts via header-label LLM pass for layout with cover page', async () => {
    // Text layer has some coverage but insufficient for deterministic segmentation
    vi.mocked(extractPdfPageHeaders).mockResolvedValue({
      hasTextLayer: true,
      pageHeaders: [
        { pageIndex: 0, headerText: 'American Patrol', fullText: 'American Patrol — F.W. Meacham', hasText: true },
        // pages 1-11 have typical instrument headers
        ...Array.from({ length: 11 }, (_, i) => ({
          pageIndex: i + 1, headerText: '', fullText: '', hasText: false,
        })),
      ],
      textLayerCoverage: 0.1, // sparse — cover page only
    } as any);

    // Low confidence from deterministic pass → header-label LLM pass triggers
    vi.mocked(detectPartBoundaries).mockReturnValue({
      segments: [],
      cuttingInstructions: [],
      segmentationConfidence: 20,
    } as any);

    // In PDF mode a single vision call is made — include the cover page
    // (page 1) as a part so there are no gaps (gap = hard fail → second pass).
    vi.mocked(callVisionModel).mockResolvedValue({
      content: JSON.stringify({
        title: 'American Patrol',
        composer: 'F.W. Meacham',
        arranger: 'arr. Lake',
        copyrightYear: 1977,
        ensembleType: 'Concert Band',
        fileType: 'FULL_SCORE',
        isMultiPart: true,
        confidenceScore: 88,
        cuttingInstructions: [
          { instrument: 'Cover Page', partName: 'Cover Page', section: 'Score', transposition: 'C', partNumber: 0, pageRange: [1, 1] },
          { instrument: '1st Bb Clarinet', partName: '1st Bb Clarinet', section: 'Woodwinds', transposition: 'Bb', partNumber: 1, pageRange: [2, 3] },
          { instrument: '2nd Bb Clarinet', partName: '2nd Bb Clarinet', section: 'Woodwinds', transposition: 'Bb', partNumber: 2, pageRange: [4, 5] },
          { instrument: 'Bb Bass Clarinet', partName: 'Bb Bass Clarinet', section: 'Woodwinds', transposition: 'Bb', partNumber: 3, pageRange: [6, 6] },
          { instrument: '1st Alto Saxophone', partName: '1st Alto Saxophone', section: 'Woodwinds', transposition: 'Eb', partNumber: 4, pageRange: [7, 7] },
          { instrument: '2nd Alto Saxophone', partName: '2nd Alto Saxophone', section: 'Woodwinds', transposition: 'Eb', partNumber: 5, pageRange: [8, 8] },
          { instrument: 'Tenor Saxophone', partName: 'Tenor Saxophone', section: 'Woodwinds', transposition: 'Bb', partNumber: 6, pageRange: [9, 9] },
          { instrument: 'Baritone Saxophone', partName: 'Baritone Saxophone', section: 'Woodwinds', transposition: 'Eb', partNumber: 7, pageRange: [10, 10] },
          { instrument: 'Tuba', partName: 'Tuba', section: 'Brass', transposition: 'C', partNumber: 8, pageRange: [11, 12] },
        ],
      }),
    });

    vi.mocked(splitPdfByCuttingInstructions).mockResolvedValue(
      ['Cover Page', '1st Bb Clarinet', '2nd Bb Clarinet', 'Bb Bass Clarinet', '1st Alto Saxophone', '2nd Alto Saxophone', 'Tenor Saxophone', 'Baritone Saxophone', 'Tuba'].map((instr, i) => ({
        instruction: { partName: instr, instrument: instr, section: 'Woodwinds', transposition: 'Bb', partNumber: i, pageRange: [i, i] },
        buffer: Buffer.from(`part-${i}`),
        pageCount: 1,
      })) as any
    );

    const result = await processSmartUpload(makeJob());

    expect(result.status).toBe('complete');
    expect(result.partsCreated).toBe(9); // 8 instrument parts + 1 cover

    // Verify copyrightYear is persisted in extractedMetadata
    const updateCalls = vi.mocked(prisma.smartUploadSession.update).mock.calls;
    const finalUpdate = updateCalls.find((c) => (c[0] as any).data?.parseStatus === 'PARSED');
    expect(finalUpdate).toBeDefined();
    const meta = parseSmartUploadJsonField<Record<string, unknown>>(
      (finalUpdate![0] as any).data.extractedMetadata,
      {},
    );
    expect(meta.copyrightYear).toBe(1977);
    expect(meta.title).toBe('American Patrol');
    expect(meta.composer).toBe('F.W. Meacham');
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: Multi-part with frequent instrument changes
// ---------------------------------------------------------------------------

describe('Regression: multi-part PDF with frequent instrument changes', () => {
  it('produces correct cutting instructions for a 12-part dense packet', async () => {
    vi.mocked(extractPdfPageHeaders).mockResolvedValue({
      hasTextLayer: false,
      pageHeaders: [],
      textLayerCoverage: 0,
    } as any);
    vi.mocked(detectPartBoundaries).mockReturnValue({ segments: [], cuttingInstructions: [], segmentationConfidence: 0 } as any);

    const instruments = [
      'Piccolo', 'Flute', '1st Bb Clarinet', '2nd Bb Clarinet',
      'Alto Sax', 'Tenor Sax', '1st Bb Trumpet', '2nd Bb Trumpet',
      'F Horn', '1st Trombone', 'Euphonium', 'Tuba',
    ];

    vi.mocked(callVisionModel).mockResolvedValue({
      content: JSON.stringify({
        title: 'Stars and Stripes Forever',
        composer: 'John Philip Sousa',
        confidenceScore: 85,
        isMultiPart: true,
        cuttingInstructions: instruments.map((inst, i) => ({
          instrument: inst, partName: inst, section: i < 5 ? 'Woodwinds' : 'Brass',
          transposition: 'C', partNumber: i + 1,
          pageRange: [i + 1, i + 1],
        })),
      }),
    });

    vi.mocked(splitPdfByCuttingInstructions).mockResolvedValue(
      instruments.map((inst, i) => ({
        instruction: { partName: inst, instrument: inst, section: i < 5 ? 'Woodwinds' : 'Brass', transposition: 'C', partNumber: i + 1, pageRange: [i, i] },
        buffer: Buffer.from(`part-${i}`),
        pageCount: 1,
      })) as any
    );

    const result = await processSmartUpload(makeJob());

    expect(result.status).toBe('complete');
    expect(result.partsCreated).toBe(12);

    // 12 part PDFs uploaded
    expect(uploadFile).toHaveBeenCalledTimes(12);

    const updateCalls = vi.mocked(prisma.smartUploadSession.update).mock.calls;
    const finalUpdate = updateCalls.find((c) => (c[0] as any).data?.parseStatus === 'PARSED');
    expect(finalUpdate).toBeDefined();
    const parsedParts = parseSmartUploadJsonArray((finalUpdate![0] as any).data.parsedParts);
    expect(parsedParts).toHaveLength(12);
  });

  it('detects and fills gap pages for dense multi-part PDF', async () => {
    vi.mocked(extractPdfPageHeaders).mockResolvedValue({ hasTextLayer: false, pageHeaders: [], textLayerCoverage: 0 } as any);
    vi.mocked(detectPartBoundaries).mockReturnValue({ segments: [], cuttingInstructions: [], segmentationConfidence: 0 } as any);

    // LLM only covers pages 1-10, leaving pages 11-12 as a gap
    vi.mocked(callVisionModel).mockResolvedValue({
      content: JSON.stringify({
        title: 'Gap Test Score',
        confidenceScore: 80,
        isMultiPart: true,
        cuttingInstructions: [
          { instrument: 'Flute', partName: 'Flute', section: 'Woodwinds', transposition: 'C', partNumber: 1, pageRange: [1, 6] },
          { instrument: 'Clarinet', partName: 'Clarinet', section: 'Woodwinds', transposition: 'Bb', partNumber: 2, pageRange: [7, 10] },
          // pages 11-12 NOT covered → gap
        ],
      }),
    });

    vi.mocked(splitPdfByCuttingInstructions).mockResolvedValue([
      { instruction: { partName: 'Flute', instrument: 'Flute', section: 'Woodwinds', transposition: 'C', partNumber: 1, pageRange: [0, 5] }, buffer: Buffer.from('f1'), pageCount: 6 },
      { instruction: { partName: 'Clarinet', instrument: 'Clarinet', section: 'Woodwinds', transposition: 'Bb', partNumber: 2, pageRange: [6, 9] }, buffer: Buffer.from('f2'), pageCount: 4 },
      // Gap part will be added by gap detection
      { instruction: { partName: 'Unlabelled p11-12', instrument: 'Unlabelled p11-12', section: 'Other', transposition: 'C', partNumber: 3, pageRange: [10, 11] }, buffer: Buffer.from('f3'), pageCount: 2 },
    ] as any);

    const result = await processSmartUpload(makeJob());
    // Gap pages now trigger hard-fail → routed to human review / second pass
    expect(result.status).toBe('queued_for_second_pass');

    // Session must be marked for human review
    const updateCalls = vi.mocked(prisma.smartUploadSession.update).mock.calls;
    const reviewUpdate = updateCalls.find((c) => (c[0] as any).data?.requiresHumanReview === true);
    expect(reviewUpdate).toBeDefined();
    expect((reviewUpdate![0] as any).data.secondPassStatus).toBe('QUEUED');

    // Nothing was split / uploaded — fail-safe fires before the split phase
    expect(uploadFile).not.toHaveBeenCalled();
  });
});
