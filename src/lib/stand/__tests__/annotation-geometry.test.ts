import { describe, expect, it } from 'vitest';
import {
  COORDINATE_SPACE_VERSION,
  coalescedSamples,
  hasPersistedWidth,
  isLegacyStroke,
  strokePointsToNormalized,
  strokePointsToPixels,
  strokeSegmentWidth,
  stylusAttributes,
  toNormalized,
  toPixels,
} from '../annotation-geometry';

const PAGE = { width: 1000, height: 2000 };

describe('toNormalized / toPixels', () => {
  it('normalizes a pixel position against the page', () => {
    expect(toNormalized({ x: 500, y: 1000 }, PAGE)).toEqual({ x: 0.5, y: 0.5 });
  });

  it('round-trips a point back to the same pixels', () => {
    const px = { x: 740, y: 360 };
    expect(toPixels(toNormalized(px, PAGE), PAGE)).toEqual(px);
  });

  it('the same MUSICAL point at two different page sizes normalizes identically', () => {
    // This is the whole point: a note at the middle of the score must stay at
    // the middle when the tablet is resized or another device opens the file.
    const onTablet = { x: 500, y: 1000 }; // 1000x2000
    const onLaptop = { x: 300, y: 600 }; // 600x1200

    expect(toNormalized(onTablet, PAGE)).toEqual(toNormalized(onLaptop, { width: 600, height: 1200 }));
  });

  it('the same musical point survives a zoom change', () => {
    // Zoom doubles the rendered page; the musical position is unchanged.
    const atZoom100 = { x: 500, y: 1000 };
    const atZoom200 = { x: 1000, y: 2000 };

    expect(toNormalized(atZoom100, PAGE)).toEqual(
      toNormalized(atZoom200, { width: 2000, height: 4000 }),
    );
  });

  it('the same musical point survives a device pixel ratio change', () => {
    // DPR affects the backing-store size, not the CSS geometry we normalize by,
    // so the normalized value is identical.
    const rect = { left: 0, top: 0 };
    const clientX = 500;
    expect(toNormalized({ x: clientX - rect.left, y: 1000 }, PAGE)).toEqual({ x: 0.5, y: 0.5 });
  });

  it('clamps out-of-range positions instead of producing values outside 0..1', () => {
    expect(toNormalized({ x: -50, y: 5000 }, PAGE)).toEqual({ x: 0, y: 1 });
    expect(toNormalized({ x: 2000, y: 2000 }, PAGE)).toEqual({ x: 1, y: 1 });
  });

  it('passes the point through when the page geometry is unusable', () => {
    // A zero-size canvas mid-layout must not corrupt a stored annotation.
    const bad = { x: 5, y: 6 };
    expect(toNormalized(bad, { width: 0, height: 0 })).toEqual(bad);
    expect(toNormalized(bad, null)).toEqual(bad);
    expect(toNormalized(bad, { width: Number.NaN, height: 10 })).toEqual(bad);
  });
});

describe('coordinate space versioning', () => {
  it('treats a stroke with no version as legacy', () => {
    expect(isLegacyStroke({ points: [] })).toBe(true);
    expect(isLegacyStroke({ points: [], coordinateSpace: 1 })).toBe(true);
    expect(isLegacyStroke(null)).toBe(false);
  });

  it('treats a versioned stroke as current', () => {
    expect(isLegacyStroke({ points: [], coordinateSpace: COORDINATE_SPACE_VERSION })).toBe(false);
  });

  it('replays legacy pixel strokes unchanged', () => {
    const legacy = { points: [{ x: 740, y: 360 }] };
    expect(strokePointsToPixels(legacy, PAGE)).toEqual([{ x: 740, y: 360 }]);
  });

  it('converts current strokes from normalized to pixels', () => {
    const current = { coordinateSpace: COORDINATE_SPACE_VERSION, points: [{ x: 0.5, y: 0.5 }] };
    expect(strokePointsToPixels(current, PAGE)).toEqual([{ x: 500, y: 1000 }]);
  });

  it('reproduces a stored stroke at a different page size', () => {
    const stroke = {
      coordinateSpace: COORDINATE_SPACE_VERSION,
      points: [
        { x: 0.25, y: 0.25 },
        { x: 0.75, y: 0.75 },
      ],
    };
    const small = strokePointsToPixels(stroke, { width: 500, height: 1000 });
    const large = strokePointsToPixels(stroke, { width: 1000, height: 2000 });

    // Same relative position, different pixels — which is correct.
    expect(small[0]).toEqual({ x: 125, y: 250 });
    expect(large[0]).toEqual({ x: 250, y: 500 });
    expect(small[0].x / small[1].x).toBeCloseTo(large[0].x / large[1].x);
  });

  it('handles a stroke with no points', () => {
    expect(strokePointsToPixels({ points: [] }, PAGE)).toEqual([]);
  });
});

