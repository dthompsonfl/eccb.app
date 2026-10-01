/**
 * Adaptive PDF Splitter with Multi-Engine Fallover
 *
 * When pdf-lib fails to handle a corrupted or complex PDF structure,
 * this module attempts fallback strategies:
 * 1. pdf-lib (primary) — structural page copy
 * 2. Image-based extraction (fallback) — rasterizes pages with pdfjs +
 *    @napi-rs/canvas and re-embeds them into a fresh pdf-lib document
 * 3. Raw object extraction (last resort) — a self-contained PDF object
 *    parser/serializer that rebuilds a valid document from the original
 *    byte stream without relying on pdf-lib at all
 *
 * Design goals:
 * - Maximize success rate for "hard to parse" PDFs
 * - Maintain per-part failure isolation
 * - Log detailed fallover decisions for debugging
 * - Return successful parts even if some fail
 *
 * All engines are Node-only server code (worker process / route handlers).
 */

import { createRequire } from 'node:module';
import * as nodePath from 'node:path';
import { pathToFileURL } from 'node:url';
import { inflateSync } from 'node:zlib';

import { PDFDocument } from 'pdf-lib';
import { logger } from '@/lib/logger';
import { asError } from '@/lib/services/pdf-source';
import type { CuttingInstruction } from '@/types/smart-upload';

export interface AdaptiveSplitResult {
  instruction: CuttingInstruction;
  buffer: Buffer | null; // null if extraction failed completely
  pageCount: number;
  fileName: string;
  strategy: 'pdf-lib' | 'image-based' | 'raw-slice' | 'failed';
  error?: string;
}

type Strategy = 'pdf-lib' | 'image-based' | 'raw-slice' | 'failed';

interface EngineResult {
  buffer: Buffer;
  pageCount: number;
}

// =============================================================================
// Engine Implementations
// =============================================================================

/**
 * Standard pdf-lib engine — Uses copyPages to extract pages.
 * Fails on corrupted PDFs with invalid object references.
 */
async function pdfLibEngine(
  sourcePdf: PDFDocument,
  pageIndices: number[],
): Promise<EngineResult> {
  let newPdf: PDFDocument | undefined;

  try {
    newPdf = await PDFDocument.create();
    const copiedPages = await newPdf.copyPages(sourcePdf, pageIndices);

    for (const page of copiedPages) {
      newPdf.addPage(page);
    }

    const pdfBytes = await newPdf.save();
    return {
      buffer: Buffer.from(pdfBytes),
      pageCount: copiedPages.length,
    };
  } finally {
    if (newPdf && typeof (newPdf as any).flush === 'function') {
      try {
        await (newPdf as any).flush();
      } catch {
        // best-effort
      }
    }
  }
}

// -----------------------------------------------------------------------------
// Image-based engine
// -----------------------------------------------------------------------------

/** Rasterization DPI for the image fallback. 150 DPI is legible for sheet
 *  music while keeping a typical letter page under ~250 KB of PNG. */
const IMAGE_ENGINE_DPI = 150;
const POINTS_PER_INCH = 72;

const require = createRequire(import.meta.url);

function resolvePdfJsDistDir(): string {
  try {
    const entry = require.resolve('pdfjs-dist/legacy/build/pdf.mjs');
    return nodePath.resolve(nodePath.dirname(entry), '..', '..');
  } catch {
    return nodePath.join(process.cwd(), 'node_modules', 'pdfjs-dist');
  }
}

/**
 * Resolve the pdfjs worker script to an absolute file:// URL.
 *
 * `require('pdfjs-dist/build/pdf.worker')` cannot be used here: the package is
 * `"type": "module"`, so `require` is unavailable at runtime and a bare
 * specifier string is not a valid worker `src` outside a bundler. pdfjs also
 * silently falls back to a "fake worker" (main thread) if the path is
 * unresolvable, so the URL must be absolute.
 */
function resolvePdfJsWorkerSrc(): string {
  const distDir = resolvePdfJsDistDir();
  const candidates = [
    nodePath.join(distDir, 'legacy', 'build', 'pdf.worker.mjs'),
    nodePath.join(distDir, 'build', 'pdf.worker.mjs'),
  ];

  for (const candidate of candidates) {
    if (require('node:fs').existsSync(candidate)) {
      return pathToFileURL(candidate).href;
    }
  }

  return pathToFileURL(candidates[0]).href;
}

interface PdfJsPageViewport {
  width: number;
  height: number;
}

