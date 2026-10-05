import path from 'path';
import os from 'os';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { spawn } from 'child_process';
import { logger } from '@/lib/logger';
import { extractPdfPageHeaders } from '@/lib/services/pdf-text-extractor';
import { renderPdfToImage, renderPdfHeaderCropBatch } from '@/lib/services/pdf-renderer';
import { preprocessForOcr } from '@/lib/services/header-image-segmentation';

/**
 * OCR metadata result
 */
export interface OCRMetadata {
  title: string;
  composer?: string;
  arranger?: string;
  publisher?: string;
  confidence: number;
  isImageScanned: boolean;
  needsManualReview: boolean;
  /** Raw OCR text if requested (never logged) */
  rawOcrText?: string;
  /** Number of characters extracted from text layer */
  textLayerChars?: number;
  /** Number of pages processed by OCR */
  ocrPagesProcessed?: number;
  /** OCR engine used */
  ocrEngine?: string;
  /** Structured provenance for enterprise audit */
  provenance?: {
    textLayerAttempt: boolean;
    textLayerSuccess: boolean;
    textLayerEngine: string;
    textLayerChars: number;
    ocrAttempt: boolean;
    ocrSuccess: boolean;
    ocrEngine: string;
    ocrConfidence: number;
    ocrPagesProcessed: number;
    sources: string[];
  };
}

/**
 * OCR fallback options for metadata extraction
 */
export interface OcrFallbackOptions {
  /**
   * OCR engine to use.
   * - 'pdf_text': use embedded PDF text layer only
   * - 'tesseract': use tesseract.js
   * - 'ocrmypdf': use ocrmypdf binary (requires installation)
   * - 'vision_api': use cloud vision API (not implemented)
   * - 'native': use native PDF text layer with fallback to tesseract
   * Default: 'native' (PDF text layer first, then tesseract)
   */
  ocrEngine?: 'pdf_text' | 'tesseract' | 'ocrmypdf' | 'vision_api' | 'native';

  /**
   * Max pages to probe for text-layer extraction.
   * Default: 3 (fast and sufficient for cover pages).
   */
  maxTextProbePages?: number;

  /**
   * Whether to attempt OCR using tesseract.js (optional dependency).
   * Default: true
   */
  enableTesseractOcr?: boolean;

  /**
   * OCR strategy:
   * - 'header': only OCR the top-of-page crop (fastest; best for part labels)
   * - 'full': OCR the full first page (slower; better for title/composer)
   * - 'both': try header first, then full if needed
   * Default: 'both'
   */
  ocrMode?: 'header' | 'full' | 'both';

  /**
   * Render quality for OCR images.
   */
  renderScale?: number;
  renderMaxWidth?: number;
  renderFormat?: 'png' | 'jpeg';
  renderQuality?: number;

  /**
   * If we reach >= this confidence, we can mark needsManualReview false.
   * Default: 70
   */
  autoAcceptConfidenceThreshold?: number;

  /**
   * Whether to return raw OCR text in results.
   * Default: false
   */
  returnRawOcrText?: boolean;

  /**
   * Minimum characters to consider "meaningful text" for early-stop.
   * Default: 50
   */
  minMeaningfulChars?: number;

  /**
   * Maximum pages to OCR when using full-page OCR.
   * Default: 3
   */
  maxOcrPages?: number;
}

type OcrEngine = NonNullable<OcrFallbackOptions['ocrEngine']>;
type OcrMode = NonNullable<OcrFallbackOptions['ocrMode']>;

interface TitleComposerExtraction {
  title?: string;
  composer?: string;
}

interface OcrAttemptResult {
  text: string;
  confidence: number;
  engine: string;
  pagesScanned: number;
  charsExtracted: number;
}

interface TesseractLike {
  recognize(
    image: string,
    lang?: string,
    options?: Record<string, unknown>,
  ): Promise<{ data?: { text?: string; confidence?: number } }>;
}

interface ProcessRunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

// =============================================================================
// Defaults
// =============================================================================

