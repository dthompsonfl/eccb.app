import { describe, it, expect } from 'vitest';
import { evaluateQualityGates } from '@/lib/smart-upload/quality-gates';

/**
 * Coverage-gate contract.
 *
 * `findCoverageIssues` short-circuits when `totalPages <= 0`, which means an
 * UNKNOWN page count silently disables dropped/duplicated-page detection. A
 * caller that cannot determine the page count must therefore route to human
 * review rather than treat "no issues found" as "coverage verified".
 *
 * These tests pin the gate's behaviour so the fail-open behaviour cannot be
 * reintroduced unnoticed.
 */

const BASE_METADATA = {
  cuttingInstructions: [
    { instrument: 'Flute', partName: 'Flute', section: 'Woodwinds', transposition: 'C', partNumber: 1, pageRange: [1, 2] as [number, number] },
    { instrument: 'Trumpet', partName: 'Trumpet', section: 'Brass', transposition: 'Bb', partNumber: 2, pageRange: [3, 4] as [number, number] },
  ],
} as never;

const BASE_PARTS = [
  { instrument: 'Flute', partName: 'Flute', pageRange: [1, 2], confidence: 90 },
  { instrument: 'Trumpet', partName: 'Trumpet', pageRange: [3, 4], confidence: 90 },
] as never;

describe('evaluateQualityGates — page coverage', () => {
  it('passes when parts fully cover the known page count', () => {
    const result = evaluateQualityGates({
      parsedParts: BASE_PARTS,
      metadata: BASE_METADATA,
      totalPages: 4,
      maxPagesPerPart: 12,
      segmentationConfidence: 95,
    });

    expect(result.reasons.join(' ')).not.toMatch(/coverage|uncovered|overlap/i);
  });

  it('detects uncovered pages when the page count IS known', () => {
    // Only page 1 covered out of 4 — a dropped-pages situation the gate must catch.
    const result = evaluateQualityGates({
      parsedParts: [{ instrument: 'Flute', partName: 'Flute', pageRange: [1, 1], confidence: 90 }] as never,
      metadata: {
        cuttingInstructions: [
          { instrument: 'Flute', partName: 'Flute', section: 'Woodwinds', transposition: 'C', partNumber: 1, pageRange: [1, 1] },
        ],
      } as never,
      totalPages: 4,
      maxPagesPerPart: 12,
      segmentationConfidence: 95,
    });

    expect(result.reasons.join(' ')).toMatch(/not covered|uncovered/i);
  });

  it('reports no coverage findings when page count is unknown (documents the fail-open)', () => {
    // This is WHY the worker must force human review when it cannot read the
    // page count: the gate itself goes quiet rather than failing.
    const result = evaluateQualityGates({
      parsedParts: [{ instrument: 'Flute', partName: 'Flute', pageRange: [1, 1], confidence: 90 }] as never,
      metadata: {
        cuttingInstructions: [
          { instrument: 'Flute', partName: 'Flute', section: 'Woodwinds', transposition: 'C', partNumber: 1, pageRange: [1, 1] },
        ],
      } as never,
      totalPages: 0,
      maxPagesPerPart: 12,
      segmentationConfidence: 95,
    });

    expect(result.reasons.join(' ')).not.toMatch(/uncovered|coverage/i);
  });

  it('detects overlapping page ranges', () => {
    const result = evaluateQualityGates({
      parsedParts: BASE_PARTS,
      metadata: {
        cuttingInstructions: [
          { instrument: 'Flute', partName: 'Flute', section: 'Woodwinds', transposition: 'C', partNumber: 1, pageRange: [1, 3] },
          { instrument: 'Trumpet', partName: 'Trumpet', section: 'Brass', transposition: 'Bb', partNumber: 2, pageRange: [3, 4] },
        ],
      } as never,
      totalPages: 4,
      maxPagesPerPart: 12,
      segmentationConfidence: 95,
    });

    expect(result.reasons.join(' ')).toMatch(/covered more than once|overlap/i);
  });
});
