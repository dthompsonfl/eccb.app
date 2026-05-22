/**
 * Smart Upload Processor Worker
 *
 * Handles the main Smart Upload pipeline with OCR-first architecture:
 *
 * 1. Download PDF
 * 2. Extract text layer → deterministic part-boundary detection
 * 3. If deterministic segmentation confidence ≥ threshold:
 *    → OCR-first path: extract title/composer from text layer + filename
 *    → Skip LLM entirely (zero API calls, zero cost)
 * 4. Otherwise, fall back to LLM:
 *    → Send entire PDF (or rendered images) for AI analysis
 * 5. Validate cutting instructions
 * 6. Split PDF into parts
 * 7. Quality gates for auto-commit eligibility
 * 8. Route: auto-commit, second-pass, or human review
 */

import { Job } from 'bullmq';
import { prisma } from '@/lib/db';
import { downloadFile, uploadFile } from '@/lib/services/storage';
import { renderPdfHeaderCropBatch, renderPdfPageBatch, clearRenderCache } from '@/lib/services/pdf-renderer';
import { callVisionModel } from '@/lib/llm';
import { virusScanner } from '@/lib/services/virus-scanner';
import {
  loadSmartUploadRuntimeConfig,
  runtimeToAdapterConfig,
  buildAdapterConfigForStep,
  type LLMRuntimeConfig,
} from '@/lib/llm/config-loader';
import {
  toOneIndexed,
  validateAndNormalizeInstructions,
  buildGapInstructions,
  sanitizeCuttingInstructionsForSplit,
} from '@/lib/services/cutting-instructions';
import { splitPdfByCuttingInstructions, validatePdfBuffer } from '@/lib/services/pdf-splitter';
import { getPdfSourceInfo } from '@/lib/services/pdf-source';
import { extractPdfPageHeaders } from '@/lib/services/pdf-text-extractor';
import { detectPartBoundaries, type SegmentationResult } from '@/lib/services/part-boundary-detector';
import { extractOcrFallbackMetadata } from '@/lib/services/ocr-fallback';
import { segmentByHeaderImages } from '@/lib/services/header-image-segmentation';
import { labelPages, type PageLabelerResult } from '@/lib/services/page-labeler';
import {
  queueSmartUploadSecondPass,
  queueSmartUploadAutoCommit,
  SmartUploadJobProgress,
} from '@/lib/jobs/smart-upload';
import { buildPartFilename, buildPartStorageSlug, normalizeInstrumentLabel } from '@/lib/smart-upload/part-naming';
import { evaluateQualityGates, isForbiddenLabel } from '@/lib/smart-upload/quality-gates';
import { parseJsonLenient } from '@/lib/smart-upload/json';
import { createSessionBudget } from '@/lib/smart-upload/budgets';
import { determineRoute, DEFAULT_THRESHOLDS } from '@/lib/smart-upload/fallback-policy';
import type { RoutingSignals, PolicyThresholds } from '@/lib/smart-upload/fallback-policy';
import { buildLlmCacheKey, getCachedLlmResponse, setCachedLlmResponse } from '@/lib/smart-upload/llm-cache';
import type { VisionResponse, LabeledDocument } from '@/lib/llm/types';
import { getProviderMeta } from '@/lib/llm/providers';
import { logger } from '@/lib/logger';
import { serializeSmartUploadJsonField } from '@/lib/smart-upload/persistence';
import {
  buildHeaderLabelPrompt,
  buildPdfVisionPrompt,
  buildVisionMetadataPrompt,
  DEFAULT_HEADER_LABEL_SYSTEM_PROMPT,
  DEFAULT_PDF_VISION_USER_PROMPT_TEMPLATE,
  DEFAULT_VISION_METADATA_ONLY_USER_PROMPT_TEMPLATE,
  DEFAULT_VISION_SYSTEM_PROMPT,
  PROMPT_VERSION,
} from '@/lib/smart-upload/prompts';
import { chooseBestCuttingInstructions } from '@/lib/smart-upload/cutting-instruction-selection';
import type {
  CuttingInstruction,
  ExtractedMetadata,
  ParsedPartRecord,
  RoutingDecision,
  SecondPassStatus,
} from '@/types/smart-upload';
import type { SmartUploadProcessData } from '@/lib/jobs/smart-upload';

// =============================================================================
// Constants
// =============================================================================

const MAX_SAMPLED_PAGES = 8;
const MAX_HEADER_CROP_BATCH_SIZE = 30;

// =============================================================================
// Helper Functions
// =============================================================================

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

function safeErrorDetails(err: unknown) {
  const error = asError(err);
  return {
    errorMessage: error.message,
    errorName: error.name,
    errorStack: error.stack,
  };
}

function normalizeConfidence(value: unknown): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return 0;
  if (value > 0 && value < 1) {
    return Math.round(value * 100);
  }
  return Math.max(0, Math.min(100, Math.round(value)));
}

function isBudgetExhaustedError(err: unknown): boolean {
  return asError(err).message.toLowerCase().includes('budget exhausted');
}

/**
 * Select representative pages from a PDF for LLM analysis.
 * - Always includes the first 2 pages (cover + first music page)
 * - For docs > MAX_SAMPLED_PAGES pages: samples evenly, always includes the last page
 */
async function samplePdfPages(
  pdfBuffer: Buffer,
  cacheTag?: string,
): Promise<{ images: string[]; totalPages: number; sampledIndices: number[] }> {
  const totalPages = (await getPdfSourceInfo(pdfBuffer)).pageCount;

  if (totalPages <= 0) {
    throw new Error('Unable to sample PDF pages: authoritative page count unavailable');
  }

  let indices: number[];
  if (totalPages <= MAX_SAMPLED_PAGES) {
    indices = Array.from({ length: totalPages }, (_, i) => i);
  } else {
    const fixed = [0, 1, totalPages - 1];
    const remaining = MAX_SAMPLED_PAGES - fixed.length;
    const step = Math.floor((totalPages - 3) / (remaining + 1));
    const interior: number[] = [];

    for (let i = 1; i <= remaining; i++) {
      const idx = 1 + i * step;
      if (idx < totalPages - 1) interior.push(idx);
    }

    indices = [...new Set([...fixed, ...interior])].sort((a, b) => a - b);
  }

  const images = await renderPdfPageBatch(pdfBuffer, indices, {
    scale: 2,
    maxWidth: 1024,
    quality: 85,
    format: 'png',
    cacheTag,
  });

  logger.info('PDF pages sampled for LLM', {
    totalPages,
    sampledCount: images.length,
    indices,
  });

  return { images, totalPages, sampledIndices: indices };
}

interface HeaderLabelEntry {
  page: number;
  label: string | null;
  confidence: number;
}

function parseHeaderLabelResponse(content: string): HeaderLabelEntry[] {
  const result = parseJsonLenient<unknown[]>(content, 'array');
  if (!result.ok) {
    logger.warn('parseHeaderLabelResponse: JSON extraction failed', {
      error: result.error,
    });
    return [];
  }

  return (result.value as unknown[])
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const value = entry as Record<string, unknown>;
      const page = Number(value.page);
      const confidence = Number(value.confidence);
      const rawLabel =
        typeof value.label === 'string' && value.label.trim().length > 0
          ? value.label.trim()
          : null;
      const label = rawLabel && !isForbiddenLabel(rawLabel) ? rawLabel : null;

      if (!Number.isFinite(page) || !Number.isInteger(page) || page < 1) {
        return null;
      }

      return {
        page,
        label,
        confidence: Number.isFinite(confidence)
          ? Math.max(0, Math.min(100, Math.round(confidence)))
          : 0,
      };
    })
    .filter((entry): entry is HeaderLabelEntry => entry !== null);
}

function toOneIndexedInstructions(instructions: CuttingInstruction[]): CuttingInstruction[] {
  return instructions.map((instruction) => ({
    ...instruction,
    pageRange: toOneIndexed(instruction.pageRange),
  }));
}