const DEFAULT_MAX_TEXT_PROBE_PAGES = 3;
const DEFAULT_MAX_OCR_PAGES = 3;
const DEFAULT_MIN_MEANINGFUL_CHARS = 50;
const DEFAULT_RENDER_SCALE = 2;
const DEFAULT_RENDER_MAX_WIDTH = 1024;
const DEFAULT_RENDER_FORMAT: 'png' | 'jpeg' = 'png';
const DEFAULT_RENDER_QUALITY = 85;
const DEFAULT_AUTO_ACCEPT_CONFIDENCE_THRESHOLD = 70;
const DEFAULT_OCRMY_PDF_TIMEOUT_MS = 120_000;
const HEADER_CROP_FRACTIONS = [0.20, 0.25, 0.40];

// =============================================================================
// Utilities
// =============================================================================

let tesseractModulePromise: Promise<TesseractLike | null> | null = null;

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

function safeErrorDetails(err: unknown) {
  const error = asError(err);
  return { errorMessage: error.message, errorName: error.name, errorStack: error.stack };
}

function nowMs(): number {
  const perf = (globalThis as { performance?: { now(): number } }).performance;
  if (perf?.now) return perf.now();
  return Date.now();
}

function safeBaseName(filename: string): string {
  try {
    return path.basename(filename);
  } catch {
    return filename;
  }
}

