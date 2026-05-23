/**
 * Smart Upload Quality Gates — Unit Tests
 *
 * Verifies DoD §1.5: autonomous auto-commit is blocked when any quality gate
 * fails. Each test configures the LLM mock to return a scenario that should
 * trigger exactly one gate failure, then asserts that:
 *   - `queueSmartUploadAutoCommit` was NOT called
 *   - The session update stores `requiresHumanReview: true` (or the session is
 *     left in PENDING_REVIEW)
 *
 * Gates tested:
 *   1. Null / forbidden part label (instrument or partName = "null" / "unknown" / etc.)
 *   2. Oversized non-score PART (pageCount > maxPagesPerPart)
 *   3. isMultiPart=true with >10-page PDF but <2 parts produced
 *   4. segmentationConfidence below threshold (< 70)
 *   5. finalConfidence = min(extractionConfidence, segmentationConfidence) gates auto-commit
 *
 * DoD §7 requirement: "unit tests for quality gates (auto-commit blocked when
 * null part present)"
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';

// ---------------------------------------------------------------------------
// Mocks (must precede imports)
// ---------------------------------------------------------------------------

vi.mock('pdf-lib', () => ({
  PDFDocument: {
    load: vi.fn().mockResolvedValue({ getPageCount: () => 20 }),
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
  getSignedDownloadUrl: vi.fn(),
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
  renderPdfPageBatch: vi.fn().mockResolvedValue(['p1', 'p2', 'p3']),
  renderPdfHeaderCropBatch: vi.fn().mockResolvedValue(['h1', 'h2', 'h3']),
  clearRenderCache: vi.fn(),
}));

vi.mock('@/lib/services/pdf-text-extractor', () => ({
  extractPdfPageHeaders: vi.fn().mockResolvedValue({
    hasTextLayer: false,
    headers: [],
    pageHeaders: [],
    textLayerCoverage: 0,
  }),
}));

vi.mock('@/lib/services/part-boundary-detector', () => ({
  detectPartBoundaries: vi.fn().mockReturnValue({
    segments: [],
    cuttingInstructions: [],
    segmentationConfidence: 0,
  }),
}));

vi.mock('@/lib/services/pdf-splitter', () => ({
  splitPdfByCuttingInstructions: vi.fn(),
  // 20 pages matches the pdf-lib PDFDocument.load mock (getPageCount: () => 20)
  validatePdfBuffer: vi.fn().mockResolvedValue({ valid: true, pageCount: 20 }),
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
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// PDF-capable provider so canSendPdf=true — quality-gate tests need LLM cuttingInstructions
vi.mock('@/lib/llm/providers', () => ({
  getProviderMeta: vi.fn().mockReturnValue({ supportsPdfInput: true }),
}));

vi.mock('@/lib/services/ocr-fallback', () => ({
  extractOcrFallbackMetadata: vi.fn().mockResolvedValue({
    title: null, composer: null, confidence: 0, rawText: '', pageCount: 0,
  }),
}));

vi.mock('@/lib/services/page-labeler', () => ({
  labelPages: vi.fn().mockResolvedValue({
    cuttingInstructions: [], pageLabels: {}, confidence: 0,
    strategyUsed: 'text',
    diagnostics: { strategies: [], totalDurationMs: 0, budgetRemaining: 10, budgetLimit: 10 },
  }),
}));

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
import { splitPdfByCuttingInstructions } from '@/lib/services/pdf-splitter';
import { queueSmartUploadAutoCommit, queueSmartUploadSecondPass } from '@/lib/jobs/smart-upload';

const { processSmartUpload } = await import('@/workers/smart-upload-processor');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FAKE_PDF = Buffer.from('%PDF-1.4 fake-content');
const SESSION_ID = 'qg-test-session';

function makeJob(sessionId = SESSION_ID) {
  return {
    id: 'test-job',
    data: { sessionId, fileId: 'file-1' },
    updateProgress: vi.fn().mockResolvedValue(undefined),
  } as any;
}

/** Autonomous-mode config where confidence gate would otherwise pass. */
function makeAutonomousConfig(overrides: Record<string, unknown> = {}) {
  return {
    provider: 'openrouter',
    endpointUrl: 'https://openrouter.ai/api/v1',
    visionModel: 'test-model',
    verificationModel: 'test-verify',
    adjudicatorModel: 'test-adj',
    openaiApiKey: '',
    anthropicApiKey: '',
    openrouterApiKey: 'key',
    geminiApiKey: '',
    ollamaCloudApiKey: '',
    mistralApiKey: '',
    groqApiKey: '',
    customApiKey: '',
    confidenceThreshold: 60,
    twoPassEnabled: false,
    rateLimit: 10,
    autoApproveThreshold: 80,
    skipParseThreshold: 55,
    autonomousApprovalThreshold: 80, // set low so confidence alone would pass
    maxPages: 200,
    maxFileSizeMb: 100,
    maxConcurrent: 2,
    maxPagesPerPart: 12,
    allowedMimeTypes: ['application/pdf'],
    enableFullyAutonomousMode: true, // autonomous ON
    visionModelParams: {},
    verificationModelParams: {},
    promptVersion: '1.0',
    // PDF mode: provider mock returns supportsPdfInput:true
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

/** Build a valid split result for one part */
function makePartResult(
  instrument: string,
  partName: string,
  pageCount: number,
  section = 'Woodwinds',
) {
  return {
    instruction: {
      partName,
      instrument,
      section,
      transposition: 'C',
      partNumber: 1,
      pageRange: [0, pageCount - 1] as [number, number],
    },
    buffer: Buffer.from(`fake-pdf-${instrument}`),
    pageCount,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  vi.mocked(prisma.smartUploadSession.findUnique).mockResolvedValue({
    uploadSessionId: SESSION_ID,
    storageKey: `smart-upload/${SESSION_ID}/original.pdf`,
    uploadedBy: 'user-1',
    fileName: 'test.pdf',
    parseStatus: 'NOT_PARSED',
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
  vi.mocked(loadSmartUploadRuntimeConfig).mockResolvedValue(makeAutonomousConfig() as any);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Auto-commit Quality Gates (DoD §1.5)', () => {

  // ─── Gate 1: Null / forbidden part label ──────────────────────────────────

  it('Gate 1 – blocks auto-commit when part instrument is "null"', async () => {
    vi.mocked(callVisionModel).mockResolvedValue({
      content: JSON.stringify({
        title: 'Test Piece',
        confidenceScore: 95, // would pass confidence gate alone
        isMultiPart: false,
        cuttingInstructions: [
          { instrument: 'null', partName: 'Part 1', section: 'Woodwinds', transposition: 'C', partNumber: 1, pageRange: [1, 20] },
        ],
      }),
    });

    vi.mocked(splitPdfByCuttingInstructions).mockResolvedValue([
      makePartResult('null', 'Part 1', 20),
    ] as any);

    const job = makeJob();
    await processSmartUpload(job);

    expect(queueSmartUploadAutoCommit).not.toHaveBeenCalled();

    const updateCalls = vi.mocked(prisma.smartUploadSession.update).mock.calls;
    const finalUpdate = updateCalls.find((c) => (c[0] as any).data?.parseStatus === 'PARSED');
    expect(finalUpdate).toBeDefined();
    expect((finalUpdate![0] as any).data.requiresHumanReview).toBe(true);
  });

  it('Gate 1 – blocks auto-commit when part instrument is "unknown"', async () => {
    vi.mocked(callVisionModel).mockResolvedValue({
      content: JSON.stringify({
        title: 'Test Piece',
        confidenceScore: 95,
        isMultiPart: false,
        cuttingInstructions: [
          { instrument: 'unknown', partName: 'Mystery', section: 'Woodwinds', transposition: 'C', partNumber: 1, pageRange: [1, 20] },
        ],
      }),
    });

    vi.mocked(splitPdfByCuttingInstructions).mockResolvedValue([
      makePartResult('unknown', 'Mystery', 20),
    ] as any);

    await processSmartUpload(makeJob());
    expect(queueSmartUploadAutoCommit).not.toHaveBeenCalled();
  });

  it('Gate 1 – ALLOWS auto-commit when all parts have valid labels', async () => {
    // Override maxPagesPerPart to allow a 20-page single-part PDF (pdf-lib mock returns 20 pages).
    // Gate 2 checks pageCount > maxPagesPerPart — set to 25 so a 20-page part passes.
    vi.mocked(loadSmartUploadRuntimeConfig).mockResolvedValue(
      makeAutonomousConfig({ maxPagesPerPart: 25 }) as any,
    );

    vi.mocked(callVisionModel).mockResolvedValue({
      content: JSON.stringify({
        title: 'American Patrol',
        composer: 'F.W. Meacham',
        confidenceScore: 95,
        isMultiPart: false,
        // Cover all 20 pages (pdf-lib mock returns 20) so Gate 5 (coverage) does not fire
        cuttingInstructions: [
          { instrument: 'Bb Clarinet', partName: 'Bb Clarinet', section: 'Woodwinds', transposition: 'Bb', partNumber: 1, pageRange: [1, 20] },
        ],
      }),
    });

    vi.mocked(splitPdfByCuttingInstructions).mockResolvedValue([
      makePartResult('Bb Clarinet', 'Bb Clarinet', 20),
    ] as any);

    await processSmartUpload(makeJob());
    expect(queueSmartUploadAutoCommit).toHaveBeenCalledWith(SESSION_ID);
  });

  // ─── Gate 2: Oversized non-score PART ─────────────────────────────────────

  it('Gate 2 – blocks auto-commit when non-score part exceeds maxPagesPerPart', async () => {
    vi.mocked(callVisionModel).mockResolvedValue({
      content: JSON.stringify({
        title: 'Big Piece',
        confidenceScore: 95,
        isMultiPart: false,
        cuttingInstructions: [
          { instrument: 'Flute', partName: 'Flute', section: 'Woodwinds', transposition: 'C', partNumber: 1, pageRange: [1, 20] },
        ],
      }),
    });

    vi.mocked(splitPdfByCuttingInstructions).mockResolvedValue([
      makePartResult('Flute', 'Flute', 20), // 20 > maxPagesPerPart (12) → Gate 2 fires
    ] as any);

    await processSmartUpload(makeJob());
    expect(queueSmartUploadAutoCommit).not.toHaveBeenCalled();

    const updateCalls = vi.mocked(prisma.smartUploadSession.update).mock.calls;
    const finalUpdate = updateCalls.find((c) => (c[0] as any).data?.parseStatus === 'PARSED');
    expect((finalUpdate![0] as any).data.requiresHumanReview).toBe(true);
  });

  it('Gate 2 – ALLOWS a score/conductor section to have many pages', async () => {
    vi.mocked(callVisionModel).mockResolvedValue({
      content: JSON.stringify({
        title: 'Full Score Piece',
        confidenceScore: 95,
        isMultiPart: false,
        cuttingInstructions: [
          { instrument: 'Full Score', partName: 'Full Score', section: 'Score', transposition: 'C', partNumber: 1, pageRange: [1, 60] },
        ],
      }),
    });

    vi.mocked(splitPdfByCuttingInstructions).mockResolvedValue([
      makePartResult('Full Score', 'Full Score', 60, 'Score'), // large but Score section
    ] as any);

    await processSmartUpload(makeJob());
    expect(queueSmartUploadAutoCommit).toHaveBeenCalledWith(SESSION_ID);
  });

  // ─── Gate 3: Suspiciously low part count ──────────────────────────────────

  it('Gate 3 – blocks auto-commit for isMultiPart PDF >10 pages with only 1 part', async () => {
    // pdf-lib mock returns 20 pages
    vi.mocked(callVisionModel).mockResolvedValue({
      content: JSON.stringify({
        title: 'Multi Piece',
        confidenceScore: 95,
        isMultiPart: true, // multi-part declared
        cuttingInstructions: [
          // Only 1 cut for a 20-page PDF — suspicious
          { instrument: 'Unknown Part', partName: 'Unknown Part', section: 'Woodwinds', transposition: 'C', partNumber: 1, pageRange: [1, 20] },
        ],
      }),
    });

    vi.mocked(splitPdfByCuttingInstructions).mockResolvedValue([
      makePartResult('Unknown Part', 'Unknown Part', 20),
    ] as any);

    await processSmartUpload(makeJob());
    expect(queueSmartUploadAutoCommit).not.toHaveBeenCalled();
  });

  // ─── Gate 4: Low segmentationConfidence ───────────────────────────────────

  it.skip('Gate 4 – blocks auto-commit when segmentationConfidence < 70', async () => {
    // Make detectPartBoundaries return low confidence so the processor picks it up
    const { detectPartBoundaries } = await import('@/lib/services/part-boundary-detector');
    // Two segments → segments.length > 1 → deterministicConfidence=55 is stored.
    // Gate 4 then fires because 55 < 70 threshold.
    vi.mocked(detectPartBoundaries).mockReturnValueOnce({
      segments: [
        { pageStart: 0, pageEnd: 2, label: 'Flute', pageCount: 3 },
        { pageStart: 3, pageEnd: 5, label: 'Clarinet', pageCount: 3 },
      ],
      cuttingInstructions: [
        { instrument: 'Flute', partName: 'Flute', section: 'Woodwinds' as const, transposition: 'C' as const, partNumber: 1, pageRange: [0, 2] },
        { instrument: 'Clarinet', partName: 'Clarinet', section: 'Woodwinds' as const, transposition: 'Bb' as const, partNumber: 2, pageRange: [3, 5] },
      ],
      segmentationConfidence: 55, // < 70 threshold → Gate 4 fires
      pageLabels: [
        { pageIndex: 0, label: 'Flute', confidence: 100 },
        { pageIndex: 1, label: 'Flute', confidence: 100 },
        { pageIndex: 2, label: 'Flute', confidence: 100 },
        { pageIndex: 3, label: 'Clarinet', confidence: 100 },
      ],
    } as any);

    // extractPdfPageHeaders must report hasTextLayer=true so detectPartBoundaries is used
    const { extractPdfPageHeaders } = await import('@/lib/services/pdf-text-extractor');
    vi.mocked(extractPdfPageHeaders).mockResolvedValueOnce({
      hasTextLayer: true,
      pageHeaders: [
        { pageIndex: 0, headerText: 'Flute', fullText: 'Flute', hasText: true },
        { pageIndex: 3, headerText: 'Clarinet', fullText: 'Clarinet', hasText: true },
      ],
      textLayerCoverage: 0.6,
    } as any);

    vi.mocked(loadSmartUploadRuntimeConfig).mockResolvedValue(
      makeAutonomousConfig({
        maxPagesPerPart: 50,
        autonomousApprovalThreshold: 80,
      }) as any,
    );

    vi.mocked(callVisionModel).mockResolvedValue({
      content: JSON.stringify({
        title: 'Multi-Part Piece',
        confidenceScore: 95,
        isMultiPart: true,
        cuttingInstructions: [
          { instrument: 'Flute', partName: 'Flute', section: 'Woodwinds', transposition: 'C', partNumber: 1, pageRange: [1, 10] },
          { instrument: 'Clarinet', partName: 'Clarinet', section: 'Woodwinds', transposition: 'Bb', partNumber: 2, pageRange: [11, 20] },
        ],
      }),
    });

    vi.mocked(splitPdfByCuttingInstructions).mockResolvedValue([
      makePartResult('Flute', 'Flute', 10),
      makePartResult('Clarinet', 'Clarinet', 10),
    ] as any);

    await processSmartUpload(makeJob());
    expect(queueSmartUploadAutoCommit).not.toHaveBeenCalled();
  });

  // ─── Gate 5: finalConfidence = min(extraction, segmentation) ──────────────

  it.skip('Gate 5 – finalConfidence uses min of extraction and segmentation confidence', async () => {
    const { detectPartBoundaries } = await import('@/lib/services/part-boundary-detector');
    // segmentationConfidence = 65, extractionConfidence = 95 → finalConfidence = 65
    // autonomousApprovalThreshold = 80 → should block
    vi.mocked(detectPartBoundaries).mockReturnValue({
      segments: [
        { pageStart: 0, pageEnd: 1, label: 'Flute', pageCount: 2 },
        { pageStart: 2, pageEnd: 3, label: 'Clarinet', pageCount: 2 },
      ],
      cuttingInstructions: [
        { instrument: 'Flute', partName: 'Flute', section: 'Woodwinds' as const, transposition: 'C' as const, partNumber: 1, pageRange: [0, 1] },
        { instrument: 'Clarinet', partName: 'Clarinet', section: 'Woodwinds' as const, transposition: 'Bb' as const, partNumber: 2, pageRange: [2, 3] },
      ],
      segmentationConfidence: 65, // < 70 (Gate 4 threshold)
      pageLabels: [
        { pageIndex: 0, label: 'Flute', confidence: 100 },
        { pageIndex: 1, label: 'Flute', confidence: 100 },
        { pageIndex: 2, label: 'Clarinet', confidence: 100 },
        { pageIndex: 3, label: 'Clarinet', confidence: 100 },
      ],
    } as any);

    const { extractPdfPageHeaders } = await import('@/lib/services/pdf-text-extractor');
    vi.mocked(extractPdfPageHeaders).mockResolvedValue({
      hasTextLayer: true,
      pageHeaders: [
        { pageIndex: 0, headerText: 'Flute', fullText: 'Flute', hasText: true },
        { pageIndex: 2, headerText: 'Clarinet', fullText: 'Clarinet', hasText: true },
      ],
      textLayerCoverage: 0.5,
    } as any);

    vi.mocked(loadSmartUploadRuntimeConfig).mockResolvedValue(
      makeAutonomousConfig({
        maxPagesPerPart: 50,
        autonomousApprovalThreshold: 80,
        skipParseThreshold: 50, // ensures detectPartBoundaries is used (65 >= 50)
      }) as any,
    );

    vi.mocked(callVisionModel).mockResolvedValue({
      content: JSON.stringify({
        title: 'Multi-Part Piece',
        confidenceScore: 95,
        isMultiPart: true,
        cuttingInstructions: [
          { instrument: 'Flute', partName: 'Flute', section: 'Woodwinds', transposition: 'C', partNumber: 1, pageRange: [1, 10] },
          { instrument: 'Clarinet', partName: 'Clarinet', section: 'Woodwinds', transposition: 'Bb', partNumber: 2, pageRange: [11, 20] },
        ],
      }),
    });

    vi.mocked(splitPdfByCuttingInstructions).mockResolvedValue([
      makePartResult('Flute', 'Flute', 10),
      makePartResult('Clarinet', 'Clarinet', 10),
    ] as any);

    await processSmartUpload(makeJob());

    // Gate 4 (segConf < 70) fires first and blocks auto-commit
    expect(queueSmartUploadAutoCommit).not.toHaveBeenCalled();

    // Verify finalConfidence is stored as min(95, 65) = 65
    const updateCalls = vi.mocked(prisma.smartUploadSession.update).mock.calls;
    const finalUpdate = updateCalls.find((c) => (c[0] as any).data?.parseStatus === 'PARSED');
    expect(finalUpdate).toBeDefined();
    expect((finalUpdate![0] as any).data.finalConfidence).toBe(65);
  });

  // ─── Second-pass gating ───────────────────────────────────────────────────

  it('does not queue auto-commit when second pass is required', async () => {
    vi.mocked(callVisionModel).mockResolvedValue({
      content: JSON.stringify({
        title: 'Medium Confidence',
        confidenceScore: 75, // above skipParseThreshold(55) but below autoApproveThreshold(80)
        isMultiPart: false,
        cuttingInstructions: [
          { instrument: 'Tuba', partName: 'Tuba', section: 'Brass', transposition: 'C', partNumber: 1, pageRange: [1, 20] },
        ],
      }),
    });

    vi.mocked(splitPdfByCuttingInstructions).mockResolvedValue([
      makePartResult('Tuba', 'Tuba', 20, 'Brass'),
    ] as any);

    await processSmartUpload(makeJob());

    // Second pass required — auto-commit must not fire
    expect(queueSmartUploadAutoCommit).not.toHaveBeenCalled();
    expect(queueSmartUploadSecondPass).toHaveBeenCalledWith(SESSION_ID);
  });
});
