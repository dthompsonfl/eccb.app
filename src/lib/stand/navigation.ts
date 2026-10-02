/**
 * Deterministic page navigation for the Digital Music Stand.
 *
 * Three problems this solves, all of which previously produced ambiguous or
 * visibly wrong behaviour during live performance:
 *
 *  1. **Two-page mode was not a spread.** It advanced `currentPage + 2` while
 *     only ever rendering ONE page, so the musician saw 1 -> 3 -> 5 -> 7 with
 *     every other page skipped. A spread is a pair of pages shown together, and
 *     the page you land on must be the one you can see.
 *
 *  2. **Half-page navigation was a toggle.** `scrollHalfPage()` flipped between
 *     0 and 0.5, and both gesture directions reached the same call, so scrolling
 *     up and scrolling down were indistinguishable and dead ends existed at the
 *     start and end of a piece.
 *
 *  3. **Spread parity.** A spread must begin on a recto (odd, 1-based) page in
 *     this product's convention, so it never starts in the middle of a system.
 *
 * Everything here is pure: no store, no DOM. The store composes it.
 */

/** Page numbers are 1-based throughout the product. */
export const FIRST_PAGE = 1;

/** Vertical position within the current page, as a fraction of page height. */
export type HalfPage = 'top' | 'bottom';

/** The two pages a spread shows, left and right. */
export interface SpreadPages {
  /** 1-based page number shown on the left of the spread. Always odd. */
  left: number;
  /** 1-based page number shown on the right, or null when the piece ends. */
  right: number | null;
}

/**
 * Clamp a 1-based page number into `[1, totalPages]`.
 * A non-positive or non-finite `totalPages` degrades to a single page.
 */
export function clampPage(page: number, totalPages: number): number {
  const total = Number.isFinite(totalPages) && totalPages >= 1 ? Math.floor(totalPages) : 1;
  if (!Number.isFinite(page)) return FIRST_PAGE;
  return Math.min(Math.max(Math.floor(page), FIRST_PAGE), total);
}

/**
 * The odd (recto) page at or before `page`.
 *
 * A spread always starts on an odd page so the left-hand side of the opening is
 * the back of the previous leaf. `alignToRecto(1) === 1`, `alignToRecto(2) === 1`,
 * `alignToRecto(3) === 3`.
 */
export function alignToRecto(page: number): number {
  const p = Math.max(FIRST_PAGE, Math.floor(page));
  return p % 2 === 1 ? p : p - 1;
}

/**
 * The two pages a spread starting at `page` should display.
 *
 * The left page is aligned to a recto so the pair never begins mid-system. The
 * right page is `left + 1`, or null when the piece ends on the left page (an
 * odd-length piece) so the caller can centre a single page instead of padding.
 */
export function getSpreadPages(page: number, totalPages: number): SpreadPages {
  const total = Number.isFinite(totalPages) && totalPages >= 1 ? Math.floor(totalPages) : 1;
  const left = clampPage(alignToRecto(page), total);

  // An even-length piece spreads every page; an odd-length piece ends with a
  // lone final page, which is correct book behaviour, not a bug.
  const right = left + 1 <= total ? left + 1 : null;

  return { left, right };
}

/** Total page count, defensively floored to at least one page. */
export function safeTotalPages(totalPages: number): number {
  return Number.isFinite(totalPages) && totalPages >= 1 ? Math.floor(totalPages) : 1;
}

/** True when a piece cannot form a spread (fewer than 2 pages). */
export function isSpreadable(totalPages: number): boolean {
  return Number.isFinite(totalPages) && totalPages >= 2;
}

/**
 * Advance by one spread.
 *
 * The returned page is always a recto, so repeated calls walk
 * 1 -> 3 -> 5 and never strand the user on an even page they cannot see the
 * start of.
 */
export function nextSpreadPage(page: number, totalPages: number): number {
  const total = safeTotalPages(totalPages);
  const current = getSpreadPages(page, total);

  // Already showing the last page (alone, or as the right half of this spread):
  // there is nowhere further to go. Returning `current.left` rather than
  // `left + 2` keeps the invariant that the stored page is always a recto, so
  // the page the musician lands on is always the left page they can see.
  const isLastSpread = current.right === null || current.right >= total;
  if (isLastSpread) return current.left;

  return clampPage(current.left + 2, total);
}

/** Retreat by one spread, never below page 1. */
export function prevSpreadPage(page: number, totalPages: number): number {
  const total = safeTotalPages(totalPages);
  const current = getSpreadPages(page, total);
  return Math.max(FIRST_PAGE, current.left - 2);
}

/** The next spread in a direction, for a caller that knows the sign. */
export function stepSpread(page: number, totalPages: number, direction: 1 | -1): number {
  return direction === 1 ? nextSpreadPage(page, totalPages) : prevSpreadPage(page, totalPages);
}