function normalizeWhitespace(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

function stripPdfExtension(input: string): string {
  return input.replace(/\.pdf$/i, '').trim();
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function truncateForLogs(input: string, maxLength = 200): string {
  return input.length <= maxLength ? input : `${input.slice(0, maxLength)}…`;
}

function buildDefaultProvenance(): NonNullable<OCRMetadata['provenance']> {
  return {
    textLayerAttempt: false,
    textLayerSuccess: false,
    textLayerEngine: 'pdf_text',
    textLayerChars: 0,
    ocrAttempt: false,
    ocrSuccess: false,
    ocrEngine: 'none',
    ocrConfidence: 0,
    ocrPagesProcessed: 0,
    sources: [],
  };
}

function buildMetadataResult(params: {
  title: string;
  composer?: string;
  confidence: number;
  isImageScanned: boolean;
  needsManualReviewThreshold: number;
  rawOcrText?: string;
  textLayerChars?: number;
  ocrPagesProcessed?: number;
  ocrEngine?: string;
  provenance: NonNullable<OCRMetadata['provenance']>;
}): OCRMetadata {
  return {
    title: params.title,
    composer: params.composer,
    confidence: params.confidence,
    isImageScanned: params.isImageScanned,
    needsManualReview: params.confidence < params.needsManualReviewThreshold,
    rawOcrText: params.rawOcrText,
    textLayerChars: params.textLayerChars,
    ocrPagesProcessed: params.ocrPagesProcessed,
    ocrEngine: params.ocrEngine,
    provenance: params.provenance,
  };
}

function combineExtractedPdfText(
  extraction: Awaited<ReturnType<typeof extractPdfPageHeaders>>,
  maxPages: number,
): { combinedText: string; totalChars: number; pagesScanned: number } {
  let totalChars = 0;
  let pagesScanned = 0;
  const parts: string[] = [];

  for (const page of extraction.pageHeaders.slice(0, Math.max(0, maxPages))) {
    const headerText = page.headerText || '';
    const fullText = page.fullText || '';
    const combinedPageText = `${headerText} ${fullText}`.trim();

    if (combinedPageText) {
      parts.push(combinedPageText);
      totalChars += combinedPageText.length;
    }

    pagesScanned += 1;
  }

  return {
    combinedText: parts.join(' ').slice(0, 3000),
    totalChars,
    pagesScanned,
  };
}

/**
 * Heuristic extraction of title/composer from a blob of text.
 * Conservative and deterministic.
 */
function extractTitleComposerFromText(text: string): TitleComposerExtraction {
  const cleaned = normalizeWhitespace(
    text
      .replace(/[_]+/g, ' ')
      .replace(/[|]+/g, ' ')
      .replace(/[•·]+/g, ' '),
  );

  if (!cleaned || cleaned.length < 3) return {};

  const byMatch = cleaned.match(
    /\b(?:by|composer|composed\s+by|arr\.?\s*by)\b\s*([A-Z][A-Za-z.'’-]{1,}.*)$/i,
  );
  const arrangerMatch = cleaned.match(
    /\b(?:arranged\s+by|arr\.?\s*by)\b\s*([A-Z][A-Za-z.'’-]{1,}.*)$/i,
  );

  const tokens = cleaned
    .split(/\s{2,}|\s-\s|\s•\s|\s\|\s/)
    .map((token) => normalizeWhitespace(token))
    .filter(Boolean);

  let titleCandidate: string | undefined;
  for (const token of tokens.slice(0, 6)) {
    const lowered = token.toLowerCase();
    if (
      lowered.startsWith('by ') ||
      lowered.startsWith('arr') ||
      lowered.includes('arranged by') ||
      lowered.includes('composer')
    ) {
      continue;
    }

    if (token.length >= 4 && token.length <= 120) {
      titleCandidate = token;
      break;
    }
  }

  let composerCandidate: string | undefined;
  if (byMatch?.[1]) composerCandidate = normalizeWhitespace(byMatch[1]);
  if (!composerCandidate && arrangerMatch?.[1]) composerCandidate = normalizeWhitespace(arrangerMatch[1]);

  if (!composerCandidate) {
    for (const token of tokens.slice(0, 8)) {
      const lowered = token.toLowerCase();
      if (lowered.includes('by ') || lowered.includes('arr') || lowered.includes('composer')) continue;

      if (/^[A-Z][A-Za-z.'’-]+(?:\s+[A-Z][A-Za-z.'’-]+){0,3}$/.test(token) && token.length <= 40) {
        if (titleCandidate && normalizeWhitespace(token) === normalizeWhitespace(titleCandidate)) continue;
        composerCandidate = token;
        break;
      }
    }
  }

  return {
    title: titleCandidate ? normalizeWhitespace(titleCandidate) : undefined,
    composer: composerCandidate ? normalizeWhitespace(composerCandidate) : undefined,
  };
}

async function getTesseractModule(): Promise<TesseractLike | null> {
  if (!tesseractModulePromise) {
    tesseractModulePromise = import('tesseract.js')
      .then((mod) => {
        const maybeRecognizer = mod as unknown as TesseractLike;
        return typeof maybeRecognizer?.recognize === 'function' ? maybeRecognizer : null;
      })
      .catch(() => null);
  }

  return tesseractModulePromise;
}

/**
 * Optional OCR engine using tesseract.js.
 * Returns {text:'', confidence:0} if OCR cannot run.
 */
async function tryTesseractOcrOnImage(base64Image: string): Promise<{ text: string; confidence: number }> {
  const start = nowMs();

  try {
    const mod = await getTesseractModule();
    if (!mod) {
      logger.warn('OCR engine unavailable (tesseract.js not installed)');
      return { text: '', confidence: 0 };
    }

    const dataUrl = `data:image/png;base64,${base64Image}`;
    const result = await mod.recognize(dataUrl, 'eng', {
      logger: () => undefined,
    });

    const text = typeof result?.data?.text === 'string' ? result.data.text : '';
    const confidence = typeof result?.data?.confidence === 'number' ? result.data.confidence : 0;

    logger.info('OCR (tesseract) completed', {
      durationMs: Math.round(nowMs() - start),
      extractedChars: text.length,
      confidence,
    });

    return { text, confidence };
  } catch (err) {
    logger.warn('OCR (tesseract) failed', {
      ...safeErrorDetails(err),
      durationMs: Math.round(nowMs() - start),
    });
    return { text: '', confidence: 0 };
  }
}

async function runCommand(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<ProcessRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderr = '';
    let settled = false;

    const timeout = setTimeout(() => {
      if (!settled) {
        child.kill('SIGKILL');
      }
    }, timeoutMs);

    child.stderr.on('data', (chunk: Buffer | string) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
      stderr += text;
      if (stderr.length > 4000) {
        stderr = stderr.slice(-4000);
      }
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ code, signal, stderr });
    });
  });
}

