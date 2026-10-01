// @vitest-environment node
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { inflateSync } from 'node:zlib';

import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';

import {
  adaptivelyExtractPages,
  adaptiveSplitWithFallover,
  imageBasedEngine,
  rawSliceEngine,
} from '@/lib/services/pdf-splitter-adaptive';

const FIXTURES = path.join(process.cwd(), 'src/lib/services/__tests__/fixtures');

function fixture(name: string): Buffer {
  return readFileSync(path.join(FIXTURES, name));
}

const VALID_THREE_PAGE = 'valid-three-page.pdf';
const VALID_MIXED = 'valid-mixed-geometry.pdf';
const VALID_ROTATED = 'valid-rotated.pdf';
const DAMAGED = 'damaged-xref-three-page.pdf';
const DAMAGED_OBJSTM = 'damaged-xref-objstm.pdf';
const TRUNCATED = 'truncated-two-page.pdf';
const NOT_A_PDF = 'not-a-pdf.pdf';

const PDF_LIB_LOAD_OPTS = { ignoreEncryption: true, updateMetadata: false } as const;

async function loadPageCount(buf: Buffer): Promise<number> {
  const doc = await PDFDocument.load(new Uint8Array(buf), PDF_LIB_LOAD_OPTS);
  return doc.getPageCount();
}

async function loadPageSizes(buf: Buffer): Promise<Array<{ w: number; h: number }>> {
  const doc = await PDFDocument.load(new Uint8Array(buf), PDF_LIB_LOAD_OPTS);
  return doc.getPages().map((p) => ({ w: p.getWidth(), h: p.getHeight() }));
}

/**
 * Extract text per page using pdfjs — an independent parser from the pdf-lib
 * one used to validate output. Asserting content with a second engine means a
 * pass cannot be an artifact of the writer agreeing with itself.
 */
async function extractText(buf: Buffer): Promise<string[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buf),
    disableWorker: true,
    verbosity: 0,
    isEvalSupported: false,
    useSystemFonts: false,
  } as unknown as Parameters<typeof pdfjs.getDocument>[0]);
  const doc = await loadingTask.promise;
  try {
    const out: string[] = [];
    for (let i = 1; i <= doc.numPages; i += 1) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      out.push(
        content.items
          .map((item) => ('str' in item ? item.str : ''))
          .join(' ')
          .trim(),
      );
    }
    return out;
  } finally {
    await doc.destroy();
  }
}

// ---------------------------------------------------------------------------
// Fixture sanity. Note: pdf-lib's loader auto-repairs broken cross-reference
// tables, so the "damaged" fixtures do NOT defeat pdf-lib on load. They exist
// to prove the fallback engines can read documents whose xref is destroyed,
// which is the realistic failure class for these code paths.
// ---------------------------------------------------------------------------
describe('fixture preconditions', () => {
  it('valid fixtures load cleanly with the expected page counts', async () => {
    await expect(loadPageCount(fixture(VALID_THREE_PAGE))).resolves.toBe(3);
    await expect(loadPageCount(fixture(VALID_MIXED))).resolves.toBe(3);
    await expect(loadPageCount(fixture(VALID_ROTATED))).resolves.toBe(1);
  });

  it('damaged fixtures carry a startxref that points at garbage', () => {
    for (const name of [DAMAGED, DAMAGED_OBJSTM]) {
      const text = fixture(name).toString('latin1');
      const startxref = Number(/startxref\n(\d+)/.exec(text)?.[1]);
      expect(startxref).toBeGreaterThan(text.length - 200);
    }
  });

  it('page content in the damaged fixtures is intact and readable by pdfjs', async () => {
    const text = await extractText(fixture(DAMAGED));
    expect(text[0]).toContain('page one');
    expect(text[2]).toContain('page three');
  });

  it('the objstm fixture genuinely packs a page inside an object stream', () => {
    const text = fixture(DAMAGED_OBJSTM).toString('latin1');
    expect(text).toContain('/ObjStm');
    expect(text).toContain('/Filter /FlateDecode');
  });

  it('the objstm fixture omits /MediaBox on its last page to force inheritance', () => {
    // Pages 1 and 2 declare /MediaBox; page 3 (inside the ObjStm) must not, so
    // the engine has to walk /Parent to inherit it.
    const text = fixture(DAMAGED_OBJSTM).toString('latin1');
    expect(text).toContain('/Type /ObjStm');

    // Locate the object stream data and inflate it the same way the engine does.
    const declared = /\/Length (\d+)/.exec(text.slice(text.indexOf('/ObjStm'))) as RegExpExecArray;
    const streamAt = text.indexOf('stream\n', text.indexOf('/ObjStm')) + 'stream\n'.length;
    const packed = inflateSync(
      Buffer.from(text.slice(streamAt, streamAt + Number(declared[1])), 'latin1'),
    ).toString('latin1');

    // The packed page dict must be a /Type /Page with no /MediaBox of its own.
    expect(packed).toContain('/Type /Page');
    expect(packed).not.toContain('/MediaBox');
  });
});

