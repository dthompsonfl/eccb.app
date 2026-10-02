/**
 * OMR (Optical Music Recognition) support for the Digital Music Stand.
 *
 * Extracted from the route so the pieces that are easy to get subtly wrong —
 * reading a private file, and covering the WHOLE score rather than page 1 — are
 * pure and testable.
 */

import { Readable } from 'node:stream';

// =============================================================================
// Full-score page rendering
// =============================================================================

export interface RenderedPage {
  /** 1-based page number. */
  pageNumber: number;
  /** PNG bytes of the rendered page. */
  buffer: Buffer;
  width: number;
  height: number;
}

export interface PageRendererDeps {
  /**
   * Loads a page from an already-open pdf.js document.
   *
   * Typed structurally but permissively: pdf.js's own `PDFPageProxy.render`
   * takes a named `RenderParameters` object and returns a `RenderTask`, and
   * matching it exactly would couple this module to one pdf.js version.
   */
  getPage: (pageNumber: number) => Promise<{
    getViewport: (opts: { scale: number }) => { width: number; height: number };
    render: (ctx: any) => { promise: Promise<void> };
  }>;
  /** Number of pages in the document. */
  pageCount: number;
  /** Creates a canvas for a given pixel size. */
  createCanvas: (width: number, height: number) => {
    getContext: (type: '2d') => unknown;
    toBuffer: (mime: string) => Buffer;
  };
  /** Render scale; 2.0 is roughly 150 dpi, sufficient for vision models. */
  scale?: number;
  /** Hard cap so a pathological 500-page score cannot exhaust memory. */
  maxPages?: number;
}

/** Default cap: a full concert part is well under this. */
export const DEFAULT_MAX_OMR_PAGES = 40;

export interface FullScoreResult {
  pages: RenderedPage[];
  /** True when the document had more pages than the cap allowed. */
  truncated: boolean;
  /** Total pages in the document, even if only some were rendered. */
  totalPages: number;
}

/**
 * Render EVERY page of a score, not just the first.
 *
 * The previous implementation analysed only page 1, so tempo, key and duration
 * were inferred from the opening page alone and a piece whose title page differs
 * from its music page produced wrong metadata.
 */
export async function renderFullScore(deps: PageRendererDeps): Promise<FullScoreResult> {
  const scale = deps.scale ?? 2.0;
  const maxPages = deps.maxPages ?? DEFAULT_MAX_OMR_PAGES;
  const totalPages = Math.max(0, Math.floor(deps.pageCount || 0));

  if (totalPages === 0) {
    return { pages: [], truncated: false, totalPages: 0 };
  }

  const toRender = Math.min(totalPages, maxPages);
  const truncated = toRender < totalPages;
  const pages: RenderedPage[] = [];

  for (let pageNumber = 1; pageNumber <= toRender; pageNumber++) {
    const page = await deps.getPage(pageNumber);
    const viewport = page.getViewport({ scale });
    const width = Math.max(1, Math.floor(viewport.width));
    const height = Math.max(1, Math.floor(viewport.height));

    const canvas = deps.createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      // A page we cannot render is skipped rather than failing the whole score:
      // partial metadata beats no metadata.
      continue;
    }

    await page.render({
      canvasContext: ctx,
      canvas,
      viewport,
    }).promise;

    pages.push({ pageNumber, buffer: canvas.toBuffer('image/png'), width, height });
  }

  return { pages, truncated, totalPages };
}

// =============================================================================
// Merging per-page analysis
// =============================================================================

/** A single page's OMR result, as returned by a vision provider. */
export interface PageAnalysis {
  tempo?: number;
  keySignature?: string;
  timeSignature?: string;
  measureCount?: number;
  difficulty?: string;
  instruments?: string[];
  notes?: string;
}

/**
 * Merge per-page analyses into one whole-score result.
 *
 * Musical facts are carried from the earliest page that states them, which
 * matters because a title page often omits tempo while a later system states it.
 * `measureCount` is summed, `instruments` are unioned.
 */
export function mergePageAnalyses(analyses: Array<PageAnalysis | null | undefined>): PageAnalysis {
  const merged: PageAnalysis = {};
  const instruments = new Set<string>();
  let totalMeasures = 0;
  let sawMeasures = false;

  for (const analysis of analyses) {
    if (!analysis) continue;

    if (merged.tempo === undefined && typeof analysis.tempo === 'number') {
      merged.tempo = analysis.tempo;
    }
    if (!merged.keySignature && analysis.keySignature) {
      merged.keySignature = analysis.keySignature;
    }
    if (!merged.timeSignature && analysis.timeSignature) {
      merged.timeSignature = analysis.timeSignature;
    }
    if (!merged.difficulty && analysis.difficulty) {
      merged.difficulty = analysis.difficulty;
    }
    if (!merged.notes && analysis.notes) {
      merged.notes = analysis.notes;
    }

    if (typeof analysis.measureCount === 'number' && Number.isFinite(analysis.measureCount)) {
      totalMeasures += analysis.measureCount;
      sawMeasures = true;
    }

    for (const instrument of analysis.instruments ?? []) {
      if (instrument) instruments.add(instrument);
    }
  }

  if (sawMeasures) merged.measureCount = totalMeasures;
  if (instruments.size > 0) merged.instruments = [...instruments];

  return merged;
}

// =============================================================================
// Reading stored files
// =============================================================================

/** Storage download result, matching the shape returned by `downloadFile`. */
export type DownloadLike =
  | string
  | { stream: NodeJS.ReadableStream; metadata?: { contentType?: string } };

export class StorageReadError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'StorageReadError';
  }
}

/**
 * Read a stored object into a Buffer using the app's storage abstraction.
 *
 * This deliberately does NOT self-fetch `/api/files/<key>`. That route is
 * correctly protected: a private score returns 401 without the caller's
 * session, so an internal self-fetch could never read a non-public file. Going
 * through the storage layer reads the bytes directly and the CALLER is
 * responsible for authorizing first.
 */
export async function readStoredFile(
  download: () => Promise<DownloadLike>,
): Promise<{ buffer: Buffer; contentType: string | null }> {
  const result = await download();

  if (typeof result === 'string') {
    // S3 in signed-URL mode: the string is a URL, not bytes.
    throw new StorageReadError(
      'Storage returned a signed URL instead of bytes; this driver cannot be read server-side.',
      502,
    );
  }

  const chunks: Buffer[] = [];
  for await (const chunk of result.stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return {
    buffer: Buffer.concat(chunks),
    contentType: result.metadata?.contentType ?? null,
  };
}

/** True when the buffer is a PDF, judged by magic bytes. */
export function isPdfBuffer(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer.slice(0, 4).toString('ascii') === '%PDF';
}

/** True when the buffer is a JPEG, judged by magic bytes. */
export function isJpegBuffer(buffer: Buffer): boolean {
  return buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xd8;
}

/**
 * Convert one image buffer to a base64 data payload, detecting the real format
 * rather than trusting a stored content-type string.
 */
export function imageBufferToBase64(buffer: Buffer): {
  base64: string;
  mimeType: 'image/png' | 'image/jpeg';
} {
  return {
    base64: buffer.toString('base64'),
    mimeType: isJpegBuffer(buffer) ? 'image/jpeg' : 'image/png',
  };
}

/** Drain a Node stream into a Buffer (re-exported for route convenience). */
export async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of Readable.from(stream as Readable)) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