async function ocrHeaderFirstPage(
  pdfBuffer: Buffer,
  renderOptions: {
    scale: number;
    maxWidth: number;
    quality: number;
    format: 'png' | 'jpeg';
  },
): Promise<OcrAttemptResult> {
  let bestText = '';
  let bestConfidence = 0;
  let pagesScanned = 0;

  for (const cropFraction of HEADER_CROP_FRACTIONS) {
    const crops = await renderPdfHeaderCropBatch(pdfBuffer, [0], {
      scale: renderOptions.scale,
      maxWidth: renderOptions.maxWidth,
      quality: renderOptions.quality,
      format: renderOptions.format,
      cropHeightFraction: cropFraction,
    });

    const crop = crops[0];
    if (!crop) continue;

    const processed = await preprocessForOcr(crop);
    const ocr = await tryTesseractOcrOnImage(processed);
    pagesScanned += 1;

    if (
      ocr.text.length > bestText.length ||
      (ocr.text.length === bestText.length && ocr.confidence > bestConfidence)
    ) {
      bestText = ocr.text;
      bestConfidence = ocr.confidence;
    }
  }

  return {
    text: bestText,
    confidence: bestConfidence,
    engine: 'tesseract',
    pagesScanned,
    charsExtracted: bestText.length,
  };
}

async function ocrFullPages(
  pdfBuffer: Buffer,
  maxPages: number,
  renderOptions: {
    scale: number;
    maxWidth: number;
    quality: number;
    format: 'png' | 'jpeg';
  },
): Promise<OcrAttemptResult> {
  let bestText = '';
  let bestConfidence = 0;
  let pagesScanned = 0;

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
    const imageBase64 = await renderPdfToImage(pdfBuffer, {
      pageIndex,
      scale: renderOptions.scale,
      maxWidth: renderOptions.maxWidth,
      quality: renderOptions.quality,
      format: renderOptions.format,
    });

    const processed = await preprocessForOcr(imageBase64);
    const ocr = await tryTesseractOcrOnImage(processed);
    pagesScanned += 1;

    if (
      ocr.text.length > bestText.length ||
      (ocr.text.length === bestText.length && ocr.confidence > bestConfidence)
    ) {
      bestText = ocr.text;
      bestConfidence = ocr.confidence;
    }
  }

  return {
    text: bestText,
    confidence: bestConfidence,
    engine: 'tesseract',
    pagesScanned,
    charsExtracted: bestText.length,
  };
}

// =============================================================================
// Core OCR fallback metadata extraction
// =============================================================================

/**
 * Enterprise-grade OCR fallback metadata extraction.
 * This never throws; it always returns a usable OCRMetadata payload.
 */
