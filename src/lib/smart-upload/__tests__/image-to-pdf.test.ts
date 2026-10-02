/**
 * @vitest-environment node
 *
 * sharp and pdf-lib are Node-native. Under jsdom, sharp returns a Buffer from a
 * different realm and pdf-lib's `assertIs` reads its length as NaN, so these
 * tests must run in the node environment. (The production path is a Next.js
 * nodejs runtime route, so this matches reality.)
 */

/**
 * Image -> single-page PDF normalisation.
 *
 * The downstream Smart Upload pipeline is PDF-oriented, so an uploaded image is
 * wrapped as a one-page PDF. These tests use REAL images produced by sharp and
 * verify the resulting PDF is genuinely parseable, not just non-empty bytes.
 */
import { describe, expect, it } from 'vitest';
import { imageToSinglePagePdf, sniffContentType } from '../content-sniffing';

async function makeImage(
  format: 'png' | 'jpeg' | 'tiff',
  width: number,
  height: number,
): Promise<Buffer> {
  const { default: sharp } = await import('sharp');
  const base = sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  });
  return base[format]().toBuffer();
}

describe('imageToSinglePagePdf', () => {
  it('wraps a PNG into a readable one-page PDF', async () => {
    const png = await makeImage('png', 200, 100);
    const pdf = await imageToSinglePagePdf(png, { format: 'png' });

    // It really is a PDF...
    expect(sniffContentType(pdf)?.isPdf).toBe(true);
    // ...and it really parses, with exactly one page.
    const { PDFDocument } = await import('pdf-lib');
    const doc = await PDFDocument.load(pdf);
    expect(doc.getPageCount()).toBe(1);
  });

  it('sizes the page to the image aspect ratio', async () => {
    const png = await makeImage('png', 400, 200);
    const pdf = await imageToSinglePagePdf(png, { format: 'png' });

    const { PDFDocument } = await import('pdf-lib');
    const doc = await PDFDocument.load(pdf);
    const { width, height } = doc.getPage(0).getSize();

    expect(width / height).toBeCloseTo(2, 1);
  });

  it('converts a JPEG into a one-page PDF', async () => {
    const jpeg = await makeImage('jpeg', 300, 300);
    const pdf = await imageToSinglePagePdf(jpeg, { format: 'jpeg' });

    const { PDFDocument } = await import('pdf-lib');
    const doc = await PDFDocument.load(pdf);
    expect(doc.getPageCount()).toBe(1);
  });

  it('converts a TIFF into a one-page PDF', async () => {
    const tiff = await makeImage('tiff', 120, 90);
    const pdf = await imageToSinglePagePdf(tiff, { format: 'tiff' });

    const { PDFDocument } = await import('pdf-lib');
    const doc = await PDFDocument.load(pdf);
    expect(doc.getPageCount()).toBe(1);
  });

  it('caps an oversized image to the max dimension', async () => {
    const png = await makeImage('png', 1000, 500);
    const pdf = await imageToSinglePagePdf(png, { format: 'png', maxDimension: 400 });

    const { PDFDocument } = await import('pdf-lib');
    const doc = await PDFDocument.load(pdf);
    const { width, height } = doc.getPage(0).getSize();

    expect(Math.max(width, height)).toBeLessThanOrEqual(400);
    // Aspect ratio preserved while scaling down.
    expect(width / height).toBeCloseTo(2, 1);
  });

  it('is deterministic enough to be re-runnable', async () => {
    const png = await makeImage('png', 80, 60);
    const a = await imageToSinglePagePdf(png, { format: 'png' });
    const b = await imageToSinglePagePdf(png, { format: 'png' });
    expect(a.length).toBe(b.length);
  });

  it('rejects content that is not an image', async () => {
    await expect(imageToSinglePagePdf(Buffer.from('not an image'))).rejects.toThrow();
  });
});