// =============================================================================
// Half-page state machine
// =============================================================================

/**
 * Result of a directional half-page scroll.
 *
 * `moved` is false when the request could not be honoured, which is how the UI
 * avoids flashing a page-turn animation for input that did nothing.
 */
export interface HalfPageStep {
  page: number;
  half: HalfPage;
  moved: boolean;
  /** True when the step crossed a page boundary rather than staying on a half. */
  crossedPage: boolean;
}

export interface HalfPageState {
  page: number;
  half: HalfPage;
}

/**
 * Step the viewport forward or backward by half a page.
 *
 * Forward:  top(p1) -> bottom(p1) -> top(p2) -> bottom(p2) -> ...
 * Backward: the exact inverse, ending back at top(p1).
 *
 * Clamping is explicit at both ends: scrolling forward on the last page's
 * bottom half and backward on page 1's top half both return `moved: false`
 * rather than wrapping or sticking on a half that looks stuck.
 */
export function stepHalfPage(state: HalfPageState, direction: 1 | -1, totalPages: number): HalfPageStep {
  const total = safeTotalPages(totalPages);
  const page = clampPage(state.page, total);
  const half: HalfPage = state.half === 'bottom' ? 'bottom' : 'top';

  if (direction === 1) {
    if (half === 'top') {
      return { page, half: 'bottom', moved: true, crossedPage: false };
    }
    // On the bottom half: move to the top of the next page, if there is one.
    if (page >= total) {
      return { page, half: 'bottom', moved: false, crossedPage: false };
    }
    return { page: page + 1, half: 'top', moved: true, crossedPage: true };
  }

  // Backward
  if (half === 'bottom') {
    return { page, half: 'top', moved: true, crossedPage: false };
  }
  // On the top half: move to the bottom of the previous page, if there is one.
  if (page <= FIRST_PAGE) {
    return { page: FIRST_PAGE, half: 'top', moved: false, crossedPage: false };
  }
  return { page: page - 1, half: 'bottom', moved: true, crossedPage: true };
}

/** The legacy numeric scroll offset (0 or 0.5) derived from a half. */
export function halfToScrollOffset(half: HalfPage): number {
  return half === 'bottom' ? 0.5 : 0;
}

/** The half implied by a legacy numeric scroll offset. */
export function scrollOffsetToHalf(offset: number): HalfPage {
  return offset >= 0.25 ? 'bottom' : 'top';
}

// =============================================================================
// Crop
// =============================================================================

/**
 * A crop rectangle in normalised page space (0..1), so it is independent of
 * zoom, display size, and device pixel ratio.
 */
export interface NormalizedCropRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** Clamp a crop rect into the unit square, keeping a usable minimum size. */
export function normalizeCropRect(
  rect: Partial<NormalizedCropRect> | null | undefined,
  minSize = 0.2,
): NormalizedCropRect | null {
  if (!rect) return null;

  const top = clamp01(rect.top);
  const left = clamp01(rect.left);
  const width = clamp01(rect.width);
  const height = clamp01(rect.height);

  if (!Number.isFinite(top) || !Number.isFinite(left)) return null;
  if (width < minSize || height < minSize) return null;

  // A crop that starts near an edge is shifted inward so it stays in bounds
  // at the requested size rather than silently shrinking.
  const clampedLeft = Math.min(left, 1 - width);
  const clampedTop = Math.min(top, 1 - height);

  return {
    top: clampedTop,
    left: clampedLeft,
    width,
    height,
  };
}

function clamp01(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), 1);
}

/** True when a crop rect would actually change what is displayed. */
export function isCropActive(rect: NormalizedCropRect | null | undefined): boolean {
  if (!rect) return false;
  return (
    rect.top > 0.001 ||
    rect.left > 0.001 ||
    rect.width < 0.999 ||
    rect.height < 0.999
  );
}

/**
 * Convert a normalised crop (0..1 of the page) into pixel space for a page of
 * the given dimensions.
 *
 * The store persists crops in NORMALISED space so a musician's framing survives
 * a different tablet, zoom level, or device pixel ratio. The canvas renderer
 * needs pixels, so the conversion happens here, at the boundary.
 */
export function normalizedCropToPixels(
  rect: NormalizedCropRect | null | undefined,
  pageWidth: number,
  pageHeight: number,
): { x: number; y: number; width: number; height: number } | null {
  if (!rect) return null;
  if (!(pageWidth > 0) || !(pageHeight > 0)) return null;

  return {
    x: Math.round(rect.left * pageWidth),
    y: Math.round(rect.top * pageHeight),
    width: Math.round(rect.width * pageWidth),
    height: Math.round(rect.height * pageHeight),
  };
}