export async function extractOcrFallbackMetadata(params: {
  pdfBuffer?: Buffer;
  filename: string;
  options?: OcrFallbackOptions;
}): Promise<OCRMetadata> {
  const start = nowMs();
  const { pdfBuffer, filename, options = {} } = params;
  const fileSafe = safeBaseName(filename);

  const ocrEngine: OcrEngine = options.ocrEngine ?? 'native';
  const maxTextProbePages = clampInteger(
    options.maxTextProbePages,
    1,
    20,
    DEFAULT_MAX_TEXT_PROBE_PAGES,
  );
  const enableTesseractOcr = options.enableTesseractOcr ?? true;
  const ocrMode: OcrMode = options.ocrMode ?? 'both';
  const renderScale = clampInteger(options.renderScale, 1, 8, DEFAULT_RENDER_SCALE);
  const renderMaxWidth = clampInteger(options.renderMaxWidth, 256, 4000, DEFAULT_RENDER_MAX_WIDTH);
  const renderFormat = options.renderFormat === 'jpeg' ? 'jpeg' : DEFAULT_RENDER_FORMAT;
  const renderQuality = clampInteger(options.renderQuality, 1, 100, DEFAULT_RENDER_QUALITY);
  const autoAcceptConfidenceThreshold = clampInteger(
    options.autoAcceptConfidenceThreshold,
    0,
    100,
    DEFAULT_AUTO_ACCEPT_CONFIDENCE_THRESHOLD,
  );
  const returnRawOcrText = options.returnRawOcrText ?? false;
  const minMeaningfulChars = clampInteger(
    options.minMeaningfulChars,
    1,
    1000,
    DEFAULT_MIN_MEANINGFUL_CHARS,
  );
  const maxOcrPages = clampInteger(options.maxOcrPages, 1, 20, DEFAULT_MAX_OCR_PAGES);

  const filenameFallback = generateOCRFallback(fileSafe);
  const provenance = buildDefaultProvenance();

  if (!pdfBuffer) {
    provenance.sources.push('filename');

    logger.warn('OCR fallback: no pdfBuffer provided; using filename fallback only', {
      filename: fileSafe,
      durationMs: Math.round(nowMs() - start),
    });

    return {
      ...filenameFallback,
      provenance,
    };
  }

  // 0.5) PDF document-info metadata (highest-confidence local path)
  try {
    const pdfLib = await import('pdf-lib').catch(() => null);

    if (pdfLib?.PDFDocument) {
      const doc = await pdfLib.PDFDocument.load(pdfBuffer, {
        ignoreEncryption: true,
        updateMetadata: false,
      } as { ignoreEncryption: boolean; updateMetadata: boolean });

      const rawTitle = doc.getTitle?.()?.trim();
      const rawAuthor = doc.getAuthor?.()?.trim();
      const rawSubject = doc.getSubject?.()?.trim();

      if (rawTitle && rawTitle.length >= 2) {
        const composerCandidate = rawAuthor || rawSubject || undefined;
        provenance.sources.push('pdf_document_info');

        const confidence = composerCandidate ? 80 : 70;

        logger.info('OCR fallback: using PDF document-info metadata', {
          filename: fileSafe,
          confidence,
          durationMs: Math.round(nowMs() - start),
          hasComposer: Boolean(composerCandidate),
        });

        return buildMetadataResult({
          title: normalizeWhitespace(rawTitle),
          composer: composerCandidate ? normalizeWhitespace(composerCandidate) : undefined,
          confidence,
          isImageScanned: false,
          needsManualReviewThreshold: autoAcceptConfidenceThreshold,
          provenance,
        });
      }
    }
  } catch {
    // Non-fatal — continue to text-layer extraction
  }

  // 1) Text-layer extraction first
  let derivedIsImageScanned = true;

  try {
    provenance.textLayerAttempt = true;

    const extraction = await extractPdfPageHeaders(pdfBuffer, {
      maxPages: maxTextProbePages,
      minMeaningfulChars,
    });

    derivedIsImageScanned = !extraction.hasTextLayer || extraction.textLayerCoverage < 0.4;

    const combined = combineExtractedPdfText(extraction, maxTextProbePages);
    provenance.textLayerChars = combined.totalChars;

    const tc = extractTitleComposerFromText(combined.combinedText);

    if (tc.title) {
      provenance.textLayerSuccess = true;
      provenance.sources.push('pdf_text_layer');

      const confidence = tc.composer ? 65 : 55;

      logger.info('OCR fallback: extracted metadata from PDF text layer', {
        filename: fileSafe,
        hasTextLayer: extraction.hasTextLayer,
        textLayerCoverage: extraction.textLayerCoverage,
        isImageScanned: derivedIsImageScanned,
        confidence,
        pagesScanned: combined.pagesScanned,
        charsExtracted: combined.totalChars,
        durationMs: Math.round(nowMs() - start),
      });

      return buildMetadataResult({
        title: tc.title,
        composer: tc.composer,
        confidence,
        isImageScanned: derivedIsImageScanned,
        needsManualReviewThreshold: autoAcceptConfidenceThreshold,
        textLayerChars: combined.totalChars,
        provenance,
      });
    }

    if (!derivedIsImageScanned || ocrEngine === 'pdf_text') {
      provenance.sources.push('filename');

      logger.info(
        'OCR fallback: text-layer parse inconclusive; using filename fallback',
        {
          filename: fileSafe,
          hasTextLayer: extraction.hasTextLayer,
          textLayerCoverage: extraction.textLayerCoverage,
          isImageScanned: derivedIsImageScanned,
          charsExtracted: combined.totalChars,
          durationMs: Math.round(nowMs() - start),
        },
      );

      return {
        ...filenameFallback,
        isImageScanned: derivedIsImageScanned,
        textLayerChars: combined.totalChars,
        provenance,
      };
    }

    logger.info('OCR fallback: PDF appears scanned; proceeding to OCR attempt', {
      filename: fileSafe,
      hasTextLayer: extraction.hasTextLayer,
      textLayerCoverage: extraction.textLayerCoverage,
      ocrEngine,
      durationMs: Math.round(nowMs() - start),
    });
  } catch (err) {
    logger.warn('OCR fallback: text-layer probe failed; proceeding to OCR attempt', {
      filename: fileSafe,
      ...safeErrorDetails(err),
    });
  }

  // 2) OCR attempt
  if (enableTesseractOcr && (ocrEngine === 'tesseract' || ocrEngine === 'native')) {
    try {
      provenance.ocrAttempt = true;
      provenance.ocrEngine = 'tesseract';

      let bestOcr: OcrAttemptResult = {
        text: '',
        confidence: 0,
        engine: 'tesseract',
        pagesScanned: 0,
        charsExtracted: 0,
      };

      if (ocrMode === 'header' || ocrMode === 'both') {
        const headerOcr = await ocrHeaderFirstPage(pdfBuffer, {
          scale: renderScale,
          maxWidth: renderMaxWidth,
          quality: renderQuality,
          format: renderFormat,
        });

        if (
          headerOcr.text.length > bestOcr.text.length ||
          (headerOcr.text.length === bestOcr.text.length && headerOcr.confidence > bestOcr.confidence)
        ) {
          bestOcr = headerOcr;
        }
      }

      if ((!bestOcr.text || bestOcr.text.trim().length < 8) && (ocrMode === 'full' || ocrMode === 'both')) {
        const fullOcr = await ocrFullPages(pdfBuffer, maxOcrPages, {
          scale: renderScale,
          maxWidth: renderMaxWidth,
          quality: renderQuality,
          format: renderFormat,
        });

        if (
          fullOcr.text.length > bestOcr.text.length ||
          (fullOcr.text.length === bestOcr.text.length && fullOcr.confidence > bestOcr.confidence)
        ) {
          bestOcr = fullOcr;
        } else {
          bestOcr.pagesScanned += fullOcr.pagesScanned;
        }
      }

      provenance.ocrPagesProcessed = bestOcr.pagesScanned;
      provenance.ocrConfidence = bestOcr.confidence;

      const tc = extractTitleComposerFromText(bestOcr.text);

      if (tc.title) {
        provenance.ocrSuccess = true;
        provenance.sources.push('tesseract');

        const confidence = tc.composer ? 55 : 45;

        logger.info('OCR fallback: extracted metadata via OCR', {
          filename: fileSafe,
          confidence,
          durationMs: Math.round(nowMs() - start),
          ocrMode,
          ocrEngine: bestOcr.engine,
          pagesScanned: bestOcr.pagesScanned,
          charsExtracted: bestOcr.charsExtracted,
        });

        return buildMetadataResult({
          title: tc.title,
          composer: tc.composer,
          confidence,
          isImageScanned: true,
          needsManualReviewThreshold: autoAcceptConfidenceThreshold,
          rawOcrText: returnRawOcrText ? bestOcr.text : undefined,
          ocrPagesProcessed: bestOcr.pagesScanned,
          ocrEngine: bestOcr.engine,
          provenance,
        });
      }

      logger.info('OCR fallback: OCR completed but metadata parse inconclusive; using filename fallback', {
        filename: fileSafe,
        durationMs: Math.round(nowMs() - start),
        ocrMode,
        ocrEngine: bestOcr.engine,
        pagesScanned: bestOcr.pagesScanned,
        charsExtracted: bestOcr.charsExtracted,
        hasTitle: Boolean(tc.title),
        hasComposer: Boolean(tc.composer),
      });
    } catch (err) {
      logger.warn('OCR fallback: OCR path failed; using filename fallback', {
        filename: fileSafe,
        ...safeErrorDetails(err),
      });
    }
  } else if (ocrEngine === 'ocrmypdf') {
    try {
      provenance.ocrAttempt = true;
      provenance.ocrEngine = 'ocrmypdf';

      const result = await runOcrmypdf(pdfBuffer);
      provenance.ocrPagesProcessed = result.text ? DEFAULT_MAX_OCR_PAGES : 0;
      provenance.ocrConfidence = result.confidence;

      if (result.text) {
        const tc = extractTitleComposerFromText(result.text);

        if (tc.title) {
          provenance.ocrSuccess = true;
          provenance.sources.push('ocrmypdf');

          const confidence = tc.composer ? 60 : 50;

          logger.info('OCR fallback: extracted metadata via ocrmypdf', {
            filename: fileSafe,
            confidence,
            durationMs: Math.round(nowMs() - start),
            charsExtracted: result.text.length,
          });

          return buildMetadataResult({
            title: tc.title,
            composer: tc.composer,
            confidence,
            isImageScanned: true,
            needsManualReviewThreshold: autoAcceptConfidenceThreshold,
            rawOcrText: returnRawOcrText ? result.text : undefined,
            ocrPagesProcessed: result.text ? DEFAULT_MAX_OCR_PAGES : 0,
            ocrEngine: 'ocrmypdf',
            provenance,
          });
        }
      }

      logger.info('OCR fallback: ocrmypdf completed but metadata parse inconclusive', {
        filename: fileSafe,
        durationMs: Math.round(nowMs() - start),
        charsExtracted: result.text.length,
      });
    } catch (err) {
      logger.warn('OCR fallback: ocrmypdf path failed; using filename fallback', {
        filename: fileSafe,
        ...safeErrorDetails(err),
      });
    }
  } else {
    logger.info('OCR fallback: OCR disabled; using filename fallback', {
      filename: fileSafe,
      durationMs: Math.round(nowMs() - start),
    });
  }

  // 3) Filename fallback
  provenance.sources.push('filename');

  logger.info('OCR fallback: returning filename-derived metadata', {
    filename: fileSafe,
    confidence: filenameFallback.confidence,
    durationMs: Math.round(nowMs() - start),
  });

  return {
    ...filenameFallback,
    isImageScanned: derivedIsImageScanned,
    provenance,
  };
}