function parseVisionResponse(content: string, totalPages: number): ExtractedMetadata {
  const result = parseJsonLenient<Record<string, unknown>>(content, 'object');
  if (!result.ok) {
    logger.error('parseVisionResponse: JSON extraction failed', {
      error: result.error,
    });
    return buildFallbackMetadata(totalPages);
  }

  const parsed = result.value;

  const title =
    typeof parsed.title === 'string' && parsed.title.trim()
      ? parsed.title.trim()
      : 'Unknown Title';

  const confidenceScore = normalizeConfidence(parsed.confidenceScore);
  const isMultiPart = parsed.isMultiPart === true;

  const rawParts = Array.isArray(parsed.parts) ? parsed.parts : [];
  const parts = rawParts.map((partValue: unknown, index: number) => {
    const part = (partValue ?? {}) as Record<string, unknown>;
    return {
      instrument:
        typeof part.instrument === 'string' ? part.instrument.trim() : `Unknown Part ${index + 1}`,
      partName: typeof part.partName === 'string' ? part.partName.trim() : `Part ${index + 1}`,
      section: typeof part.section === 'string' ? part.section : 'Other',
      transposition: typeof part.transposition === 'string' ? part.transposition : 'C',
      partNumber: typeof part.partNumber === 'number' ? part.partNumber : index + 1,
    };
  });

  const rawCuts = Array.isArray(parsed.cuttingInstructions) ? parsed.cuttingInstructions : [];
  const cuttingInstructions = rawCuts
    .map((cutValue: unknown) => {
      const cut = (cutValue ?? {}) as Record<string, unknown>;
      const pageRange =
        Array.isArray(cut.pageRange) && cut.pageRange.length >= 2
          ? ([Number(cut.pageRange[0]), Number(cut.pageRange[1])] as [number, number])
          : null;

      if (!pageRange || Number.isNaN(pageRange[0]) || Number.isNaN(pageRange[1])) return null;

      return {
        partName: typeof cut.partName === 'string' ? cut.partName.trim() : 'Unknown',
        instrument: typeof cut.instrument === 'string' ? cut.instrument.trim() : 'Unknown',
        section: (typeof cut.section === 'string' ? cut.section : 'Other') as CuttingInstruction['section'],
        transposition: (typeof cut.transposition === 'string' ? cut.transposition : 'C') as CuttingInstruction['transposition'],
        partNumber: typeof cut.partNumber === 'number' ? cut.partNumber : 1,
        pageRange,
      } satisfies CuttingInstruction;
    })
    .filter((cut): cut is CuttingInstruction => cut !== null);

  return {
    title,
    subtitle: typeof parsed.subtitle === 'string' ? parsed.subtitle : undefined,
    composer: typeof parsed.composer === 'string' ? parsed.composer : undefined,
    arranger: typeof parsed.arranger === 'string' ? parsed.arranger : undefined,
    publisher: typeof parsed.publisher === 'string' ? parsed.publisher : undefined,
    copyrightYear:
      typeof parsed.copyrightYear === 'number'
        ? parsed.copyrightYear
        : typeof parsed.copyrightYear === 'string' && parsed.copyrightYear.trim()
          ? parsed.copyrightYear.trim()
          : undefined,
    ensembleType: typeof parsed.ensembleType === 'string' ? parsed.ensembleType : undefined,
    keySignature: typeof parsed.keySignature === 'string' ? parsed.keySignature : undefined,
    timeSignature: typeof parsed.timeSignature === 'string' ? parsed.timeSignature : undefined,
    tempo: typeof parsed.tempo === 'string' ? parsed.tempo : undefined,
    fileType: (['FULL_SCORE', 'CONDUCTOR_SCORE', 'CONDENSED_SCORE', 'PART'] as const).includes(
      parsed.fileType as never,
    )
      ? (parsed.fileType as ExtractedMetadata['fileType'])
      : 'FULL_SCORE',
    isMultiPart,
    parts,
    cuttingInstructions,
    confidenceScore,
    notes: typeof parsed.notes === 'string' ? parsed.notes : undefined,
  };
}

/**
 * Parse image-mode vision response that contains metadata only.
 */
function parseVisionMetadataResponse(
  content: string,
): Omit<ExtractedMetadata, 'cuttingInstructions'> & { cuttingInstructions: [] } {
  const result = parseJsonLenient<Record<string, unknown>>(content, 'object');
  if (!result.ok) {
    logger.error('parseVisionMetadataResponse: JSON extraction failed', {
      error: result.error,
    });
    return {
      title: 'Unknown Title',
      confidenceScore: 0,
      fileType: 'FULL_SCORE',
      isMultiPart: false,
      parts: [],
      cuttingInstructions: [],
      notes: 'Metadata extraction failed — manual review required',
    };
  }

  const parsed = result.value;

  const title =
    typeof parsed.title === 'string' && parsed.title.trim()
      ? parsed.title.trim()
      : null;

  const confidenceScore = normalizeConfidence(parsed.confidenceScore);
  const isMultiPart = parsed.isMultiPart === true;

  const rawParts = Array.isArray(parsed.parts) ? parsed.parts : [];
  const parts = rawParts.map((partValue: unknown, index: number) => {
    const part = (partValue ?? {}) as Record<string, unknown>;
    return {
      instrument:
        typeof part.instrument === 'string' ? part.instrument.trim() : `Unknown Part ${index + 1}`,
      partName: typeof part.partName === 'string' ? part.partName.trim() : `Part ${index + 1}`,
      section: typeof part.section === 'string' ? part.section : 'Other',
      transposition: typeof part.transposition === 'string' ? part.transposition : 'C',
      partNumber: typeof part.partNumber === 'number' ? part.partNumber : index + 1,
    };
  });

  return {
    title: title ?? 'Unknown Title',
    subtitle: typeof parsed.subtitle === 'string' ? parsed.subtitle : undefined,
    composer: typeof parsed.composer === 'string' ? parsed.composer : undefined,
    arranger: typeof parsed.arranger === 'string' ? parsed.arranger : undefined,
    publisher: typeof parsed.publisher === 'string' ? parsed.publisher : undefined,
    copyrightYear:
      typeof parsed.copyrightYear === 'number'
        ? parsed.copyrightYear
        : typeof parsed.copyrightYear === 'string' && parsed.copyrightYear.trim()
          ? parsed.copyrightYear.trim()
          : undefined,
    ensembleType: typeof parsed.ensembleType === 'string' ? parsed.ensembleType : undefined,
    keySignature: typeof parsed.keySignature === 'string' ? parsed.keySignature : undefined,
    timeSignature: typeof parsed.timeSignature === 'string' ? parsed.timeSignature : undefined,
    tempo: typeof parsed.tempo === 'string' ? parsed.tempo : undefined,
    fileType: (['FULL_SCORE', 'CONDUCTOR_SCORE', 'CONDENSED_SCORE', 'PART'] as const).includes(
      parsed.fileType as never,
    )
      ? (parsed.fileType as ExtractedMetadata['fileType'])
      : 'FULL_SCORE',
    isMultiPart,
    parts,
    cuttingInstructions: [],
    confidenceScore,
    notes: typeof parsed.notes === 'string' ? parsed.notes : undefined,
  };
}

function buildFallbackMetadata(totalPages: number): ExtractedMetadata {
  return {
    title: 'Unknown Title',
    confidenceScore: 0,
    fileType: 'FULL_SCORE',
    isMultiPart: false,
    parts: [],
    cuttingInstructions: [
      {
        partName: 'Full Score',
        instrument: 'Full Score',
        section: 'Score',
        transposition: 'C',
        partNumber: 1,
        pageRange: [1, totalPages],
      },
    ],
    notes: 'Metadata extraction failed — manual review required',
  };
}

function determineRoutingDecision(
  confidence: number,
  config: LLMRuntimeConfig,
): { decision: RoutingDecision; autoApproved: boolean } {
  if (confidence >= config.autoApproveThreshold) {
    return { decision: 'auto_parse_auto_approve', autoApproved: true };
  }
  if (confidence >= config.skipParseThreshold) {
    return { decision: 'auto_parse_second_pass', autoApproved: false };
  }
  return { decision: 'no_parse_second_pass', autoApproved: false };
}

// =============================================================================
// Main Job Processor
// =============================================================================

