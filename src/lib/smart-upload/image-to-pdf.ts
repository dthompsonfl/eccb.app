/**
 * Server-only image normalisation for Smart Upload.
 *
 * Split from `content-sniffing.ts` deliberately: sharp and pdf-lib are
 * Node-native, and importing them from a module that a client component pulls in
 * breaks the browser bundle ("Can't resolve 'fs' / 'child_process'"). The
 * sniffing policy stays dependency-free and client-safe; this file is only ever
 * imported from the upload route, which runs on the Node runtime.
 */

import {
  sniffContentType,
  type SniffedImageFormat,
} from './content-sniffing';

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
  // The format does not affect the conversion: every input is re-encoded to PNG
  // before embedding, so only the pixel dimensions matter.
  void opts?.format;
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

  // Normalise to PNG for embedding: lossless, and it preserves alpha so an OCR
  // pass reads the original pixels.
  const pngBuffer = await image.png().toBuffer();

  const { PDFDocument } = await import('pdf-lib');
  const pdf = await PDFDocument.create();
  const pngImage = await pdf.embedPng(pngBuffer);
  const page = pdf.addPage([width, height]);
  page.drawImage(pngImage, { x: 0, y: 0, width, height });

  const bytes = await pdf.save();
  return Buffer.from(bytes);
}

/** Re-exported so the route can sniff before deciding to normalise. */
export { sniffContentType };
