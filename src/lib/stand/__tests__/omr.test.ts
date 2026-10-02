/**
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import {
  DEFAULT_MAX_OMR_PAGES,
  imageBufferToBase64,
  isJpegBuffer,
  isPdfBuffer,
  mergePageAnalyses,
  readStoredFile,
  renderFullScore,
  StorageReadError,
} from '../omr';

/** A canvas stand-in that records the pages actually rendered. */
function makeRenderer(pageCount: number, opts?: { failOn?: number[] }) {
  const renderedPages: number[] = [];
  const getPage = vi.fn(async (pageNumber: number) => ({
    getViewport: ({ scale }: { scale: number }) => ({
      width: 100 * scale,
      height: 200 * scale,
    }),
    render: (_ctx: unknown) => {
      renderedPages.push(pageNumber);
      if (opts?.failOn?.includes(pageNumber)) {
        return { promise: Promise.reject(new Error('render failed')) };
      }
      return { promise: Promise.resolve() };
    },
  }));

  const createCanvas = (width: number, height: number) => ({
    getContext: () => ({}),
    toBuffer: () => Buffer.from(`page-${width}x-${height}`),
  });

  return { getPage, createCanvas, renderedPages, pageCount };
}

describe('renderFullScore', () => {
  it('renders EVERY page, not just page 1', async () => {
    const r = makeRenderer(5);
    const result = await renderFullScore({
      pageCount: 5,
      getPage: r.getPage as never,
      createCanvas: r.createCanvas as never,
    });

    expect(result.pages).toHaveLength(5);
    expect(r.renderedPages).toEqual([1, 2, 3, 4, 5]);
  });

  it('records the real total page count', async () => {
    const r = makeRenderer(7);
    const result = await renderFullScore({
      pageCount: 7,
      getPage: r.getPage as never,
      createCanvas: r.createCanvas as never,
    });
    expect(result.totalPages).toBe(7);
    expect(result.truncated).toBe(false);
  });

  it('renders a single-page score', async () => {
    const r = makeRenderer(1);
    const result = await renderFullScore({
      pageCount: 1,
      getPage: r.getPage as never,
      createCanvas: r.createCanvas as never,
    });
    expect(result.pages).toHaveLength(1);
  });

  it('caps a pathological score and reports the truncation', async () => {
    const r = makeRenderer(500);
    const result = await renderFullScore({
      pageCount: 500,
      getPage: r.getPage as never,
      createCanvas: r.createCanvas as never,
    });

    expect(result.pages.length).toBeLessThanOrEqual(DEFAULT_MAX_OMR_PAGES);
    expect(result.truncated).toBe(true);
    // The true total is still reported, not the rendered count.
    expect(result.totalPages).toBe(500);
  });

  it('honours an explicit cap', async () => {
    const r = makeRenderer(20);
    const result = await renderFullScore({
      pageCount: 20,
      getPage: r.getPage as never,
      createCanvas: r.createCanvas as never,
      maxPages: 3,
    });
    expect(result.pages).toHaveLength(3);
    expect(result.truncated).toBe(true);
  });

  it('handles a zero-page document', async () => {
    const result = await renderFullScore({
      pageCount: 0,
      getPage: vi.fn() as never,
      createCanvas: vi.fn() as never,
    });
    expect(result.pages).toEqual([]);
    expect(result.totalPages).toBe(0);
  });

  it('numbers pages from 1', async () => {
    const r = makeRenderer(3);
    const result = await renderFullScore({
      pageCount: 3,
      getPage: r.getPage as never,
      createCanvas: r.createCanvas as never,
    });
    expect(result.pages.map((p) => p.pageNumber)).toEqual([1, 2, 3]);
  });
});

