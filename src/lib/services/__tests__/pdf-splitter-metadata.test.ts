/**
 * Splitter contract tests: metadata stamping and part-count fidelity.
 *
 * These exercise `splitPdfByCuttingInstructions` against the committed PDF
 * fixtures so the properties the Digital Music Stand and a downloading musician
 * depend on are pinned, not assumed.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PDFDocument } from 'pdf-lib';

import { splitPdfByCuttingInstructions } from '../pdf-splitter';
import { analyzePageCoverage } from '@/lib/smart-upload/page-coverage';
import type { CuttingInstruction } from '@/types/smart-upload';

const FIXTURES_DIR = path.join(
  process.cwd(),
  'src',
  'lib',
  'services',
  '__tests__',
  'fixtures',
);

function readFixture(name: string): Buffer {
  return fs.readFileSync(path.join(FIXTURES_DIR, name));
}

function inst(
  partName: string,
  pageRange: [number, number],
  overrides: Partial<CuttingInstruction> = {},
): CuttingInstruction {
  return {
    instrument: partName,
    partName,
    section: 'Woodwinds',
    transposition: 'C',
    partNumber: 1,
    pageRange,
    ...overrides,
  };
}

/** pdf-lib's instanceof check fails for a Node Buffer inside Vitest's VM. */
function loadDoc(buffer: Buffer): Promise<PDFDocument> {
  return PDFDocument.load(Uint8Array.from(buffer));
}

describe('splitPdfByCuttingInstructions — page fidelity', () => {
  it('produces one PDF per instruction with the exact requested page count', async () => {
    const parts = await splitPdfByCuttingInstructions(
      readFixture('valid-three-page.pdf'),
      'whole-score',
      [inst('Flute', [0, 0]), inst('Clarinet', [1, 1]), inst('Tuba', [2, 2])],
      { indexing: 'zero' },
    );

    expect(parts).toHaveLength(3);
    expect(parts.map((p) => p.pageCount)).toEqual([1, 1, 1]);

    for (const part of parts) {
      const doc = await loadDoc(part.buffer);
      expect(doc.getPageCount()).toBe(part.pageCount);
    }
  });

  it('sums to the document page count when ranges partition the score', async () => {
    const parts = await splitPdfByCuttingInstructions(
      readFixture('valid-three-page.pdf'),
      'whole-score',
      [inst('Flute', [0, 1]), inst('Tuba', [2, 2], { partNumber: 2 })],
      { indexing: 'zero' },
    );

    const total = parts.reduce((sum, part) => sum + part.pageCount, 0);
    expect(total).toBe(3);
  });

  it('produces identical page counts across repeated runs of the same score', async () => {
    const buffer = readFixture('valid-three-page.pdf');
    const instructions = [inst('Flute', [0, 1]), inst('Tuba', [2, 2], { partNumber: 2 })];

    const first = await splitPdfByCuttingInstructions(buffer, 'score', instructions, {
      indexing: 'zero',
    });
    const second = await splitPdfByCuttingInstructions(buffer, 'score', instructions, {
      indexing: 'zero',
    });

    expect(first.map((p) => p.pageCount)).toEqual(second.map((p) => p.pageCount));
    expect(first.map((p) => p.fileName)).toEqual(second.map((p) => p.fileName));
  });

  it('clamps an over-long range rather than emitting a failure', async () => {
    const parts = await splitPdfByCuttingInstructions(
      readFixture('valid-three-page.pdf'),
      'score',
      [inst('Flute', [1, 99])],
      { indexing: 'zero' },
    );

    expect(parts).toHaveLength(1);
    expect(parts[0].pageCount).toBe(2);
  });

  it('skips an instruction with no valid pageRange instead of emitting an empty PDF', async () => {
    const parts = await splitPdfByCuttingInstructions(
      readFixture('valid-three-page.pdf'),
      'score',
      [
        inst('Flute', [0, 0]),
        { ...inst('Broken', [0, 0]), pageRange: [Number.NaN, 2] },
      ],
      { indexing: 'zero' },
    );

    expect(parts).toHaveLength(1);
    expect(parts[0].instruction.partName).toBe('Flute');
  });
});

