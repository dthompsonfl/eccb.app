/**
 * Annotation geometry and stroke fidelity for the Digital Music Stand.
 *
 * ## Why coordinates are normalized
 *
 * Annotation points were captured as `event.clientX - rect.left` — raw display
 * CSS pixels relative to whatever the canvas happened to be at the time. A note
 * written at x=740 therefore lands somewhere completely different after a
 * resize, an orientation change, a zoom change, a different device pixel ratio,
 * or opening the score on another tablet.
 *
 * The fix is to persist positions as fractions of the page (0..1) and convert to
 * pixels only at draw time. A point captured at 50% across the page is 50% across
 * the page forever.
 *
 * ## Why widths are stored on the stroke
 *
 * `drawStroke` computed line width from the toolbar's *current* strokeWidth via
 * a closure, so every previously saved marking changed thickness when the
 * musician changed the selected pen. A stored stroke must replay at the width it
 * was drawn with.
 *
 * Everything here is pure so the behaviour can be tested without a canvas.
 */

/** Coordinate space discriminator, persisted with each stroke. */
export const COORDINATE_SPACE_VERSION = 2 as const;

export type CoordinateSpace = typeof COORDINATE_SPACE_VERSION;

/**
 * A point in NORMALISED page space: fractions of the page's width and height.
 */
export interface NormalizedPoint {
  x: number;
  y: number;
}

/** A point as it is persisted. */
export interface PersistedPoint extends NormalizedPoint {
  pressure: number;
  timestamp: number;
  /** Stylus tilt, when the browser reported it. */
  tiltX?: number;
  tiltY?: number;
  /** Stylus barrel rotation, when the browser reported it. */
  twist?: number;
}

/** The minimal page geometry needed to convert between spaces. */
export interface PageGeometry {
  /** CSS pixel width of the rendered page. */
  width: number;
  /** CSS pixel height of the rendered page. */
  height: number;
}

function isUsableGeometry(geometry: PageGeometry | null | undefined): geometry is PageGeometry {
  return (
    !!geometry &&
    Number.isFinite(geometry.width) &&
    Number.isFinite(geometry.height) &&
    geometry.width > 0 &&
    geometry.height > 0
  );
}

/**
 * Convert a display-pixel position to normalized page coordinates.
 *
 * Returns the input unchanged when the geometry is unusable (a zero-size
 * canvas mid-layout), rather than producing NaN/Infinity that would silently
 * corrupt a stored annotation.
 */
export function toNormalized(
  point: NormalizedPoint,
  geometry: PageGeometry | null | undefined,
): NormalizedPoint {
  if (!isUsableGeometry(geometry)) {
    return { x: point.x, y: point.y };
  }
  return {
    x: clamp01(point.x / geometry.width),
    y: clamp01(point.y / geometry.height),
  };
}

/**
 * Convert normalized page coordinates back to display pixels for rendering.
 */
export function toPixels(
  point: NormalizedPoint,
  geometry: PageGeometry | null | undefined,
): NormalizedPoint {
  if (!isUsableGeometry(geometry)) {
    return { x: point.x, y: point.y };
  }
  return {
    x: point.x * geometry.width,
    y: point.y * geometry.height,
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), 1);
}

// =============================================================================
// Legacy compatibility
// =============================================================================

/**
 * A stored point that predates normalized coordinates.
 *
 * Legacy records are raw display pixels with no version marker. They cannot be
 * converted without knowing the page size they were drawn at, so they are
 * replayed in the current space and flagged — a visible, bounded inaccuracy
 * rather than a silent large offset.
 */
export interface LegacyPoint extends NormalizedPoint {
  pressure?: number;
  timestamp?: number;
}

/** The persisted stroke shape, as far as this module needs to know. */
export interface PersistableStroke {
  coordinateSpace?: number;
  points: Array<Partial<PersistedPoint> & NormalizedPoint>;
  baseWidth?: number;
  pressureScale?: number;
  [key: string]: unknown;
}

/** True when a stroke's points are legacy raw pixels rather than normalized. */
export function isLegacyStroke(stroke: PersistableStroke | null | undefined): boolean {
  if (!stroke) return false;
  return stroke.coordinateSpace !== COORDINATE_SPACE_VERSION;
}

/**
 * Points of a stroke in DISPLAY PIXELS for the given page geometry.
 *
 * Handles both coordinate spaces: normalized strokes are converted, legacy
 * pixel strokes are passed through unchanged.
 */
export function strokePointsToPixels(
  stroke: PersistableStroke,
  geometry: PageGeometry | null | undefined,
): NormalizedPoint[] {
  const points = Array.isArray(stroke?.points) ? stroke.points : [];
  const legacy = isLegacyStroke(stroke);

  return points.map((p) => {
    const point = { x: p?.x ?? 0, y: p?.y ?? 0 };
    return legacy ? point : toPixels(point, geometry);
  });
}