/**
 * Check if PDF appears to be scanned/image-based (not searchable text)
 *
 * Uses text-layer coverage from pdfjs extraction.
 *
 * LOGIC UNCHANGED:
 *   isImageBased = !hasTextLayer || textLayerCoverage < 0.4
 */
export async function isImageBasedPdf(pdfBuffer: Buffer | string): Promise<boolean> {
  if (typeof pdfBuffer === 'string') {
    logger.warn('isImageBasedPdf called with string input; expected Buffer', {
      inputType: 'string',
    });
    return false;
  }

  try {
    const extraction = await extractPdfPageHeaders(pdfBuffer);
    const isImageBased = !extraction.hasTextLayer || extraction.textLayerCoverage < 0.4;

    logger.info('isImageBasedPdf evaluated', {
      hasTextLayer: extraction.hasTextLayer,
      textLayerCoverage: extraction.textLayerCoverage,
      isImageBased,
    });

    return isImageBased;
  } catch (error) {
    logger.warn('isImageBasedPdf failed to inspect PDF text layer; assuming image-based', {
      ...safeErrorDetails(error),
    });
    return true;
  }
}

/**
 * Generate fallback metadata when standard extraction fails.
 * Uses filename parsing and provides a low confidence score to indicate
 * that manual review is required.
 *
 * LOGIC UNCHANGED.
 */
