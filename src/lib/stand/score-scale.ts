/**
 * Score-scale helpers for the Digital Music Stand.
 *
 * WHY THE PDF NEEDS ITS OWN SCALING
 * ---------------------------------
 * The "text size" preference (`TextScale`) works by scaling the ROOT font size,
 * which scales everything sized in `rem`. The music stand's score is not DOM
 * text at all — it is rasterised by PDF.js into a `<canvas>` at an explicit
 * scale. A member who has chosen "Extra large" for the app is still squinting
 * at the part itself, which is the one thing they actually came to the stand to
 * read. So the preference is applied here as well.
 *
 * HOW THE TWO COMPOSE
 * -------------------
 * The musician's own zoom (`zoom`, 50–200%) and their text-size preference are
 * independent controls that must MULTIPLY, not override each other:
 *
 *   - someone at 100% zoom who wants large print still needs the score enlarged;
 *   - someone who has zoomed to 150% to read a hard passage should not have that
 *     silently replaced by their text-size setting.
 *
 * The combined result is then clamped to `MAX_SCORE_SCALE`. Without that clamp,
 * a member at 200% zoom with "Extra large" text would ask PDF.js for 2.6× the
 * natural size; on a tablet that is a bitmap large enough to exhaust GPU memory
 * and get the canvas context killed mid-rehearsal. Clamping keeps the worst case
 * bounded while still being genuinely large enough to read from a music stand.
 */
import { TEXT_SCALE_VALUES, normalizeTextScale, type TextScale } from '@/lib/accessibility/text-scale';

/** Lowest zoom the stand allows, mirroring `setZoom`'s clamp in the store. */
export const MIN_ZOOM_PERCENT = 50;

/** Highest zoom the stand allows, mirroring `setZoom`'s clamp in the store. */
export const MAX_ZOOM_PERCENT = 200;

/**
 * Ceiling on the COMBINED (zoom × text size) score scale.
 *
 * 2.6 is the product of the two independent maxima (200% × 1.3). Allowing it in
 * full is the risk described above, so the effective ceiling sits just under it:
 * comfortably larger than any real musician needs, while keeping the canvas
 * bitmap within what a tablet GPU will allocate.
 */
export const MAX_SCORE_SCALE = 2.6;

/**
 * The PDF.js render scale for a given musician zoom and text-size preference.
 *
 * Returns a finite, positive number for ANY input — including `NaN`, `Infinity`
 * and nonsense strings — because this value is multiplied into a canvas
 * dimension, and a single `NaN` propagates into `canvas.width`, which silently
 * produces a blank page with no error anywhere.
 */
export function getScoreRenderScale(zoomPercent: number, textScale: TextScale | string): number {
  const safeZoom =
    Number.isFinite(zoomPercent) && zoomPercent > 0 ? zoomPercent : 100;

  const normalized = normalizeTextScale(textScale);
  const multiplier = TEXT_SCALE_VALUES[normalized];

  const combined = (safeZoom / 100) * multiplier;

  // Final guard: never hand PDF.js something it cannot render.
  if (!Number.isFinite(combined) || combined <= 0) return 1;
  return Math.min(combined, MAX_SCORE_SCALE);
}

/**
 * The zoom value to DISPLAY in the stand's zoom control.
 *
 * The control shows the musician's own zoom preference, not the compounded
 * value. Echoing the compounded number back would make the toolbar read "130%"
 * for someone who never touched it, and pressing "reset" would not return the
 * score to the size they actually chose.
 */
export function getDisplayedZoom(zoomPercent: number): number {
  if (!Number.isFinite(zoomPercent)) return 100;
  return Math.min(MAX_ZOOM_PERCENT, Math.max(MIN_ZOOM_PERCENT, Math.round(zoomPercent)));
}