interface PdfJsRenderedPage {
  getViewport(params: { scale: number }): PdfJsPageViewport;
  render(params: {
    canvasContext: unknown;
    viewport: PdfJsPageViewport;
    canvasFactory: unknown;
  }): { promise: Promise<void> };
}

interface PdfJsLoadedPage {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfJsRenderedPage>;
  cleanup?(): void | Promise<void>;
  destroy?(): void | Promise<void>;
}

interface PdfJsLoadingTask {
  promise: Promise<PdfJsLoadedPage>;
  destroy?(): void | Promise<void>;
  onPassword?: ((updatePassword: (password: string) => void, reason: number) => void) | null;
}

interface NapiCanvas {
  getContext(contextId: '2d'): unknown;
  toBuffer(mime: 'image/png'): Buffer;
  width: number;
  height: number;
}

/**
 * pdfjs needs a canvas factory. `@napi-rs/canvas` is a prebuilt native
 * Skia binding (no system cairo/pango build step), so it is safe to require at
 * runtime on the server and in CI.
 */
function createCanvasFactory(createCanvas: (w: number, h: number) => NapiCanvas) {
  return {
    reset() {
      /* no shared cache to reset */
    },
    destroy() {
      /* canvases are released by GC once pdfjs drops its references */
    },
    create(width: number, height: number): NapiCanvas {
      return createCanvas(Math.max(1, Math.floor(width)), Math.max(1, Math.floor(height)));
    },
  };
}

async function destroyPdfJs(loadingTask?: PdfJsLoadingTask, doc?: PdfJsLoadedPage) {
  try {
    if (doc && typeof doc.cleanup === 'function') await doc.cleanup();
  } catch {
    // best-effort
  }
  try {
    if (loadingTask && typeof loadingTask.destroy === 'function') await loadingTask.destroy();
  } catch {
    // best-effort
  }
  try {
    if (doc && typeof doc.destroy === 'function') await doc.destroy();
  } catch {
    // best-effort
  }
}

/**
 * Image-based extraction engine — Renders specified pages to images, then
 * embeds them in a new PDF. Slower but works on PDFs whose internal structure
 * pdf-lib cannot copy (bad xref, exotic object graphs, etc.).
 *
 * The output PDF preserves the original page geometry in points, so every
 * downstream consumer (Music Stand viewer, OCR, thumbnail generation) sees the
 * same page size it would have seen from a structural split. Only the vector
 * content is lost — each page becomes a single raster image.
 *
 * Exported for direct unit testing: pdf-lib's loader is resilient enough that
 * the orchestration-level fallover path is hard to trigger from a fixture
 * alone, so the engine must be provable on its own.
 */
