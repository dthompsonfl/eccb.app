'use client';

import { logger } from '@/lib/logger';

// Type definitions for Wake Lock API
interface WakeLockSentinel {
  released: boolean;
  type: string;
  release: () => Promise<void>;
}

interface WakeLock {
  request: (type: 'screen') => Promise<WakeLockSentinel>;
}

// Type-safe access to wakeLock (checking for existence)
function getWakeLock(): WakeLock | undefined {
  if (typeof navigator === 'undefined') {
    return undefined;
  }
   
  return (navigator as any).wakeLock;
}

/**
 * Check if Wake Lock API is supported
 */
export function isWakeLockSupported(): boolean {
  return !!getWakeLock();
}

let currentWakeLock: WakeLockSentinel | null = null;
let fallbackIntervalId: NodeJS.Timeout | null = null;
let wakeLockFallbackActive = false;

/**
 * Fallback mechanism used when the native Wake Lock API is unavailable.
 *
 * IMPORTANT: there is NO reliable way to keep a screen awake from a web page
 * without the native API. A no-op requestAnimationFrame does NOT prevent device
 * sleep — it only keeps the main thread scheduled. This fallback therefore
 * cannot honour the guarantee its name implies, so it is explicitly best-effort:
 * it exists so the rehearsal UI can TELL the user their screen may sleep and
 * suggest Fullscreen (which demonstrably suppresses idle-sleep on iOS/iPadOS),
 * rather than silently implying the display is being held awake.
 *
 * The browser exposes no "screen kept awake" signal, so the honest contract is
 * to report best-effort status distinctly from a real sentinel — see
 * isUsingFallbackWakeLock().
 */
function startFallbackWakeLock(): void {
  if (fallbackIntervalId !== null) {
    return; // Already running
  }

  wakeLockFallbackActive = true;

  // Periodic best-effort keep-alive. This does NOT guarantee the screen stays
  // on; it only nudges some browsers to keep rendering while the tab is visible.
  fallbackIntervalId = setInterval(() => {
    if (!wakeLockFallbackActive) {
      if (fallbackIntervalId) {
        clearInterval(fallbackIntervalId);
        fallbackIntervalId = null;
      }
      return;
    }
    requestAnimationFrame(() => {
      // No-op: scheduling a frame cannot prevent device sleep.
    });
  }, 15000); // Every 15 seconds

  logger.warn(
    'Wake Lock API unavailable — screen-wake is BEST-EFFORT ONLY. ' +
      'Request Fullscreen to reduce the chance of the display sleeping.',
  );
}

/**
 * Stop the fallback wake lock mechanism
 */
function stopFallbackWakeLock(): void {
  wakeLockFallbackActive = false;
  if (fallbackIntervalId !== null) {
    clearInterval(fallbackIntervalId);
    fallbackIntervalId = null;
    console.log('[WakeLock] Fallback wake lock stopped');
  }
}

/**
 * Acquires a wake lock to prevent the screen from sleeping.
 * Falls back to a setInterval-based approach if Wake Lock API is unavailable.
 * @returns The wake lock sentinel if successful, null otherwise
 * @param onFallbackActive - Optional callback when fallback is activated (for user notification)
 */
export async function acquireWakeLock(
  onFallbackActive?: () => void
): Promise<WakeLockSentinel | null> {
  const wakeLock = getWakeLock();

  if (!wakeLock) {
    // Wake Lock API not supported - use fallback
    console.warn('[WakeLock] Wake Lock API is not supported in this browser, using fallback');
    startFallbackWakeLock();
    onFallbackActive?.();
    return null;
  }

  try {
    // Release any existing wake lock first
    if (currentWakeLock && !currentWakeLock.released) {
      await releaseWakeLock();
    }

    currentWakeLock = await wakeLock.request('screen');
    
    // Handle visibility change - re-acquire when page becomes visible again
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange);
    }
    
    return currentWakeLock;
  } catch (err) {
    console.error('[WakeLock] Failed to acquire wake lock:', err);
    
    // Try fallback on error
    startFallbackWakeLock();
    onFallbackActive?.();
    return null;
  }
}

/**
 * Handle visibility change to re-acquire wake lock when page becomes visible
 */
async function handleVisibilityChange(): Promise<void> {
  if (document.visibilityState === 'visible' && !currentWakeLock) {
    const wakeLock = getWakeLock();
    if (wakeLock) {
      try {
        currentWakeLock = await wakeLock.request('screen');
      } catch (_err) {
        console.warn('[WakeLock] Could not re-acquire wake lock after visibility change');
        startFallbackWakeLock();
      }
    }
  }
}

/**
 * Releases the current wake lock if one is active.
 * Also stops any fallback mechanism.
 * @returns True if successfully released or no lock was held, false on error
 */
export async function releaseWakeLock(): Promise<boolean> {
  // Stop fallback if running
  stopFallbackWakeLock();
  
  // Remove visibility change listener
  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', handleVisibilityChange);
  }

  if (!currentWakeLock) {
    return true;
  }

  try {
    if (!currentWakeLock.released) {
      await currentWakeLock.release();
    }
    currentWakeLock = null;
    return true;
  } catch (err) {
    console.error('[WakeLock] Failed to release wake lock:', err);
    return false;
  }
}

/**
 * Checks whether a NATIVE wake lock sentinel is held.
 *
 * This deliberately reports ONLY the real sentinel. The best-effort fallback
 * cannot prevent device sleep, so counting it here would hand callers a false
 * guarantee ("screen will stay awake") that the platform never made. Use
 * isUsingFallbackWakeLock() to detect degraded mode, and show the user an
 * explicit warning.
 *
 * @returns True only when the native Wake Lock API is holding the screen awake
 */
export function isWakeLockActive(): boolean {
  return currentWakeLock !== null && !currentWakeLock.released;
}

/**
 * Checks if the fallback wake lock mechanism is being used.
 * @returns True if using fallback, false if using native Wake Lock API
 */
export function isUsingFallbackWakeLock(): boolean {
  return wakeLockFallbackActive && !currentWakeLock;
}

/**
 * Requests fullscreen mode on the document element.
 * @returns True if fullscreen was requested successfully, false otherwise
 */
export async function requestFullscreen(): Promise<boolean> {
  if (typeof document === 'undefined') {
    return false;
  }

  try {
    if (!document.fullscreenElement) {
      await document.documentElement.requestFullscreen();
    }
    return true;
  } catch (err) {
    console.error('[WakeLock] Failed to request fullscreen:', err);
    return false;
  }
}

/**
 * Exits fullscreen mode.
 * @returns True if fullscreen was exited successfully or wasn't active, false on error
 */
export async function exitFullscreen(): Promise<boolean> {
  if (typeof document === 'undefined') {
    return false;
  }

  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    }
    return true;
  } catch (err) {
    console.error('[WakeLock] Failed to exit fullscreen:', err);
    return false;
  }
}

/**
 * Checks if the document is currently in fullscreen mode.
 * @returns True if in fullscreen, false otherwise
 */
export function isFullscreen(): boolean {
  return typeof document !== 'undefined' && !!document.fullscreenElement;
}
