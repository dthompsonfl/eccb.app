/**
 * Content sniffing for Smart Upload.
 *
 * Determines what a buffer ACTUALLY is from its magic bytes, independently of
 * the MIME type the client declared. A file named `score.pdf` containing a PNG
 * must be recognised as a PNG, and a declared `application/pdf` must not be
 * trusted on its own.
 *
 * The previous `validateFileMagicBytes` returned `true` for every type it did
 * not explicitly recognise, so asking whether a buffer was, say, an image
 * silently succeeded for any input. That is a permissive default in a
 * validation path; here an unknown type is `null` (not detected) and callers
 * must handle that explicitly.
 */

import { randomUUID } from 'node:crypto';

export type SniffedImageFormat = 'jpeg' | 'png' | 'tiff';

export interface SniffResult {
  /** Canonical media type of the detected content. */
  mediaType: string;
  /** For images, the concrete format; null for PDF. */
  imageFormat: SniffedImageFormat | null;
  /** True when the content is a PDF. */
  isPdf: boolean;
  /** True when the content is a supported raster image. */
  isImage: boolean;
}

/** Media types accepted by the Smart Upload intake. */
export const ACCEPTED_MEDIA_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/tiff',
] as const;

export type AcceptedMediaType = (typeof ACCEPTED_MEDIA_TYPES)[number];

export function isAcceptedMediaType(value: string): value is AcceptedMediaType {
  return (ACCEPTED_MEDIA_TYPES as readonly string[]).includes(value);
}

function startsWith(buffer: Buffer, bytes: number[], offset = 0): boolean {
  if (buffer.length < offset + bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) {
    if (buffer[offset + i] !== bytes[i]) return false;
  }
  return true;
}

/** Detect PDF (`%PDF`). */
export function isPdfBuffer(buffer: Buffer): boolean {
  // Some producers emit leading whitespace or a BOM before %PDF.
  for (let i = 0; i < Math.min(buffer.length, 1024); i++) {
    if (buffer[i] === 0x25 && startsWith(buffer, [0x25, 0x50, 0x44, 0x46], i)) {
      return true;
    }
  }
  return false;
}

/** Detect JPEG (`FF D8 FF`). */
export function isJpegBuffer(buffer: Buffer): boolean {
  return startsWith(buffer, [0xff, 0xd8, 0xff]);
}

/** Detect PNG (`89 50 4E 47 0D 0A 1A 0A`). */
export function isPngBuffer(buffer: Buffer): boolean {
  return startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
}

/**
 * Detect TIFF (II*\0 or MM\0*).
 */
export function isTiffBuffer(buffer: Buffer): boolean {
  return (
    startsWith(buffer, [0x49, 0x49, 0x2a, 0x00]) ||
    startsWith(buffer, [0x4d, 0x4d, 0x00, 0x2a])
  );
}

/**
 * Sniff a buffer's real content type.
 *
 * Returns null for anything unrecognised, so an unknown or hostile payload is
 * rejected rather than waved through.
 */
export function sniffContentType(buffer: Buffer): SniffResult | null {
  if (!buffer || buffer.length === 0) return null;

  if (isPdfBuffer(buffer)) {
    return { mediaType: 'application/pdf', imageFormat: null, isPdf: true, isImage: false };
  }
  if (isJpegBuffer(buffer)) {
    return { mediaType: 'image/jpeg', imageFormat: 'jpeg', isPdf: false, isImage: true };
  }
  if (isPngBuffer(buffer)) {
    return { mediaType: 'image/png', imageFormat: 'png', isPdf: false, isImage: true };
  }
  if (isTiffBuffer(buffer)) {
    return { mediaType: 'image/tiff', imageFormat: 'tiff', isPdf: false, isImage: true };
  }

  return null;
}

/**
 * Whether a buffer matches an expected media type, judged by CONTENT.
 *
 * Use this instead of trusting the client's declared MIME type.
 */
export function bufferMatchesMediaType(buffer: Buffer, expected: string): boolean {
  const detected = sniffContentType(buffer);
  if (!detected) return false;
  return detected.mediaType === expected;
}

/**
 * Whether a buffer matches the expected type, allowing image content where a
 * PDF is expected (the caller may normalise the image into a PDF).
 */
export function bufferIsPdfOrImage(buffer: Buffer): boolean {
  const detected = sniffContentType(buffer);
  return detected !== null;
}

// =============================================================================
// Image -> single-page PDF normalisation
// =============================================================================

/**
 * Convert a raster image into a single-page PDF.
 *
 * The downstream Smart Upload pipeline (OCR, page segmentation, cutting) is
 * PDF-oriented, so an uploaded image is wrapped as a one-page PDF sized to the
 * image's own dimensions. The original image bytes are still retained in
 * storage as the archival source; this is a working copy, not a replacement.
 */
export async function imageToSinglePagePdf(
  imageBuffer: Buffer,
  opts?: { format?: SniffedImageFormat; maxDimension?: number },
): Promise<Buffer> {
  void opts?.format; // accepted for call-site clarity; conversion is uniform
  // The detected format is not needed for the conversion itself: every input
  // is re-encoded to PNG before embedding, so only the pixel dimensions matter.
  const maxDimension = opts?.maxDimension ?? 5000;

  // sharp is already a dependency; it handles JPEG/PNG/TIFF uniformly and
  // gives us the real pixel dimensions.
  const { default: sharp } = await import('sharp');
  const image = sharp(imageBuffer, { animated: false });

  const metadata = await image.metadata();
  const srcWidth = metadata.width ?? 0;
  const srcHeight = metadata.height ?? 0;

  if (!srcWidth || !srcHeight) {
    throw new Error('Could not determine image dimensions');
  }

  // Keep the page within a sane PDF point size while preserving aspect ratio.
  const scale = Math.min(1, maxDimension / Math.max(srcWidth, srcHeight));
  const width = Math.max(1, Math.round(srcWidth * scale));
  const height = Math.max(1, Math.round(srcHeight * scale));

  // Normalise to PNG for embedding: it is lossless and handles alpha, so an
  // OCR pass reading the score sees the original pixels.
  const pngBuffer = await image.png().toBuffer();

  const { PDFDocument } = await import('pdf-lib');
  const pdf = await PDFDocument.create();
  const pngImage = await pdf.embedPng(pngBuffer);
  const page = pdf.addPage([width, height]);
  page.drawImage(pngImage, { x: 0, y: 0, width, height });

  const bytes = await pdf.save();
  return Buffer.from(bytes);
}

/** A stable id for a generated storage key segment. */
export function newSessionId(): string {
  return randomUUID();
}