export async function imageBasedEngine(params: {
  pdfBuffer: Buffer;
  pageIndices: number[];
}): Promise<EngineResult> {
  const { pdfBuffer, pageIndices } = params;

  if (!Buffer.isBuffer(pdfBuffer) || pdfBuffer.length === 0) {
    throw new Error('image-based engine: empty source buffer');
  }
  if (!pageIndices.length) {
    throw new Error('image-based engine: no page indices requested');
  }

  logger.debug('image-based fallback: rendering pages to images', {
    requestedPages: pageIndices.length,
    dpi: IMAGE_ENGINE_DPI,
  });

  const [pdfjs, canvasModule] = await Promise.all([
    import('pdfjs-dist/legacy/build/pdf.mjs'),
    import('@napi-rs/canvas'),
  ]);

  const GlobalWorkerOptions = (
    pdfjs as unknown as { GlobalWorkerOptions?: { workerSrc?: string } }
  ).GlobalWorkerOptions;
  if (GlobalWorkerOptions && !GlobalWorkerOptions.workerSrc) {
    GlobalWorkerOptions.workerSrc = resolvePdfJsWorkerSrc();
  }

  const createCanvas = (
    canvasModule as unknown as {
      createCanvas: (w: number, h: number) => NapiCanvas;
    }
  ).createCanvas;
  if (typeof createCanvas !== 'function') {
    throw new Error('image-based engine: @napi-rs/canvas createCanvas unavailable');
  }

  // `disableWorker` is still honoured by pdfjs at runtime but is no longer in
  // the published DocumentInitParameters type, so cast through unknown.
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(pdfBuffer),
    disableWorker: true,
    stopAtErrors: false,
    isEvalSupported: false,
    useSystemFonts: false,
    verbosity: 0,
  } as unknown as Parameters<typeof pdfjs.getDocument>[0]) as unknown as PdfJsLoadingTask;

  if (loadingTask && typeof loadingTask === 'object' && 'onPassword' in loadingTask) {
    loadingTask.onPassword = (updatePassword) => updatePassword('');
  }

  let doc: PdfJsLoadedPage | undefined;
  const canvasFactory = createCanvasFactory(createCanvas);
  const outPdf = await PDFDocument.create();
  let rendered = 0;

  try {
    doc = await loadingTask.promise;

    // 0-indexed request → 1-indexed pdfjs page numbers, de-duplicated and
    // clamped so a bad index can never abort the whole part.
    const targets = Array.from(new Set(pageIndices))
      .filter((index) => Number.isInteger(index) && index >= 0 && index < doc!.numPages)
      .sort((a, b) => a - b);

    if (targets.length === 0) {
      throw new Error(
        `image-based engine: no requested page is within range (document has ${doc.numPages} pages)`,
      );
    }

    for (const index of targets) {
      const page = await doc.getPage(index + 1);
      const baseViewport = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: IMAGE_ENGINE_DPI / POINTS_PER_INCH });

      const canvas = canvasFactory.create(viewport.width, viewport.height);
      const context = canvas.getContext('2d');

      // Sheet music is black on white; force an opaque white backdrop so pages
      // without a background do not come out transparent.
      const fillable = context as { fillStyle: string; fillRect: (a: number, b: number, w: number, h: number) => void };
      if (fillable && typeof fillable.fillRect === 'function') {
        fillable.fillStyle = '#ffffff';
        fillable.fillRect(0, 0, canvas.width, canvas.height);
      }

      await page.render({ canvasContext: context, viewport, canvasFactory }).promise;

      const pngBytes = canvas.toBuffer('image/png');
      const embedded = await outPdf.embedPng(new Uint8Array(pngBytes));
      const widthPt = Math.max(1, Math.round(baseViewport.width));
      const heightPt = Math.max(1, Math.round(baseViewport.height));

      const pageOut = outPdf.addPage([widthPt, heightPt]);
      pageOut.drawImage(embedded, {
        x: 0,
        y: 0,
        width: widthPt,
        height: heightPt,
      });

      rendered += 1;
    }

    const saved = await outPdf.save();
    logger.info('image-based fallback rasterized pages', {
      rendered,
      requestedPages: pageIndices.length,
    });

    return { buffer: Buffer.from(saved), pageCount: rendered };
  } finally {
    await destroyPdfJs(loadingTask, doc);
    if (typeof (outPdf as any).flush === 'function') {
      try {
        await (outPdf as any).flush();
      } catch {
        // best-effort
      }
    }
  }
}

// -----------------------------------------------------------------------------
// Raw object extraction engine
// -----------------------------------------------------------------------------

interface RawObject {
  num: number;
  gen: number;
  /** Everything between `obj` and `endobj` (dictionary text, and stream bytes
   *  when this object has one). Copied byte-for-byte into the output. */
  raw: string;
  /** True when `raw` contains a `stream ... endstream` payload. */
  hasStream: boolean;
  /** Source byte offset of the object's `N G obj` header. */
  start: number;
}

const OBJ_HEADER_RE = /(\d+)\s+(\d+)\s+obj\b/g;
const REF_RE = /(\d+)\s+(\d+)\s+R(?![A-Za-z0-9])/g;
const STREAM_START_RE = /(?:^|[\r\n])stream(?:\r\n|\r|\n)/;
const STREAM_END_RE = /endstream/;

function firstRef(dictText: string, key: string): number | null {
  const re = new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R(?![A-Za-z0-9])`);
  const match = re.exec(dictText);
  return match ? Number.parseInt(match[1], 10) : null;
}

function dictName(dictText: string, key: string): string | null {
  const re = new RegExp(`/${key}\\s*/([A-Za-z0-9#+.\\-]+)`);
  const match = re.exec(dictText);
  return match ? match[1] : null;
}

/** Collect every indirect reference number appearing in a dictionary body. */
function collectRefNums(dictText: string, into: Set<number>): void {
  REF_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = REF_RE.exec(dictText)) !== null) {
    into.add(Number.parseInt(match[1], 10));
  }
}

/** Strip the `/Parent N 0 R` entry so output pages can be re-parented. */
function stripParentRef(dictText: string): string {
  return dictText.replace(/\/Parent\s+\d+\s+\d+\s+R(?![A-Za-z0-9])\s*/g, '');
}

