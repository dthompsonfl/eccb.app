/**
 * Page Coverage Invariant
 *
 * The single most important safety property of the Smart Upload pipeline is
 * that **every page of an uploaded score ends up in exactly one instrument
 * part**. A dropped page means a musician is missing music at a concert, which
 * is the worst failure this app can produce.
 *
 * This module is the executable definition of that property. It is pure — no
 * PDF parsing, no database, no I/O — so it can be asserted directly in unit
 * tests against real page ranges, and reused at every point in the pipeline
 * where a split is about to be committed.
 *
 * What it catches, and why each is a real defect:
 *
 * - **Uncovered pages** — a page before the first detected part boundary (the
 *   title page and the conductor's full score are the usual casualties), a page
 *   after the last boundary, or a page whose part the detector never matched.
 * - **Duplicated pages** — the same page in two parts. Also fatal: it means one
 *   part is short and the ranges were mis-assigned.
 * - **Out-of-range pages** — a range pointing past the end of the document,
 *   which would silently truncate.
 *
 * Note this deliberately does NOT paper over gaps by auto-generating filler
 * parts and then declaring success. `buildGapInstructions` in
 * `cutting-instructions.ts` exists to make gaps *visible* and label them
 * ("Unlabelled Pages 3-4"); whether to ship those is a routing decision made by
 * the caller, not something this invariant should quietly absorb.
 */

import type { CuttingInstruction } from '@/types/smart-upload';

/** A contiguous run of pages, 1-indexed and inclusive — how humans count. */
export interface PageSpan {
  start: number;
  end: number;
}

export interface NormalizedPartRange {
  /** Part name, echoed back for actionable error messages. */
  partName: string;
  /** 1-indexed, inclusive. */
  start: number;
  end: number;
  indexing: PageIndexing;
}

export interface PageCoverageReport {
  /** True when pages 1..totalPages are covered exactly once each. */
  coversAllPagesExactlyOnce: boolean;
  totalPages: number;
  /** Pages in no part at all. Sorted ascending, 1-indexed. */
  uncoveredPages: number[];
  /** Pages appearing in more than one part. Sorted ascending, 1-indexed. */
  duplicatedPages: number[];
  /**
   * Parts whose requested range did not survive normalisation — empty, or
   * entirely outside the document. These are parts that will NOT be produced,
   * which is exactly the "could not locate this part" case.
   */
  unlocatableParts: string[];
  /** Ranges clipped to fit inside the document, if any were. */
  clampedParts: Array<{ partName: string; requested: PageSpan; clamped: PageSpan }>;
  /** Normalized ranges actually analysed, in ascending start order. */
  parts: NormalizedPartRange[];
}

/**
 * How a set of page ranges is numbered.
 *
 * This is an explicit input, never inferred. A range of `[1, 1]` on a 3-page
 * score is genuinely ambiguous — it is page 1 under 1-indexing and page 2 under
 * 0-indexing — and guessing wrong silently attaches the wrong music to the
 * wrong player. Every production caller knows which convention it is holding
 * (the splitter is told via `indexing`, and persisted instructions are
 * converted with `toOneIndexedInstructions`), so the convention is passed in.
 */
export type PageIndexing = 'zero' | 'one';

export interface NormalizedPartRange {
  /** Part name, echoed back for actionable error messages. */
  partName: string;
  /** 1-indexed, inclusive. */
  start: number;
  end: number;
  indexing: PageIndexing;
}

export interface PageCoverageReport {
  /** True when pages 1..totalPages are covered exactly once each. */
  coversAllPagesExactlyOnce: boolean;
  totalPages: number;
  /** Pages in no part at all. Sorted ascending, 1-indexed. */
  uncoveredPages: number[];
  /** Pages appearing in more than one part. Sorted ascending, 1-indexed. */
  duplicatedPages: number[];
  /**
   * Parts whose requested range did not survive normalisation — empty,
   * inverted, or lying entirely outside the document. These parts will NOT be
   * produced, which is exactly the "could not locate this part" case.
   */
  unlocatableParts: string[];
  /** Ranges clipped to fit inside the document, if any were. */
  clampedParts: Array<{ partName: string; requested: PageSpan; clamped: PageSpan }>;
  /** Normalized ranges actually analysed, in ascending start order. */
  parts: NormalizedPartRange[];
}

/**
 * Normalize a raw `pageRange` into 1-indexed inclusive bounds.
 *
 * Returns `null` when the range cannot be interpreted at all — not a pair of
 * finite integers, inverted, or lying entirely outside the document. Callers
 * must treat `null` as "this part could not be located", never as "zero pages".
 *
 * A range that only *partly* overruns the document is clamped to the pages it
 * does legitimately cover and reported via `PageCoverageReport.clampedParts`.
 * A range that lies entirely outside is NOT clamped: clamping `[20, 30]` on a
 * 10-page score down to `[10, 10]` would silently hand page 10 to a part that
 * never covered it, which is the misattribution this module exists to prevent.
 */
