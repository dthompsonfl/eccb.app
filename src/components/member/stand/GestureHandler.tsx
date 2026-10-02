'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useStandStore } from '@/store/standStore';
import { cn } from '@/lib/utils';
import {
  arbitratePointer,
  shouldGestureLayerPassThrough,
  type ArbitrationDecision,
} from '@/lib/stand/input-arbitration';

// Configuration constants
const SWIPE_THRESHOLD_PX = 50;
const TAP_ZONE_THRESHOLD_PX = 20;
const MIN_TOUCH_TARGET_PX = 44; // WCAG minimum touch target size

/** How long after the last pen event the pen still counts as "in use". */
const PEN_ACTIVE_IDLE_MS = 1500;

interface GestureHandlerProps {
  className?: string;
  enabled?: boolean;
}

type Orientation = 'portrait' | 'landscape';

/**
 * GestureHandler - Advanced page turning gesture detection for the digital music stand
 * 
 * Handles:
 * - Swipe left/right for page navigation
 * - Tap zones (left/right halves) for navigation
 * - Portrait mode: half-page scrolling
 * - Landscape mode: two-page turn
 * 
 * Accessibility:
 * - Uses pointer events for cross-device compatibility
 * - Provides ARIA labels for screen readers
 * - Maintains 44x44px minimum touch targets
 */