/**
 * Scan a PDF byte buffer for top-level indirect objects without using any
 * cross-reference table. This is the whole point of this engine: broken or
 * missing xref data is exactly the corruption that defeats pdf-lib, yet the
 * objects themselves are still present verbatim in the file.
 */
function scanIndirectObjects(pdfBuffer: Buffer): Map<number, RawObject> {
  const latin1 = pdfBuffer.toString('latin1');
  const objects = new Map<number, RawObject>();

  OBJ_HEADER_RE.lastIndex = 0;
  let headerMatch: RegExpExecArray | null;

  while ((headerMatch = OBJ_HEADER_RE.exec(latin1)) !== null) {
    const num = Number.parseInt(headerMatch[1], 10);
    const gen = Number.parseInt(headerMatch[2], 10);
    const start = headerMatch.index;
    const bodyStart = headerMatch.index + headerMatch[0].length;

    // Duplicate object definitions: later definitions win in normal readers,
    // and the last one is the one a repaired-xref reader should keep.
    if (objects.has(num)) continue;

    // Bound the object body first. Without this bound a dictionary that has no
    // stream of its own would match the *next* object's `stream` keyword and
    // swallow everything in between.
    const endObjIndex = latin1.indexOf('endobj', bodyStart);
    if (endObjIndex === -1) continue;
    const body = latin1.slice(bodyStart, endObjIndex);

    const streamStart = STREAM_START_RE.exec(body);
    let raw: string;
    let hasStream = false;

    if (streamStart) {
      hasStream = true;
      const dictPart = body.slice(0, streamStart.index);
      const dataStart = bodyStart + streamStart.index + streamStart[0].length;

      const lengthMatch = /\/Length\s+(\d+)(?![A-Za-z0-9])/.exec(dictPart);
      let dataEnd = -1;
      let afterEnd = -1;

      if (lengthMatch) {
        const declared = Number.parseInt(lengthMatch[1], 10);
        if (Number.isFinite(declared) && declared >= 0) {
          const candidate = Math.min(dataStart + declared, latin1.length);
          // Validate: the bytes right after the declared data must be
          // endstream (optionally after a single EOL). Binary stream payloads
          // can contain the literal "endstream", so trust only a validated
          // /Length.
          const tail = latin1.slice(candidate, candidate + 32);
          const tailMatch = /^(?:\r\n|\r|\n)?endstream/.exec(tail);
          if (tailMatch) {
            dataEnd = candidate;
            afterEnd = candidate + tailMatch[0].length;
          }
        }
      }

      if (dataEnd === -1) {
        // /Length was indirect or wrong — fall back to the first endstream,
        // still confined to this object's own body.
        const endMatch = STREAM_END_RE.exec(latin1.slice(dataStart, endObjIndex));
        if (!endMatch) continue;
        dataEnd = dataStart + endMatch.index;
        afterEnd = dataStart + endMatch.index + endMatch[0].length;
      }

      const trailingEndObj = latin1.indexOf('endobj', afterEnd);
      const objEnd = trailingEndObj === -1 ? endObjIndex : trailingEndObj;
      raw = latin1.slice(bodyStart, objEnd);
      OBJ_HEADER_RE.lastIndex = objEnd;
    } else {
      raw = body;
      OBJ_HEADER_RE.lastIndex = endObjIndex;
    }

    objects.set(num, { num, gen, raw, hasStream, start });
  }

  expandObjectStreams(objects);
  return objects;
}

/**
 * PDF 1.5+ files pack most objects inside `/Type /ObjStm` compressed object
 * streams. Expand them so pages nested there are still reachable.
 */