export function generateOCRFallback(filename: string): OCRMetadata {
  let title = stripPdfExtension(filename);
  const dashMatch = title.match(/^(.+?)\s*-\s*(.+)$/);
  let composer: string | undefined;

  if (dashMatch) {
    const firstPart = dashMatch[1].trim();
    const secondPart = dashMatch[2].trim();

    if (/^\d+$/.test(firstPart)) {
      title = secondPart;
    } else if (!/^\d/.test(firstPart) && firstPart.length < 30 && /^[A-Z]/.test(firstPart)) {
      composer = firstPart;
      title = secondPart;
    } else if (!/^\d/.test(secondPart) && secondPart.length < 30 && /^[A-Z]/.test(secondPart)) {
      composer = secondPart;
      title = firstPart;
    }
  }

  title = title
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^\d+[\s._-]+/, '')
    .trim();

  const result: OCRMetadata = {
    title,
    confidence: 25,
    isImageScanned: true,
    needsManualReview: true,
  };

  if (composer) {
    result.composer = composer;
    result.confidence = 35;
  }

  logger.info('Generated OCR fallback metadata', {
    filename,
    titleChars: result.title.length,
    hasComposer: Boolean(result.composer),
    confidence: result.confidence,
  });

  return result;
}

/**
 * Parse score metadata from common filename patterns.
 * Returns structured metadata if recognized patterns are found.
 *
 * LOGIC UNCHANGED.
 */
