'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  MAX_QUEUED_ANNOTATIONS,
  QUEUE_DB_NAME,
  QUEUE_STORE_NAME,
  deriveSyncState,
  mergeQueue,
  resolveReplay,
  type QueuedAnnotation,
  type SyncState,
} from '@/lib/stand/offline';

/**
 * Durable offline annotation queue.
 *
 * A musician rehearsing in a venue with no signal must still be able to mark
 * their part. Annotations made offline are stored in IndexedDB and replayed on
 * reconnect.
 *
 * Two properties matter more than speed here:
 *
 *  - **Idempotency.** Replay is keyed on a client-generated id, so a flaky
 *    connection that retries cannot create a second copy of the same stroke.
 *  - **Durability.** A queued annotation is only removed once the server has
 *    acknowledged that specific id, so a failed flush loses nothing.
 *
 * This module is deliberately separate from the annotation store and the canvas
 * layer: it owns persistence and replay only, and needs neither.
 */

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const request = indexedDB.open(QUEUE_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(QUEUE_STORE_NAME)) {
        const store = db.createObjectStore(QUEUE_STORE_NAME, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
  });
}

async function readAll(): Promise<QueuedAnnotation[]> {
  const db = await openDb();
  try {
    return await new Promise<QueuedAnnotation[]>((resolve, reject) => {
      const tx = db.transaction(QUEUE_STORE_NAME, 'readonly');
      const store = tx.objectStore(QUEUE_STORE_NAME);
      const request = store.getAll();
      request.onsuccess = () => resolve((request.result as QueuedAnnotation[]) ?? []);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

async function writeAll(items: QueuedAnnotation[]): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(QUEUE_STORE_NAME, 'readwrite');
      const store = tx.objectStore(QUEUE_STORE_NAME);
      store.clear();
      for (const item of items) store.put(item);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export interface UseOfflineAnnotationsOptions {
  /** POST a batch of annotations; resolve with the ids the server accepted. */
  send: (items: QueuedAnnotation[]) => Promise<string[]>;
  /** The piece currently open, used to scope the queue. */
  musicId: string | null;
  enabled?: boolean;
}

export interface OfflineAnnotationsState {
  queue: QueuedAnnotation[];
  syncState: SyncState;
  /** Queue an annotation made while offline. */
  enqueue: (annotation: Omit<QueuedAnnotation, 'attempts'>) => Promise<void>;
  /** Attempt a flush. Safe to call repeatedly; idempotent. */
  flush: () => Promise<void>;
  /** Drop everything queued. */
  clear: () => Promise<void>;
}

export function useOfflineAnnotations({
  send,
  musicId,
  enabled = true,
}: UseOfflineAnnotationsOptions): OfflineAnnotationsState {
  const [queue, setQueue] = useState<QueuedAnnotation[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [online, setOnline] = useState(true);

  // Keep the latest send/queue in refs so flush never closes over stale state.
  const sendRef = useRef(send);
  sendRef.current = send;
  const queueRef = useRef<QueuedAnnotation[]>([]);
  queueRef.current = queue;
  const syncingRef = useRef(false);

  useEffect(() => {
    setOnline(typeof navigator === 'undefined' ? true : navigator.onLine);
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  // Load the queue on mount so a reload does not lose offline work.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void readAll()
      .then((items) => {
        if (!cancelled) setQueue(items);
      })
      .catch(() => {
        // No IndexedDB (private mode, etc.): the app still works, just not
        // offline-durable. Not worth surfacing as an error.
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  const enqueue = useCallback(async (annotation: Omit<QueuedAnnotation, 'attempts'>) => {
    const withAttempts: QueuedAnnotation = { ...annotation, attempts: 0 };
    const merged = mergeQueue(queueRef.current, [withAttempts]);
    queueRef.current = merged;
    setQueue(merged);
    try {
      await writeAll(merged);
    } catch {
      // Persistence failure: the in-memory queue still flushes this session.
    }
  }, []);

  const flush = useCallback(async () => {
    if (!enabled || syncingRef.current) return;
    const pending = queueRef.current.filter((q) => !musicId || q.musicId === musicId);
    if (pending.length === 0) return;
    if (typeof navigator !== 'undefined' && !navigator.onLine) return;

    syncingRef.current = true;
    setSyncing(true);
    setLastError(null);
    try {
      const accepted = await sendRef.current(pending);
      // Remove ONLY what the server confirmed; anything else stays queued.
      const { remaining } = resolveReplay(queueRef.current, accepted);
      queueRef.current = remaining;
      setQueue(remaining);
      try {
        await writeAll(remaining);
      } catch {
        // In-memory state is still correct.
      }
    } catch (err) {
      setLastError(err instanceof Error ? err.message : 'Sync failed');
    } finally {
      syncingRef.current = false;
      setSyncing(false);
    }
  }, [enabled, musicId]);

  // Flush as soon as the connection returns.
  useEffect(() => {
    if (online) void flush();
  }, [online, flush]);

  const clear = useCallback(async () => {
    queueRef.current = [];
    setQueue([]);
    try {
      await writeAll([]);
    } catch {
      // Nothing more to do.
    }
  }, []);

  return {
    queue,
    syncState: deriveSyncState({ online, queueLength: queue.length, syncing, lastError }),
    enqueue,
    flush,
    clear,
  };
}

/** True when the queue has reached its cap and is dropping the oldest work. */
export function queueIsFull(queue: QueuedAnnotation[]): boolean {
  return queue.length >= MAX_QUEUED_ANNOTATIONS;
}
