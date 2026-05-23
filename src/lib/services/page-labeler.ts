/**
 * Page Labeler Service
 *
 * Orchestrates page labeling strategies for music PDF segmentation:
 * 1. Text-layer headers (extractPdfPageHeaders + detectPartBoundaries)
 * 2. OCR segmentation (segmentByHeaderImages)
 * 3. LLM header-label fallback (last resort with budget limits)
 *
 * Production-grade goals:
 * - Never log raw OCR text or PDF bytes
 * - Strict budget enforcement for LLM calls
 * - Deterministic strategy selection based on prior results
 * - Comprehensive diagnostics without exposing sensitive content
 */

import { logger } from '@/lib/logger';
import { buildAdapterConfigForStep, loadSmartUploadRuntimeConfig } from '@/lib/smart-upload/runtime-config';
import { SessionBudget } from '@/lib/smart-upload/budgets';
import { parseJsonLenient } from '@/lib/smart-upload/json';
import { buildHeaderLabelPrompt } from '@/lib/smart-upload/prompts';
import { extractPdfPageHeaders, normalizePdfText } from '@/lib/services/pdf-text-extractor';
import { detectPartBoundaries, type SegmentationResult } from '@/lib/services/part-boundary-detector';
import { segmentByHeaderImages, type HeaderImageSegmentationResult } from '@/lib/services/header-image-segmentation';
import { renderPdfHeaderCropBatch } from '@/lib/services/pdf-renderer';
import { callVisionModel, runtimeToAdapterConfig } from '@/lib/llm/index';
import { type CuttingInstruction } from '@/lib/services/cutting-instructions';

// =============================================================================
// Types
// =============================================================================

/** Source of page label */
export type PageLabelSource = 'text' | 'ocr' | 'llm';

/** Single page label */
export interface PageLabel {
  /** Label for the page (instrument/part name) */
  label: string;
  /** Confidence score 0-100 */
  confidence: number;
  /** Source of the label */
  source: PageLabelSource;
}

/** Strategy used for labeling */
export type LabelingStrategy = 'text' | 'ocr' | 'llm' | 'hybrid';

/** Diagnostic info for a strategy */
export interface StrategyDiagnostic {
  strategy: LabelingStrategy;
  durationMs: number;
  success: boolean;
  pagesProcessed: number;
  labelsExtracted: number;
  /** Reason if strategy failed or was skipped */
  reason?: string;
}

/** Result from page labeling */
export interface PageLabelerResult {
  /** Cutting instructions derived from labels */
  cuttingInstructions: CuttingInstruction[];
  /** Labels keyed by 1-indexed page number */
  pageLabels: Record<number, PageLabel>;
  /** Aggregate confidence score 0-100 */
  confidence: number;
  /** Primary strategy used */
  strategyUsed: LabelingStrategy;
  /** Detailed diagnostics */
  diagnostics: {
    strategies: StrategyDiagnostic[];
    totalDurationMs: number;
    budgetRemaining: number;
    budgetLimit: number;
  };
}