describe('mergePageAnalyses', () => {
  it('sums measures across pages', () => {
    const merged = mergePageAnalyses([
      { measureCount: 12 },
      { measureCount: 16 },
      { measureCount: 8 },
    ]);
    expect(merged.measureCount).toBe(36);
  });

  it('takes tempo from the earliest page that states it', () => {
    // A title page often omits tempo; a later system states it.
    const merged = mergePageAnalyses([
      { keySignature: 'C major' },
      { tempo: 96, keySignature: 'C major' },
    ]);
    expect(merged.tempo).toBe(96);
    expect(merged.keySignature).toBe('C major');
  });

  it('keeps the first tempo when pages disagree', () => {
    const merged = mergePageAnalyses([{ tempo: 120 }, { tempo: 60 }]);
    expect(merged.tempo).toBe(120);
  });

  it('unions instruments', () => {
    const merged = mergePageAnalyses([
      { instruments: ['Flute', 'Clarinet'] },
      { instruments: ['Clarinet', 'Tuba'] },
    ]);
    expect(new Set(merged.instruments)).toEqual(new Set(['Flute', 'Clarinet', 'Tuba']));
  });

  it('omits measureCount when no page reported it', () => {
    const merged = mergePageAnalyses([{ tempo: 90 }, { tempo: 90 }]);
    expect(merged.measureCount).toBeUndefined();
  });

  it('tolerates null and undefined pages', () => {
    const merged = mergePageAnalyses([null, { tempo: 88 }, undefined]);
    expect(merged.tempo).toBe(88);
  });

  it('returns an empty result for no analyses', () => {
    expect(mergePageAnalyses([])).toEqual({});
  });

  it('keeps the first difficulty and first notes', () => {
    const merged = mergePageAnalyses([
      { difficulty: 'GRADE_3', notes: 'first' },
      { difficulty: 'GRADE_6', notes: 'second' },
    ]);
    expect(merged.difficulty).toBe('GRADE_3');
    expect(merged.notes).toBe('first');
  });
});

describe('readStoredFile', () => {
  it('reads a local-driver stream into a buffer', async () => {
    const bytes = Buffer.from('%PDF-1.7 private score');
    const result = await readStoredFile(async () => ({
      stream: Readable.from([bytes]),
      metadata: { contentType: 'application/pdf' },
    }));

    expect(result.buffer.toString()).toBe('%PDF-1.7 private score');
    expect(result.contentType).toBe('application/pdf');
  });

  it('reassembles a chunked stream', async () => {
    const result = await readStoredFile(async () => ({
      stream: Readable.from([Buffer.from('abc'), Buffer.from('def')]),
    }));
    expect(result.buffer.toString()).toBe('abcdef');
  });

  it('fails loudly when the driver returns a signed URL', async () => {
    // This is exactly why the route must not self-fetch: an S3 signed URL is
    // not bytes, and silently treating it as such would analyse a URL string.
    await expect(readStoredFile(async () => 'https://s3.example/signed')).rejects.toThrow(
      StorageReadError,
    );
  });

  it('handles an empty object', async () => {
    const result = await readStoredFile(async () => ({ stream: Readable.from([]) }));
    expect(result.buffer.length).toBe(0);
  });
});

describe('buffer format detection', () => {
  it('detects a PDF', () => {
    expect(isPdfBuffer(Buffer.from('%PDF-1.7'))).toBe(true);
    expect(isPdfBuffer(Buffer.from('not a pdf'))).toBe(false);
  });

  it('detects a JPEG', () => {
    expect(isJpegBuffer(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
    expect(isJpegBuffer(Buffer.from([0x89, 0x50]))).toBe(false);
  });

  it('labels an image by its real content, not a claimed type', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

    expect(imageBufferToBase64(jpeg).mimeType).toBe('image/jpeg');
    expect(imageBufferToBase64(png).mimeType).toBe('image/png');
  });

  it('produces decodable base64', () => {
    const bytes = Buffer.from('score image bytes');
    const { base64 } = imageBufferToBase64(bytes);
    expect(Buffer.from(base64, 'base64').toString()).toBe('score image bytes');
  });
});