describe('strokePointsToNormalized', () => {
  it('normalizes and preserves pressure and timestamp', () => {
    const out = strokePointsToNormalized(
      { points: [{ x: 500, y: 1000, pressure: 0.7, timestamp: 123 }] },
      PAGE,
    );
    expect(out).toEqual([
      { x: 0.5, y: 0.5, pressure: 0.7, timestamp: 123 },
    ]);
  });

  it('preserves stylus tilt and twist when present', () => {
    const out = strokePointsToNormalized(
      { points: [{ x: 0.5, y: 0.5, pressure: 0.5, timestamp: 1, tiltX: 30, tiltY: -12, twist: 90 }] },
      PAGE,
    );
    expect(out[0]).toMatchObject({ tiltX: 30, tiltY: -12, twist: 90 });
  });

  it('omits stylus attributes a mouse cannot provide', () => {
    const out = strokePointsToNormalized(
      { points: [{ x: 0.5, y: 0.5, pressure: 0.5, timestamp: 1 }] },
      PAGE,
    );
    expect(out[0].tiltX).toBeUndefined();
    expect(out[0].twist).toBeUndefined();
  });

  it('defaults a missing pressure rather than storing undefined', () => {
    const out = strokePointsToNormalized({ points: [{ x: 0, y: 0 }] }, PAGE);
    expect(out[0].pressure).toBe(0.5);
  });
});

describe('strokeSegmentWidth', () => {
  it('uses the SAVED baseWidth, not the live toolbar width', () => {
    // The fidelity defect: a stroke saved at 8 must replay at 8 even after the
    // musician switches the pen to 2.
    const saved = strokeSegmentWidth({
      baseWidth: 8,
      pressure: 0.5,
      pressureScale: 0,
      liveStrokeWidth: 2,
    });
    expect(saved).toBe(8);
  });

  it('is unaffected by the live toolbar width', () => {
    const at2 = strokeSegmentWidth({ baseWidth: 8, pressure: 0.5, pressureScale: 0, liveStrokeWidth: 2 });
    const at20 = strokeSegmentWidth({ baseWidth: 8, pressure: 0.5, pressureScale: 0, liveStrokeWidth: 20 });
    expect(at2).toBe(at20);
  });

  it('applies the stroke’s own persisted pressure scale', () => {
    expect(
      strokeSegmentWidth({ baseWidth: 4, pressure: 0.5, pressureScale: 2, liveStrokeWidth: 99 }),
    ).toBe(5);
  });

  it('treats zero pressure as a light touch rather than a hairline', () => {
    const zero = strokeSegmentWidth({ baseWidth: 4, pressure: 0, pressureScale: 1 });
    const half = strokeSegmentWidth({ baseWidth: 4, pressure: 0.5, pressureScale: 1 });
    expect(zero).toBe(half);
  });

  it('falls back predictably for a legacy stroke with no saved width', () => {
    expect(
      strokeSegmentWidth({ pressure: 0.5, pressureScale: 0, liveStrokeWidth: 3 }),
    ).toBe(3);
  });

  it('does not throw when nothing at all is known', () => {
    expect(Number.isFinite(strokeSegmentWidth({}))).toBe(true);
  });

  it('reports whether a stroke carries a persisted width', () => {
    expect(hasPersistedWidth({ points: [], baseWidth: 8 })).toBe(true);
    expect(hasPersistedWidth({ points: [] })).toBe(false);
    expect(hasPersistedWidth(null)).toBe(false);
  });
});

describe('coalescedSamples', () => {
  it('returns the high-frequency samples when the browser provides them', () => {
    const event = {
      getCoalescedEvents: () => [
        { clientX: 1, clientY: 1, pressure: 0.1 },
        { clientX: 2, clientY: 2, pressure: 0.2 },
        { clientX: 3, clientY: 3, pressure: 0.3 },
      ],
    };
    expect(coalescedSamples(event, { clientX: 0, clientY: 0 })).toHaveLength(3);
  });

  it('falls back to the event itself when the browser lacks the API', () => {
    const fallback = { clientX: 9, clientY: 9 };
    expect(coalescedSamples({}, fallback)).toEqual([fallback]);
  });

  it('falls back when the browser returns an empty list', () => {
    const fallback = { clientX: 9, clientY: 9 };
    expect(coalescedSamples({ getCoalescedEvents: () => [] }, fallback)).toEqual([fallback]);
  });

  it('falls back when the browser throws', () => {
    const fallback = { clientX: 9, clientY: 9 };
    const throwing = {
      getCoalescedEvents: () => {
        throw new Error('pointer inactive');
      },
    };
    expect(coalescedSamples(throwing, fallback)).toEqual([fallback]);
  });

  it('drops malformed samples rather than storing NaN', () => {
    const event = {
      getCoalescedEvents: () => [{ clientX: Number.NaN, clientY: 1 }, { clientX: 5, clientY: 5 }],
    };
    const out = coalescedSamples(event, { clientX: 0, clientY: 0 });
    expect(out).toEqual([{ clientX: 5, clientY: 5 }]);
  });
});

describe('stylusAttributes', () => {
  it('captures tilt and twist from a stylus', () => {
    expect(stylusAttributes({ clientX: 0, clientY: 0, tiltX: 20, tiltY: 5, twist: 180 })).toEqual({
      tiltX: 20,
      tiltY: 5,
      twist: 180,
    });
  });

  it('omits zero values, which mean "not reported"', () => {
    expect(stylusAttributes({ clientX: 0, clientY: 0, tiltX: 0, tiltY: 0, twist: 0 })).toEqual({});
  });

  it('omits attributes the device does not have', () => {
    expect(stylusAttributes({ clientX: 0, clientY: 0 })).toEqual({});
  });
});