/** Options for page labeling */
export interface PageLabelerOptions {
  /** PDF buffer to process */
  pdfBuffer: Buffer;
  /** Total pages in PDF */
  totalPages: number;
  /** Session ID for budget tracking */
  sessionId: string;
  /** Override max pages for LLM (default from config) */
  maxLLmPages?: number;
  /** Override max header batches for LLM */
  maxHeaderBatches?: number;
  /** Override max LLM calls per session */
  maxLlmCallsPerSession?: number;
  /** Cache tag for PDF rendering */
  cacheTag?: string;
  /** Enable OCR fallback (default: true) */
  enableOcr?: boolean;
  /** Enable LLM fallback (default: true) */
  enableLlm?: boolean;
  /** Text layer options */
  textOptions?: {
    /** Max pages to probe for text */
    maxProbePages?: number;
    /** Early stop consecutive pages */
    earlyStopConsecutivePages?: number;
  };
  /** OCR segmentation options */
  ocrOptions?: {
    /** Hash distance threshold */
    hashDistanceThreshold?: number;
    /** Crop height fraction */
    cropHeightFraction?: number;
    /** Enable OCR on segments */
    enableOcr?: boolean;
  };
  /**
   * Authoritative text-layer segmentation from upstream processor.
   * When provided with adequate confidence, page-labeler must not override it
   * with weaker probe strategies.
   */
  authoritativeTextSegmentation?: SegmentationResult;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_MAX_LLM_PAGES = 20;
const DEFAULT_MAX_HEADER_BATCHES = 5;
const DEFAULT_MAX_LLM_CALLS = 10;
const MIN_PAGES_FOR_LLM = 3;
const MIN_RENDERED_HEADER_BASE64_CHARS = 200;

/** Minimum confidence to consider a strategy successful */
const MIN_STRATEGY_CONFIDENCE = 30;

/** Minimum labels needed to consider text-layer strategy successful */
const MIN_TEXT_LABELS = 2;

// =============================================================================
// Helper Functions
// =============================================================================

function nowMs(): number {
  const perf = (globalThis as { performance?: { now(): number } }).performance;
  if (perf?.now) return perf.now();
  return Date.now();
}

function elapsedMs(startMs: number): number {
  return Math.max(1, Math.round(nowMs() - startMs));
}

function parseSinglePageLabelResponse(content: string): string {
  const arrayResult = parseJsonLenient<Array<Record<string, unknown>>>(content, 'array');
  if (arrayResult.ok) {
    const first = arrayResult.value[0];
    const label = typeof first?.label === 'string' ? first.label.trim() : '';
    if (label) return normalizePdfText(label);
    return '';
  }

  const objectResult = parseJsonLenient<Record<string, unknown>>(content, 'object');
  if (objectResult.ok) {
    const label = typeof objectResult.value.label === 'string'
      ? objectResult.value.label.trim()
      : '';
    if (label) return normalizePdfText(label);
  }

  return normalizePdfText(content);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function convertSegmentationResult(
  result: SegmentationResult,
  source: PageLabelSource,
): { pageLabels: Record<number, PageLabel>; cuttingInstructions: CuttingInstruction[]; confidence: number } {
  const pageLabels: Record<number, PageLabel> = {};
  const confidenceValues: number[] = [];

  for (const pageLabel of result.pageLabels) {
    const pageNum = pageLabel.pageIndex + 1; // Convert to 1-indexed
    pageLabels[pageNum] = {
      label: pageLabel.label || 'Unknown',
      confidence: clampConfidence(pageLabel.confidence),
      source,
    };
    confidenceValues.push(clampConfidence(pageLabel.confidence));
  }

  const avgConfidence = confidenceValues.length > 0
    ? Math.round(confidenceValues.reduce((a, b) => a + b, 0) / confidenceValues.length)
    : 0;

  return {
    pageLabels,
    cuttingInstructions: result.cuttingInstructions,
    confidence: avgConfidence,
  };
}

function convertHeaderImageResult(
  result: HeaderImageSegmentationResult,
  source: PageLabelSource,
): { pageLabels: Record<number, PageLabel>; cuttingInstructions: CuttingInstruction[]; confidence: number } {
  const pageLabels: Record<number, PageLabel> = {};

  // Use result.confidence as the authoritative segmentation quality score.
  // diag.ocrConfidence reflects per-segment text recognition quality — it may be 0
  // for auto-labeled segments (e.g., "Part 1") even when the perceptual-hash
  // boundary detection was highly reliable. Averaging those zeros collapses the
  // overall confidence to 0, which is incorrect.
  const baseConfidence = clampConfidence(result.confidence);

  for (const diag of result.diagnostics) {
    const perPageConfidence = diag.ocrConfidence > 0
      ? Math.max(clampConfidence(diag.ocrConfidence), Math.min(baseConfidence, 60))
      : Math.max(baseConfidence, 40);

    // Expand labels to cover every page in the segment.
    for (let page0 = diag.pageStart; page0 <= diag.pageEnd; page0++) {
      const pageNum = page0 + 1; // 0-indexed → 1-indexed
      pageLabels[pageNum] = {
        label: diag.label || 'Unknown',
        confidence: clampConfidence(perPageConfidence),
        source,
      };
    }
  }

  return {
    pageLabels,
    cuttingInstructions: result.cuttingInstructions,
    confidence: baseConfidence,
  };
}

function buildFallbackCuttingInstructions(
  pageLabels: Record<number, PageLabel>,
  totalPages: number,
): CuttingInstruction[] {
  const safeTotalPages = Math.max(0, totalPages);

  const sortedPages = Object.keys(pageLabels)
    .map(Number)
    .filter((pageNum) => Number.isFinite(pageNum))
    .sort((a, b) => a - b);

  if (sortedPages.length === 0) {
    return [{
      partName: 'Full Score',
      instrument: 'Full Score',
      section: 'Other',
      transposition: 'C',
      partNumber: 1,
      pageRange: [0, Math.max(0, safeTotalPages - 1)],
    }];
  }

  const segments: Array<{ start: number; end: number; label: string }> = [];
  let currentStart = sortedPages[0];
  let currentLabel = pageLabels[sortedPages[0]].label;

  for (let i = 1; i <= sortedPages.length; i++) {
    const pageNum = sortedPages[i];
    const nextLabel = pageNum ? pageLabels[pageNum].label : null;

    if (i === sortedPages.length || nextLabel !== currentLabel) {
      segments.push({
        start: currentStart - 1, // Convert to 0-indexed
        end: (i === sortedPages.length ? safeTotalPages : sortedPages[i - 1]) - 1,
        label: currentLabel,
      });

      if (i < sortedPages.length) {
        currentStart = sortedPages[i];
        currentLabel = pageLabels[sortedPages[i]].label;
      }
    }
  }

  return segments.map((segment, index) => ({
    partName: segment.label,
    instrument: segment.label,
    section: 'Other' as const,
    transposition: 'C' as const,
    partNumber: index + 1,
    pageRange: [segment.start, segment.end] as [number, number],
  }));
}

function buildResult(params: {
  cuttingInstructions: CuttingInstruction[];
  pageLabels: Record<number, PageLabel>;
  confidence: number;
  strategyUsed: LabelingStrategy;
  diagnostics: StrategyDiagnostic[];
  totalDurationMs: number;
  budgetRemaining: number;
  budgetLimit: number;
}): PageLabelerResult {
  return {
    cuttingInstructions: params.cuttingInstructions,
    pageLabels: params.pageLabels,
    confidence: params.confidence,
    strategyUsed: params.strategyUsed,
    diagnostics: {
      strategies: params.diagnostics,
      totalDurationMs: Math.max(1, params.totalDurationMs),
      budgetRemaining: params.budgetRemaining,
      budgetLimit: params.budgetLimit,
    },
  };
}

// =============================================================================
// Main Function
// =============================================================================

/**
 * Orchestrate page labeling using multiple strategies.
 *
 * Strategy order:
 * 1. Text-layer headers (extractPdfPageHeaders + detectPartBoundaries)
 * 2. OCR segmentation (segmentByHeaderImages)
 * 3. LLM header-label fallback (budget-limited)
 *
 * @param options - Labeling options
 * @returns Page labeling result with cutting instructions
 */
export async function labelPages(options: PageLabelerOptions): Promise<PageLabelerResult> {
  const startMs = nowMs();
  const {
    pdfBuffer,
    totalPages,
    sessionId,
    maxLLmPages = DEFAULT_MAX_LLM_PAGES,
    maxHeaderBatches = DEFAULT_MAX_HEADER_BATCHES,
    maxLlmCallsPerSession = DEFAULT_MAX_LLM_CALLS,
    cacheTag,
    enableOcr = true,
    enableLlm = true,
    textOptions,
    ocrOptions,
    authoritativeTextSegmentation,
  } = options;

  const diagnostics: StrategyDiagnostic[] = [];

  if (
    authoritativeTextSegmentation &&
    authoritativeTextSegmentation.segmentationConfidence >= MIN_STRATEGY_CONFIDENCE &&
    authoritativeTextSegmentation.cuttingInstructions.length > 0
  ) {
    const authoritative = convertSegmentationResult(authoritativeTextSegmentation, 'text');

    diagnostics.push({
      strategy: 'text',
      durationMs: 1,
      success: true,
      pagesProcessed: authoritativeTextSegmentation.pageLabels.length,
      labelsExtracted: Object.keys(authoritative.pageLabels).length,
      reason: 'used upstream authoritative segmentation',
    });

    return buildResult({
      cuttingInstructions: authoritative.cuttingInstructions,
      pageLabels: authoritative.pageLabels,
      confidence: clampConfidence(authoritativeTextSegmentation.segmentationConfidence),
      strategyUsed: 'text',
      diagnostics,
      totalDurationMs: elapsedMs(startMs),
      budgetRemaining: maxLlmCallsPerSession,
      budgetLimit: maxLlmCallsPerSession,
    });
  }

  const budget = new SessionBudget(sessionId, {
    maxLlmCalls: maxLlmCallsPerSession,
    maxInputTokens: 100000,
    maxOutputTokens: 10000,
  });

  logger.info('page-labeler: starting orchestration', {
    totalPages,
    sessionId,
    enableOcr,
    enableLlm,
    maxLLmPages,
    maxHeaderBatches,
    maxLlmCallsPerSession,
  });

  // Strategy 1: Text-layer headers
  const textStartMs = nowMs();
  let textResult: SegmentationResult | null = null;
  let textSuccess = false;
  let textReason: string | undefined;

  try {
    const maxProbe = textOptions?.maxProbePages ?? Math.min(totalPages, 10);
    const earlyStop = textOptions?.earlyStopConsecutivePages;

    const extractionResult = await extractPdfPageHeaders(pdfBuffer, {
      maxPages: maxProbe,
      earlyStopConsecutivePages: earlyStop,
    });

    if (extractionResult.hasTextLayer && extractionResult.pageHeaders.length > 0) {
      textResult = detectPartBoundaries(
        extractionResult.pageHeaders,
        extractionResult.totalPages,
        true,
      );

      const labelsCount = textResult.pageLabels.filter((pageLabel) => Boolean(pageLabel.label)).length;
      if (labelsCount >= MIN_TEXT_LABELS && textResult.segmentationConfidence >= MIN_STRATEGY_CONFIDENCE) {
        textSuccess = true;
      } else {
        textReason = `insufficient labels (${labelsCount}) or low confidence (${textResult.segmentationConfidence})`;
      }
    } else {
      textReason = 'no text layer detected';
    }
  } catch (error) {
    textReason = `error: ${asError(error).message}`;
    logger.warn('page-labeler: text-layer strategy failed', {
      reason: textReason,
    });
  }

  diagnostics.push({
    strategy: 'text',
    durationMs: elapsedMs(textStartMs),
    success: textSuccess,
    pagesProcessed: textResult?.pageLabels.length || 0,
    labelsExtracted: textResult?.pageLabels.filter((pageLabel) => Boolean(pageLabel.label)).length || 0,
    reason: textReason,
  });

  if (textSuccess && textResult) {
    const { pageLabels, cuttingInstructions, confidence } = convertSegmentationResult(textResult, 'text');

    logger.info('page-labeler: text strategy succeeded', {
      labelsExtracted: Object.keys(pageLabels).length,
      confidence,
      durationMs: elapsedMs(startMs),
    });

    return buildResult({
      cuttingInstructions,
      pageLabels,
      confidence,
      strategyUsed: 'text',
      diagnostics,
      totalDurationMs: elapsedMs(startMs),
      budgetRemaining: maxLlmCallsPerSession,
      budgetLimit: maxLlmCallsPerSession,
    });
  }

  // Strategy 2: OCR segmentation
  const ocrStartMs = nowMs();
  let ocrResult: HeaderImageSegmentationResult | null = null;
  let ocrSuccess = false;
  let ocrReason: string | undefined;

  if (enableOcr) {
    try {
      ocrResult = await segmentByHeaderImages(pdfBuffer, totalPages, {
        cacheTag,
        hashDistanceThreshold: ocrOptions?.hashDistanceThreshold,
        cropHeightFraction: ocrOptions?.cropHeightFraction,
        enableOcr: ocrOptions?.enableOcr !== false,
      });

      if (ocrResult && ocrResult.segmentCount > 1 && ocrResult.confidence >= MIN_STRATEGY_CONFIDENCE) {
        ocrSuccess = true;
      } else if (!ocrResult) {
        ocrReason = 'no boundaries detected';
      } else {
        ocrReason = `low confidence (${ocrResult.confidence}) or single segment`;
      }
    } catch (error) {
      ocrReason = `error: ${asError(error).message}`;
      logger.warn('page-labeler: OCR strategy failed', {
        reason: ocrReason,
      });
    }
  } else {
    ocrReason = 'OCR disabled';
  }

  diagnostics.push({
    strategy: 'ocr',
    durationMs: elapsedMs(ocrStartMs),
    success: ocrSuccess,
    pagesProcessed: ocrResult?.segmentCount || 0,
    labelsExtracted: ocrResult?.diagnostics.filter((diag) => Boolean(diag.label)).length || 0,
    reason: ocrReason,
  });

  if (ocrSuccess && ocrResult) {
    const { pageLabels, cuttingInstructions, confidence } = convertHeaderImageResult(ocrResult, 'ocr');

    logger.info('page-labeler: OCR strategy succeeded', {
      labelsExtracted: Object.keys(pageLabels).length,
      confidence,
      durationMs: elapsedMs(startMs),
    });

    return buildResult({
      cuttingInstructions,
      pageLabels,
      confidence,
      strategyUsed: 'ocr',
      diagnostics,
      totalDurationMs: elapsedMs(startMs),
      budgetRemaining: maxLlmCallsPerSession,
      budgetLimit: maxLlmCallsPerSession,
    });
  }

  // Strategy 3: LLM fallback
  const llmStartMs = nowMs();
  let llmSuccess = false;
  let llmReason: string | undefined;
  const llmPageLabels: Record<number, PageLabel> = {};

  if (!enableLlm) {
    llmReason = 'LLM disabled';
  } else if (totalPages < MIN_PAGES_FOR_LLM) {
    llmReason = `too few pages (${totalPages}) for LLM fallback`;
  } else if (!budget.check().allowed) {
    llmReason = 'budget exhausted';
  } else {
    try {
      const llmConfig = await loadSmartUploadRuntimeConfig();
      const headerLabelStepConfig = await buildAdapterConfigForStep(llmConfig, 'header-label');
      const adapterConfig = {
        ...runtimeToAdapterConfig(llmConfig),
        llm_provider: headerLabelStepConfig.provider,
        llm_endpoint_url: headerLabelStepConfig.endpointUrl,
        llm_vision_model: headerLabelStepConfig.model,
      };

      const maxPagesToProcess = Math.min(totalPages, maxLLmPages);
      const pagesToLabel: number[] = [];

      const step = Math.max(1, Math.floor(maxPagesToProcess / maxHeaderBatches));
      for (let i = 0; i < maxPagesToProcess && pagesToLabel.length < maxHeaderBatches; i += step) {
        pagesToLabel.push(i + 1);
      }

      const pageIndices0 = pagesToLabel.map((pageNum) => pageNum - 1);
      let headerCrops: string[] = new Array(pagesToLabel.length).fill('');

      try {
        headerCrops = await renderPdfHeaderCropBatch(pdfBuffer, pageIndices0, {
          scale: 2,
          maxWidth: 768,
          quality: 85,
          format: 'png',
          cropHeightFraction: 0.2,
          cacheTag,
        });
      } catch (renderErr) {
        logger.warn('page-labeler: header crop render failed; LLM fallback will be skipped', {
          error: renderErr instanceof Error ? renderErr.message : String(renderErr),
        });
      }

      for (let i = 0; i < pagesToLabel.length; i++) {
        const pageNum = pagesToLabel[i];
        const imageBase64 = headerCrops[i] || '';

        if (!budget.check().allowed) {
          llmReason = 'budget exhausted during processing';
          break;
        }

        if (imageBase64.length < MIN_RENDERED_HEADER_BASE64_CHARS) {
          logger.warn('page-labeler: skipping LLM call — header crop render unavailable', { pageNum });
          continue;
        }

        const prompt = buildHeaderLabelPrompt(
          llmConfig.headerLabelUserPrompt || '',
          { pageNumbers: [pageNum] },
        );

        const response = await callVisionModel(
          adapterConfig,
          [{ mimeType: 'image/png', base64Data: imageBase64, label: `Page ${pageNum} header` }],
          prompt,
          {
            system: headerLabelStepConfig.systemPrompt || llmConfig.headerLabelPrompt,
            responseFormat: { type: 'json' },
            modelParams: headerLabelStepConfig.modelParams,
            maxTokens: 500,
          },
        );

        budget.record(
          (response as { usage?: { inputTokens?: number; promptTokens?: number } })?.usage?.inputTokens
          ?? (response as { usage?: { inputTokens?: number; promptTokens?: number } })?.usage?.promptTokens
          ?? 1000,
        );

        const normalizedLabel = parseSinglePageLabelResponse(response.content || '');

        if (normalizedLabel && normalizedLabel.length > 0) {
          llmPageLabels[pageNum] = {
            label: normalizedLabel.slice(0, 100),
            confidence: 50,
            source: 'llm',
          };
        }
      }

      const labelsCount = Object.keys(llmPageLabels).length;
      if (labelsCount >= MIN_TEXT_LABELS) {
        llmSuccess = true;
      } else {
        llmReason = `insufficient labels extracted (${labelsCount})`;
      }
    } catch (error) {
      llmReason = `error: ${asError(error).message}`;
      logger.warn('page-labeler: LLM strategy failed', {
        reason: llmReason,
      });
    }
  }

  diagnostics.push({
    strategy: 'llm',
    durationMs: elapsedMs(llmStartMs),
    success: llmSuccess,
    pagesProcessed: Object.keys(llmPageLabels).length,
    labelsExtracted: Object.keys(llmPageLabels).length,
    reason: llmReason,
  });

  // Determine final result.
  // Repo contract:
  // - first successful strategy returns early above
  // - here we only select best-effort leftovers
  // - generic fallback remains "hybrid"
  let finalPageLabels: Record<number, PageLabel>;
  let finalStrategy: LabelingStrategy;
  let finalConfidence: number;

  if (textResult) {
    const { pageLabels, confidence } = convertSegmentationResult(textResult, 'text');
    finalPageLabels = pageLabels;
    finalStrategy = 'text';
    finalConfidence = confidence;
  } else if (ocrResult) {
    const { pageLabels, confidence } = convertHeaderImageResult(ocrResult, 'ocr');
    finalPageLabels = pageLabels;
    finalStrategy = 'ocr';
    finalConfidence = confidence;
  } else if (llmSuccess && Object.keys(llmPageLabels).length > 0) {
    finalPageLabels = llmPageLabels;
    finalStrategy = 'llm';
    finalConfidence = 50;
  } else {
    finalPageLabels = {};
    finalStrategy = 'hybrid';
    finalConfidence = 0;
  }

  const cuttingInstructions = buildFallbackCuttingInstructions(finalPageLabels, totalPages);

  logger.info('page-labeler: orchestration complete', {
    strategyUsed: finalStrategy,
    labelsExtracted: Object.keys(finalPageLabels).length,
    confidence: finalConfidence,
    cuttingInstructionsCount: cuttingInstructions.length,
    durationMs: elapsedMs(startMs),
  });

  return buildResult({
    cuttingInstructions,
    pageLabels: finalPageLabels,
    confidence: finalConfidence,
    strategyUsed: finalStrategy,
    diagnostics,
    totalDurationMs: elapsedMs(startMs),
    budgetRemaining: budget.getRemaining().remainingCalls,
    budgetLimit: maxLlmCallsPerSession,
  });
}
