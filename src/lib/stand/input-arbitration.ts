/**
 * Pointer arbitration for the Digital Music Stand.
 *
 * The stand has two mutually exclusive pointer consumers stacked in the same
 * area: the page-navigation gesture plane (a full-screen `absolute inset-0`
 * overlay) and the annotation canvases. A single overlay that always consumes
 * input will swallow stylus drawing, which is the single most important
 * interaction for a musician rehearsing from a tablet.
 *
 * This module is the single source of truth for "who gets this pointer?". It is
 * pure so the policy can be tested exhaustively without a DOM.
 *
 * Model (mirrors Piascore-class behaviour):
 *   - Annotate mode ON  → pen and mouse draw; touch turns pages.
 *   - Annotate mode OFF → everything navigates.
 *   - While a pen is in active use, touch input is treated as a page-turning
 *     hand, not as ink. This is the "write with the pencil, turn with the hand"
 *     interaction.
 */

export type PointerType = 'pen' | 'touch' | 'mouse' | '' | (string & {});

export interface ArbitrationInput {
  /** Annotate mode from the stand store. */
  editMode: boolean;
  /** `PointerEvent.pointerType`. */
  pointerType: PointerType;
  /**
   * True while a pen has been seen recently. Used to keep a resting hand from
   * painting while the pencil is in use.
   */
  penActive?: boolean;
  /**
   * Touch contact area in CSS px². Large contacts are almost always a palm or
   * forearm resting on the tablet rather than a deliberate fingertip.
   */
  contactArea?: number;
  /** Number of simultaneous touch contacts. */
  activeTouchPoints?: number;
  /** Ignore touch input entirely (e.g. a stylus-only performance setup). */
  ignoreTouch?: boolean;
}

/** Above this, a touch is treated as a palm rather than a fingertip. */
export const PALM_CONTACT_AREA_PX2 = 900;

/** Two or more contacts is a hand, not a fingertip. */
export const PALM_MULTI_TOUCH_POINTS = 2;

export type PointerConsumer = 'annotation' | 'navigation' | 'ignored';

export interface ArbitrationDecision {
  consumer: PointerConsumer;
  /**
   * Why this decision was made. Surfaced in dev tooling and asserted in tests so
   * a regression is diagnosable rather than mysterious.
   */
  reason:
    | 'annotate-mode-off'
    | 'annotation-layers-hidden'
    | 'pen-draws'
    | 'mouse-draws'
    | 'pen-active-touch-navigates'
    | 'palm-rejected'
    | 'multitouch-rejected'
    | 'touch-ignored-by-setting'
    | 'touch-navigates'
    | 'unknown-device-navigates';
}

/**
 * Decide which layer owns a pointer event.
 *
 * Precedence, highest first:
 *  1. Annotate mode off            → navigation (nothing should draw)
 *  2. Pen                          → annotation
 *  3. Mouse                        → annotation (it is an explicit device)
 *  4. Touch, pen in use            → navigation (hand turns, pencil writes)
 *  5. Touch, looks like a palm      → ignored
 *  6. Touch                        → navigation
 */
export function arbitratePointer(input: ArbitrationInput): ArbitrationDecision {
  const { editMode, pointerType, penActive = false } = input;

  if (!editMode) {
    return { consumer: 'navigation', reason: 'annotate-mode-off' };
  }

  if (pointerType === 'pen') {
    return { consumer: 'annotation', reason: 'pen-draws' };
  }

  if (pointerType === 'mouse') {
    return { consumer: 'annotation', reason: 'mouse-draws' };
  }

  if (pointerType !== 'touch') {
    // Unknown or empty pointerType (some assistive tech, some older engines):
    // do not risk drawing ink from a device we cannot identify.
    return { consumer: 'navigation', reason: 'unknown-device-navigates' };
  }

  if (input.ignoreTouch) {
    return { consumer: 'ignored', reason: 'touch-ignored-by-setting' };
  }

  // Touch, annotate mode on. A resting hand must not paint.
  if (
    typeof input.contactArea === 'number' &&
    input.contactArea > PALM_CONTACT_AREA_PX2
  ) {
    return { consumer: 'ignored', reason: 'palm-rejected' };
  }

  if (
    typeof input.activeTouchPoints === 'number' &&
    input.activeTouchPoints >= PALM_MULTI_TOUCH_POINTS
  ) {
    return { consumer: 'ignored', reason: 'multitouch-rejected' };
  }

  if (penActive) {
    // The pencil is in use: the hand is holding the page, not drawing on it.
    return { consumer: 'navigation', reason: 'pen-active-touch-navigates' };
  }

  return { consumer: 'navigation', reason: 'touch-navigates' };
}

/** True when the gesture overlay must not consume the event. */
export function shouldGestureLayerPassThrough(decision: ArbitrationDecision): boolean {
  return decision.consumer !== 'navigation';
}

/**
 * Whether the annotation canvas should be interactive for this pointer.
 * Kept separate from the decision so the canvas can render the correct
 * `pointer-events` value without re-running the policy.
 */
export function shouldAnnotationAccept(decision: ArbitrationDecision): boolean {
  return decision.consumer === 'annotation';
}