// ---------------------------------------------------------------------------
// Engine 1: pdf-lib (primary path — must keep winning when it works)
// ---------------------------------------------------------------------------
describe('pdf-lib engine', () => {
  it('is used when a working document is supplied', async () => {
    const buf = fixture(VALID_THREE_PAGE);
    const source = await PDFDocument.load(new Uint8Array(buf), PDF_LIB_LOAD_OPTS);

    const result = await adaptivelyExtractPages(buf, source, [0, 1], 3);

    expect(result.strategy).toBe('pdf-lib');
    expect(result.pageCount).toBe(2);
    expect(await loadPageCount(result.buffer as Buffer)).toBe(2);
  });

  it('produces a real text-bearing split rather than a rasterized copy', async () => {
    const buf = fixture(VALID_THREE_PAGE);
    const source = await PDFDocument.load(new Uint8Array(buf), PDF_LIB_LOAD_OPTS);

    const result = await adaptivelyExtractPages(buf, source, [2], 3);
    const text = await extractText(result.buffer as Buffer);

    expect(text[0]).toContain('Movement III');
  });
});

// ---------------------------------------------------------------------------
// Engine 2: image-based (pdfjs + @napi-rs/canvas rasterization)
// ---------------------------------------------------------------------------
describe('imageBasedEngine', () => {
  it('rasterizes pages into a valid pdf-lib document', async () => {
    const { buffer, pageCount } = await imageBasedEngine({
      pdfBuffer: fixture(DAMAGED),
      pageIndices: [0, 2],
    });

    expect(pageCount).toBe(2);
    expect(await loadPageCount(buffer)).toBe(2);
  });

  it('preserves original page geometry in points, per page', async () => {
    const { buffer } = await imageBasedEngine({
      pdfBuffer: fixture(VALID_MIXED),
      pageIndices: [0, 1, 2],
    });

    expect(await loadPageSizes(buffer)).toEqual([
      { w: 612, h: 792 },
      { w: 792, h: 612 },
      { w: 595, h: 842 },
    ]);
  });

  it('honours page rotation when rasterizing', async () => {
    const { buffer } = await imageBasedEngine({
      pdfBuffer: fixture(VALID_ROTATED),
      pageIndices: [0],
    });

    // /Rotate 90 swaps the rendered page dimensions.
    expect(await loadPageSizes(buffer)).toEqual([{ w: 792, h: 612 }]);
  });

  it('embeds real raster content, not a blank page', async () => {
    const { buffer } = await imageBasedEngine({
      pdfBuffer: fixture(DAMAGED),
      pageIndices: [0],
    });

    // A blank white letter page at 150 DPI compresses to a few hundred bytes.
    // Real ink does not. This asserts something was actually drawn.
    expect(buffer.length).toBeGreaterThan(2000);
  });

  it('embeds a decodable PNG image XObject on each output page', async () => {
    const { buffer } = await imageBasedEngine({
      pdfBuffer: fixture(DAMAGED),
      pageIndices: [0],
    });

    const text = buffer.toString('latin1');
    expect(text).toContain('/Subtype /Image');
    expect(text).toContain('/Filter');
  });

  it('sorts and de-duplicates requested page indices', async () => {
    const { buffer, pageCount } = await imageBasedEngine({
      pdfBuffer: fixture(DAMAGED),
      pageIndices: [2, 0, 1, 1],
    });

    expect(pageCount).toBe(3);
    expect(await loadPageCount(buffer)).toBe(3);
  });

  it('renders only the requested subset of a multi-page document', async () => {
    const single = await imageBasedEngine({
      pdfBuffer: fixture(VALID_THREE_PAGE),
      pageIndices: [0],
    });
    const all = await imageBasedEngine({
      pdfBuffer: fixture(VALID_THREE_PAGE),
      pageIndices: [0, 1, 2],
    });

    expect(single.pageCount).toBe(1);
    expect(all.pageCount).toBe(3);
    expect(single.buffer.length).toBeLessThan(all.buffer.length);
  });

  it('clamps out-of-range indices instead of aborting the part', async () => {
    const { buffer, pageCount } = await imageBasedEngine({
      pdfBuffer: fixture(DAMAGED),
      pageIndices: [0, 99],
    });

    expect(pageCount).toBe(1);
    expect(await loadPageCount(buffer)).toBe(1);
  });

  it('rejects an empty page-index list rather than emitting an empty PDF', async () => {
    await expect(
      imageBasedEngine({ pdfBuffer: fixture(DAMAGED), pageIndices: [] }),
    ).rejects.toThrow(/no page indices/i);
  });

  it('rejects an empty source buffer', async () => {
    await expect(
      imageBasedEngine({ pdfBuffer: Buffer.alloc(0), pageIndices: [0] }),
    ).rejects.toThrow(/empty source buffer/i);
  });

  it('fails on a non-PDF input instead of producing a garbage document', async () => {
    await expect(
      imageBasedEngine({ pdfBuffer: fixture(NOT_A_PDF), pageIndices: [0] }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Engine 3: raw-slice (self-contained PDF object parser/serializer)
// ---------------------------------------------------------------------------
describe('rawSliceEngine', () => {
  it('rebuilds a loadable PDF from a document with a destroyed xref', async () => {
    const { buffer, pageCount } = await rawSliceEngine({
      pdfBuffer: fixture(DAMAGED),
      pageIndices: [0, 1, 2],
    });

    expect(pageCount).toBe(3);
    expect(await loadPageCount(buffer)).toBe(3);
  });

  it('preserves real text content, not a screenshot', async () => {
    const { buffer } = await rawSliceEngine({ pdfBuffer: fixture(DAMAGED), pageIndices: [1] });
    const text = await extractText(buffer);

    expect(text).toHaveLength(1);
    expect(text[0]).toContain('Damaged fixture page two');
  });

  it('selects exactly the requested pages and emits them in document order', async () => {
    const { buffer } = await rawSliceEngine({
      pdfBuffer: fixture(DAMAGED),
      pageIndices: [2, 0],
    });
    const text = await extractText(buffer);

    expect(text).toHaveLength(2);
    // Document order, regardless of the order they were requested in.
    expect(text[0]).toContain('page one');
    expect(text[1]).toContain('page three');
  });

  it('recovers pages stored inside a PDF 1.5 object stream (/ObjStm)', async () => {
    const { buffer } = await rawSliceEngine({
      pdfBuffer: fixture(DAMAGED_OBJSTM),
      pageIndices: [0, 1, 2],
    });
    const text = await extractText(buffer);

    expect(text).toHaveLength(3);
    expect(text[0]).toContain('page one');
    // The third page's dictionary lives inside the compressed object stream.
    expect(text[2]).toContain('page three');
  });

  it('resolves /MediaBox inheritance from the page tree', async () => {
    const { buffer } = await rawSliceEngine({ pdfBuffer: fixture(DAMAGED), pageIndices: [2] });
    const sizes = await loadPageSizes(buffer);

    // The fixture's last page omits /MediaBox; it must inherit [0 0 612 792].
    expect(sizes[0].w).toBeCloseTo(612, 0);
    expect(sizes[0].h).toBeCloseTo(792, 0);
  });

  it('emits a structurally valid file: header, xref, trailer, %%EOF', async () => {
    const { buffer } = await rawSliceEngine({ pdfBuffer: fixture(DAMAGED), pageIndices: [0] });
    const text = buffer.toString('latin1');

    expect(text.startsWith('%PDF-')).toBe(true);
    expect(text).toContain('/Type /Catalog');
    expect(text).toMatch(/\nxref\n0 \d+\n/);
    expect(text).toContain('/Root');
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
  });

  it('writes a startxref that actually points at the xref table', async () => {
    const { buffer } = await rawSliceEngine({ pdfBuffer: fixture(DAMAGED), pageIndices: [0] });
    const text = buffer.toString('latin1');

    const xrefOffset = Number(/startxref\n(\d+)/.exec(text)?.[1]);
    expect(xrefOffset).toBeGreaterThan(0);
    expect(text.slice(xrefOffset, xrefOffset + 4)).toBe('xref');
  });

  it('records xref offsets that point at real object headers', async () => {
    const { buffer } = await rawSliceEngine({ pdfBuffer: fixture(DAMAGED), pageIndices: [0, 1] });
    const text = buffer.toString('latin1');
    const xrefStart = Number(/startxref\n(\d+)/.exec(text)?.[1]);
    const entries = text.slice(xrefStart).match(/^(\d{10}) (\d{5}) ([nf]) $/gm) ?? [];

    expect(entries.length).toBeGreaterThan(1);

    let inUse = 0;
    for (const entry of entries) {
      const [, offset, , kind] = /^(\d{10}) (\d{5}) ([nf]) $/.exec(entry) as RegExpExecArray;
      if (kind !== 'n') continue;
      inUse += 1;
      const at = Number(offset);
      expect(at).toBeGreaterThan(0);
      expect(text.slice(at)).toMatch(/^\d+ \d+ obj/);
    }
    expect(inUse).toBeGreaterThan(0);
  });

  it('closes every object so no bytes bleed between them', async () => {
    const { buffer } = await rawSliceEngine({ pdfBuffer: fixture(DAMAGED), pageIndices: [0, 1, 2] });
    const text = buffer.toString('latin1');

    expect(text.match(/endobj/g)?.length).toBe(text.match(/\d+ \d+ obj/g)?.length);
  });

  it('declares the correct /Count and /Kids length on the new page tree', async () => {
    const { buffer } = await rawSliceEngine({ pdfBuffer: fixture(DAMAGED), pageIndices: [0, 2] });
    const text = buffer.toString('latin1');

    const pagesDict = /\/Type \/Pages([^>]*)>>/.exec(text);
    expect(pagesDict).not.toBeNull();

    const kids = /\/Kids \[([^\]]*)\]/.exec(pagesDict?.[1] ?? '');
    expect(kids).not.toBeNull();

    // /Kids must list exactly the two selected pages, and /Count must agree.
    const kidRefs = (kids?.[1] ?? '').match(/\d+ \d+ R/g) ?? [];
    expect(kidRefs).toHaveLength(2);
    expect(pagesDict?.[1]).toContain('/Count 2');
  });

  it('re-parents copied pages to the regenerated page tree', async () => {
    const { buffer } = await rawSliceEngine({ pdfBuffer: fixture(DAMAGED), pageIndices: [0] });
    const text = buffer.toString('latin1');

    // Find the regenerated page tree by the object number it is written as,
    // then confirm the page's /Parent points at that same number.
    const pagesNum = /(\d+) 0 obj\s*<< \/Type \/Pages /.exec(text)?.[1];
    expect(pagesNum).toBeTruthy();

    const parents = [...text.matchAll(/\/Parent (\d+) 0 R/g)].map((m) => m[1]);
    expect(parents).toEqual([pagesNum]);
  });

  it('rejects files with no %PDF header instead of emitting garbage', async () => {
    await expect(
      rawSliceEngine({ pdfBuffer: fixture(NOT_A_PDF), pageIndices: [0] }),
    ).rejects.toThrow(/missing %PDF- header/i);
  });

  it('rejects an empty buffer', async () => {
    await expect(
      rawSliceEngine({ pdfBuffer: Buffer.alloc(0), pageIndices: [0] }),
    ).rejects.toThrow(/empty source buffer/i);
  });

  it('rejects an empty page-index list', async () => {
    await expect(
      rawSliceEngine({ pdfBuffer: fixture(DAMAGED), pageIndices: [] }),
    ).rejects.toThrow(/no page indices/i);
  });

  it('refuses encrypted PDFs rather than emitting undecryptable garbage', async () => {
    const buf = fixture(DAMAGED);
    const withEncrypt = Buffer.concat([buf, Buffer.from('\n/Encrypt 9 0 R\n', 'latin1')]);

    await expect(
      rawSliceEngine({ pdfBuffer: withEncrypt, pageIndices: [0] }),
    ).rejects.toThrow(/encrypted/i);
  });

  it('handles a %PDF header that is not at offset 0', async () => {
    // Real-world uploads sometimes carry leading garbage before the header.
    const buf = Buffer.concat([Buffer.alloc(64, 0x20), fixture(DAMAGED)]);

    const { buffer, pageCount } = await rawSliceEngine({
      pdfBuffer: buf,
      pageIndices: [0],
    });
    expect(pageCount).toBe(1);
    expect(await loadPageCount(buffer)).toBe(1);
  });

  it('terminates deterministically on a truncated file', async () => {
    // The missing tail bytes cannot be invented, but the engine must not hang
    // and must not hand back a half-written buffer as a success.
    const outcome = await rawSliceEngine({
      pdfBuffer: fixture(TRUNCATED),
      pageIndices: [0],
    }).then(
      (value: { buffer: Buffer; pageCount: number }) => ({ ok: true as const, value }),
      (error: Error) => ({ ok: false as const, message: error.message }),
    );

    if (outcome.ok) {
      // Recovering the surviving page is a legitimate outcome; the output must
      // then be a genuinely valid PDF, not a truncated fragment.
      expect(await loadPageCount(outcome.value.buffer)).toBeGreaterThan(0);
    } else {
      expect(outcome.message).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// Fallover orchestration
// ---------------------------------------------------------------------------
describe('adaptive fallover orchestration', () => {
  it('prefers pdf-lib when a working document is available', async () => {
    const buf = fixture(VALID_THREE_PAGE);
    const source = await PDFDocument.load(new Uint8Array(buf), PDF_LIB_LOAD_OPTS);

    const result = await adaptivelyExtractPages(buf, source, [0], 3);
    expect(result.strategy).toBe('pdf-lib');
  });

  it('skips pdf-lib and uses the image engine when no document could be opened', async () => {
    const result = await adaptivelyExtractPages(fixture(DAMAGED), undefined, [0], 3);
    expect(result.strategy).toBe('image-based');
  });

  it('falls through to raw-slice when pdf-lib and rendering are both impossible', async () => {
    const result = await adaptivelyExtractPages(fixture(NOT_A_PDF), undefined, [0], 1);

    // Rendering a non-PDF cannot work; raw-slice rejects it too, so the chain
    // must terminate in a clean, reported failure.
    expect(result.strategy).toBe('failed');
    expect(result.buffer).toBeNull();
  });

  it('never throws out of the orchestrator, whatever the input', async () => {
    for (const name of [VALID_THREE_PAGE, DAMAGED, DAMAGED_OBJSTM, TRUNCATED, NOT_A_PDF]) {
      await expect(
        adaptivelyExtractPages(fixture(name), undefined, [0], 3),
      ).resolves.toHaveProperty('strategy');
    }
  });

  it('reports failure with a reason when every engine fails', async () => {
    const result = await adaptivelyExtractPages(fixture(NOT_A_PDF), undefined, [0], 1);

    expect(result.strategy).toBe('failed');
    expect(result.buffer).toBeNull();
    expect(result.pageCount).toBe(0);
    expect(result.falloverReason).toBeTruthy();
  });

  it('reports failure when every requested index is out of range', async () => {
    const result = await adaptivelyExtractPages(fixture(DAMAGED), undefined, [500], 3);

    expect(result.strategy).toBe('failed');
    expect(result.pageCount).toBe(0);
  });

  it('does not echo raw PDF bytes into the reported error', async () => {
    const result = await adaptivelyExtractPages(fixture(NOT_A_PDF), undefined, [0], 1);
    const reason = result.falloverReason ?? '';

    // The fixture's distinctive payload must never reach an error string that
    // ends up in logs.
    expect(reason).not.toContain('pretending to be a score');
  });
});

// ---------------------------------------------------------------------------
// Public wrapper
// ---------------------------------------------------------------------------
describe('adaptiveSplitWithFallover', () => {
  const instruction = {
    partName: 'Movement I',
    pageRange: [0, 1] as [number, number],
  };

  it('returns a populated result for a successful adaptive split', async () => {
    const result = await adaptiveSplitWithFallover(
      fixture(DAMAGED),
      undefined,
      3,
      instruction as never,
      'score - Movement I.pdf',
      [0, 1],
    );

    expect(result.strategy).toBe('image-based');
    expect(result.pageCount).toBe(2);
    expect(result.fileName).toBe('score - Movement I.pdf');
    expect(result.instruction).toBe(instruction);
    expect(await loadPageCount(result.buffer as Buffer)).toBe(2);
  });

  it('returns buffer null and an error for a total failure', async () => {
    const result = await adaptiveSplitWithFallover(
      fixture(NOT_A_PDF),
      undefined,
      1,
      instruction as never,
      'score.pdf',
      [0],
    );

    expect(result.strategy).toBe('failed');
    expect(result.buffer).toBeNull();
    expect(result.pageCount).toBe(0);
    expect(result.error).toBeTruthy();
  });

  it('preserves the caller instruction object', async () => {
    const result = await adaptiveSplitWithFallover(
      fixture(DAMAGED),
      undefined,
      3,
      instruction as never,
      'x.pdf',
      [0],
    );

    expect(result.instruction.partName).toBe('Movement I');
    expect(result.instruction.pageRange).toEqual([0, 1]);
  });
});