export function normalizeRangeToOneIndexed(
  pageRange: unknown,
  totalPages: number,
  indexing: PageIndexing = 'one',
): { start: number; end: number; indexing: PageIndexing } | null {
  if (
    !Array.isArray(pageRange) ||
    pageRange.length < 2 ||
    typeof pageRange[0] !== 'number' ||
    typeof pageRange[1] !== 'number' ||
    !Number.isFinite(pageRange[0]) ||
    !Number.isFinite(pageRange[1])
  ) {
    return null;
  }
  if (totalPages <= 0) return null;

  const rawStart = Math.trunc(pageRange[0]);
  const rawEnd = Math.trunc(pageRange[1]);
  if (rawStart > rawEnd) return null;

  // Convert to 1-indexed under the declared convention.
  const start = indexing === 'zero' ? rawStart + 1 : rawStart;
  const end = indexing === 'zero' ? rawEnd + 1 : rawEnd;

  // Entirely outside the document: the part cannot be located at all.
  if (start > totalPages || end < 1) return null;

  const clampedStart = Math.max(1, Math.min(start, totalPages));
  const clampedEnd = Math.max(1, Math.min(end, totalPages));
  if (clampedStart > clampedEnd) return null;

  return { start: clampedStart, end: clampedEnd, indexing };
}

/**
 * Analyse page coverage for a set of cutting instructions.
 *
 * This is the single place the coverage question is answered, so the splitter,
 * the quality gates, and the review UI can never disagree about whether a score
 * is fully covered.
 */
export function analyzePageCoverage(
  instructions: readonly CuttingInstruction[],
  totalPages: number,
  indexing: PageIndexing = 'one',
): PageCoverageReport {
  const parts: NormalizedPartRange[] = [];
  const unlocatableParts: string[] = [];
  const clampedParts: PageCoverageReport['clampedParts'] = [];

  if (totalPages <= 0) {
    return {
      coversAllPagesExactlyOnce: false,
      totalPages,
      uncoveredPages: [],
      duplicatedPages: [],
      unlocatableParts: instructions.map((i) => i.partName),
      clampedParts,
      parts,
    };
  }

  for (const instruction of instructions) {
    const partName = instruction.partName || '(unnamed part)';
    const normalized = normalizeRangeToOneIndexed(
      instruction.pageRange,
      totalPages,
      indexing,
    );

    if (!normalized) {
      unlocatableParts.push(partName);
      continue;
    }

    const requested: PageSpan = {
      start: instruction.pageRange[0],
      end: instruction.pageRange[1],
    };
    if (
      requested.start !== normalized.start ||
      requested.end !== normalized.end
    ) {
      clampedParts.push({
        partName,
        requested,
        clamped: { start: normalized.start, end: normalized.end },
      });
    }

    parts.push({
      partName,
      start: normalized.start,
      end: normalized.end,
      indexing: normalized.indexing,
    });
  }

  parts.sort((a, b) => a.start - b.start || a.end - b.end);

  const counts = new Array<number>(totalPages + 1).fill(0);
  for (const part of parts) {
    for (let page = part.start; page <= part.end; page += 1) {
      if (page >= 1 && page <= totalPages) counts[page] += 1;
    }
  }

  const uncoveredPages: number[] = [];
  const duplicatedPages: number[] = [];
  for (let page = 1; page <= totalPages; page += 1) {
    if (counts[page] === 0) uncoveredPages.push(page);
    else if (counts[page] > 1) duplicatedPages.push(page);
  }

  return {
    coversAllPagesExactlyOnce:
      uncoveredPages.length === 0 && duplicatedPages.length === 0 && unlocatableParts.length === 0,
    totalPages,
    uncoveredPages,
    duplicatedPages,
    unlocatableParts,
    clampedParts,
    parts,
  };
}

/**
 * Human-readable summary of why coverage failed, for logs, notes, and the
 * reviewer-facing UI. Empty string when coverage is complete.
 */
export function describePageCoverageFailure(report: PageCoverageReport): string {
  if (report.coversAllPagesExactlyOnce) return '';

  const problems: string[] = [];

  if (report.uncoveredPages.length > 0) {
    problems.push(
      `${report.uncoveredPages.length} page(s) in no part: [${report.uncoveredPages.join(', ')}]`,
    );
  }

  if (report.duplicatedPages.length > 0) {
    problems.push(
      `${report.duplicatedPages.length} page(s) in more than one part: [${report.duplicatedPages.join(', ')}]`,
    );
  }

  if (report.unlocatableParts.length > 0) {
    problems.push(
      `${report.unlocatableParts.length} part(s) could not be located in the score: [${report.unlocatableParts.join(', ')}]`,
    );
  }

  return problems.join('; ');
}

/**
 * Which expected instrument parts never made it into the produced set.
 *
 * A part with no detected boundary must be surfaced to the librarian as
 * "could not locate this part" rather than silently omitted — silent omission
 * means a section simply has no music at the concert with no explanation.
 *
 * Matching is by normalised part name so cosmetic differences (case, chair
 * prefix, whitespace) do not produce phantom "missing" reports.
 */
export function findMissingParts(
  expectedPartNames: readonly string[],
  producedParts: readonly { partName: string }[],
): string[] {
  const canonical = (value: string): string =>
    value
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ')
      // Drop a leading chair ordinal: "1st Flute" and "Flute" are the same desk.
      .replace(/^(1st|2nd|3rd|4th|aux|solo)\s+/, '')
      .replace(/[^a-z0-9 ]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

  const produced = new Set(producedParts.map((p) => canonical(p.partName)));
  const missing: string[] = [];
  const seen = new Set<string>();

  for (const name of expectedPartNames) {
    const key = canonical(name);
    if (key.length === 0) continue;
    if (produced.has(key)) continue;
    // Two expected entries can canonicalise to the same desk ("Flute 1",
    // "1st Flute"); report the gap once rather than twice.
    if (seen.has(key)) continue;
    seen.add(key);
    missing.push(name.trim());
  }

  return missing;
}