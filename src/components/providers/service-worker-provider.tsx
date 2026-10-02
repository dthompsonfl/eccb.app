'use client';

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

/**
 * Service Worker Registration Provider
 *
 * Registers the service worker in production only. Registration is deliberately
 * NOT aggressive: an update waits until every tab is closed rather than swapping
 * the app out from under a musician mid-piece, and a waiting worker is applied
 * only when the user asks.
 *
 * The worker also needs to know which user is signed in, because score caches
 * are namespaced per user so one musician's music is never shown to another on
 * a shared tablet. `setServiceWorkerUser` does that; `purgeOfflineScores` runs
 * on sign-out.
 */

let registration: ServiceWorkerRegistration | null = null;
let waitingWorker: ServiceWorker | null = null;

/** True when a new build is installed and waiting to take over. */
let updateAvailable = false;
const updateListeners = new Set<() => void>();

function notifyUpdate() {
  for (const listener of updateListeners) listener();
}

/** The worker that should receive commands: the controller, else the active one. */
function activeWorker(): ServiceWorker | null {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  return navigator.serviceWorker.controller ?? registration?.active ?? null;
}

export function ServiceWorkerRegistration() {
  const [, setUpdateReady] = useState(updateAvailable);

  useEffect(() => {
    if (!('serviceWorker' in navigator) || process.env.NODE_ENV !== 'production') {
      return;
    }

    let cancelled = false;

    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then((reg) => {
        if (cancelled) return;
        registration = reg;

        // A worker that finishes installing while a tab is open waits rather
        // than activating immediately, so nobody is moved to a new build in the
        // middle of playing.
        if (reg.waiting && navigator.serviceWorker.controller) {
          waitingWorker = reg.waiting;
          updateAvailable = true;
          notifyUpdate();
        }

        reg.addEventListener('updatefound', () => {
          const installing = reg.installing;
          if (!installing) return;
          installing.addEventListener('statechange', () => {
            if (installing.state === 'installed' && navigator.serviceWorker.controller) {
              waitingWorker = installing;
              updateAvailable = true;
              notifyUpdate();
            }
          });
        });
      })
      .catch((error) => {
        // Offline support is an enhancement: never break the app over it.
        console.error('[ServiceWorker] registration failed:', error);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const listener = () => setUpdateReady(updateAvailable);
    updateListeners.add(listener);
    return () => {
      updateListeners.delete(listener);
    };
  }, []);

  return null;
}

/** Apply a waiting service worker update now. */
export function applyServiceWorkerUpdate(): void {
  waitingWorker?.postMessage({ type: 'SKIP_WAITING' });
  waitingWorker = null;
  updateAvailable = false;
  notifyUpdate();
}

/**
 * Tell the service worker which user is signed in.
 *
 * Switching users purges the previous user's cached scores inside the worker,
 * which is what prevents one musician's music leaking to the next on a shared
 * device.
 */
export function setServiceWorkerUser(userId: string | null): void {
  const worker = activeWorker();
  if (!worker) return;
  worker.postMessage(userId ? { type: 'SET_USER', userId } : { type: 'LOGOUT' });
}

/** Purge this device's cached scores. Call on sign-out. */
export function purgeOfflineScores(): void {
  activeWorker()?.postMessage({ type: 'LOGOUT' });
}

/** Ask the worker to pre-cache a score for offline use. */
export function cacheScoreForOffline(url: string): void {
  activeWorker()?.postMessage({ type: 'CACHE_SCORE', url });
}

/**
 * Hook to detect online/offline status.
 * Works whether or not a service worker is registered.
 */
export function useOnlineStatus() {
  return useSyncExternalStore(
    (callback) => {
      window.addEventListener('online', callback);
      window.addEventListener('offline', callback);
      return () => {
        window.removeEventListener('online', callback);
        window.removeEventListener('offline', callback);
      };
    },
    () => navigator.onLine,
    () => true,
  );
}

/** Hook that reports whether an app update is waiting to be applied. */
export function useServiceWorkerUpdate(): { available: boolean; apply: () => void } {
  const available = useSyncExternalStore(
    (callback) => {
      updateListeners.add(callback);
      return () => {
        updateListeners.delete(callback);
      };
    },
    () => updateAvailable,
    () => false,
  );

  const apply = useCallback(() => applyServiceWorkerUpdate(), []);
  return { available, apply };
}
