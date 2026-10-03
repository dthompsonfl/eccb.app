/**
 * Page-coverage invariant tests.
 *
 * These assert the property that matters most in Smart Upload: every page of an
 * uploaded score ends up in exactly one instrument part. The range-level tests
 * use the pure analyser; the end-to-end tests drive the real splitter against
 * the committed PDF fixtures so a regression in page selection is caught too.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import * as path from 'node:path';

import {
  analyzePageCoverage,
  describePageCoverageFailure,
  findMissingParts,
  normalizeRangeToOneIndexed,
} from '../page-coverage';
import { splitPdfByCuttingInstructions, validatePdfBuffer } from '@/lib/services/pdf-splitter';
import { buildGapInstructions, validateAndNormalizeInstructions } from '@/lib/services/cutting-instructions';
import { resolvePartTitle } from '../part-naming';
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

describe('normalizeRangeToOneIndexed', () => {
  it('reads a 1-indexed range as given', () => {
    expect(normalizeRangeToOneIndexed([1, 4], 10, 'one')).toEqual({
      start: 1, end: 4, indexing: 'one',
    });
  });

  it('shifts a 0-indexed range up by one', () => {
    expect(normalizeRangeToOneIndexed([0, 3], 10, 'zero')).toEqual({
      start: 1, end: 4, indexing: 'zero',
    });
  });

  it('resolves an ambiguous [1,1] by the declared convention, not by guessing', () => {
    // The same range means page 1 under one-indexing and page 2 under
    // zero-indexing. Guessing here is how a player gets the wrong music.
    expect(normalizeRangeToOneIndexed([1, 1], 3, 'one')).toEqual({
      start: 1, end: 1, indexing: 'one',
    });
    expect(normalizeRangeToOneIndexed([1, 1], 3, 'zero')).toEqual({
      start: 2, end: 2, indexing: 'zero',
    });
  });

  it('clamps a range that overruns the end of the document', () => {
    expect(normalizeRangeToOneIndexed([8, 40], 10, 'one')).toEqual({
      start: 8, end: 10, indexing: 'one',
    });
  });

  it('rejects inverted, non-numeric, and out-of-document ranges', () => {
    expect(normalizeRangeToOneIndexed([5, 2], 10, 'one')).toBeNull();
    expect(normalizeRangeToOneIndexed([Number.NaN, 3], 10, 'one')).toBeNull();
    expect(normalizeRangeToOneIndexed([1], 10, 'one')).toBeNull();
    expect(normalizeRangeToOneIndexed(['a', 'b'], 10, 'one')).toBeNull();
  });

  it('refuses to clamp a range lying entirely outside the document', () => {
    // Clamping [20,30] onto a 10-page score would silently hand page 10 to a
    // part that never covered it. Report it as unlocatable instead.
    expect(normalizeRangeToOneIndexed([20, 30], 10, 'one')).toBeNull();
    expect(normalizeRangeToOneIndexed([-5, -1], 10, 'one')).toBeNull();
  });
});

describe('analyzePageCoverage — the union must cover 1..N exactly once', () => {
  it('passes for a clean non-overlapping partition', () => {
    const report = analyzePageCoverage(
      [inst('Flute', [1, 2]), inst('Clarinet', [3, 5]), inst('Tuba', [6, 8])],
      8,
    );

    expect(report.uncoveredPages).toEqual([]);
    expect(report.duplicatedPages).toEqual([]);
    expect(report.unlocatableParts).toEqual([]);
    expect(report.coversAllPagesExactlyOnce).toBe(true);
    expect(describePageCoverageFailure(report)).toBe('');
  });

  it('passes when the union is contiguous but ranges arrive out of order', () => {
    const report = analyzePageCoverage(
      [inst('Tuba', [7, 8]), inst('Flute', [1, 3]), inst('Clarinet', [4, 6])],
      8,
    );
    expect(report.coversAllPagesExactlyOnce).toBe(true);
  });

  it('passes for a single part covering the whole score', () => {
    const report = analyzePageCoverage([inst('Full Score', [1, 12])], 12);
    expect(report.coversAllPagesExactlyOnce).toBe(true);
  });

  it('DETECTS the title page being dropped before the first boundary', () => {
    // Classic failure: the detector finds Flute first and never claims page 1.
    const report = analyzePageCoverage([inst('Flute', [2, 4])], 5);

    expect(report.coversAllPagesExactlyOnce).toBe(false);
    expect(report.uncoveredPages).toEqual([1, 5]);
  });

  it('DETECTS trailing pages after the last boundary', () => {
    const report = analyzePageCoverage(
      [inst('Flute', [1, 2]), inst('Clarinet', [3, 4])],
      6,
    );
    expect(report.uncoveredPages).toEqual([5, 6]);
  });

  it('DETECTS a duplicated page across two parts', () => {
    const report = analyzePageCoverage(
      [inst('Flute', [1, 3]), inst('Clarinet', [3, 5])],
      5,
    );
    expect(report.duplicatedPages).toEqual([3]);
    expect(report.coversAllPagesExactlyOnce).toBe(false);
  });

  it('DETECTS a part whose range cannot be located at all', () => {
    const report = analyzePageCoverage(
      [inst('Flute', [1, 3]), inst('Oboe', [99, 120])],
      5,
    );
    expect(report.unlocatableParts).toEqual(['Oboe']);
    expect(report.coversAllPagesExactlyOnce).toBe(false);
    expect(describePageCoverageFailure(report)).toContain('could not be located');
  });

  it('REPORTS clamped ranges rather than silently accepting them', () => {
    const report = analyzePageCoverage(
      [inst('Flute', [1, 2]), inst('Tuba', [3, 99])],
      5,
    );
    expect(report.clampedParts).toHaveLength(1);
    expect(report.clampedParts[0].partName).toBe('Tuba');
    expect(report.clampedParts[0].clamped).toEqual({ start: 3, end: 5 });
    // Clamping recovered the pages, so coverage itself is intact.
    expect(report.uncoveredPages).toEqual([]);
  });

  it('fails closed on a zero-page document rather than reporting success', () => {
    const report = analyzePageCoverage([inst('Flute', [1, 3])], 0);
    expect(report.coversAllPagesExactlyOnce).toBe(false);
    expect(report.unlocatableParts).toEqual(['Flute']);
  });

  it('treats an empty instruction set as full coverage loss, not success', () => {
    const report = analyzePageCoverage([], 10);
    expect(report.coversAllPagesExactlyOnce).toBe(false);
    expect(report.uncoveredPages).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('never reports success while any page is missing from a long score', () => {
    // A 30-page score with one boundary missed in the middle.
    const report = analyzePageCoverage(
      [inst('Flute', [1, 14]), inst('Clarinet', [16, 30])],
      30,
    );
    expect(report.uncoveredPages).toEqual([15]);
    expect(report.coversAllPagesExactlyOnce).toBe(false);
  });

  it('is deterministic regardless of input ordering', () => {
    const a = analyzePageCoverage(
      [inst('A', [1, 5]), inst('B', [6, 9])],
      9,
    );
    const b = analyzePageCoverage(
      [inst('B', [6, 9]), inst('A', [1, 5])],
      9,
    );
    expect(a.coversAllPagesExactlyOnce).toBe(b.coversAllPagesExactlyOnce);
    expect(a.uncoveredPages).toEqual(b.uncoveredPages);
  });
});

describe('buildGapInstructions closes coverage without hiding it', () => {
  it('fills every gap so the union covers the document exactly once', () => {
    const instructions = [inst('Flute', [2, 4]), inst('Tuba', [7, 8])];
    const gaps = buildGapInstructions(instructions, 8);

    const combined = [...instructions, ...gaps];
    const report = analyzePageCoverage(combined, 8, 'zero');

    expect(report.coversAllPagesExactlyOnce).toBe(true);
    expect(report.uncoveredPages).toEqual([]);
    expect(report.duplicatedPages).toEqual([]);
  });

  it('survives the real validate → gap-fill → validate round trip', () => {
    // Reproduces the production sequence the processor runs.
    const raw = [inst('Flute', [1, 2]), inst('Clarinet', [4, 5])];

    const validated = validateAndNormalizeInstructions(raw, 6, {
      oneIndexed: true,
      detectGaps: true,
    });
    // Validation must report the gap rather than claim full coverage.
    expect(validated.gaps?.length).toBeGreaterThan(0);

    const withGaps = [
      ...validated.instructions,
      ...buildGapInstructions(validated.instructions, 6),
    ];
    const report = analyzePageCoverage(withGaps, 6, 'zero');

    expect(report.coversAllPagesExactlyOnce).toBe(true);
  });
});

describe('findMissingParts — silent omission is unacceptable', () => {
  it('returns nothing when every expected part was produced', () => {
    expect(
      findMissingParts(['Flute', 'Clarinet', 'Tuba'], [
        { partName: 'Flute' },
        { partName: 'Clarinet' },
        { partName: 'Tuba' },
      ]),
    ).toEqual([]);
  });

  it('names the part that could not be located', () => {
    expect(
      findMissingParts(['Flute', 'Oboe', 'Tuba'], [
        { partName: 'Flute' },
        { partName: 'Tuba' },
      ]),
    ).toEqual(['Oboe']);
  });

  it('matches across chair-prefix and case differences', () => {
    expect(
      findMissingParts(['1st Flute', 'Oboe'], [{ partName: 'Flute' }]),
    ).toEqual(['Oboe']);
    expect(
      findMissingParts(['FLUTE'], [{ partName: 'flute' }]),
    ).toEqual([]);
  });

  it('reports a gap once even when two expected names canonicalise alike', () => {
    // "1st Flute" and "Flute" are the same desk once the chair prefix is
    // dropped, so an absent Flute is one missing part, not two.
    expect(
      findMissingParts(['1st Flute', 'Flute', 'Oboe'], [{ partName: 'Tuba' }]),
    ).toEqual(['1st Flute', 'Oboe']);
  });

  it('distinguishes numbered chairs from a bare instrument', () => {
    // "Flute 1" and "Flute" are different desks on the stand; collapsing them
    // would hide a genuinely missing part.
    expect(findMissingParts(['Flute 1'], [{ partName: 'Flute' }])).toEqual(['Flute 1']);
    expect(findMissingParts(['Flute 1'], [{ partName: 'Flute 1' }])).toEqual([]);
  });

  it('ignores empty expected names rather than reporting phantom gaps', () => {
    expect(findMissingParts(['', '   ', 'Oboe'], [{ partName: 'Flute' }])).toEqual([
      'Oboe',
    ]);
  });
});

describe('end-to-end: real PDF split preserves full page coverage', () => {
  it('splits a 3-page fixture into 3 one-page parts covering 1..3 exactly once', async () => {
    const pdfBuffer = readFixture('valid-three-page.pdf');
    const validation = await validatePdfBuffer(pdfBuffer);
    expect(validation.valid).toBe(true);

    const totalPages = validation.pageCount ?? 0;
    expect(totalPages).toBe(3);

    const instructions: CuttingInstruction[] = [
      inst('Flute', [0, 0], { partNumber: 1 }),
      inst('Bb Clarinet', [1, 1], { partNumber: 2 }),
      inst('Tuba', [2, 2], { partNumber: 3 }),
    ];

    const parts = await splitPdfByCuttingInstructions(
      pdfBuffer,
      'lincolnshire-posy',
      instructions,
      { indexing: 'zero' },
    );

    expect(parts).toHaveLength(3);

    // The union of what was actually produced must cover 1..3 exactly once.
    const produced = analyzePageCoverage(
      parts.map((p) => p.instruction),
      totalPages,
      'zero',
    );
    expect(produced.coversAllPagesExactlyOnce).toBe(true);

    // And the rendered page counts must match the requested ranges: no part
    // silently lost a page inside the splitter itself.
    expect(parts.map((p) => p.pageCount)).toEqual([1, 1, 1]);
  });

  it('reports the real page count of a single part spanning the fixture', async () => {
    const pdfBuffer = readFixture('valid-three-page.pdf');

    const parts = await splitPdfByCuttingInstructions(
      pdfBuffer,
      'whole-score',
      [inst('Full Score', [0, 2], { section: 'Score' })],
      { indexing: 'zero' },
    );

    expect(parts).toHaveLength(1);
    expect(parts[0].pageCount).toBe(3);
  });

  it('stamps work title and part name into each part PDF metadata', async () => {
    const pdfBuffer = readFixture('valid-three-page.pdf');

    const parts = await splitPdfByCuttingInstructions(
      pdfBuffer,
      'scan_00482',
      [inst('Flute', [0, 1]), inst('Tuba', [2, 2], { partNumber: 2 })],
      {
        indexing: 'zero',
        metadata: { title: 'Lincolnshire Posy', author: 'Philip Sparke' },
      },
    );

    expect(parts).toHaveLength(2);

    for (const part of parts) {
      // pdf-lib's instanceof Uint8Array check fails for a Node Buffer inside
      // Vitest's VM realm, so hand it a same-realm copy.
      const doc = await PDFDocument.load(Uint8Array.from(part.buffer));
      expect(doc.getTitle()).toBe(
        `Lincolnshire Posy — ${part.instruction.partName}`,
      );
      expect(doc.getAuthor()).toBe('Philip Sparke');
    }
  });

  it('builds findable filenames carrying the work title for every part', async () => {
    const pdfBuffer = readFixture('valid-three-page.pdf');

    const parts = await splitPdfByCuttingInstructions(
      pdfBuffer,
      'scan_00482',
      [inst('Flute', [0, 1]), inst('Tuba', [2, 2], { partNumber: 2 })],
      { indexing: 'zero' },
    );

    for (const part of parts) {
      const resolved = resolvePartTitle({
        extractedTitle: 'Lincolnshire Posy',
        uploadedFileName: 'scan_00482.pdf',
        part: { instrument: part.instruction.partName },
        partNumber: part.instruction.partNumber,
        pageRange: part.instruction.pageRange,
      });

      expect(resolved.fileName).toContain('Lincolnshire_Posy');
      expect(resolved.fileName).toContain(part.instruction.partName.replace(/\s/g, '_'));
      expect(resolved.fileName.endsWith('.pdf')).toBe(true);
    }
  });

  it('is idempotent: splitting the same score twice yields identical filenames', async () => {
    const pdfBuffer = readFixture('valid-three-page.pdf');
    const instructions = [inst('Flute', [0, 2])];

    const first = await splitPdfByCuttingInstructions(
      pdfBuffer, 'scan_00482', instructions, { indexing: 'zero' },
    );
    const second = await splitPdfByCuttingInstructions(
      pdfBuffer, 'scan_00482', instructions, { indexing: 'zero' },
    );

    expect(first.map((p) => p.fileName)).toEqual(second.map((p) => p.fileName));
  });
});