describe('splitPdfByCuttingInstructions — embedded metadata', () => {
  it('stamps a per-part title carrying both the work and the part', async () => {
    const parts = await splitPdfByCuttingInstructions(
      readFixture('valid-three-page.pdf'),
      'scan_00482',
      [inst('Flute', [0, 0]), inst('Bb Clarinet', [1, 1], { partNumber: 2 })],
      {
        indexing: 'zero',
        metadata: { title: 'Lincolnshire Posy', author: 'Philip Sparke' },
      },
    );

    expect(parts).toHaveLength(2);

    const doc0 = await loadDoc(parts[0].buffer);
    expect(doc0.getTitle()).toBe('Lincolnshire Posy — Flute');
    expect(doc0.getAuthor()).toBe('Philip Sparke');

    const doc1 = await loadDoc(parts[1].buffer);
    expect(doc1.getTitle()).toBe('Lincolnshire Posy — Bb Clarinet');
    expect(doc1.getAuthor()).toBe('Philip Sparke');
  });

  it('leaves the document untitled when no metadata is supplied', async () => {
    // Pre-existing behaviour for callers that pass no metadata; asserted so a
    // future change does not silently start stamping something misleading.
    const parts = await splitPdfByCuttingInstructions(
      readFixture('valid-three-page.pdf'),
      'score',
      [inst('Flute', [0, 0])],
      { indexing: 'zero' },
    );

    const doc = await loadDoc(parts[0].buffer);
    expect(doc.getTitle()).toBeUndefined();
  });

  it('falls back to the part name alone when the work title is unknown', async () => {
    const parts = await splitPdfByCuttingInstructions(
      readFixture('valid-three-page.pdf'),
      'score',
      [inst('Flute', [0, 0])],
      { indexing: 'zero', metadata: {} },
    );

    const doc = await loadDoc(parts[0].buffer);
    expect(doc.getTitle()).toBe('Flute');
  });

  it('does not destroy the pages it stamps', async () => {
    const parts = await splitPdfByCuttingInstructions(
      readFixture('valid-three-page.pdf'),
      'score',
      [inst('Flute', [0, 2])],
      { indexing: 'zero', metadata: { title: 'Lincolnshire Posy' } },
    );

    expect(parts[0].pageCount).toBe(3);
    const doc = await loadDoc(parts[0].buffer);
    expect(doc.getPageCount()).toBe(3);
  });

  it('round-trips the coverage invariant on a real fixture', async () => {
    const parts = await splitPdfByCuttingInstructions(
      readFixture('valid-three-page.pdf'),
      'score',
      [inst('Flute', [0, 0]), inst('Clarinet', [1, 1]), inst('Tuba', [2, 2])],
      { indexing: 'zero' },
    );

    const report = analyzePageCoverage(
      parts.map((p) => p.instruction),
      3,
      'zero',
    );
    expect(report.coversAllPagesExactlyOnce).toBe(true);
  });
});

describe('splitPdfByCuttingInstructions — filenames', () => {
  it('names each part with the base name and the part name', async () => {
    const parts = await splitPdfByCuttingInstructions(
      readFixture('valid-three-page.pdf'),
      'lincolnshire-posy',
      [inst('Flute', [0, 0]), inst('Bb Clarinet', [1, 2], { partNumber: 2 })],
      { indexing: 'zero' },
    );

    expect(parts.map((p) => p.fileName)).toEqual([
      'lincolnshire-posy - Flute.pdf',
      'lincolnshire-posy - Bb Clarinet.pdf',
    ]);
  });

  it('never emits an empty or extensionless filename', async () => {
    const parts = await splitPdfByCuttingInstructions(
      readFixture('valid-three-page.pdf'),
      'score',
      [inst('Flute', [0, 0]), inst('   ', [1, 2], { partNumber: 2 })],
      { indexing: 'zero' },
    );

    for (const part of parts) {
      expect(part.fileName.endsWith('.pdf')).toBe(true);
      expect(part.fileName.length).toBeGreaterThan(4);
    }
  });
});