/** Points of a stroke as they should be persisted (normalized space). */
export function strokePointsToNormalized(
  stroke: PersistableStroke,
  geometry: PageGeometry | null | undefined,
): Array<PersistedPoint> {
  const points = Array.isArray(stroke?.points) ? stroke.points : [];
  return points.map((p) => {
    const base = toNormalized({ x: p?.x ?? 0, y: p?.y ?? 0 }, geometry);
    return {
      ...base,
      pressure: p?.pressure ?? 0.5,
      timestamp: p?.timestamp ?? Date.now(),
      ...(typeof p?.tiltX === 'number' ? { tiltX: p.tiltX } : {}),
      ...(typeof p?.tiltY === 'number' ? { tiltY: p.tiltY } : {}),
      ...(typeof p?.twist === 'number' ? { twist: p.twist } : {}),
    };
  });
}

// =============================================================================
// Stroke width fidelity
// =============================================================================

/**
 * The line width to draw a stroke segment at.
 *
 * Uses the width the stroke was SAVED with. `liveStrokeWidth` is only a fallback
 * for legacy strokes that predate persisted widths, and is deliberately not the
 * default: honouring it is what made old annotations change thickness when the
 * musician switched pens.
 */
export function strokeSegmentWidth(args: {
  /** The persisted `baseWidth` of the stroke being drawn. */
  baseWidth?: number;
  /** Pressure at this point, 0..1. */
  pressure?: number;
  /** The pressure scale the stroke was drawn with. */
  pressureScale?: number;
  /** The toolbar's current width, used only when nothing was persisted. */
  liveStrokeWidth?: number;
}): number {
  const pressure = args.pressure === 0 ? 0.5 : (args.pressure ?? 0.5);
  const scale =
    typeof args.pressureScale === 'number' && Number.isFinite(args.pressureScale)
      ? args.pressureScale
      : 0;

  if (typeof args.baseWidth === 'number' && Number.isFinite(args.baseWidth)) {
    return args.baseWidth + pressure * scale;
  }

  // Legacy stroke with no recorded width: fall back predictably.
  const live = args.liveStrokeWidth ?? 0;
  return live + pressure * scale;
}

/** True when a stroke carries enough data to replay at its original fidelity. */
export function hasPersistedWidth(stroke: PersistableStroke | null | undefined): boolean {
  return typeof stroke?.baseWidth === 'number' && Number.isFinite(stroke.baseWidth);
}

// =============================================================================
// High-fidelity pointer sampling
// =============================================================================

/**
 * The samples a pointermove should contribute.
 *
 * Browsers coalesce high-frequency pen input into a single event with the
 * full detail attached via `getCoalescedEvents()`. Using it is what lets a fast
 * signature-like stroke replay faithfully instead of as a coarse polygon.
 * Guarded because not every browser implements it.
 */
export function coalescedSamples(
  event: {
    getCoalescedEvents?: () => ArrayLike<PointerSampleLike>;
  },
  fallback: PointerSampleLike,
): PointerSampleLike[] {
  const getCoalesced = event?.getCoalescedEvents;
  if (typeof getCoalesced !== 'function') {
    return [fallback];
  }

  try {
    const list = getCoalesced.call(event);
    if (!list || typeof list.length !== 'number' || list.length === 0) {
      return [fallback];
    }
    const samples: PointerSampleLike[] = [];
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (s && Number.isFinite(s.clientX) && Number.isFinite(s.clientY)) {
        samples.push(s);
      }
    }
    return samples.length > 0 ? samples : [fallback];
  } catch {
    // Some browsers throw when the pointer is no longer active.
    return [fallback];
  }
}

/** The subset of PointerEvent this module reads. */
export interface PointerSampleLike {
  clientX: number;
  clientY: number;
  pressure?: number;
  tiltX?: number;
  tiltY?: number;
  twist?: number;
  pointerId?: number;
  pointerType?: string;
}

/**
 * Extract stylus attributes from a sample, omitting the ones the browser does
 * not provide so a mouse stroke does not carry meaningless tilt values.
 */
export function stylusAttributes(sample: PointerSampleLike): Partial<PersistedPoint> {
  const out: Partial<PersistedPoint> = {};
  if (typeof sample.tiltX === 'number' && sample.tiltX !== 0) out.tiltX = sample.tiltX;
  if (typeof sample.tiltY === 'number' && sample.tiltY !== 0) out.tiltY = sample.tiltY;
  if (typeof sample.twist === 'number' && sample.twist !== 0) out.twist = sample.twist;
  return out;
}
