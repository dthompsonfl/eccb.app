/**
 * Tests for the music stand's score scaling.
 *
 * The two properties that matter most are the ones that produce a BLANK SCORE
 * rather than an error: a `NaN` or non-positive scale propagates into
 * `canvas.width`, which PDF.js silently renders as nothing. So every input class
 * is asserted to yield a finite, positive, clamped number.
 */
import { describe, it, expect } from 'vitest';

import {
  MAX_SCORE_SCALE,
  MAX_ZOOM_PERCENT,
  MIN_ZOOM_PERCENT,
  getDisplayedZoom,
  getScoreRenderScale,
} from '@/lib/stand/score-scale';

describe('getScoreRenderScale', () => {
  it('leaves a default member at exactly 1x', () => {
    // 100% zoom + "Medium" text must be a no-op, or this feature would change
    // the stand for everyone the moment it shipped.
    expect(getScoreRenderScale(100, 'medium')).toBe(1);
  });

  it('enlarges the score for every larger text preference', () => {
    expect(getScoreRenderScale(100, 'large')).toBeGreaterThan(1);
    expect(getScoreRenderScale(100, 'xlarge')).toBeGreaterThan(
      getScoreRenderScale(100, 'large'),
    );
  });

  it('shrinks the score for the smaller preference', () => {
    expect(getScoreRenderScale(100, 'small')).toBeLessThan(1);
  });

  it('MULTIPLIES zoom and text size rather than overriding either', () => {
    // The core composition rule: a member who zoomed in must keep that zoom.
    const zoomOnly = getScoreRenderScale(150, 'medium');
    const textOnly = getScoreRenderScale(100, 'xlarge');
    const both = getScoreRenderScale(150, 'xlarge');

    expect(zoomOnly).toBeCloseTo(1.5, 5);
    expect(textOnly).toBeCloseTo(1.3, 5);
    expect(both).toBeCloseTo(1.5 * 1.3, 5);
  });

  it('clamps the combined maximum so a tablet cannot be asked for an impossible bitmap', () => {
    // 200% zoom × 1.3 would be 2.6 and is allowed; anything beyond the ceiling
    // is what would exhaust GPU memory mid-rehearsal.
    expect(getScoreRenderScale(MAX_ZOOM_PERCENT, 'xlarge')).toBeLessThanOrEqual(MAX_SCORE_SCALE);
    expect(getScoreRenderScale(400, 'xlarge')).toBe(MAX_SCORE_SCALE);
    expect(getScoreRenderScale(100000, 'xlarge')).toBe(MAX_SCORE_SCALE);
  });

  it.each([
    ['NaN zoom', Number.NaN],
    ['Infinity zoom', Number.POSITIVE_INFINITY],
    ['negative zoom', -50],
    ['zero zoom', 0],
  ])('never returns a non-renderable scale for %s', (_label, zoom) => {
    const result = getScoreRenderScale(zoom, 'xlarge');
    expect(Number.isFinite(result)).toBe(true);
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThanOrEqual(MAX_SCORE_SCALE);
  });

  it.each([
    ['an unknown string', 'huge'],
    ['null', null],
    ['undefined', undefined],
    ['a number instead of a keyword', 1.15],
    ['an object', {}],
  ])('falls back to the default preference for %s', (_label, value) => {
    // normalizeTextScale owns this, but the stand must not blow up if it is ever
    // handed something unexpected.
    const result = getScoreRenderScale(100, value as never);
    expect(Number.isFinite(result)).toBe(true);
    expect(result).toBeGreaterThan(0);
  });
});

describe('getDisplayedZoom', () => {
  it('reports the musician’s own zoom, not the compounded value', () => {
    // The toolbar must not read "130%" to someone who never touched it.
    expect(getDisplayedZoom(100)).toBe(100);
    expect(getDisplayedZoom(137)).toBe(137);
  });

  it('clamps to the stand’s supported range', () => {
    expect(getDisplayedZoom(10)).toBe(MIN_ZOOM_PERCENT);
    expect(getDisplayedZoom(9999)).toBe(MAX_ZOOM_PERCENT);
  });

  it('falls back to 100% for a non-numeric value', () => {
    expect(getDisplayedZoom(Number.NaN)).toBe(100);
  });
});