function expandObjectStreams(objects: Map<number, RawObject>): void {
  const packed = Array.from(objects.values()).filter(
    (obj) => obj.hasStream && dictName(obj.raw, 'Type') === 'ObjStm',
  );

  for (const container of packed) {
    const streamStart = STREAM_START_RE.exec(container.raw);
    if (!streamStart) continue;

    const dictPart = container.raw.slice(0, streamStart.index);
    const numMatch = /\/N\s+(\d+)(?![A-Za-z0-9])/.exec(dictPart);
    const firstMatch = /\/First\s+(\d+)(?![A-Za-z0-9])/.exec(dictPart);
    if (!numMatch || !firstMatch) continue;

    const dataStart = streamStart.index + streamStart[0].length;
    const data = Buffer.from(container.raw.slice(dataStart), 'latin1');
    const declaredLengthMatch = /\/Length\s+(\d+)(?![A-Za-z0-9])/.exec(dictPart);

    let payload: Buffer;
    try {
      const isFlate = /\/Filter\s*(?:\[\s*)?\/FlateDecode/.test(dictPart);
      const declared = declaredLengthMatch
        ? Number.parseInt(declaredLengthMatch[1], 10)
        : data.length;
      const bounded = data.subarray(0, Math.min(data.length, declared));
      payload = isFlate ? inflateSync(bounded) : bounded;
    } catch {
      continue;
    }

    const headerText = payload.subarray(0, Number.parseInt(firstMatch[1], 10)).toString('latin1');
    const pairs = headerText.trim().split(/\s+/).map((token) => Number.parseInt(token, 10));
    const count = Math.min(
      Number.parseInt(numMatch[1], 10),
      Math.floor(pairs.length / 2),
    );

    const first = Number.parseInt(firstMatch[1], 10);
    for (let i = 0; i < count; i += 1) {
      const objNum = pairs[i * 2];
      const offset = pairs[i * 2 + 1];
      if (!Number.isInteger(objNum) || !Number.isInteger(offset)) continue;
      if (objects.has(objNum)) continue;

      const bodyStart = first + offset;
      const bodyEnd = i + 1 < count ? first + pairs[(i + 1) * 2 + 1] : payload.length;
      if (bodyStart < 0 || bodyStart >= payload.length) continue;

      objects.set(objNum, {
        num: objNum,
        gen: 0,
        raw: payload.subarray(bodyStart, Math.max(bodyStart, bodyEnd)).toString('latin1'),
        hasStream: false,
        start: -1,
      });
    }
  }
}

function findCatalog(objects: Map<number, RawObject>): RawObject | undefined {
  for (const obj of objects.values()) {
    if (dictName(obj.raw, 'Type') === 'Catalog') return obj;
  }
  return undefined;
}

function parseArrayRefs(dictText: string, key: string): number[] {
  const re = new RegExp(`/${key}\\s*\\[([^\\]]*)\\]`);
  const match = re.exec(dictText);
  if (!match) return [];

  const refs: number[] = [];
  REF_RE.lastIndex = 0;
  let refMatch: RegExpExecArray | null;
  const inner = new RegExp(REF_RE.source, 'g');
  while ((refMatch = inner.exec(match[1])) !== null) {
    refs.push(Number.parseInt(refMatch[1], 10));
  }
  return refs;
}

interface RawPage {
  num: number;
  dict: string;
  mediaBox: [number, number, number, number] | null;
}

function parseMediaBox(value: string | null): [number, number, number, number] | null {
  if (!value) return null;
  const nums = value.match(/-?\d+(?:\.\d+)?/g);
  if (!nums || nums.length < 4) return null;
  const [x0, y0, x1, y1] = nums.slice(0, 4).map(Number);
  const box: [number, number, number, number] = [
    Math.min(x0, x1),
    Math.min(y0, y1),
    Math.max(x0, x1),
    Math.max(y0, y1),
  ];
  if (box[2] - box[0] <= 0 || box[3] - box[1] <= 0) return null;
  return box;
}

/** Resolve `/MediaBox` through the page tree, since it is inheritable. */
function resolveInherited(
  obj: RawObject,
  key: string,
  objects: Map<number, RawObject>,
): string | null {
  const seen = new Set<number>();
  let current: RawObject | undefined = obj;

  while (current && !seen.has(current.num)) {
    seen.add(current.num);
    const inline = new RegExp(`/${key}\\s*(\\[[^\\]]*\\])`).exec(current.raw);
    if (inline) return inline[1];
    const parentNum = firstRef(current.raw, 'Parent');
    current = parentNum === null ? undefined : objects.get(parentNum);
  }

  return null;
}

/**
 * Walk the page tree (Root → Pages → Kids) in document order, falling back to
 * object-number order when the tree is unusable. This matters: Smart Upload
 * page ranges are derived from the *visible* page order, so a reordered
 * fallback would silently attach the wrong part of a score to a part.
 */
function collectPagesInOrder(objects: Map<number, RawObject>): RawPage[] {
  const pages: RawPage[] = [];
  const visited = new Set<number>();

  const walk = (obj: RawObject): void => {
    if (!obj || visited.has(obj.num) || pages.length > 100000) return;
    visited.add(obj.num);

    const type = dictName(obj.raw, 'Type');
    const kids = parseArrayRefs(obj.raw, 'Kids');

    // An object stream container holds page dictionaries; it is never itself a
    // page, and treating it as one corrupts the output.
    if (type === 'ObjStm' || type === 'XRef') return;

    if (type === 'Page' || (type !== 'Pages' && kids.length === 0)) {
      pages.push({
        num: obj.num,
        dict: stripParentRef(obj.raw),
        mediaBox: parseMediaBox(resolveInherited(obj, 'MediaBox', objects)),
      });
      return;
    }

    for (const kidNum of kids) {
      const kid = objects.get(kidNum);
      if (kid) walk(kid);
    }
  };

  const catalog = findCatalog(objects);
  const pagesRootNum = catalog ? firstRef(catalog.raw, 'Pages') : null;
  if (pagesRootNum !== null) {
    const pagesRoot = objects.get(pagesRootNum);
    if (pagesRoot) walk(pagesRoot);
  }

  if (pages.length === 0) {
    const fallback = Array.from(objects.values())
      .filter((obj) => dictName(obj.raw, 'Type') === 'Page')
      .sort((a, b) => a.num - b.num);
    for (const obj of fallback) {
      pages.push({
        num: obj.num,
        dict: stripParentRef(obj.raw),
        mediaBox: parseMediaBox(resolveInherited(obj, 'MediaBox', objects)),
      });
    }
  }

  return pages;
}

/** Build a classic cross-reference table + trailer with exact byte offsets. */
function serializePdf(
  emitted: Array<{ num: number; gen: number; body: string }>,
  rootNum: number,
  infoNum: number | null,
): Buffer {
  const sorted = [...emitted].sort((a, b) => a.num - b.num);
  const maxNum = sorted.reduce((max, obj) => Math.max(max, obj.num), rootNum);
  const size = maxNum + 1;

  const offsets = new Array<number>(size).fill(0);
  const chunks: Buffer[] = [];

  let cursor = 0;
  const push = (text: string) => {
    const buf = Buffer.from(text, 'latin1');
    chunks.push(buf);
    cursor += buf.length;
  };

  push('%PDF-1.7\n');
  push(`%${String.fromCharCode(0xe2, 0xe3, 0xcf, 0xd3)}\n`);

  for (const obj of sorted) {
    offsets[obj.num] = cursor;
    push(`${obj.num} ${obj.gen} obj\n`);
    push(obj.body);
    push('\nendobj\n');
  }

  const xrefStart = cursor;
  let xref = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let num = 1; num < size; num += 1) {
    const offset = offsets[num];
    xref +=
      offset === 0
        ? '0000000000 65535 f \n'
        : `${offset.toString().padStart(10, '0')} ${String(
            sorted.find((o) => o.num === num)?.gen ?? 0,
          )
            .padStart(5, '0')
            .slice(0, 5)} n \n`;
  }
  push(xref);

  let trailer = `trailer\n<< /Size ${size} /Root ${rootNum} 0 R`;
  if (infoNum !== null) trailer += ` /Info ${infoNum} 0 R`;
  trailer += ' >>\n';
  push(trailer);
  push(`startxref\n${xrefStart}\n%%EOF\n`);

  return Buffer.concat(chunks);
}

