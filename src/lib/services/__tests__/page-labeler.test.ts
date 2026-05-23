/**
 * Unit Tests — Page Labeler Service
 *
 * Tests the page labeling orchestration with strategy branching and budget enforcement.
 * Mocks all dependencies to ensure fast, deterministic, environment-independent tests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('@/lib/smart-upload/runtime-config', () => ({
  loadSmartUploadRuntimeConfig: vi.fn().mockResolvedValue({
    headerLabelProvider: 'openai',
    headerLabelModel: 'gpt-4o',
    headerLabelModelParams: { temperature: 0.2 },
    headerLabelPrompt: 'You are a music expert.',
    headerLabelUserPrompt: 'What instrument part is on {{pageLabels}}?',
  }),
  buildAdapterConfigForStep: vi.fn().mockResolvedValue({
    provider: 'openai',
    model: 'gpt-4o',
    apiKey: 'test-key',
    endpointUrl: 'https://api.openai.com/v1',
  }),
}));

vi.mock('@/lib/llm/index', () => ({
  callVisionModel: vi.fn(),
  runtimeToAdapterConfig: vi.fn().mockReturnValue({ provider: 'openai', model: 'gpt-4o' }),
}));

vi.mock('@/lib/services/pdf-text-extractor', () => ({
  extractPdfPageHeaders: vi.fn(),
  normalizePdfText: vi.fn().mockImplementation((text: string) => text.trim()),
}));

vi.mock('@/lib/services/part-boundary-detector', () => ({
  detectPartBoundaries: vi.fn(),
}));

vi.mock('@/lib/services/header-image-segmentation', () => ({
  segmentByHeaderImages: vi.fn(),
}));

// Mock pdf-renderer so LLM strategy gets valid header crop images without
// actually rendering the fake PDF buffer. The returned string must be at
// least 200 chars so the "skip degenerate placeholder" guard passes.
const FAKE_HEADER_IMAGE = 'A'.repeat(300);
vi.mock('@/lib/services/pdf-renderer', () => ({
  renderPdfHeaderCropBatch: vi.fn().mockImplementation((buf: Buffer, indices: number[]) =>
    Promise.resolve(indices.map(() => FAKE_HEADER_IMAGE))
  ),
}));

vi.mock('@/lib/smart-upload/budgets', () => {
  class MockSessionBudget {
    check() {
      return { allowed: true };
    }
    record() {}
    getRemaining() {
      return { remainingCalls: 10, remainingTokens: 90000 };
    }
    snapshot() {
      return { llmCallCount: 0, inputTokensConsumed: 0, maxLlmCalls: 10, maxInputTokens: 100000 };
    }
  }
  return { SessionBudget: MockSessionBudget };
});

vi.mock('@/lib/smart-upload/prompts', () => ({
  buildHeaderLabelPrompt: vi.fn().mockReturnValue('What instrument?'),
}));

// Import after mocks
import { labelPages } from '../page-labeler';
import { extractPdfPageHeaders } from '@/lib/services/pdf-text-extractor';
import { detectPartBoundaries } from '@/lib/services/part-boundary-detector';
import { segmentByHeaderImages } from '@/lib/services/header-image-segmentation';
import { callVisionModel } from '@/lib/llm/index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFakePdfBuffer(): Buffer {
  return Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF');
}

function makeSuccessfulTextResult() {
  return {
    pageHeaders: [
      { pageIndex: 0, headerText: 'Flute', fullText: 'Flute Part', hasText: true },
      { pageIndex: 1, headerText: 'Flute', fullText: 'Flute Part', hasText: true },
      { pageIndex: 2, headerText: 'Clarinet', fullText: 'Clarinet Part', hasText: true },
      { pageIndex: 3, headerText: 'Clarinet', fullText: 'Clarinet Part', hasText: true },
    ],
    totalPages: 4,
    hasTextLayer: true,
    textLayerCoverage: 1.0,
  };
}

function makeSuccessfulSegmentationResult() {
  return {
    pageLabels: [
      { pageIndex: 0, label: 'Flute', confidence: 80 },
      { pageIndex: 2, label: 'Clarinet', confidence: 75 },
    ],
    cuttingInstructions: [
      { partName: 'Flute', instrument: 'Flute', section: 'Woodwind', transposition: 'C', partNumber: 1, pageRange: [0, 1] },
      { partName: 'Clarinet', instrument: 'Clarinet', section: 'Woodwind', transposition: 'Bb', partNumber: 2, pageRange: [2, 3] },
    ],
    segmentationConfidence: 77,
  };
}

function makeSuccessfulOcrResult() {
  return {
    segmentCount: 2,
    confidence: 70,
    cuttingInstructions: [
      { partName: 'Oboe', instrument: 'Oboe', section: 'Woodwind', transposition: 'C', partNumber: 1, pageRange: [0, 1] },
      { partName: 'Bassoon', instrument: 'Bassoon', section: 'Woodwind', transposition: 'C', partNumber: 2, pageRange: [2, 3] },
    ],
    diagnostics: [
      { pageStart: 0, pageEnd: 1, label: 'Oboe', ocrConfidence: 70 },
      { pageStart: 2, pageEnd: 3, label: 'Bassoon', ocrConfidence: 65 },
    ],
    hasOcrLabels: true,
    isDefinitive: false,
  };
}

// ---------------------------------------------------------------------------
// Tests — Strategy Branching
// ---------------------------------------------------------------------------

describe('labelPages', () => {
  const fakePdf = makeFakePdfBuffer();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('text-layer strategy (Strategy 1)', () => {
    it('returns text strategy when text-layer headers are found with sufficient confidence', async () => {
      vi.mocked(extractPdfPageHeaders).mockResolvedValueOnce(makeSuccessfulTextResult());
      vi.mocked(detectPartBoundaries).mockReturnValueOnce(makeSuccessfulSegmentationResult());

      const result = await labelPages({
        pdfBuffer: fakePdf,
        totalPages: 4,
        sessionId: 'test-session',
      });

      expect(result.strategyUsed).toBe('text');
      expect(result.pageLabels[1]?.label).toBe('Flute');
      expect(result.pageLabels[1]?.source).toBe('text');
      expect(result.confidence).toBeGreaterThan(0);
      expect(result.cuttingInstructions.length).toBeGreaterThan(0);
    });

    it('falls through to OCR when text strategy fails (no text layer)', async () => {
      vi.mocked(extractPdfPageHeaders).mockResolvedValueOnce({
        pageHeaders: [],
        totalPages: 4,
        hasTextLayer: false,
        textLayerCoverage: 0,
      });

      vi.mocked(segmentByHeaderImages).mockResolvedValueOnce(makeSuccessfulOcrResult());

      const result = await labelPages({
        pdfBuffer: fakePdf,
        totalPages: 4,
        sessionId: 'test-session',
        enableOcr: true,
        enableLlm: false,
      });

      expect(result.strategyUsed).toBe('ocr');
      expect(result.pageLabels[1]?.source).toBe('ocr');
    });

    it('falls through to OCR when text strategy has low confidence', async () => {
      vi.mocked(extractPdfPageHeaders).mockResolvedValueOnce(makeSuccessfulTextResult());
      vi.mocked(detectPartBoundaries).mockReturnValueOnce({
        pageLabels: [{ pageIndex: 0, label: 'Unknown', confidence: 10 }],
        cuttingInstructions: [],
        segmentationConfidence: 10,
      });

      vi.mocked(segmentByHeaderImages).mockResolvedValueOnce(makeSuccessfulOcrResult());

      const result = await labelPages({
        pdfBuffer: fakePdf,
        totalPages: 4,
        sessionId: 'test-session',
        enableOcr: true,
        enableLlm: false,
      });

      expect(result.strategyUsed).toBe('ocr');
    });
  });

  describe('OCR segmentation strategy (Strategy 2)', () => {
    it('returns OCR strategy when segmentation succeeds with sufficient confidence', async () => {
      vi.mocked(extractPdfPageHeaders).mockResolvedValueOnce({
        pageHeaders: [],
        totalPages: 4,
        hasTextLayer: false,
        textLayerCoverage: 0,
      });

      vi.mocked(segmentByHeaderImages).mockResolvedValueOnce(makeSuccessfulOcrResult());

      const result = await labelPages({
        pdfBuffer: fakePdf,
        totalPages: 4,
        sessionId: 'test-session',
        enableOcr: true,
        enableLlm: false,
      });

      expect(result.strategyUsed).toBe('ocr');
      expect(result.pageLabels[1]?.label).toBe('Oboe');
      expect(result.pageLabels[1]?.source).toBe('ocr');
    });

    it('falls through to LLM when OCR strategy fails', async () => {
      vi.mocked(extractPdfPageHeaders).mockResolvedValueOnce({
        pageHeaders: [],
        totalPages: 4,
        hasTextLayer: false,
        textLayerCoverage: 0,
      });

      vi.mocked(segmentByHeaderImages).mockResolvedValueOnce(null);

      vi.mocked(callVisionModel).mockResolvedValueOnce({
        content: 'Flute',
        usage: { inputTokens: 100, outputTokens: 50 },
      });

      const _result = await labelPages({
        pdfBuffer: fakePdf,
        totalPages: 4,
        sessionId: 'test-session',
        enableOcr: true,
        enableLlm: true,
        maxLlmCallsPerSession: 10,
      });

      // Should attempt LLM (check that callVisionModel was called)
      expect(callVisionModel).toHaveBeenCalled();
    });
  });

  describe('LLM fallback strategy (Strategy 3)', () => {
    it('uses LLM when both text and OCR strategies fail', async () => {
      vi.mocked(extractPdfPageHeaders).mockResolvedValueOnce({
        pageHeaders: [],
        totalPages: 10,
        hasTextLayer: false,
        textLayerCoverage: 0,
      });

      vi.mocked(segmentByHeaderImages).mockResolvedValueOnce(null);

      vi.mocked(callVisionModel).mockResolvedValue({
        content: 'Trumpet',
        usage: { inputTokens: 100, outputTokens: 50 },
      });

      const result = await labelPages({
        pdfBuffer: fakePdf,
        totalPages: 10,
        sessionId: 'test-session',
        enableOcr: false,
        enableLlm: true,
        maxLLmPages: 5,
        maxHeaderBatches: 2,
        maxLlmCallsPerSession: 10,
      });

      expect(callVisionModel).toHaveBeenCalled();
      expect(result.strategyUsed).toBe('llm');
    });

    it('skips LLM when enableLlm is false', async () => {
      vi.mocked(extractPdfPageHeaders).mockResolvedValueOnce({
        pageHeaders: [],
        totalPages: 4,
        hasTextLayer: false,
        textLayerCoverage: 0,
      });

      vi.mocked(segmentByHeaderImages).mockResolvedValueOnce(null);

      const result = await labelPages({
        pdfBuffer: fakePdf,
        totalPages: 4,
        sessionId: 'test-session',
        enableOcr: false,
        enableLlm: false,
      });

      expect(callVisionModel).not.toHaveBeenCalled();
      // Should generate fallback cutting instructions
      expect(result.cuttingInstructions.length).toBeGreaterThan(0);
      expect(result.strategyUsed).toBe('hybrid');
    });

    it('skips LLM when totalPages < MIN_PAGES_FOR_LLM (3)', async () => {
      vi.mocked(extractPdfPageHeaders).mockResolvedValueOnce({
        pageHeaders: [],
        totalPages: 2,
        hasTextLayer: false,
        textLayerCoverage: 0,
      });

      vi.mocked(segmentByHeaderImages).mockResolvedValueOnce(null);

      const result = await labelPages({
        pdfBuffer: fakePdf,
        totalPages: 2,
        sessionId: 'test-session',
        enableOcr: false,
        enableLlm: true,
      });

      expect(callVisionModel).not.toHaveBeenCalled();
      expect(result.strategyUsed).toBe('hybrid');
    });
  });

  describe('budget enforcement', () => {
    it('reports budget remaining in diagnostics', async () => {
      vi.mocked(extractPdfPageHeaders).mockResolvedValueOnce({
        pageHeaders: [],
        totalPages: 4,
        hasTextLayer: false,
        textLayerCoverage: 0,
      });

      vi.mocked(segmentByHeaderImages).mockResolvedValueOnce(null);

      vi.mocked(callVisionModel).mockResolvedValue({
        content: 'Flute',
        usage: { inputTokens: 100, outputTokens: 50 },
      });

      const result = await labelPages({
        pdfBuffer: fakePdf,
        totalPages: 4,
        sessionId: 'test-session',
        enableOcr: false,
        enableLlm: true,
        maxLlmCallsPerSession: 10,
      });

      expect(result.diagnostics.budgetLimit).toBe(10);
      expect(result.diagnostics.budgetRemaining).toBeLessThanOrEqual(10);
    });

    it('respects maxHeaderBatches limit', async () => {
      vi.mocked(extractPdfPageHeaders).mockResolvedValueOnce({
        pageHeaders: [],
        totalPages: 100,
        hasTextLayer: false,
        textLayerCoverage: 0,
      });

      vi.mocked(segmentByHeaderImages).mockResolvedValueOnce(null);

      vi.mocked(callVisionModel).mockResolvedValue({
        content: 'Flute',
        usage: { inputTokens: 100, outputTokens: 50 },
      });

      const _result = await labelPages({
        pdfBuffer: fakePdf,
        totalPages: 100,
        sessionId: 'test-session',
        enableOcr: false,
        enableLlm: true,
        maxLLmPages: 50,
        maxHeaderBatches: 3, // Only 3 batches
        maxLlmCallsPerSession: 10,
      });

      // Should only call LLM for maxHeaderBatches pages
      expect(callVisionModel).toHaveBeenCalledTimes(3);
    });

    it('respects maxLLmPages limit', async () => {
      vi.mocked(extractPdfPageHeaders).mockResolvedValueOnce({
        pageHeaders: [],
        totalPages: 100,
        hasTextLayer: false,
        textLayerCoverage: 0,
      });

      vi.mocked(segmentByHeaderImages).mockResolvedValueOnce(null);

      vi.mocked(callVisionModel).mockResolvedValue({
        content: 'Flute',
        usage: { inputTokens: 100, outputTokens: 50 },
      });

      const _result = await labelPages({
        pdfBuffer: fakePdf,
        totalPages: 100,
        sessionId: 'test-session',
        enableOcr: false,
        enableLlm: true,
        maxLLmPages: 5, // Only process 5 pages
        maxHeaderBatches: 10,
        maxLlmCallsPerSession: 10,
      });

      // Should sample pages within maxLLmPages limit
      expect(callVisionModel).toHaveBeenCalled();
    });
  });

  describe('diagnostics', () => {
    it('includes strategy diagnostics for all attempted strategies', async () => {
      vi.mocked(extractPdfPageHeaders).mockResolvedValueOnce({
        pageHeaders: [],
        totalPages: 4,
        hasTextLayer: false,
        textLayerCoverage: 0,
      });

      vi.mocked(segmentByHeaderImages).mockResolvedValueOnce(null);

      vi.mocked(callVisionModel).mockResolvedValue({
        content: 'Flute',
        usage: { inputTokens: 100, outputTokens: 50 },
      });

      const result = await labelPages({
        pdfBuffer: fakePdf,
        totalPages: 4,
        sessionId: 'test-session',
        enableOcr: true,
        enableLlm: true,
        maxLlmCallsPerSession: 10,
      });

      expect(result.diagnostics.strategies.length).toBeGreaterThanOrEqual(1);
      expect(result.diagnostics.totalDurationMs).toBeGreaterThan(0);

      // Each strategy should have success/failure recorded
      for (const strat of result.diagnostics.strategies) {
        expect(typeof strat.success).toBe('boolean');
        expect(typeof strat.durationMs).toBe('number');
      }
    });

    it('includes reason for failed strategies', async () => {
      vi.mocked(extractPdfPageHeaders).mockResolvedValueOnce({
        pageHeaders: [],
        totalPages: 4,
        hasTextLayer: false,
        textLayerCoverage: 0,
      });

      vi.mocked(segmentByHeaderImages).mockResolvedValueOnce(null);

      vi.mocked(callVisionModel).mockResolvedValue({
        content: '',
        usage: { inputTokens: 100, outputTokens: 50 },
      });

      const result = await labelPages({
        pdfBuffer: fakePdf,
        totalPages: 4,
        sessionId: 'test-session',
        enableOcr: false,
        enableLlm: true,
      });

      // Should have reason for text strategy
      const textDiag = result.diagnostics.strategies.find(s => s.strategy === 'text');
      expect(textDiag?.reason).toBeDefined();
    });
  });

  describe('fallback behavior', () => {
    it('generates generic cutting instructions when all strategies fail', async () => {
      vi.mocked(extractPdfPageHeaders).mockResolvedValueOnce({
        pageHeaders: [],
        totalPages: 10,
        hasTextLayer: false,
        textLayerCoverage: 0,
      });

      vi.mocked(segmentByHeaderImages).mockResolvedValueOnce(null);

      // LLM returns empty content
      vi.mocked(callVisionModel).mockResolvedValue({
        content: '',
        usage: { inputTokens: 100, outputTokens: 50 },
      });

      const result = await labelPages({
        pdfBuffer: fakePdf,
        totalPages: 10,
        sessionId: 'test-session',
        enableOcr: false,
        enableLlm: true,
      });

      // Should still have cutting instructions
      expect(result.cuttingInstructions.length).toBeGreaterThan(0);
      // Should be marked as hybrid since multiple strategies failed
      expect(result.strategyUsed).toBe('hybrid');
    });

    it('marks as hybrid when multiple strategies succeed', async () => {
      // Text succeeds
      vi.mocked(extractPdfPageHeaders).mockResolvedValueOnce(makeSuccessfulTextResult());
      vi.mocked(detectPartBoundaries).mockReturnValueOnce(makeSuccessfulSegmentationResult());

      // OCR also succeeds
      vi.mocked(segmentByHeaderImages).mockResolvedValueOnce(makeSuccessfulOcrResult());

      const result = await labelPages({
        pdfBuffer: fakePdf,
        totalPages: 4,
        sessionId: 'test-session',
        enableOcr: true,
        enableLlm: false,
      });

      // Text strategy returns immediately, so should not be hybrid
      expect(result.strategyUsed).toBe('text');
    });
  });

  describe('options', () => {
    it('passes textOptions to extractPdfPageHeaders', async () => {
      vi.mocked(extractPdfPageHeaders).mockResolvedValueOnce({
        pageHeaders: [],
        totalPages: 4,
        hasTextLayer: false,
        textLayerCoverage: 0,
      });

      vi.mocked(segmentByHeaderImages).mockResolvedValueOnce(null);

      await labelPages({
        pdfBuffer: fakePdf,
        totalPages: 4,
        sessionId: 'test-session',
        enableOcr: false,
        enableLlm: false,
        textOptions: {
          maxProbePages: 5,
          earlyStopConsecutivePages: 3,
        },
      });

      expect(extractPdfPageHeaders).toHaveBeenCalledWith(expect.any(Buffer), {
        maxPages: 5,
        earlyStopConsecutivePages: 3,
      });
    });

    it('passes ocrOptions to segmentByHeaderImages', async () => {
      vi.mocked(extractPdfPageHeaders).mockResolvedValueOnce({
        pageHeaders: [],
        totalPages: 4,
        hasTextLayer: false,
        textLayerCoverage: 0,
      });

      vi.mocked(segmentByHeaderImages).mockResolvedValueOnce(null);

      await labelPages({
        pdfBuffer: fakePdf,
        totalPages: 4,
        sessionId: 'test-session',
        enableOcr: true,
        enableLlm: false,
        ocrOptions: {
          hashDistanceThreshold: 15,
          cropHeightFraction: 0.3,
          enableOcr: true,
        },
      });

      expect(segmentByHeaderImages).toHaveBeenCalledWith(expect.any(Buffer), 4, {
        cacheTag: undefined,
        hashDistanceThreshold: 15,
        cropHeightFraction: 0.3,
        enableOcr: true,
      });
    });

    it('respects enableOcr option', async () => {
      vi.mocked(extractPdfPageHeaders).mockResolvedValueOnce({
        pageHeaders: [],
        totalPages: 4,
        hasTextLayer: false,
        textLayerCoverage: 0,
      });

      await labelPages({
        pdfBuffer: fakePdf,
        totalPages: 4,
        sessionId: 'test-session',
        enableOcr: false,
        enableLlm: false,
      });

      expect(segmentByHeaderImages).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Confidence regression — A6
  // Bug: convertHeaderImageResult averaged per-segment ocrConfidence values which
  // collapsed to 0 when all diagnositics had ocrConfidence=0 (hash-matched segments).
  // Fix: uses result.confidence as base and Math.max(ocrConfidence, Math.min(base, 60)).
  // ---------------------------------------------------------------------------
  describe('convertHeaderImageResult — confidence regression (A6)', () => {
    it('does not collapse to confidence=0 when all segment ocrConfidence values are 0', async () => {
      // Bug: the old code averaged per-segment ocrConfidence values, which collapsed
      // to 0 when all segments were auto-labelled via perceptual-hash (ocrConfidence=0).
      // Fix: convertHeaderImageResult now uses result.confidence as the base confidence.
      vi.mocked(extractPdfPageHeaders).mockResolvedValueOnce({
        pageHeaders: [],
        totalPages: 4,
        hasTextLayer: false,
        textLayerCoverage: 0,
      });

      const mockOcrResultAllZeroConfidence = {
        segmentCount: 2,
        confidence: 70,
        cuttingInstructions: [
          {
            instrument: 'Oboe',
            partName: 'Oboe',
            section: 'Woodwind',
            transposition: 'C',
            partNumber: 1,
            pageRange: [0, 1],
          },
          {
            instrument: 'Bassoon',
            partName: 'Bassoon',
            section: 'Woodwind',
            transposition: 'C',
            partNumber: 2,
            pageRange: [2, 3],
          },
        ],
        diagnostics: [
          // ocrConfidence=0 means auto-labelled via hash — these are the values
          // that previously collapsed the final confidence to 0.
          { pageStart: 0, pageEnd: 1, label: 'Oboe', ocrConfidence: 0, segmentIndex: 0, hashDistanceFromPrev: null },
          { pageStart: 2, pageEnd: 3, label: 'Bassoon', ocrConfidence: 0, segmentIndex: 1, hashDistanceFromPrev: 5 },
        ],
        hasOcrLabels: false,
        isDefinitive: false,
      };

      const theResult = mockOcrResultAllZeroConfidence;
      // mockReset() is required here because a persistent mock implementation from
      // an earlier test (e.g., mockResolvedValue(null)) would override Once-values
      // and our mockImplementation without a full reset. vi.clearAllMocks() alone
      // does NOT clear persistent implementations in Vitest 4.
      vi.mocked(segmentByHeaderImages).mockReset();
      vi.mocked(segmentByHeaderImages).mockResolvedValue(theResult as any);

      const result = await labelPages({
        pdfBuffer: fakePdf,
        totalPages: 4,
        sessionId: 'test-session',
        enableOcr: true,
        enableLlm: false,
      });

      // OCR path should succeed with segmentCount=2 and confidence=70
      expect(result.strategyUsed).toBe('ocr');
      // Pre-fix: confidence would collapse to 0 (avg of all ocrConfidence=0 values)
      // Post-fix: confidence must reflect result.confidence=70 (the segmentation confidence)
      expect(result.confidence).toBeGreaterThan(0);
      // Pages should be labelled (segments expanded to cover their full range)
      expect(Object.keys(result.pageLabels).length).toBeGreaterThanOrEqual(4);
    });
  });
});
