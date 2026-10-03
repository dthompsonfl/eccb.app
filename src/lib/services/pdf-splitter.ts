 /**
 * PDF Splitter Service
 *
 * Splits a multi-part PDF into individual part PDFs based on page ranges.
 * Uses pdf-lib for PDF manipulation.
 *
 * Design goals (enterprise-grade):
 * - Stable, predictable outputs (never leak PDF bytes into logs)
 * - Defensive validation + clamping for page ranges
 * - Per-part failure isolation (one bad instruction shouldn't kill the whole job)
 * - Best-effort resource cleanup and structured logging
 * - No behavior-breaking changes from the existing logic
 */

import { PDFDocument } from 'pdf-lib';
import { logger } from '@/lib/logger';
import {
  getPdfSourceInfo,
  getAuthoritativePdfPageCount,
  openPdfDocument,
  asError,
  safeErrorDetails,
} from '@/lib/services/pdf-source';
import { adaptiveSplitWithFallover } from '@/lib/services/pdf-splitter-adaptive';

import type { CuttingInstruction } from '@/types/smart-upload';

export interface PageRange {
  start: number; // 0-indexed start page
  end: number; // 0-indexed end page (inclusive)
  name: string; // Name for the split part
}

export interface SplitPart {
  name: string;
  buffer: Buffer;
  pageCount: number;
}

export interface SplitPdfOptions {
  indexing?: 'zero' | 'one';
  generateFilename?: (partName: string, pageStart: number, pageEnd: number, index: number) => string;
  /**
   * Document metadata stamped into every split part PDF so it displays
   * correctly in a desktop PDF viewer and in Finder/Explorer.
   *
   * `title` is overridden per part with `"<title> — <partName>"` so a musician
   * who opens a downloaded part outside the Digital Music Stand can tell both
   * the work and their own part from the viewer's title bar.
   */
  metadata?: SplitPdfMetadata;
}

export interface SplitPdfMetadata {
  /** Work title, e.g. "Lincolnshire Posy". */
  title?: string;
  /** Composer / arranger. */
  author?: string;
  /** Subject line, e.g. "Instrument part — 1st Bb Clarinet". */
  subject?: string;
  /** Free-form keywords. */
  keywords?: string;
}

/** Producer stamped on generated part PDFs. */
const PART_PDF_PRODUCER = 'ECCB Smart Upload';

/**
 * Embed document metadata into a part PDF.
 *
 * pdf-lib's `copyPages` copies page content only — the document information
 * dictionary of the source is *not* carried over, so a split part comes out of
 * the splitter with no title, no author, and no subject at all. This applies
 * them so macOS Preview, Windows readers, and Finder/Explorer show the work and
 * the part instead of "untitled".
 *
 * Failures are swallowed: metadata is a usability nicety and must never fail a
 * split that produced perfectly good pages.
 */
async function stampPartMetadata(
  doc: MaybeFlushablePdfDocument,
  partName: string,
  metadata: SplitPdfMetadata | undefined,
): Promise<void> {
  if (!metadata) return;

  const workTitle = (metadata.title ?? '').trim();
  const part = partName.trim();

  try {
    const title = workTitle && part ? `${workTitle} — ${part}` : workTitle || part;
    if (title) doc.setTitle(title);
    if (metadata.author?.trim()) doc.setAuthor(metadata.author.trim());
    if (metadata.subject?.trim()) doc.setSubject(metadata.subject.trim());
    if (metadata.keywords?.trim()) doc.setKeywords([metadata.keywords.trim()]);
    doc.setProducer(PART_PDF_PRODUCER);
  } catch (error) {
    logger.warn('Failed to stamp metadata onto split part PDF', {
      partName,
      ...safeErrorDetails(error),
    });
  }
}

type MaybeFlushablePdfDocument = PDFDocument & {
  flush?: () => Promise<void> | void;
};

interface NormalizedRange {
  start: number;
  end: number;
  pageIndices: number[];
}

function nowMs(): number {
  const perf = (globalThis as { performance?: { now(): number } }).performance;
  if (perf?.now) return perf.now();
  return Date.now();
}