/**
 * Raw object extraction — rebuilds a valid, self-contained PDF from the
 * original byte stream without pdf-lib, pdfjs, or any xref table.
 *
 * Strategy: scan for `N G obj` blocks, resolve the page tree to get document
 * order, then copy the transitive closure of every object the selected pages
 * reference **under their original object numbers**. Keeping the original
 * numbering means no indirect reference anywhere in the copied dictionaries
 * needs rewriting, which is what makes this safe. Only the catalog and the
 * page tree are regenerated, at freshly allocated object numbers.
 *
 * The output opens in pdf-lib, pdfjs, and any conforming reader, with the
 * original text and vector content intact — this is a true repair, not a
 * downgraded rendering. It is still the last resort because it cannot recover
 * data that is genuinely missing from the file.
 *
 * Exported for direct unit testing — see the note on imageBasedEngine.
 */
export async function rawSliceEngine(params: {
  pdfBuffer: Buffer;
  pageIndices: number[];
}): Promise<EngineResult> {
  const { pdfBuffer, pageIndices } = params;

  if (!Buffer.isBuffer(pdfBuffer) || pdfBuffer.length === 0) {
    throw new Error('raw-slice engine: empty source buffer');
  }
  if (!pageIndices.length) {
    throw new Error('raw-slice engine: no page indices requested');
  }

  const latin1Head = pdfBuffer.subarray(0, 1024).toString('latin1');
  if (!latin1Head.includes('%PDF-')) {
    throw new Error('raw-slice engine: missing %PDF- header');
  }
  if (/\/Encrypt\b/.test(pdfBuffer.toString('latin1'))) {
    throw new Error(
      'raw-slice engine: encrypted PDFs are not supported (streams cannot be re-keyed)',
    );
  }

  logger.debug('raw-slice fallback: rebuilding document from raw objects', {
    requestedPages: pageIndices.length,
  });

  const objects = scanIndirectObjects(pdfBuffer);
  if (objects.size === 0) {
    throw new Error('raw-slice engine: no indirect objects found in source buffer');
  }

  const allPages = collectPagesInOrder(objects);
  if (allPages.length === 0) {
    throw new Error('raw-slice engine: no pages found in source buffer');
  }

  const targets = Array.from(new Set(pageIndices))
    .filter((index) => Number.isInteger(index) && index >= 0 && index < allPages.length)
    .sort((a, b) => a - b);

  if (targets.length === 0) {
    throw new Error(
      `raw-slice engine: no requested page is within range (document has ${allPages.length} pages)`,
    );
  }

  // Transitive closure of referenced objects, skipping the original /Parent
  // links we stripped (we supply our own page tree).
  //
  // The selected page objects are rewritten below (re-parented, /MediaBox made
  // explicit), so they must neither be copied verbatim by this closure nor have
  // their references walked — the latter would drag in the stale page tree and
  // every unselected page beneath it.
  const targetPageNums = new Set(targets.map((index) => allPages[index].num));
  const pageDictByNum = new Map(
    targets.map((index) => [allPages[index].num, allPages[index].dict] as const),
  );

  const needed = new Set<number>();
  const queue: number[] = [];
  for (const index of targets) {
    const page = allPages[index];
    if (!needed.has(page.num)) {
      needed.add(page.num);
      queue.push(page.num);
    }
  }

  while (queue.length > 0) {
    const num = queue.pop() as number;
    const obj = objects.get(num);
    if (!obj) {
      // A dangling reference is survivable: some readers tolerate it and the
      // rest of the page still renders. Record and continue.
      logger.debug('raw-slice fallback: dangling reference skipped', { objectNumber: num });
      continue;
    }
    // Page objects are rewritten from their stripped dictionary below, so walk
    // that stripped form rather than the raw one. Walking the raw dictionary
    // would follow /Parent into the stale page tree and pull every unselected
    // page into the output; skipping pages entirely would lose /Contents and
    // /Resources and produce blank pages.
    const source = targetPageNums.has(num) ? pageDictByNum.get(num) : obj.raw;
    if (source === undefined) continue;
    const refs = new Set<number>();
    collectRefNums(source, refs);
    for (const ref of refs) {
      if (!needed.has(ref)) {
        needed.add(ref);
        queue.push(ref);
      }
    }
  }

  let maxNum = 0;
  for (const num of needed) maxNum = Math.max(maxNum, num);

  const catalogNum = maxNum + 1;
  const pagesNum = maxNum + 2;
  const kidsRefs = targets.map((index) => `${allPages[index].num} 0 R`).join(' ');

  // The selected page objects are rewritten below (re-parented, /MediaBox made
  // explicit), so they must not also be copied verbatim by the closure.
  const emitted: Array<{ num: number; gen: number; body: string }> = [];
  const missing: number[] = [];
  for (const num of Array.from(needed).sort((a, b) => a - b)) {
    if (targetPageNums.has(num)) continue;
    const obj = objects.get(num);
    if (!obj) {
      missing.push(num);
      continue;
    }
    emitted.push({ num: obj.num, gen: obj.gen, body: obj.raw });
  }

  if (missing.length > 0) {
    logger.debug('raw-slice fallback: missing objects omitted', {
      missingCount: missing.length,
    });
  }

  for (const index of targets) {
    const page = allPages[index];
    // Edit the dictionary in place rather than rebuilding it: the copied body
    // still starts with `<<` and ends with `>>`, so keys must be inserted
    // before the closing delimiter, not appended after it.
    let body = page.dict
      .replace(/\/Parent\s+\d+\s+\d+\s+R(?![A-Za-z0-9])\s*/g, '')
      .replace(/\/Type\s*\/Page(?![A-Za-z0-9])\s*/, '');

    const additions: string[] = ['/Type /Page', `/Parent ${pagesNum} 0 R`];
    // Only add /MediaBox when the page did not already carry its own; a
    // duplicate key makes some readers reject the dictionary outright.
    if (page.mediaBox && !/\/MediaBox\s*\[/.test(body)) {
      additions.push(`/MediaBox [${page.mediaBox.join(' ')}]`);
    }

    const closeAt = body.lastIndexOf('>>');
    if (closeAt === -1) {
      body = `<< ${additions.join(' ')} ${body} >>`;
    } else {
      body = `${body.slice(0, closeAt)}${additions.join(' ')} ${body.slice(closeAt)}`;
    }

    emitted.push({ num: page.num, gen: 0, body });
  }

  emitted.push({
    num: pagesNum,
    gen: 0,
    body: `<< /Type /Pages /Kids [${kidsRefs}] /Count ${targets.length} >>`,
  });
  emitted.push({
    num: catalogNum,
    gen: 0,
    body: `<< /Type /Catalog /Pages ${pagesNum} 0 R >>`,
  });

  const output = serializePdf(emitted, catalogNum, null);
  logger.info('raw-slice fallback rebuilt document', {
    pagesWritten: targets.length,
    objectsCopied: emitted.length,
    outputBytes: output.length,
  });

  return { buffer: output, pageCount: targets.length };
}

// =============================================================================
// Adaptive Split Logic
// =============================================================================

/**
 * Attempt to split a PDF using multiple engines with fallover.
 * Returns result even if buffer is null (partial success).
 */
export async function adaptivelyExtractPages(
  pdfBuffer: Buffer,
  sourcePdf: PDFDocument | undefined,
  pageIndices: number[],
  totalPages: number,
): Promise<{
  buffer: Buffer | null;
  pageCount: number;
  strategy: Strategy;
  falloverReason?: string;
}> {
  // Engines are attempted in order of fidelity. pdf-lib is only usable when a
  // document object was actually produced by the caller; when pdf-lib could
  // not even open the file, the fallback engines are the only option.
  const engines: Array<{
    name: Strategy;
    run: () => Promise<EngineResult>;
  }> = [];

  if (sourcePdf) {
    engines.push({
      name: 'pdf-lib',
      run: () => pdfLibEngine(sourcePdf, pageIndices),
    });
  }
  engines.push({
    name: 'image-based',
    run: () => imageBasedEngine({ pdfBuffer, pageIndices }),
  });
  engines.push({
    name: 'raw-slice',
    run: () => rawSliceEngine({ pdfBuffer, pageIndices }),
  });

  if (totalPages > 0) {
    logger.debug('Adaptive extraction engine order', {
      engines: engines.map((engine) => engine.name),
      requestedPages: pageIndices.length,
    });
  }

  let lastError: Error | null = null;
  const failures: Array<{ engine: Strategy; message: string }> = [];

  for (const engine of engines) {
    try {
      logger.debug(`Attempting PDF extraction with ${engine.name}`, {
        pageCount: pageIndices.length,
      });

      const result = await engine.run();

      logger.info(`Successfully extracted pages using ${engine.name}`, {
        strategy: engine.name,
        pageCount: result.pageCount,
      });

      return {
        buffer: result.buffer,
        pageCount: result.pageCount,
        strategy: engine.name,
      };
    } catch (error) {
      const err = asError(error);
      lastError = err;
      failures.push({ engine: engine.name, message: err.message });
      logger.debug(`${engine.name} extraction failed, attempting next engine`, {
        strategy: engine.name,
        errorMessage: err.message,
      });
    }
  }

  const finalError = lastError?.message || 'Unknown error';
  logger.error('All PDF extraction engines failed', {
    strategy: 'failed',
    finalError,
    failures,
  });

  return {
    buffer: null,
    pageCount: 0,
    strategy: 'failed',
    falloverReason: finalError,
  };
}

/**
 * Wraps the adaptive extraction in a user-friendly result object.
 * Partial successes are marked with strategy info; complete failures
 * return buffer: null.
 */
export async function adaptiveSplitWithFallover(
  pdfBuffer: Buffer,
  sourcePdf: PDFDocument | undefined,
  totalPages: number,
  instruction: CuttingInstruction,
  fileName: string,
  pageIndices: number[],
): Promise<AdaptiveSplitResult> {
  const result = await adaptivelyExtractPages(
    pdfBuffer,
    sourcePdf,
    pageIndices,
    totalPages,
  );

  if (result.buffer === null) {
    return {
      instruction,
      buffer: null,
      pageCount: 0,
      fileName,
      strategy: 'failed',
      error: result.falloverReason,
    };
  }

  return {
    instruction,
    buffer: result.buffer,
    pageCount: result.pageCount,
    fileName,
    strategy: result.strategy,
  };
}