export function parseFilenameMetadata(filename: string): Partial<OCRMetadata> {
  const cleanName = stripPdfExtension(filename);
  const result: Partial<OCRMetadata> = {};

  const partMatch = cleanName.match(/(?:Part\s*(\d+)|(\d+)(?:st|nd|rd|th)\s*Part)/i);
  if (partMatch) {
    const instrumentMatch = cleanName.match(
      /(?:Flute|Oboe|Clarinet|Saxophone|Trumpet|Trombone|Horn|Tuba|Percussion|Violin|Viola|Cello|Bass)/i,
    );
    if (instrumentMatch) {
      result.title = cleanName;
      result.confidence = 30;
    }
  }

  if (/conductor|full\s*score|score/i.test(cleanName)) {
    result.title = cleanName;
    result.confidence = 35;
  }

  return result;
}

// =============================================================================
// OCR Engine Functions
// =============================================================================

/**
 * Try OCR using ocrmypdf binary.
 * Writes the PDF to a temp directory, runs ocrmypdf, then extracts text
 * from the OCR-augmented output PDF via the shared PDF text extractor.
 */
export async function runOcrmypdf(buffer: Buffer): Promise<{ text: string; confidence: number }> {
  const start = nowMs();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'ocrmypdf-'));
  const inputPath = path.join(tempDir, 'input.pdf');
  const outputPath = path.join(tempDir, 'output.pdf');

  try {
    await writeFile(inputPath, buffer);

    const processResult = await runCommand(
      'ocrmypdf',
      ['--skip-text', '--force-ocr', '-q', inputPath, outputPath],
      DEFAULT_OCRMY_PDF_TIMEOUT_MS,
    );

    if (processResult.code !== 0) {
      logger.warn('OCR (ocrmypdf) failed', {
        exitCode: processResult.code,
        signal: processResult.signal,
        stderr: truncateForLogs(processResult.stderr),
        durationMs: Math.round(nowMs() - start),
      });

      return { text: '', confidence: 0 };
    }

    const outputBuffer = await readFile(outputPath);
    const extraction = await extractPdfPageHeaders(outputBuffer, {
      maxPages: DEFAULT_MAX_OCR_PAGES,
    });

    const combined = combineExtractedPdfText(extraction, DEFAULT_MAX_OCR_PAGES);

    logger.info('OCR (ocrmypdf) completed', {
      durationMs: Math.round(nowMs() - start),
      pagesScanned: combined.pagesScanned,
      extractedChars: combined.totalChars,
    });

    return {
      text: combined.combinedText,
      confidence: combined.combinedText ? 75 : 0,
    };
  } catch (err) {
    logger.warn('OCR (ocrmypdf) post-process failed', {
      ...safeErrorDetails(err),
      durationMs: Math.round(nowMs() - start),
    });

    return { text: '', confidence: 0 };
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Generalized OCR engine runner
 */
export async function tryOcrEngine(
  base64Image: string,
  engine: 'tesseract' | 'ocrmypdf' | 'vision_api' | 'native',
  _options?: { returnRawText?: boolean },
): Promise<{ text: string; confidence: number; engine: string; pagesScanned: number; charsExtracted: number }> {
  switch (engine) {
    case 'tesseract': {
      const result = await tryTesseractOcrOnImage(base64Image);
      return {
        text: result.text,
        confidence: result.confidence,
        engine: 'tesseract',
        pagesScanned: 1,
        charsExtracted: result.text.length,
      };
    }

    case 'vision_api':
    case 'ocrmypdf': {
      // Neither engine can OCR a bare rasterized image. 'vision_api' is retired
      // and is no longer selectable (see normalizeOcrEngineValue); it is still
      // handled here so a stale persisted value degrades to a clear, logged no-op
      // rather than pretending to succeed.
      logger.warn(
        `OCR engine ${engine} cannot process a rasterized image; ` +
          'use pdf_buffer or select tesseract/native',
      );
      return {
        text: '',
        confidence: 0,
        engine,
        pagesScanned: 0,
        charsExtracted: 0,
      };
    }

    case 'native':
    default: {
      const result = await tryTesseractOcrOnImage(base64Image);
      return {
        text: result.text,
        confidence: result.confidence,
        engine: 'tesseract',
        pagesScanned: 1,
        charsExtracted: result.text.length,
      };
    }
  }
}

/**
 * Check if ocrmypdf binary is available
 */
export async function isOcrmypdfAvailable(): Promise<boolean> {
  try {
    const result = await runCommand('ocrmypdf', ['--version'], 10_000);
    return result.code === 0;
  } catch {
    return false;
  }
}