export async function processSmartUpload(job: Job<SmartUploadProcessData>): Promise<{
  status: string;
  sessionId: string;
  partsCreated?: number;
  confidenceScore?: number;
  routingDecision?: RoutingDecision;
}> {
  const { sessionId, fileId } = job.data;

  const progress = (step: SmartUploadJobProgress['step'], percent: number, message: string) =>
    job.updateProgress({ step, percent, message, sessionId } as SmartUploadJobProgress);

  await progress('starting', 0, 'Initializing smart upload processing');

  logger.info('Starting smart upload processing', { sessionId, fileId, jobId: job.id });

  try {
    const smartSession = await prisma.smartUploadSession.findUnique({
      where: { uploadSessionId: sessionId },
    });

    if (!smartSession) {
      throw new Error(`Smart upload session not found: ${sessionId}`);
    }

    const llmConfig = await loadSmartUploadRuntimeConfig();

    const budget = createSessionBudget(
      sessionId,
      {
        smart_upload_budget_max_llm_calls_per_session: llmConfig.budgetMaxLlmCalls,
        smart_upload_budget_max_input_tokens_per_session: llmConfig.budgetMaxInputTokens,
      },
      { llmCallCount: smartSession.llmCallCount ?? 0 },
    );

    async function recordLlmCall(promptTokens: number = 0): Promise<void> {
      budget.record(promptTokens);
      await prisma.smartUploadSession.update({
        where: { uploadSessionId: sessionId },
        data: { llmCallCount: { increment: 1 } },
      }).catch((err: unknown) => {
        logger.warn('Failed to persist llmCallCount increment', {
          sessionId,
          error: asError(err).message,
        });
      });
    }

    async function callCachedVision(
      adapterConfig: Parameters<typeof callVisionModel>[0],
      images: Parameters<typeof callVisionModel>[1],
      prompt: string,
      options: Parameters<typeof callVisionModel>[3],
      extra?: { bypassCache?: boolean; cacheSalt?: string },
    ): Promise<VisionResponse> {
      const shouldUseCache = llmConfig.enableLlmCache && !extra?.bypassCache;

      const cacheKey = shouldUseCache
        ? buildLlmCacheKey({
            provider: adapterConfig.llm_provider,
            model: adapterConfig.llm_vision_model ?? '',
            systemPrompt: options?.system,
            userPrompt: prompt,
            imageBase64List: images.map((image) => image.base64Data),
            documentBase64List: options?.documents?.map((doc) => doc.base64Data),
            extra: `${llmConfig.promptVersion}:${extra?.cacheSalt ?? ''}`,
          })
        : null;

      if (cacheKey) {
        const cached = await getCachedLlmResponse(cacheKey);
        if (cached) {
          logger.debug('LLM cache hit — skipping API call', { sessionId, cacheKey });
          return JSON.parse(cached) as VisionResponse;
        }
      }

      const budgetCheck = budget.check();
      if (!budgetCheck.allowed) {
        throw new Error(`Smart Upload budget exhausted: ${budgetCheck.reason}`);
      }

      const result = await callVisionModel(adapterConfig, images, prompt, options);
      await recordLlmCall(result.usage?.promptTokens ?? 0);

      if (cacheKey) {
        await setCachedLlmResponse(cacheKey, JSON.stringify(result), llmConfig.llmCacheTtlSeconds);
      }

      return result;
    }

    const ocrFirstEnabled = llmConfig.enableOcrFirst ?? true;

    interface StrategyAttempt {
      strategy: string;
      confidence: number;
      failureReasons: string[];
      durationMs: number;
      timestamp: string;
      provenance?: {
        textLayerAttempt: boolean;
        textLayerSuccess: boolean;
        textLayerEngine?: string;
        textLayerChars: number;
        textLayerThreshold?: number;
        textLayerCoverage?: number;
        ocrAttempt: boolean;
        ocrSuccess: boolean;
        ocrEngine?: string;
        ocrConfidence: number;
        llmFallbackReasons: string[];
      };
    }

    const strategyHistory: StrategyAttempt[] = [];

    const providerMeta = getProviderMeta(llmConfig.provider);
    const canSendPdf = llmConfig.sendFullPdfToLlm && (providerMeta?.supportsPdfInput ?? false);

    // Step 1: Download PDF
    await progress('downloading', 5, 'Downloading PDF from storage');

    const downloadResult = await downloadFile(smartSession.storageKey);
    if (typeof downloadResult === 'string') {
      throw new Error('Expected file stream but got URL');
    }

    const pdfBuffer = await streamToBuffer(downloadResult.stream);

    // Step 2: Virus scan
    await progress('scanning', 8, 'Scanning file for viruses');

    const virusScanResult = await virusScanner.scan(pdfBuffer);
    if (!virusScanResult.clean) {
      logger.error('Virus detected in uploaded file — rejecting', {
        sessionId,
        threat: virusScanResult.message,
        scanner: virusScanResult.scanner,
      });

      await prisma.smartUploadSession.update({
        where: { uploadSessionId: sessionId },
        data: {
          parseStatus: 'PARSE_FAILED',
        },
      });

      return { status: 'virus_detected', sessionId };
    }

    const validation = await validatePdfBuffer(pdfBuffer);
    if (!validation.valid) {
      logger.error('PDF validation failed; aborting smart upload', {
        sessionId,
        error: validation.error,
      });

      await prisma.smartUploadSession.update({
        where: { uploadSessionId: sessionId },
        data: {
          parseStatus: 'PARSE_FAILED',
        },
      });

      return { status: 'parse_failed', sessionId };
    }

    const initialTotalPages = (await getPdfSourceInfo(pdfBuffer)).pageCount;

    // -----------------------------------------------------------------
    // Text layer detection
    // -----------------------------------------------------------------
    await progress('analyzing', 15, 'Detecting text layer for deterministic segmentation');

    const pageHeaderResult = await extractPdfPageHeaders(
      pdfBuffer,
      { maxPages: initialTotalPages > 0 ? initialTotalPages : undefined },
    );

    const totalPages =
      initialTotalPages > 0
        ? initialTotalPages
        : (pageHeaderResult.totalPages ?? 0);

    if (totalPages <= 0) {
      logger.error('Smart upload could not determine authoritative PDF page count', {
        sessionId,
        validationPageCount: validation.pageCount,
        textExtractorPageCount: pageHeaderResult.totalPages,
      });

      await prisma.smartUploadSession.update({
        where: { uploadSessionId: sessionId },
        data: {
          parseStatus: 'PARSE_FAILED',
        },
      });

      return { status: 'parse_failed', sessionId };
    }

    let deterministicInstructions: CuttingInstruction[] | null = null;
    let deterministicConfidence = 0;
    let authoritativeTextSegmentation: SegmentationResult | null = null;
    const pageLabels: Record<number, string> = {};

    const textLayerThresholdPct = (llmConfig.textLayerThresholdPct ?? 40) / 100;
    const textLayerCoverage = pageHeaderResult.textLayerCoverage ?? 0;
    const textLayerMeetsThreshold =
      pageHeaderResult.hasTextLayer && textLayerCoverage >= textLayerThresholdPct;

    if (textLayerMeetsThreshold) {
      logger.info('Text layer detected and meets threshold — attempting deterministic segmentation', {
        sessionId,
        coverage: textLayerCoverage,
        threshold: textLayerThresholdPct,
      });

      const segResult = detectPartBoundaries(pageHeaderResult.pageHeaders, totalPages, true);
      authoritativeTextSegmentation = segResult;

      // Require BOTH multiple segments AND sufficient high-confidence labels
      // to prevent accepting garbage segmentation (e.g., 78 segments but only 1 high-confidence label)
      const MIN_HIGH_CONFIDENCE_PAGES = 3;
      const highConfidencePages = segResult.pageLabels.filter(
        (pl) => pl.confidence >= 70 && pl.label && !isForbiddenLabel(pl.label)
      ).length;
      
      const meetsConfidenceThreshold = segResult.segmentationConfidence >= (llmConfig.skipParseThreshold ?? 60);
      const hasEnoughHighConfidenceLabels = highConfidencePages >= MIN_HIGH_CONFIDENCE_PAGES;
      
      if (segResult.segments.length > 1 && meetsConfidenceThreshold && hasEnoughHighConfidenceLabels) {
        deterministicInstructions = segResult.cuttingInstructions;
        deterministicConfidence = segResult.segmentationConfidence;

        for (const pageLabel of segResult.pageLabels) {
          if (pageLabel.label) {
            pageLabels[pageLabel.pageIndex + 1] = pageLabel.label;
          }
        }

        logger.info('Deterministic segmentation succeeded', {
          sessionId,
          segments: segResult.segments.length,
          confidence: deterministicConfidence,
          highConfidencePages,
        });
      } else {
        logger.info('Deterministic segmentation rejected — insufficient quality', {
          sessionId,
          segments: segResult.segments.length,
          confidence: segResult.segmentationConfidence,
          highConfidencePages,
          meetsConfidenceThreshold,
          hasEnoughHighConfidenceLabels,
          reason: !meetsConfidenceThreshold 
            ? 'below confidence threshold' 
            : !hasEnoughHighConfidenceLabels 
              ? 'insufficient high-confidence labels' 
              : 'single segment',
        });
      }
    } else if (pageHeaderResult.hasTextLayer) {
      logger.info('Text layer detected but below threshold — skipping text layer, will use OCR', {
        sessionId,
        coverage: textLayerCoverage,
        threshold: textLayerThresholdPct,
      });
    }

    let pageLabelerResult: PageLabelerResult | null = null;
    let useFullVisionLLM = false;
    const fullVisionFallbackReasons: string[] = [];
    let ocrProvenance: StrategyAttempt['provenance'] = {
      textLayerAttempt: pageHeaderResult.hasTextLayer || textLayerCoverage > 0,
      textLayerSuccess: textLayerMeetsThreshold && deterministicInstructions !== null,
      textLayerEngine: textLayerMeetsThreshold ? 'pdfjs-text-layer' : '',
      textLayerChars: pageHeaderResult.pageHeaders.reduce(
        (sum, header) => sum + (header.headerText?.length ?? 0) + (header.fullText?.length ?? 0),
        0,
      ),
      textLayerThreshold: textLayerThresholdPct,
      textLayerCoverage,
      ocrAttempt: false,
      ocrSuccess: false,
      ocrEngine: '',
      ocrConfidence: 0,
      llmFallbackReasons: [],
    };

    await progress('analyzing', 15, 'Running page-labeler (OCR-first pipeline)');

    if (ocrFirstEnabled) {
      try {
        const labelerStart = Date.now();

        pageLabelerResult = await labelPages({
          pdfBuffer,
          totalPages,
          sessionId,
          cacheTag: sessionId,
          enableOcr: llmConfig.enableOcrFirst ?? true,
          enableLlm: false,
          maxLLmPages: llmConfig.llmMaxPages,
          maxHeaderBatches: llmConfig.llmMaxHeaderBatches,
          maxLlmCallsPerSession: llmConfig.budgetMaxLlmCalls,
          textOptions: {
            maxProbePages: llmConfig.textProbePages,
            earlyStopConsecutivePages: 3,
          },
          ocrOptions: {
            hashDistanceThreshold: 10,
            cropHeightFraction: 0.2,
            enableOcr: true,
          },
          authoritativeTextSegmentation: authoritativeTextSegmentation ?? undefined,
        });

        const labelerDuration = Date.now() - labelerStart;

        const textDiag = pageLabelerResult.diagnostics.strategies.find((strategy) => strategy.strategy === 'text');
        const ocrDiag = pageLabelerResult.diagnostics.strategies.find((strategy) => strategy.strategy === 'ocr');

        ocrProvenance = {
          textLayerAttempt: Boolean(textDiag),
          textLayerSuccess: textDiag?.success ?? false,
          textLayerEngine: 'pdfjs-text-layer',
          textLayerChars: ocrProvenance.textLayerChars,
          textLayerThreshold: textLayerThresholdPct,
          textLayerCoverage,
          ocrAttempt: Boolean(ocrDiag),
          ocrSuccess: ocrDiag?.success ?? false,
          ocrEngine: 'header-image-hash-segmentation',
          ocrConfidence: ocrDiag?.success ? pageLabelerResult.confidence : 0,
          llmFallbackReasons: fullVisionFallbackReasons,
        };

        logger.info('Page-labeler completed (OCR-first pipeline)', {
          sessionId,
          strategyUsed: pageLabelerResult.strategyUsed,
          confidence: pageLabelerResult.confidence,
          labelsExtracted: Object.keys(pageLabelerResult.pageLabels).length,
          cuttingInstructionsCount: pageLabelerResult.cuttingInstructions.length,
          durationMs: labelerDuration,
        });

        const segmentationConfidence = pageLabelerResult.confidence;
        const threshold = llmConfig.skipParseThreshold;

        if (segmentationConfidence >= threshold && pageLabelerResult.cuttingInstructions.length > 0) {
          useFullVisionLLM = false;

          logger.info('OCR-first: page-labeler confidence sufficient, skipping full-vision LLM', {
            sessionId,
            segmentationConfidence,
            threshold,
            cuttingInstructions: pageLabelerResult.cuttingInstructions.length,
          });
        } else {
          useFullVisionLLM = true;
          fullVisionFallbackReasons.push(
            `segmentation confidence (${segmentationConfidence}) < threshold (${threshold})`,
          );

          if (pageLabelerResult.cuttingInstructions.length === 0) {
            fullVisionFallbackReasons.push('no cutting instructions from page-labeler');
          }

          logger.info('OCR-first: falling back to full-vision LLM', {
            sessionId,
            segmentationConfidence,
            threshold,
            fallbackReasons: fullVisionFallbackReasons,
          });
        }
      } catch (labelerErr) {
        useFullVisionLLM = true;
        fullVisionFallbackReasons.push(
          `page-labeler error: ${labelerErr instanceof Error ? labelerErr.message : String(labelerErr)}`,
        );

        logger.warn('Page-labeler failed, falling back to full-vision LLM', {
          sessionId,
          error: labelerErr instanceof Error ? labelerErr.message : String(labelerErr),
        });
      }
    } else {
      useFullVisionLLM = true;
      fullVisionFallbackReasons.push('OCR-first disabled in config');
    }

    let extraction: ExtractedMetadata;
    let firstPassRaw: string | null = null;
    let capturedRawOcrText: string | null = null;
    let capturedOcrTextChars: number | null = null;

    // These allow us to compare OCR-derived vs LLM-derived cutting instructions
    // and choose the most reliable set for splitting while keeping both for audit.
    let ocrCuttingInstructions: CuttingInstruction[] | undefined;
    let ocrCuttingConfidence: number | undefined;
    let llmCuttingInstructions: CuttingInstruction[] | undefined;
    let llmCuttingConfidence: number | undefined;

    if (!useFullVisionLLM) {
      const ocrMeta = await extractOcrFallbackMetadata({
        pdfBuffer,
        filename: smartSession.fileName,
        options: {
          ocrEngine: (
            llmConfig.ocrEngine as 'pdf_text' | 'tesseract' | 'ocrmypdf' | 'vision_api' | 'native' | undefined
          ) ?? 'native',
          ocrMode: (llmConfig.ocrMode as 'header' | 'full' | 'both' | undefined) ?? 'both',
          maxTextProbePages: llmConfig.textProbePages ?? 3,
          maxOcrPages: llmConfig.ocrMaxPages > 0 ? Math.min(llmConfig.ocrMaxPages, totalPages) : Math.min(totalPages, 10),
          enableTesseractOcr: llmConfig.enableOcrFirst ?? true,
          returnRawOcrText: llmConfig.storeRawOcrText ?? false,
          autoAcceptConfidenceThreshold: llmConfig.ocrConfidenceThreshold ?? 70,
          renderScale: 3,
          renderMaxWidth: 1800,
        },
      });

      if (ocrMeta.rawOcrText) capturedRawOcrText = ocrMeta.rawOcrText;
      capturedOcrTextChars = ocrMeta.textLayerChars ?? ocrMeta.rawOcrText?.length ?? ocrProvenance.textLayerChars;

      const pageLabelerInstructions = pageLabelerResult?.cuttingInstructions ?? [];
      const pageLabelerLabels: Record<number, string> = {};
      if (pageLabelerResult) {
        for (const [pageNum, label] of Object.entries(pageLabelerResult.pageLabels)) {
          pageLabelerLabels[Number(pageNum)] = label.label;
        }
      }

      extraction = {
        title: ocrMeta.title || smartSession.fileName.replace(/\.pdf$/i, ''),
        composer: ocrMeta.composer,
        confidenceScore: pageLabelerResult?.confidence ?? 0,
        fileType: 'FULL_SCORE',
        isMultiPart: pageLabelerInstructions.length > 1,
        parts: pageLabelerInstructions.map((instruction, index) => ({
          instrument: instruction.instrument,
          partName: instruction.partName,
          section: instruction.section,
          transposition: instruction.transposition,
          partNumber: instruction.partNumber ?? index + 1,
        })),
        cuttingInstructions: toOneIndexedInstructions(pageLabelerInstructions),
        pageLabels: pageLabelerLabels,
        segmentationConfidence: pageLabelerResult?.confidence ?? 0,
        notes: `Processed via OCR-first pipeline (page-labeler, confidence: ${pageLabelerResult?.confidence ?? 0}%). No full-vision LLM calls used.`,
      };

      logger.info('OCR-first extraction complete (page-labeler)', {
        sessionId,
        title: extraction.title,
        composer: extraction.composer,
        parts: extraction.cuttingInstructions?.length ?? 0,
        confidence: extraction.confidenceScore,
        strategyUsed: pageLabelerResult?.strategyUsed ?? 'unknown',
      });

      // Audit: keep the OCR-derived instructions separate from any later LLM outputs.
      ocrCuttingInstructions = extraction.cuttingInstructions;
      ocrCuttingConfidence = extraction.confidenceScore;
      llmCuttingInstructions = [];
      llmCuttingConfidence = undefined;

      strategyHistory.push({
        strategy: `ocr-first-${pageLabelerResult?.strategyUsed ?? 'unknown'}`,
        confidence: extraction.confidenceScore,
        failureReasons: [],
        durationMs: 0,
        timestamp: new Date().toISOString(),
        provenance: ocrProvenance,
      });
    } else {
      strategyHistory.push({
        strategy: 'ocr-fallback',
        confidence: pageLabelerResult?.confidence ?? 0,
        failureReasons: fullVisionFallbackReasons,
        durationMs: 0,
        timestamp: new Date().toISOString(),
        provenance: ocrProvenance,
      });

      let visionResult: { content: string };
      let sampledIndices: number[] = [];
      let pdfDocumentRef: LabeledDocument | undefined;
      let visionPromptRef = '';
      let pageImagesRef: string[] = [];

      const visionStepConfig = await buildAdapterConfigForStep(llmConfig, 'vision');
      const visionAdapterConfig = {
        ...runtimeToAdapterConfig(llmConfig),
        llm_provider: visionStepConfig.provider,
        llm_endpoint_url: visionStepConfig.endpointUrl,
        llm_vision_model: visionStepConfig.model,
      };

      if (canSendPdf) {
        await progress('analyzing', 30, 'Sending full PDF to AI for analysis (OCR insufficient)');

        logger.info('Using PDF-to-LLM mode — skipping image rendering', {
          sessionId,
          provider: llmConfig.provider,
          totalPages,
          deterministicConfidence,
          reason: deterministicInstructions
            ? `Deterministic confidence ${deterministicConfidence} < threshold ${llmConfig.skipParseThreshold}`
            : 'No deterministic segmentation available',
        });

        const pdfDocument: LabeledDocument = {
          mimeType: 'application/pdf',
          base64Data: pdfBuffer.toString('base64'),
          label: 'Full Score PDF',
        };
        pdfDocumentRef = pdfDocument;

        const pdfPrompt = buildPdfVisionPrompt(
          llmConfig.pdfVisionUserPrompt || DEFAULT_PDF_VISION_USER_PROMPT_TEMPLATE,
          { totalPages },
        );

        const filenameHint = `\nOriginal filename: "${smartSession.fileName}"\nUse this filename as a strong hint for the title if the title page is unclear or missing. Do NOT guess a title from instrument pages.`;
        visionPromptRef = pdfPrompt + filenameHint;

        visionResult = await callCachedVision(
          visionAdapterConfig,
          [],
          visionPromptRef,
          {
            system: visionStepConfig.systemPrompt || DEFAULT_VISION_SYSTEM_PROMPT,
            responseFormat: { type: 'json' },
            modelParams: visionStepConfig.modelParams,
            maxTokens: 65536,
            temperature: 0.1,
            documents: [pdfDocument],
          },
        );
      } else {
        await progress('rendering', 10, 'Rendering PDF pages to images');

        let sampleResult;
        try {
          sampleResult = await samplePdfPages(pdfBuffer, sessionId);
        } catch (err) {
          logger.error('samplePdfPages failed during smart upload', {
            sessionId,
            ...safeErrorDetails(err),
          });

          await prisma.smartUploadSession.update({
            where: { uploadSessionId: sessionId },
            data: { parseStatus: 'PARSE_FAILED' },
          });

          return { status: 'parse_failed', sessionId };
        }

        const pageImages = sampleResult.images;
        pageImagesRef = pageImages;
        sampledIndices = sampleResult.sampledIndices;

        if (!deterministicInstructions || deterministicConfidence < llmConfig.skipParseThreshold) {
          if (llmConfig.enableOcrFirst) {
            await progress('analyzing', 22, 'Running local header-image segmentation (no LLM)');
            try {
              const localSeg = await segmentByHeaderImages(pdfBuffer, totalPages, {
                cropHeightFraction: 0.20,
                hashDistanceThreshold: 10,
                enableOcr: true,
                cacheTag: sessionId,
              });

              if (localSeg && localSeg.segmentCount > 1 && localSeg.confidence >= 55) {
                deterministicInstructions = localSeg.cuttingInstructions;
                deterministicConfidence = Math.max(deterministicConfidence, localSeg.confidence);

                for (const instruction of localSeg.cuttingInstructions) {
                  for (let page = instruction.pageRange[0]; page <= instruction.pageRange[1]; page++) {
                    pageLabels[page + 1] = instruction.instrument;
                  }
                }

                logger.info('Local header-image segmentation succeeded — skipping LLM header-label pass', {
                  sessionId,
                  segmentCount: localSeg.segmentCount,
                  confidence: localSeg.confidence,
                  hasOcrLabels: localSeg.hasOcrLabels,
                });
              } else {
                logger.info('Local header-image segmentation inconclusive — falling back to LLM header-label pass', {
                  sessionId,
                  segmentCount: localSeg?.segmentCount ?? 0,
                  confidence: localSeg?.confidence ?? 0,
                });
              }
            } catch (localSegErr) {
              logger.warn('Local header-image segmentation failed; will fall back to LLM', {
                sessionId,
                error: localSegErr instanceof Error ? localSegErr.message : String(localSegErr),
              });
            }
          }

          const needsLlmHeaderPass =
            !deterministicInstructions ||
            deterministicInstructions.length <= 1 ||
            deterministicConfidence < llmConfig.skipParseThreshold;

          if (needsLlmHeaderPass) {
            await progress('analyzing', 25, 'Running LLM header-label pass for scanned pages');

            try {
              const allPageIndices = Array.from({ length: totalPages }, (_, i) => i);
              const headerCropImages = await renderPdfHeaderCropBatch(pdfBuffer, allPageIndices, {
                scale: 2,
                maxWidth: 1024,
                quality: 85,
                format: 'png',
                cropHeightFraction: 0.2,
                cacheTag: sessionId,
              });

              const headerLabelStepConfig = await buildAdapterConfigForStep(llmConfig, 'header-label');
              const headerAdapterConfig = {
                ...runtimeToAdapterConfig(llmConfig),
                llm_provider: headerLabelStepConfig.provider,
                llm_endpoint_url: headerLabelStepConfig.endpointUrl,
                llm_vision_model: headerLabelStepConfig.model,
              };
              const headerProviderMeta = getProviderMeta(headerLabelStepConfig.provider);
              const headerBatchSize = Math.max(
                1,
                Math.min(
                  MAX_HEADER_CROP_BATCH_SIZE,
                  headerProviderMeta?.maxImagesPerRequest ?? MAX_HEADER_CROP_BATCH_SIZE,
                ),
              );

              const allParsedHeaderLabels: HeaderLabelEntry[] = [];

              for (let batchStart = 0; batchStart < headerCropImages.length; batchStart += headerBatchSize) {
                const batchEnd = Math.min(batchStart + headerBatchSize, headerCropImages.length);
                const batchPageIndices = allPageIndices.slice(batchStart, batchEnd);
                const batchImages = headerCropImages.slice(batchStart, batchEnd);

                const batchPrompt = buildHeaderLabelPrompt(
                  llmConfig.headerLabelUserPrompt || llmConfig.headerLabelPrompt || '',
                  {
                    pageNumbers: batchPageIndices.map((index) => index + 1),
                  },
                );

                let batchResult: VisionResponse;
                try {
                  batchResult = await callCachedVision(
                    headerAdapterConfig,
                    batchImages.map((base64Data, i) => ({
                      mimeType: 'image/png' as const,
                      base64Data,
                      label: `Page ${batchPageIndices[i] + 1}`,
                    })),
                    batchPrompt,
                    {
                      system: headerLabelStepConfig.systemPrompt || DEFAULT_HEADER_LABEL_SYSTEM_PROMPT,
                      responseFormat: { type: 'json' },
                      maxTokens: 2048,
                      temperature: 0.1,
                      modelParams: headerLabelStepConfig.modelParams,
                    },
                  );
                } catch (err) {
                  if (isBudgetExhaustedError(err)) {
                    logger.warn('Budget exhausted during header-label pass; using partial results', {
                      sessionId,
                      labelsCollected: allParsedHeaderLabels.length,
                      reason: asError(err).message,
                    });
                    break;
                  }
                  throw err;
                }

                const batchLabels = parseHeaderLabelResponse(batchResult.content);
                allParsedHeaderLabels.push(...batchLabels);

                logger.info('Header-label batch complete', {
                  sessionId,
                  batchStart: batchStart + 1,
                  batchEnd,
                  labelsFound: batchLabels.length,
                });
              }

              const pageHeaders = allParsedHeaderLabels.map((entry) => ({
                pageIndex: entry.page - 1,
                headerText: entry.label ?? '',
                fullText: entry.label ?? '',
                hasText: Boolean(entry.label),
              }));

              if (pageHeaders.length > 0) {
                const segResult = detectPartBoundaries(pageHeaders, totalPages, false);
                if (segResult.segments.length > 1 || segResult.segmentationConfidence >= 55) {
                  deterministicInstructions = segResult.cuttingInstructions;
                  deterministicConfidence = Math.max(
                    deterministicConfidence,
                    segResult.segmentationConfidence,
                  );

                  for (const pageLabel of segResult.pageLabels) {
                    if (pageLabel.label) {
                      pageLabels[pageLabel.pageIndex + 1] = pageLabel.label;
                    }
                  }

                  logger.info('LLM header-label segmentation succeeded', {
                    sessionId,
                    segments: segResult.segments.length,
                    confidence: segResult.segmentationConfidence,
                  });
                }
              }
            } catch (error) {
              logger.warn('Header-label segmentation failed; continuing with first-pass vision', {
                sessionId,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
        }

        await progress('analyzing', 30, 'Running AI vision analysis on pages (metadata only)');

        const images = pageImages.map((base64Data, index) => ({
          mimeType: 'image/png' as const,
          base64Data,
          label: `Original Page ${sampledIndices[index] + 1}`,
        }));

        const metadataOnlyPrompt = buildVisionMetadataPrompt(
          llmConfig.visionMetadataOnlyUserPrompt || DEFAULT_VISION_METADATA_ONLY_USER_PROMPT_TEMPLATE,
          {
            totalPages,
            sampledPageNumbers: sampledIndices,
          },
        );

        const filenameHint = `\nOriginal filename: "${smartSession.fileName}"\nUse this filename as a strong hint for the title if the title page is unclear or missing. Do NOT guess a title from instrument pages.`;
        visionPromptRef = metadataOnlyPrompt + filenameHint;

        visionResult = await callCachedVision(
          visionAdapterConfig,
          images,
          visionPromptRef,
          {
            system: visionStepConfig.systemPrompt || DEFAULT_VISION_SYSTEM_PROMPT,
            responseFormat: { type: 'json' },
            modelParams: visionStepConfig.modelParams,
            maxTokens: 4096,
            temperature: 0.1,
          },
        );
      }

      if (canSendPdf) {
        extraction = parseVisionResponse(visionResult.content, totalPages);
        if (deterministicConfidence && extraction.segmentationConfidence === undefined) {
          extraction.segmentationConfidence = deterministicConfidence;
        }
      } else {
        const metadataParsed = parseVisionMetadataResponse(visionResult.content);
        extraction = { ...metadataParsed, cuttingInstructions: [] };

        if (!deterministicInstructions || deterministicInstructions.length === 0) {
          logger.warn('Image-mode vision: no deterministic cutting instructions available — routing to human review', {
            sessionId,
            deterministicConfidence,
            totalPages,
            fullVisionFallbackReasons,
          });

          const failureNote = [
            'Image-mode vision: metadata extracted but no deterministic cutting instructions.',
            'Provider does not support native PDF input and deterministic segmentation failed.',
            'Reasons: ' + fullVisionFallbackReasons.join('; '),
          ].join(' ');

          await prisma.smartUploadSession.update({
            where: { uploadSessionId: sessionId },
            data: {
              extractedMetadata: serializeSmartUploadJsonField({ ...extraction, notes: failureNote }),
              confidenceScore: Math.min(extraction.confidenceScore, 10),
              routingDecision: 'no_parse_second_pass',
              parseStatus: 'NOT_PARSED',
              secondPassStatus: 'QUEUED',
              requiresHumanReview: true,
              llmProvider: llmConfig.provider,
              llmVisionModel: llmConfig.visionModel,
              llmPromptVersion: llmConfig.promptVersion || PROMPT_VERSION,
              firstPassRaw: visionResult.content,
              strategyHistory: serializeSmartUploadJsonField(strategyHistory),
            },
          });

          await queueSmartUploadSecondPass(sessionId);
          await progress('queued_for_second_pass', 100, 'No deterministic segmentation — queued for human review / second pass');

          return { status: 'queued_for_second_pass', sessionId };
        }

        extraction.cuttingInstructions = toOneIndexedInstructions(deterministicInstructions);
        extraction.confidenceScore = Math.max(extraction.confidenceScore, deterministicConfidence);
        extraction.segmentationConfidence = deterministicConfidence;

        logger.info('Image-mode vision: metadata from LLM, cuttingInstructions from deterministic segmentation', {
          sessionId,
          parts: deterministicInstructions.length,
          deterministicConfidence,
          visionConfidence: metadataParsed.confidenceScore,
        });
      }

      if (
        canSendPdf &&
        extraction.isMultiPart &&
        (!extraction.cuttingInstructions || extraction.cuttingInstructions.length === 0)
      ) {
        logger.warn('First pass: isMultiPart=true but no cuttingInstructions — retrying uncached', {
          sessionId,
          originalTokens: visionResult.content.length,
        });

        const retryOptions = {
          system: visionStepConfig.systemPrompt || DEFAULT_VISION_SYSTEM_PROMPT,
          responseFormat: { type: 'json' as const },
          modelParams: visionStepConfig.modelParams,
          maxTokens: 65536,
          temperature: 0.1,
        };

        try {
          if (pdfDocumentRef) {
            visionResult = await callCachedVision(
              visionAdapterConfig,
              [],
              visionPromptRef,
              {
                ...retryOptions,
                documents: [pdfDocumentRef],
              },
              { bypassCache: true, cacheSalt: 'retry-1' },
            );
          } else {
            const retryImages = pageImagesRef.map((base64Data, index) => ({
              mimeType: 'image/png' as const,
              base64Data,
              label: `Original Page ${sampledIndices[index] + 1}`,
            }));

            visionResult = await callCachedVision(
              visionAdapterConfig,
              retryImages,
              visionPromptRef,
              retryOptions,
              { bypassCache: true, cacheSalt: 'retry-1' },
            );
          }

          const retryExtraction = parseVisionResponse(visionResult.content, totalPages);
          if (deterministicConfidence && retryExtraction.segmentationConfidence === undefined) {
            retryExtraction.segmentationConfidence = deterministicConfidence;
          }

          if (retryExtraction.cuttingInstructions && retryExtraction.cuttingInstructions.length > 0) {
            logger.info('Retry produced valid cutting instructions', {
              sessionId,
              instructionCount: retryExtraction.cuttingInstructions.length,
            });
            extraction = retryExtraction;
            firstPassRaw = visionResult.content;
          } else {
            logger.warn('Retry also produced no cutting instructions — keeping original', { sessionId });
          }
        } catch (retryErr) {
          logger.warn('Retry vision call failed — keeping original first-pass result', {
            sessionId,
            error: asError(retryErr).message,
          });
        }
      }

      if (Object.keys(pageLabels).length > 0) {
        extraction.pageLabels = pageLabels;
      }
      if (deterministicConfidence > 0 && !extraction.segmentationConfidence) {
        extraction.segmentationConfidence = deterministicConfidence;
      }

      extraction.ocrProvenance = {
        textLayerAttempt: ocrProvenance.textLayerAttempt,
        textLayerSuccess: ocrProvenance.textLayerSuccess,
        textLayerEngine: ocrProvenance.textLayerEngine,
        textLayerChars: ocrProvenance.textLayerChars,
        ocrAttempt: ocrProvenance.ocrAttempt,
        ocrSuccess: ocrProvenance.ocrSuccess,
        ocrEngine: ocrProvenance.ocrEngine,
        ocrConfidence: ocrProvenance.ocrConfidence,
        llmFallbackReasons: [...new Set(ocrProvenance.llmFallbackReasons)],
      };

      // Audit: keep both OCR (deterministic + page-labeler) and LLM cutting instructions for later comparison.
      ocrCuttingInstructions = toOneIndexedInstructions(
        deterministicInstructions ?? (pageLabelerResult?.cuttingInstructions ?? []),
      );
      ocrCuttingConfidence = deterministicConfidence ?? (pageLabelerResult?.confidence ?? 0);
      llmCuttingInstructions = extraction.cuttingInstructions;
      llmCuttingConfidence = extraction.segmentationConfidence ?? extraction.confidenceScore;

      firstPassRaw = visionResult.content;
    }

    const SCORE_FILE_TYPES = ['FULL_SCORE', 'CONDUCTOR_SCORE', 'CONDENSED_SCORE'];
    const MAX_FULL_SCORE_PAGES = 30;
    const hasNoCuttingInstructions =
      !extraction.cuttingInstructions || extraction.cuttingInstructions.length === 0;
    const isScoreFileType = SCORE_FILE_TYPES.includes(extraction.fileType ?? '');

    if (hasNoCuttingInstructions && isScoreFileType && totalPages <= MAX_FULL_SCORE_PAGES) {
      const scoreType =
        extraction.fileType === 'CONDUCTOR_SCORE'
          ? 'Conductor Score'
          : extraction.fileType === 'CONDENSED_SCORE'
            ? 'Condensed Score'
            : 'Full Score';

      extraction.cuttingInstructions = [
        {
          partName: scoreType,
          instrument: scoreType,
          section: 'Score' as CuttingInstruction['section'],
          transposition: 'C' as CuttingInstruction['transposition'],
          partNumber: 1,
          pageRange: [1, totalPages] as [number, number],
        },
      ];
      extraction.isMultiPart = false;

      logger.info('Single-document score detected — created full-score cutting instruction', {
        sessionId,
        scoreType,
        totalPages,
        fileType: extraction.fileType,
      });
    }

    // Choose best cutting instructions between OCR (deterministic) and LLM
    // (preferring OCR unless LLM is demonstrably better).
    const cuttingChoice = chooseBestCuttingInstructions({
      totalPages,
      ocrInstructions: ocrCuttingInstructions,
      ocrConfidence: ocrCuttingConfidence,
      llmInstructions: llmCuttingInstructions,
      llmConfidence: llmCuttingConfidence,
      enforceOcr: llmConfig.enforceOcrSplitting,
    });

    extraction.cuttingInstructions = cuttingChoice.chosenInstructions;
    extraction.cuttingInstructionsSource = cuttingChoice.source;
    extraction.enforceOcrSplitting = llmConfig.enforceOcrSplitting;
    if (cuttingChoice.ocrInstructions) {
      extraction.ocrCuttingInstructions = cuttingChoice.ocrInstructions;
    }
    if (cuttingChoice.llmInstructions) {
      extraction.llmCuttingInstructions = cuttingChoice.llmInstructions;
    }

    if (cuttingChoice.source !== 'ocr') {
      extraction.notes = extraction.notes
        ? `${extraction.notes} | Cutting instructions chosen from ${cuttingChoice.source}`
        : `Cutting instructions chosen from ${cuttingChoice.source}`;
    }

    // Step 3: Validate cutting instructions
    await progress('validating', 50, 'Validating extracted cutting instructions');

    const cuttingInstructions = extraction.cuttingInstructions || [];
    const instructionValidation = validateAndNormalizeInstructions(
      cuttingInstructions,
      totalPages,
      { oneIndexed: true, detectGaps: true },
    );

    const gapInstructions = buildGapInstructions(instructionValidation.instructions, totalPages);
    if (gapInstructions.length > 0) {
      const gapPageCount = gapInstructions.reduce((sum, gap) => {
        if (!gap.pageRange) return sum;
        return sum + (gap.pageRange[1] - gap.pageRange[0] + 1);
      }, 0);

      logger.warn('Gap pages detected — HARD FAIL: routing to human review / second pass', {
        sessionId,
        gaps: gapInstructions.map((gap) => gap.pageRange),
        gapPageCount,
      });

      instructionValidation.instructions.push(...gapInstructions);
      instructionValidation.warnings.push(
        `${gapInstructions.length} uncovered page range(s) detected — session routed to human review`,
      );

      extraction.confidenceScore = Math.min(extraction.confidenceScore, 10);
      extraction.requiresHumanReview = true;

      const gapNote = `Gaps detected: ${gapInstructions.map((gap) => gap.pageRange ? `pages ${gap.pageRange[0] + 1}-${gap.pageRange[1] + 1}` : '').join(', ')}. Requires human review.`;
      extraction.notes = extraction.notes ? `${extraction.notes} | ${gapNote}` : gapNote;

      await prisma.smartUploadSession.update({
        where: { uploadSessionId: sessionId },
        data: {
          extractedMetadata: serializeSmartUploadJsonField(extraction),
          confidenceScore: extraction.confidenceScore,
          routingDecision: 'no_parse_second_pass',
          parseStatus: 'NOT_PARSED',
          secondPassStatus: 'QUEUED',
          requiresHumanReview: true,
          cuttingInstructions: serializeSmartUploadJsonField(instructionValidation.instructions),
          llmProvider: llmConfig.provider,
          llmVisionModel: llmConfig.visionModel,
          llmVerifyModel: llmConfig.verificationModel,
          llmPromptVersion: llmConfig.promptVersion || PROMPT_VERSION,
          ...(firstPassRaw ? { firstPassRaw } : {}),
          strategyHistory: serializeSmartUploadJsonField(strategyHistory),
        },
      });

      await queueSmartUploadSecondPass(sessionId);
      await progress('queued_for_second_pass', 100, `Gaps in cutting instructions (${gapPageCount} pages) — queued for human review`);

      return { status: 'queued_for_second_pass', sessionId };
    }

    const normalizedInstructionsZero = instructionValidation.instructions;
    const normalizedInstructionsOne = toOneIndexedInstructions(normalizedInstructionsZero);

    if (instructionValidation.isValid) {
      extraction.cuttingInstructions = normalizedInstructionsOne;
    }

    const { decision: routingDecision } = determineRoutingDecision(
      extraction.confidenceScore,
      llmConfig,
    );

    if (!instructionValidation.isValid || extraction.confidenceScore < llmConfig.skipParseThreshold) {
      logger.warn('Low confidence or validation failed, queueing for second pass', {
        sessionId,
        confidence: extraction.confidenceScore,
        validationErrors: instructionValidation.errors,
      });

      await prisma.smartUploadSession.update({
        where: { uploadSessionId: sessionId },
        data: {
          extractedMetadata: serializeSmartUploadJsonField(extraction),
          confidenceScore: extraction.confidenceScore,
          routingDecision: 'no_parse_second_pass',
          parseStatus: 'NOT_PARSED',
          secondPassStatus: 'QUEUED',
          cuttingInstructions: serializeSmartUploadJsonField(normalizedInstructionsOne),
          llmProvider: llmConfig.provider,
          llmVisionModel: llmConfig.visionModel,
          llmVerifyModel: llmConfig.verificationModel,
          llmModelParams: serializeSmartUploadJsonField({
            vision: llmConfig.visionModelParams,
            verification: llmConfig.verificationModelParams,
          }),
          llmPromptVersion: llmConfig.promptVersion || PROMPT_VERSION,
          firstPassRaw: firstPassRaw ?? null,
          strategyHistory: serializeSmartUploadJsonField(strategyHistory),
        },
      });

      await queueSmartUploadSecondPass(sessionId);
      await progress('queued_for_second_pass', 100, 'Queued for second pass verification');

      return { status: 'queued_for_second_pass', sessionId };
    }

    // Step 4: Split PDF
    await progress('splitting', 70, `Splitting PDF into ${instructionValidation.instructions.length} parts`);

    const validatedInstructions = sanitizeCuttingInstructionsForSplit(normalizedInstructionsZero);

    let splitResults;
    try {
      splitResults = await splitPdfByCuttingInstructions(
        pdfBuffer,
        smartSession.fileName.replace(/\.pdf$/i, ''),
        validatedInstructions,
        { indexing: 'zero' },
      );
    } catch (err) {
      logger.error('Failed to split PDF during smart upload', {
        sessionId,
        ...safeErrorDetails(err),
      });

      await prisma.smartUploadSession.update({
        where: { uploadSessionId: sessionId },
        data: { parseStatus: 'PARSE_FAILED' },
      });

      return { status: 'parse_failed', sessionId };
    }

    // Step 5: Create part records
    await progress('saving', 90, 'Uploading split parts to storage');

    const parsedParts: ParsedPartRecord[] = [];
    const tempFiles: string[] = [];

    for (const result of splitResults) {
      const normalised = normalizeInstrumentLabel(result.instruction.instrument);
      const displayName = `${smartSession.fileName.replace(/\.pdf$/i, '')} ${normalised.instrument}`;
      const slug = buildPartStorageSlug(displayName, {
        partNumber: result.instruction.partNumber,
        pageRange: result.instruction.pageRange,
      });
      const partStorageKey = `smart-upload/${sessionId}/parts/${slug}.pdf`;
      const partFileName = buildPartFilename(displayName);

      await uploadFile(partStorageKey, result.buffer, {
        contentType: 'application/pdf',
        metadata: {
          sessionId,
          instrument: result.instruction.instrument,
          partName: result.instruction.partName,
          section: result.instruction.section,
          originalUploadId: sessionId,
        },
      });

      tempFiles.push(partStorageKey);

      parsedParts.push({
        partName: result.instruction.partName,
        instrument: result.instruction.instrument,
        section: result.instruction.section,
        transposition: result.instruction.transposition,
        partNumber: result.instruction.partNumber,
        storageKey: partStorageKey,
        fileName: partFileName,
        fileSize: result.buffer.length,
        pageCount: result.pageCount,
        pageRange: toOneIndexed(result.instruction.pageRange),
      });
    }

    // Step 6: Queue second pass if needed
    let secondPassStatus: SecondPassStatus = 'NOT_NEEDED';
    if (routingDecision === 'auto_parse_second_pass') {
      secondPassStatus = 'QUEUED';
      await prisma.smartUploadSession.update({
        where: { uploadSessionId: sessionId },
        data: { secondPassStatus: 'QUEUED' },
      });
      await queueSmartUploadSecondPass(sessionId);
    }

    // ---------------------------------------------------------------------------
    // Quality gates
    // ---------------------------------------------------------------------------
    let gateResult = evaluateQualityGates({
      parsedParts,
      metadata: extraction,
      totalPages,
      maxPagesPerPart: llmConfig.maxPagesPerPart ?? 12,
      // Prefer LLM-reported segmentation confidence; fall back to text-layer
      // confidence from authoritativeTextSegmentation (which is set even when
      // detectPartBoundaries returned only one segment and deterministicConfidence
      // was not promoted — the text-layer quality signal still matters for gating).
      segmentationConfidence:
        extraction.segmentationConfidence ??
        authoritativeTextSegmentation?.segmentationConfidence ??
        undefined,
    });

    const ocrFirstUsed = extraction.notes?.includes('OCR-first pipeline') ?? false;

    strategyHistory.push({
      strategy: ocrFirstUsed ? 'ocr-first-deterministic' : canSendPdf ? 'llm-pdf-native' : 'llm-image-vision',
      confidence: gateResult.finalConfidence,
      failureReasons: gateResult.reasons,
      durationMs: 0,
      timestamp: new Date().toISOString(),
    });

    if (
      gateResult.failed &&
      llmConfig.enableFullyAutonomousMode &&
      !canSendPdf &&
      !ocrFirstUsed &&
      llmConfig.enableOcrFirst
    ) {
      logger.info('Self-heal: quality gates failed — trying alternate local segmentation strategies', {
        sessionId,
        failureReasons: gateResult.reasons,
      });

      const STRATEGY_VARIANTS: Array<[number, number]> = [
        [5, 0.15],
        [8, 0.20],
        [15, 0.25],
        [8, 0.30],
        [20, 0.20],
      ];

      for (const [hashThreshold, cropFraction] of STRATEGY_VARIANTS) {
        const healStart = Date.now();

        try {
          const altSeg = await segmentByHeaderImages(pdfBuffer, totalPages, {
            cropHeightFraction: cropFraction,
            hashDistanceThreshold: hashThreshold,
            enableOcr: true,
            cacheTag: sessionId,
          });

          if (!altSeg || altSeg.segmentCount <= 1) continue;

          const altInstructionsOne = toOneIndexedInstructions(altSeg.cuttingInstructions);
          const altValidation = validateAndNormalizeInstructions(altInstructionsOne, totalPages, {
            oneIndexed: true,
            detectGaps: true,
          });

          const altGapInstructions = buildGapInstructions(altValidation.instructions, totalPages);
          if (altGapInstructions.length > 0) {
            altValidation.instructions.push(...altGapInstructions);
          }

          const altValidatedInstructions = sanitizeCuttingInstructionsForSplit(
            altValidation.instructions,
          );

          const altSplitResults = await splitPdfByCuttingInstructions(
            pdfBuffer,
            smartSession.fileName.replace(/\.pdf$/i, ''),
            altValidatedInstructions,
            { indexing: 'zero' },
          );

          const altParsedParts: ParsedPartRecord[] = altSplitResults.map((result) => {
            const normalised = normalizeInstrumentLabel(result.instruction.instrument);
            return {
              partName: result.instruction.partName,
              instrument: result.instruction.instrument,
              section: result.instruction.section,
              transposition: result.instruction.transposition,
              partNumber: result.instruction.partNumber,
              storageKey: '',
              fileName: buildPartFilename(`${smartSession.fileName.replace(/\.pdf$/i, '')} ${normalised.instrument}`),
              fileSize: result.buffer.length,
              pageCount: result.pageCount,
              pageRange: toOneIndexed(result.instruction.pageRange),
            };
          });

          const altGateResult = evaluateQualityGates({
            parsedParts: altParsedParts,
            metadata: {
              ...extraction,
              cuttingInstructions: toOneIndexedInstructions(altValidation.instructions),
              segmentationConfidence: altSeg.confidence,
            },
            totalPages,
            maxPagesPerPart: llmConfig.maxPagesPerPart ?? 12,
            segmentationConfidence: altSeg.confidence,
          });

          const healDuration = Date.now() - healStart;
          strategyHistory.push({
            strategy: `local-segment:hash=${hashThreshold}:crop=${cropFraction}`,
            confidence: altGateResult.finalConfidence,
            failureReasons: altGateResult.reasons,
            durationMs: healDuration,
            timestamp: new Date().toISOString(),
          });

          if (!altGateResult.failed || altGateResult.finalConfidence > gateResult.finalConfidence) {
            logger.info('Self-heal: alternate segmentation improved result', {
              sessionId,
              hashThreshold,
              cropFraction,
              confidence: altGateResult.finalConfidence,
              gatesPassed: !altGateResult.failed,
            });

            parsedParts.length = 0;

            for (const result of altSplitResults) {
              const normalised = normalizeInstrumentLabel(result.instruction.instrument);
              const displayName = `${smartSession.fileName.replace(/\.pdf$/i, '')} ${normalised.instrument}`;
              const slug = buildPartStorageSlug(displayName, {
                partNumber: result.instruction.partNumber,
                pageRange: result.instruction.pageRange,
              });
              const partStorageKey = `smart-upload/${sessionId}/parts/heal/${slug}.pdf`;
              const partFileName = buildPartFilename(displayName);

              await uploadFile(partStorageKey, result.buffer, {
                contentType: 'application/pdf',
                metadata: {
                  sessionId,
                  instrument: result.instruction.instrument,
                  partName: result.instruction.partName,
                  originalUploadId: sessionId,
                },
              });

              tempFiles.push(partStorageKey);
              parsedParts.push({
                partName: result.instruction.partName,
                instrument: result.instruction.instrument,
                section: result.instruction.section,
                transposition: result.instruction.transposition,
                partNumber: result.instruction.partNumber,
                storageKey: partStorageKey,
                fileName: partFileName,
                fileSize: result.buffer.length,
                pageCount: result.pageCount,
                pageRange: toOneIndexed(result.instruction.pageRange),
              });
            }

            extraction.cuttingInstructions = toOneIndexedInstructions(altValidation.instructions);
            extraction.confidenceScore = altSeg.confidence;
            extraction.segmentationConfidence = altSeg.confidence;
            gateResult = altGateResult;

            if (!altGateResult.failed) {
              logger.info('Self-heal succeeded: all quality gates pass with alternate segmentation', {
                sessionId,
              });
              break;
            }
          }
        } catch (healErr) {
          logger.warn('Self-heal variant failed', {
            sessionId,
            hashThreshold,
            cropFraction,
            error: healErr instanceof Error ? healErr.message : String(healErr),
          });
        }
      }
    }

    const qualityGateFailed = gateResult.failed;
    const qualityGateReasons = gateResult.reasons;
    const finalConfidence = gateResult.finalConfidence;

    if (qualityGateFailed) {
      for (const reason of qualityGateReasons) {
        logger.warn('Auto-commit quality gate failed', { sessionId, reason });
      }
    }

    const textCoverage = ocrProvenance.textLayerChars > 0 ? 1.0 : (ocrProvenance.ocrEngine ? 0.5 : 0.0);
    const routingSignals: RoutingSignals = {
      textCoverage,
      metadataConfidence: finalConfidence,
      segmentationConfidence:
        deterministicConfidence > 0 ? deterministicConfidence : (extraction.segmentationConfidence ?? null),
      validPartCount: parsedParts.length,
      hasMetadataConflicts: false,
      hasDuplicateFlag: false,
      requiresHumanReview: qualityGateFailed,
      ocrStatus: ocrProvenance.ocrEngine ? 'COMPLETE' : 'NOT_NEEDED',
      secondPassStatus,
      commitStatus: 'NOT_STARTED',
      workflowStatus: 'PROCESSING',
      deterministicSegmentation: deterministicConfidence > 0,
    };

    const policyThresholds: PolicyThresholds = {
      ...DEFAULT_THRESHOLDS,
      minAutoCommitConfidence: llmConfig.autonomousApprovalThreshold,
      autonomousModeEnabled: llmConfig.enableFullyAutonomousMode,
    };

    const routingResult = determineRoute(routingSignals, policyThresholds);
    const shouldAutoCommit = routingResult.route === 'AUTO_COMMIT';

    if (qualityGateFailed && llmConfig.enableFullyAutonomousMode) {
      logger.info('Auto-commit blocked by quality gate(s)', {
        sessionId,
        reasons: qualityGateReasons,
      });
    }

    try {
      await prisma.smartUploadSession.update({
        where: { uploadSessionId: sessionId },
        data: {
          llmCallCount: budget.snapshot().llmCallCount,
          strategyHistory: serializeSmartUploadJsonField(strategyHistory),
        },
      });
    } catch {
      // non-fatal
    }

    await prisma.smartUploadSession.update({
      where: { uploadSessionId: sessionId },
      data: {
        extractedMetadata: serializeSmartUploadJsonField(extraction),
        confidenceScore: extraction.confidenceScore,
        finalConfidence,
        routingDecision,
        parseStatus: 'PARSED',
        parsedParts: serializeSmartUploadJsonField(parsedParts),
        cuttingInstructions: serializeSmartUploadJsonField(extraction.cuttingInstructions ?? normalizedInstructionsOne),
        tempFiles: serializeSmartUploadJsonField(tempFiles),
        autoApproved: shouldAutoCommit,
        status: shouldAutoCommit ? 'AUTO_COMMITTING' : 'REQUIRES_REVIEW',
        requiresHumanReview: qualityGateFailed || undefined,
        secondPassStatus: secondPassStatus === 'NOT_NEEDED' ? 'NOT_NEEDED' : secondPassStatus,
        llmProvider: llmConfig.provider,
        llmVisionModel: llmConfig.visionModel,
        llmVerifyModel: llmConfig.verificationModel,
        llmModelParams: serializeSmartUploadJsonField({
          vision: llmConfig.visionModelParams,
          verification: llmConfig.verificationModelParams,
        }),
        llmPromptVersion: llmConfig.promptVersion || PROMPT_VERSION,
        ...(firstPassRaw ? { firstPassRaw } : {}),
        ocrEngineUsed: ocrProvenance.ocrEngine || ocrProvenance.textLayerEngine || llmConfig.ocrEngine || null,
        ocrModeUsed: llmConfig.ocrMode || null,
        ocrTextChars: capturedOcrTextChars ?? ocrProvenance.textLayerChars ?? null,
        ...(capturedRawOcrText ? { rawOcrText: capturedRawOcrText } : {}),
      },
    });

    if (shouldAutoCommit) {
      logger.info('Autonomous mode: queueing auto-commit', {
        sessionId,
        finalConfidence,
        threshold: llmConfig.autonomousApprovalThreshold,
      });
      await queueSmartUploadAutoCommit(sessionId);
    }

    await progress('complete', 100, `Processing complete. Created ${parsedParts.length} parts.`);

    logger.info('Smart upload processing complete', {
      sessionId,
      partsCreated: parsedParts.length,
      routingDecision,
      confidence: extraction.confidenceScore,
      budget: budget.snapshot(),
    });

    return {
      status: 'complete',
      sessionId,
      partsCreated: parsedParts.length,
      confidenceScore: extraction.confidenceScore,
      routingDecision,
    };
  } finally {
    clearRenderCache(sessionId);
  }
}
