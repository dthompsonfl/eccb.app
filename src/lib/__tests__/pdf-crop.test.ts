import { describe, it, expect, vi, beforeEach } from 'vitest';

// pdf.js pulls in DOMMatrix at import time, which jsdom does not provide.
// The crop logic under test is the viewport/sizing arithmetic, not pdf.js, so
// the library import is stubbed.
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: vi.fn(),
  version: 'test',
}));

import { renderPageToCanvas } from '../pdf';
import { normalizedCropToPixels, normalizeCropRect, isCropActive } from '@/lib/stand/navigation';

const WIDTH = 1000;
const HEIGHT = 1400;

/** Minimal stand-in for a pdf.js page. */
function makePage() {
  return {
    getViewport: vi.fn(({ scale = 1, offsetX = 0, offsetY = 0 }) => ({
      width: WIDTH * scale - offsetX,
      height: HEIGHT * scale - offsetY,
      scale,
    })),
    render: vi.fn().mockReturnValue({
      promise: Promise.resolve(),
      cancel: vi.fn(),
    }),
  };
}

function makeCanvas() {
  const el = document.createElement('canvas');
  el.getContext = vi.fn().mockReturnValue({
    setTransform: vi.fn(),
    drawImage: vi.fn(),
  }) as unknown as HTMLCanvasElement['getContext'];
  return el;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('renderPageToCanvas crop application', () => {
  it('sizes the canvas to the full page when no crop is given', async () => {
    const page = makePage();
    const canvas = makeCanvas();

    await renderPageToCanvas(page as never, canvas, 1, 1, null);

    expect(canvas.width).toBe(WIDTH);
    expect(canvas.height).toBe(HEIGHT);
  });

  it('sizes the canvas to the CROP, not the page', async () => {
    const page = makePage();
    const canvas = makeCanvas();

    // Trim the top 10% and bottom 20%.
    await renderPageToCanvas(page as never, canvas, 1, 1, { x: 0, y: 140, width: 1000, height: 980 });

    expect(canvas.width).toBe(1000);
    expect(canvas.height).toBe(980);
    expect(canvas.style.height).toBe('980px');
  });

  it('actually passes the crop offset through to the pdf viewport', async () => {
    const page = makePage();
    const canvas = makeCanvas();

    await renderPageToCanvas(page as never, canvas, 1, 1, { x: 50, y: 140, width: 900, height: 900 });

    // The viewport must be shifted, otherwise the crop only resizes the canvas
    // and still draws the top-left corner of the page.
    expect(page.getViewport).toHaveBeenCalledWith(
      expect.objectContaining({ offsetX: -50, offsetY: -140 }),
    );
  });

  it('honours device pixel ratio when cropping', async () => {
    const page = makePage();
    const canvas = makeCanvas();

    await renderPageToCanvas(page as never, canvas, 1, 2, { x: 0, y: 0, width: 500, height: 700 });

    expect(canvas.width).toBe(1000); // 500 * dpr 2
    expect(canvas.height).toBe(1400);
  });

  it('ignores a zero-size crop rather than rendering nothing', async () => {
    const page = makePage();
    const canvas = makeCanvas();

    await renderPageToCanvas(page as never, canvas, 1, 1, { x: 0, y: 0, width: 0, height: 0 });

    expect(canvas.width).toBe(WIDTH);
    expect(canvas.height).toBe(HEIGHT);
  });

  it('never crops to a size larger than the page', async () => {
    const page = makePage();
    const canvas = makeCanvas();

    await renderPageToCanvas(page as never, canvas, 1, 1, { x: 0, y: 0, width: 5000, height: 5000 });

    expect(canvas.width).toBe(WIDTH);
    expect(canvas.height).toBe(HEIGHT);
  });
});

describe('normalizedCropToPixels', () => {
  it('converts a normalized crop to pixels', () => {
    expect(normalizedCropToPixels({ top: 0.1, left: 0.2, width: 0.5, height: 0.6 }, 1000, 2000)).toEqual({
      x: 200,
      y: 200,
      width: 500,
      height: 1200,
    });
  });

  it('returns null for no crop or a zero-size page', () => {
    expect(normalizedCropToPixels(null, 100, 100)).toBeNull();
    expect(normalizedCropToPixels(undefined, 100, 100)).toBeNull();
    expect(normalizedCropToPixels({ top: 0, left: 0, width: 1, height: 1 }, 0, 100)).toBeNull();
  });

  it('round-trips through the same page dimensions to the same result', () => {
    const rect = { top: 0.1, left: 0.1, width: 0.8, height: 0.8 };
    const a = normalizedCropToPixels(rect, 1000, 1000);
    const b = normalizedCropToPixels(rect, 1000, 1000);
    expect(a).toEqual(b);
  });

  it('produces a different pixel crop for a different page size', () => {
    const rect = { top: 0.1, left: 0.1, width: 0.8, height: 0.8 };
    const small = normalizedCropToPixels(rect, 500, 500);
    const large = normalizedCropToPixels(rect, 2000, 2000);
    expect(small).not.toEqual(large);
  });
});

describe('crop normalisation helpers', () => {
  it('normalizes and detects an active crop', () => {
    const rect = normalizeCropRect({ top: 0.05, left: 0.05, width: 0.9, height: 0.9 });
    expect(rect).not.toBeNull();
    expect(isCropActive(rect)).toBe(true);
  });

  it('treats a full-page rect as inactive', () => {
    expect(isCropActive({ top: 0, left: 0, width: 1, height: 1 })).toBe(false);
  });
});