function elapsedMs(startMs: number): number {
  return Math.max(1, Math.round(nowMs() - startMs));
}

function safeString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function normalizeFiniteInteger(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.trunc(value);
}

/**
 * Sanitize filename by replacing invalid characters.
 * NOTE: This preserves existing behavior (simple replacement).
 */
function sanitizeFileName(fileName: string): string {
  return safeString(fileName).replace(/[\\/:*?"<>|]/g, '_');
}

/**
 * Stamp metadata onto an already-rendered part PDF buffer.
 *
 * The image-based and raw-slice engines build their output documents from
 * scratch, so they have no information dictionary to fill in at creation time.
 * This re-opens the finished buffer, stamps it, and returns the new bytes.
 *
 * A failure here is non-fatal: the pages are already correct and extracted, so
 * the original buffer is returned unchanged rather than failing the part.
 */
async function stampMetadataIntoBuffer(
  buffer: Buffer,
  partName: string,
  metadata: SplitPdfMetadata | undefined,
): Promise<Buffer> {
  if (!metadata) return buffer;

  let doc: MaybeFlushablePdfDocument | undefined;
  try {
    doc = (await PDFDocument.load(buffer)) as MaybeFlushablePdfDocument;
    await stampPartMetadata(doc, partName, metadata);
    return Buffer.from(await doc.save());
  } catch (error) {
    logger.warn('Failed to stamp metadata onto adaptive part buffer', {
      partName,
      ...safeErrorDetails(error),
    });
    return buffer;
  } finally {
    await cleanupPdfDoc(doc);
  }
}

/**
 * Best-effort cleanup for PDFDocument resources.
 * (pdf-lib is generally GC-managed, but some builds expose flush().)
 */
async function cleanupPdfDoc(doc: MaybeFlushablePdfDocument | undefined) {
  try {
    if (doc && typeof doc.flush === 'function') {
      await doc.flush();
    }
  } catch {
    // best-effort
  }
}

function buildInclusivePageIndices(start: number, end: number): number[] {
  const pageIndices: number[] = [];
  for (let pageIndex = start; pageIndex <= end; pageIndex += 1) {
    pageIndices.push(pageIndex);
  }
  return pageIndices;
}

function normalizeSplitRange(
  start: number,
  end: number,
  totalPages: number,
): NormalizedRange | null {
  if (totalPages <= 0) return null;

  const clampedStart = Math.max(0, Math.min(start, totalPages - 1));
  const clampedEnd = Math.max(clampedStart, Math.min(end, totalPages - 1));
  const pageIndices = buildInclusivePageIndices(clampedStart, clampedEnd);

  if (pageIndices.length === 0) return null;

  return {
    start: clampedStart,
    end: clampedEnd,
    pageIndices,
  };
}

async function createSplitBuffer(
  sourcePdf: PDFDocument,
  pageIndices: number[],
  metadata?: { partName: string; metadata?: SplitPdfMetadata },
): Promise<{ buffer: Buffer; pageCount: number }> {
  let newPdf: MaybeFlushablePdfDocument | undefined;

  try {
    newPdf = await PDFDocument.create();
    const copiedPages = await newPdf.copyPages(sourcePdf, pageIndices);

    for (const page of copiedPages) {
      newPdf.addPage(page);
    }

    if (metadata) {
      await stampPartMetadata(newPdf, metadata.partName, metadata.metadata);
    }

    const pdfBytes = await newPdf.save();
    return {
      buffer: Buffer.from(pdfBytes),
      pageCount: copiedPages.length,
    };
  } finally {
    await cleanupPdfDoc(newPdf);
  }
}

/**
 * Split PDF into separate files by page ranges.
 *
 * @param pdfBuffer  - The original PDF as a Buffer
 * @param pageRanges - Array of page ranges with names for each part
 * @returns Array of split parts with names and buffers
 */
export async function splitPdfByPageRanges(
  pdfBuffer: Buffer,
  pageRanges: PageRange[],
): Promise<SplitPart[]> {
  if (pageRanges.length === 0) {
    logger.info('No page ranges provided, returning original PDF as single part');
    return [
      {
        name: 'unsplit.pdf',
        buffer: pdfBuffer,
        pageCount: 0, // Preserved existing behavior
      },
    ];
  }

  const startAll = nowMs();
  let sourcePdf: MaybeFlushablePdfDocument | undefined;

  try {
    const opened = await openPdfDocument(pdfBuffer);
    sourcePdf = opened.pdfDoc as MaybeFlushablePdfDocument;
    const totalPages = opened.pageCount;
    const results: SplitPart[] = [];

    logger.info('Starting PDF split', {
      totalPages,
      partsToExtract: pageRanges.length,
    });

    for (const range of pageRanges) {
      const rangeStartMs = nowMs();
      const requestedStart = normalizeFiniteInteger(range.start);
      const requestedEnd = normalizeFiniteInteger(range.end);

      if (requestedStart === null || requestedEnd === null) {
        logger.warn('Invalid page range values, skipping', {
          name: range.name,
          start: range.start,
          end: range.end,
        });
        continue;
      }

      const normalizedRange = normalizeSplitRange(requestedStart, requestedEnd, totalPages);
      if (!normalizedRange) {
        logger.warn('No valid pages for part', {
          name: range.name,
          start: range.start,
          end: range.end,
        });
        continue;
      }

      try {
        const split = await createSplitBuffer(sourcePdf, normalizedRange.pageIndices);

        results.push({
          name: range.name,
          buffer: split.buffer,
          pageCount: split.pageCount,
        });

        logger.info('Split part created', {
          partName: range.name,
          pages: split.pageCount,
          requestedPageRange: `${requestedStart}-${requestedEnd}`,
          pageIndexRange: `${normalizedRange.start}-${normalizedRange.end}`,
          durationMs: elapsedMs(rangeStartMs),
        });
      } catch (partError) {
        const details = safeErrorDetails(partError);
        logger.error('Failed to create split part', {
          ...details,
          partName: range.name,
          start: range.start,
          end: range.end,
          validStart: normalizedRange.start,
          validEnd: normalizedRange.end,
        });
        // Continue with other parts even if one fails
      }
    }

    if (results.length === 0) {
      logger.warn('No parts were successfully split, returning original');
      return [
        {
          name: 'unsplit.pdf',
          buffer: pdfBuffer,
          pageCount: totalPages,
        },
      ];
    }

    logger.info('PDF split complete', {
      partsCreated: results.length,
      totalPagesProcessed: results.reduce((sum, part) => sum + part.pageCount, 0),
      durationMs: elapsedMs(startAll),
    });

    return results;
  } catch (error) {
    const details = safeErrorDetails(error);
    logger.error('Failed to split PDF', details);
    throw new Error(`Failed to split PDF: ${asError(error).message}`);
  } finally {
    await cleanupPdfDoc(sourcePdf);
  }
}

/**
 * Validate that a PDF buffer is valid before splitting.
 */
export async function validatePdfBuffer(pdfBuffer: Buffer): Promise<{
  valid: boolean;
  pageCount?: number;
  error?: string;
}> {
  try {
    const sourceInfo = await getPdfSourceInfo(pdfBuffer);
    return {
      valid: true,
      pageCount: sourceInfo.pageCount,
    };
  } catch (error) {
    const err = asError(error);
    logger.warn('PDF parsing warning', { error: err.message });

    const fallbackPageCount = await getAuthoritativePdfPageCount(pdfBuffer);

    return {
      valid: fallbackPageCount !== null,
      pageCount: fallbackPageCount ?? undefined,
      error: fallbackPageCount === null ? err.message : undefined,
    };
  }
}

/**
 * Get basic PDF metadata without full parsing.
 */
export async function getPdfMetadata(
  pdfBuffer: Buffer,
): Promise<{
  pageCount: number;
  title?: string;
  author?: string;
  subject?: string;
}> {
  let pdfDoc: MaybeFlushablePdfDocument | undefined;

  try {
    const opened = await openPdfDocument(pdfBuffer);
    pdfDoc = opened.pdfDoc as MaybeFlushablePdfDocument;

    return {
      pageCount: opened.pageCount,
      title: pdfDoc.getTitle() ?? undefined,
      author: pdfDoc.getAuthor() ?? undefined,
      subject: pdfDoc.getSubject() ?? undefined,
    };
  } catch (error) {
    const details = safeErrorDetails(error);
    logger.error('Failed to get PDF metadata', details);
    return {
      pageCount: 0,
    };
  } finally {
    await cleanupPdfDoc(pdfDoc);
  }
}

/**
 * Split PDF by cutting instructions.
 *
 * @param pdfBuffer - The original PDF as a Buffer
 * @param originalBaseName - The original PDF base name (without extension)
 * @param instructions - Array of CuttingInstruction objects
 * @returns Array of split parts with instructions, buffers, page counts, and filenames
 */
export async function splitPdfByCuttingInstructions(
  pdfBuffer: Buffer,
  originalBaseName: string,
  instructions: CuttingInstruction[],
  options: SplitPdfOptions = {},
): Promise<
  Array<{
    instruction: CuttingInstruction;
    buffer: Buffer;
    pageCount: number;
    fileName: string;
  }>
> {
  if (instructions.length === 0) {
    logger.warn('No cutting instructions provided');
    return [];
  }

  const startAll = nowMs();
  let sourcePdf: MaybeFlushablePdfDocument | undefined;

  try {
    const { generateFilename, indexing = 'zero', metadata } = options;
    
    // Attempt to open PDF — this might fail on corrupted PDFs
    let opened: { pdfDoc: PDFDocument; pageCount: number };
    try {
      opened = await openPdfDocument(pdfBuffer);
    } catch (openError) {
      // If pdf-lib fails to open, log and attempt adaptive extraction per-part
      const details = safeErrorDetails(openError);
      logger.warn('pdf-lib failed to open PDF, will attempt per-part adaptive extraction', {
        ...details,
      });
      opened = { pdfDoc: undefined as any, pageCount: 0 };
    }

    sourcePdf = opened.pdfDoc as MaybeFlushablePdfDocument;
    let totalPages = opened.pageCount;

    // If opening failed, try to get page count from other sources
    if (totalPages === 0) {
      const fallbackCount = await getAuthoritativePdfPageCount(pdfBuffer);
      if (fallbackCount === null) {
        logger.error('Unable to determine PDF page count with any method');
        return [];
      }
      totalPages = fallbackCount;
      logger.info('Using fallback page count method', { totalPages });
    }

    const results: Array<{
      instruction: CuttingInstruction;
      buffer: Buffer;
      pageCount: number;
      fileName: string;
    }> = [];

    const sanitizedBaseName = sanitizeFileName(originalBaseName);

    logger.info('Starting PDF split by cutting instructions', {
      totalPages,
      instructionsCount: instructions.length,
      indexing,
    });

    for (const instruction of instructions) {
      const partStartMs = nowMs();

      if (
        !Array.isArray(instruction.pageRange) ||
        instruction.pageRange.length < 2 ||
        typeof instruction.pageRange[0] !== 'number' ||
        typeof instruction.pageRange[1] !== 'number'
      ) {
        logger.warn('Skipping instruction with missing or invalid pageRange', {
          partName: instruction.partName,
          pageRange: instruction.pageRange,
        });
        continue;
      }

      let [startPage, endPage] = instruction.pageRange;

      if (indexing === 'one') {
        startPage -= 1;
        endPage -= 1;
      }

      const normalizedRange = normalizeSplitRange(startPage, endPage, totalPages);
      if (!normalizedRange) {
        logger.warn('No valid pages for instruction', {
          partName: instruction.partName,
          pageRange: instruction.pageRange,
          indexing,
        });
        continue;
      }

      if (
        startPage !== normalizedRange.start ||
        endPage !== normalizedRange.end
      ) {
        logger.warn('Page range exceeds PDF bounds, clamping to valid range', {
          partName: instruction.partName,
          requestedStart: startPage,
          requestedEnd: endPage,
          totalPages,
          indexing,
        });
      }

      try {
        // First attempt: use pdf-lib if we have a working document
        let split: { buffer: Buffer; pageCount: number };

        if (sourcePdf) {
          try {
            split = await createSplitBuffer(sourcePdf, normalizedRange.pageIndices, {
              partName: instruction.partName,
              metadata,
            });
          } catch (pdfLibError) {
            // pdf-lib failed on this specific part, attempt adaptive extraction
            const details = safeErrorDetails(pdfLibError);
            logger.debug('pdf-lib failed for this part, attempting adaptive extraction', {
              ...details,
              partName: instruction.partName,
              pageRange: instruction.pageRange,
            });

            const adaptiveResult = await adaptiveSplitWithFallover(
              pdfBuffer,
              sourcePdf,
              totalPages,
              instruction,
              '',
              normalizedRange.pageIndices,
            );

            if (adaptiveResult.buffer === null) {
              throw new Error(
                `Failed to split part with all engines: ${adaptiveResult.error}`,
              );
            }

            split = {
              buffer: await stampMetadataIntoBuffer(
                adaptiveResult.buffer,
                instruction.partName,
                metadata,
              ),
              pageCount: adaptiveResult.pageCount,
            };

            logger.info('Part extracted using adaptive engine', {
              partName: instruction.partName,
              strategy: adaptiveResult.strategy,
              pageCount: adaptiveResult.pageCount,
            });
          }
        } else {
          // No working pdf-lib document, use adaptive extraction directly
          const adaptiveResult = await adaptiveSplitWithFallover(
            pdfBuffer,
            sourcePdf as any,
            totalPages,
            instruction,
            '',
            normalizedRange.pageIndices,
          );

          if (adaptiveResult.buffer === null) {
            throw new Error(
              `Failed to split part with all engines: ${adaptiveResult.error}`,
            );
          }

          split = {
            buffer: await stampMetadataIntoBuffer(
              adaptiveResult.buffer,
              instruction.partName,
              metadata,
            ),
            pageCount: adaptiveResult.pageCount,
          };

          logger.info('Part extracted using adaptive engine (no pdf-lib)', {
            partName: instruction.partName,
            strategy: adaptiveResult.strategy,
            pageCount: adaptiveResult.pageCount,
          });
        }

        const rawFileName = generateFilename
          ? generateFilename(
              instruction.partName,
              normalizedRange.start,
              normalizedRange.end,
              results.length,
            )
          : `${sanitizedBaseName} - ${instruction.partName}.pdf`;

        const fileName = sanitizeFileName(rawFileName);

        results.push({
          instruction,
          buffer: split.buffer,
          pageCount: split.pageCount,
          fileName,
        });

        logger.info('Split part created from cutting instruction', {
          partName: instruction.partName,
          pages: split.pageCount,
          pageIndexRange: `${normalizedRange.start}-${normalizedRange.end}`,
          fileName,
          durationMs: elapsedMs(partStartMs),
        });
      } catch (partError) {
        const details = safeErrorDetails(partError);
        logger.error('Failed to create split part from instruction', {
          ...details,
          partName: instruction.partName,
          pageRange: instruction.pageRange,
          indexing,
          clampedStart: normalizedRange.start,
          clampedEnd: normalizedRange.end,
        });
        // Continue with other instructions — partial success is acceptable
      }
    }

    if (results.length === 0) {
      logger.warn('No parts were successfully split from cutting instructions');
      return [];
    }

    logger.info('PDF split by cutting instructions complete', {
      partsCreated: results.length,
      totalPagesProcessed: results.reduce((sum, part) => sum + part.pageCount, 0),
      durationMs: elapsedMs(startAll),
    });

    return results;
  } catch (error) {
    const details = safeErrorDetails(error);
    logger.error('Failed to split PDF by cutting instructions', details);
    throw new Error(`Failed to split PDF: ${asError(error).message}`);
  } finally {
    await cleanupPdfDoc(sourcePdf);
  }
}