export function GestureHandler({ className, enabled = true }: GestureHandlerProps) {
  const {
    settings,
    currentPieceIndex: _currentPieceIndex,
    pieces: _pieces,
    nextPageOrPiece,
    prevPageOrPiece,
    scrollHalfPage,
    nextTwoPages,
    prevTwoPages,
    editMode,
  } = useStandStore();

  const containerRef = useRef<HTMLDivElement>(null);
  const pointerStartRef = useRef<{ x: number; y: number; time: number } | null>(null);
  const gesturePointerTypeRef = useRef<string>('');
  const [isPortrait, setIsPortrait] = useState<Orientation>('landscape');

  // A pen that was recently seen counts as "in use" so a resting hand turns
  // pages instead of painting. Cleared after a short idle period.
  const penActiveRef = useRef(false);
  const penIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [penActive, setPenActive] = useState(false);

  // Live arbitration result. When this is not 'navigation' the overlay must not
  // consume the event, so the pointer reaches the annotation canvas below.
  const [decision, setDecision] = useState<ArbitrationDecision>(() =>
    arbitratePointer({ editMode: false, pointerType: 'mouse' }),
  );

  // The pass-through state must be known BEFORE the pointer arrives, not after.
  //
  // `decide()` is only ever called from this overlay's own pointerdown handler,
  // so a decision could never be computed for the event that decides it: the
  // overlay was still `pointer-events-auto` when the stroke began, swallowed
  // that pointerdown, and only then flipped to pass-through. The musician's
  // first stroke after entering annotate mode was therefore always discarded —
  // no annotation was created, and nothing was saved.
  //
  // Recompute whenever `editMode` changes so the overlay is already in the
  // right state when the pointerdown arrives. Mouse and pen are the devices
  // that draw, so they are the ones that must reach the annotation canvas; touch
  // still navigates in annotate mode, which is the documented policy.
  useEffect(() => {
    setDecision(arbitratePointer({ editMode, pointerType: 'mouse' }));
  }, [editMode]);

  const markPenActive = useCallback(() => {
    penActiveRef.current = true;
    setPenActive(true);
    if (penIdleTimerRef.current) clearTimeout(penIdleTimerRef.current);
    penIdleTimerRef.current = setTimeout(() => {
      penActiveRef.current = false;
      setPenActive(false);
    }, PEN_ACTIVE_IDLE_MS);
  }, []);

  useEffect(() => {
    return () => {
      if (penIdleTimerRef.current) clearTimeout(penIdleTimerRef.current);
    };
  }, []);

  // The overlay is pass-through whenever this pointer is not ours.
  const passesThrough = shouldGestureLayerPassThrough(decision);

  const decide = useCallback(
    (e: React.PointerEvent) => {
      const next = arbitratePointer({
        editMode,
        pointerType: e.pointerType,
        penActive: penActiveRef.current,
        contactArea:
          e.pointerType === 'touch' && typeof e.width === 'number' && e.width > 0
            ? e.width * e.height
            : undefined,
        // A single pointerdown event cannot tell us the true simultaneous
        // contact count; that is tracked in AnnotationLayer. One is a
        // deliberate fingertip for the purpose of the palm heuristic.
        activeTouchPoints: e.pointerType === 'touch' ? 1 : undefined,
      });
      setDecision(next);
      return next;
    },
    [editMode],
  );

  // Determine orientation based on screen dimensions
  const checkOrientation = useCallback(() => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    setIsPortrait(height > width ? 'portrait' : 'landscape');
  }, []);

  // Listen for orientation changes with passive listener for performance
  useEffect(() => {
    checkOrientation();

    const mediaQuery = window.matchMedia('(orientation: portrait)');
    const handleChange = (e: MediaQueryListEvent | MediaQueryList) => {
      setIsPortrait(e.matches ? 'portrait' : 'landscape');
    };

    mediaQuery.addEventListener('change', handleChange, { passive: true });
    window.addEventListener('resize', checkOrientation, { passive: true });

    return () => {
      mediaQuery.removeEventListener('change', handleChange);
      window.removeEventListener('resize', checkOrientation);
    };
  }, [checkOrientation]);

  // Haptic feedback helper
  const triggerHaptic = useCallback(() => {
    if (settings.hapticFeedback && navigator.vibrate) {
      navigator.vibrate(10);
    }
  }, [settings.hapticFeedback]);

  // Handle pointer down event
  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!enabled || !settings.swipeGesture) return;

      // Decide ownership BEFORE recording a gesture start. If this pointer
      // belongs to the annotation layer, we must leave no gesture state behind
      // that could later turn a page mid-stroke.
      const next = decide(e);
      if (e.pointerType === 'pen') markPenActive();
      if (next.consumer !== 'navigation') return;

      pointerStartRef.current = {
        x: e.clientX,
        y: e.clientY,
        time: Date.now(),
      };
      gesturePointerTypeRef.current = e.pointerType;
    },
    [enabled, settings.swipeGesture, decide, markPenActive]
  );

  // Handle pointer up event - determine gesture type
  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (!enabled || !settings.swipeGesture || !pointerStartRef.current) return;

      // Guard against a pointerup arriving from a different device than the
      // pointerdown that armed the gesture (e.g. pen drew, finger lifted).
      if (e.pointerType !== gesturePointerTypeRef.current) {
        pointerStartRef.current = null;
        return;
      }

      const startX = pointerStartRef.current.x;
      const startY = pointerStartRef.current.y;
      const deltaX = e.clientX - startX;
      const deltaY = e.clientY - startY;
      const _deltaTime = Date.now() - pointerStartRef.current.time;

      // Reset start ref
      pointerStartRef.current = null;

      // Get container dimensions for zone calculations
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const containerWidth = rect.width;
      const _containerHeight = rect.height;

      // Determine if this is a swipe or tap
      const isSwipe = Math.abs(deltaX) > TAP_ZONE_THRESHOLD_PX || Math.abs(deltaY) > TAP_ZONE_THRESHOLD_PX;

      if (isSwipe) {
        // Swipe gesture
        const isHorizontalSwipe = Math.abs(deltaX) > Math.abs(deltaY);
        
        if (isHorizontalSwipe) {
          // Horizontal swipe - page turn (setlist-aware)
          if (deltaX < -SWIPE_THRESHOLD_PX) {
            // Swipe left - next page/piece
            triggerHaptic();
            if (isPortrait === 'landscape') {
              nextTwoPages();
            } else {
              nextPageOrPiece();
            }
          } else if (deltaX > SWIPE_THRESHOLD_PX) {
            // Swipe right - previous page/piece
            triggerHaptic();
            if (isPortrait === 'landscape') {
              prevTwoPages();
            } else {
              prevPageOrPiece();
            }
          }
        } else {
          // Vertical swipe in portrait - directional half-page scroll.
          // Both directions previously reached the same toggle, so scrolling up
          // and down were indistinguishable and neither end was reachable.
          if (isPortrait === 'portrait') {
            if (deltaY < -SWIPE_THRESHOLD_PX) {
              // Swipe up - scroll half page forward
              triggerHaptic();
              scrollHalfPage(1);
            } else if (deltaY > SWIPE_THRESHOLD_PX) {
              // Swipe down - scroll half page back
              triggerHaptic();
              scrollHalfPage(-1);
            }
          }
        }
      } else {
        // Tap gesture - check zone
        const clickX = startX - rect.left;
        const _clickY = startY - rect.top;

        if (isPortrait === 'portrait') {
          // In portrait mode the right half advances a half page and the
          // upper-left quadrant steps back a half page, so both halves of the
          // state machine are reachable by touch alone.
          if (clickX > containerWidth * 0.5) {
            triggerHaptic();
            scrollHalfPage(1);
          } else if (clickX < containerWidth * 0.25) {
            triggerHaptic();
            scrollHalfPage(-1);
          }
        } else {
          // In landscape mode, simple left/right tap
          if (clickX > containerWidth * 0.7) {
            // Right side tap - next two pages
            triggerHaptic();
            nextTwoPages();
          } else if (clickX < containerWidth * 0.3) {
            // Left side tap - previous two pages
            triggerHaptic();
            prevTwoPages();
          } else {
            // Center tap - single page/piece (setlist-aware)
            if (clickX > containerWidth * 0.5) {
              triggerHaptic();
              nextPageOrPiece();
            } else {
              triggerHaptic();
              prevPageOrPiece();
            }
          }
        }
      }

      // Emit custom event for external listeners
      window.dispatchEvent(
        new CustomEvent('pageTurn', {
          detail: {
            direction: deltaX < 0 ? 'next' : 'previous',
            type: isSwipe ? 'swipe' : 'tap',
            orientation: isPortrait,
          },
        })
      );
    },
    [
      enabled,
      settings.swipeGesture,
      isPortrait,
      nextPageOrPiece,
      prevPageOrPiece,
      scrollHalfPage,
      nextTwoPages,
      prevTwoPages,
      triggerHaptic,
    ]
  );

  // Handle pointer cancel to clean up
  const handlePointerCancel = useCallback(() => {
    pointerStartRef.current = null;
    gesturePointerTypeRef.current = '';
  }, []);

  // Don't render if disabled
  if (!enabled) {
    return null;
  }

  return (
    <div
      ref={containerRef}
      className={cn(
        'absolute inset-0 z-10',
        // Enable touch events for mobile
        'touch-none',
        // CRITICAL: when the annotation layer owns this pointer, the overlay
        // must not receive it at all. `pointer-events-none` is what lets a pen
        // reach the annotation canvas instead of being swallowed here.
        passesThrough ? 'pointer-events-none' : 'pointer-events-auto',
        className
      )}
      style={{
        // Prevent text selection during gestures
        userSelect: 'none',
        WebkitUserSelect: 'none',
        // Ensure minimum touch target size for accessibility
        minWidth: MIN_TOUCH_TARGET_PX,
        minHeight: MIN_TOUCH_TARGET_PX,
      }}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      role="application"
      aria-label="Page navigation gesture area. Swipe left or right to turn pages, tap left or right sides for navigation."
      tabIndex={0}
      // Provide keyboard instructions for screen readers
      aria-describedby="gesture-help"
    >
      {/* Screen reader instructions */}
      <div id="gesture-help" className="sr-only">
        Use arrow keys to navigate pages. Swipe or tap on touch devices.
      </div>
      {/* Touch zone indicators for accessibility - visually hidden but announced */}
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        <span>
          {editMode
            ? 'Annotate mode on. Pen writes, finger turns pages. '
            : 'Annotate mode off. Touch and gestures turn pages. '}
        </span>
        {penActive && <span>Stylus detected. </span>}
        <span>Current orientation: {isPortrait}. </span>
        <span>
          {isPortrait === 'portrait' 
            ? 'Tap right half to scroll half page, far left to go back.' 
            : 'Tap left or right sides for two-page navigation, center for single page.'}
        </span>
      </div>
    </div>
  );
}

GestureHandler.displayName = 'GestureHandler';

export default GestureHandler;
