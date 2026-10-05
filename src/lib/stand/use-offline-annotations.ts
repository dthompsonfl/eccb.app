'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  LEGACY_QUEUE_DB_NAME,
  MAX_QUEUED_ANNOTATIONS,
  QUEUE_STORE_NAME,
  deriveSyncState,
  mergeQueue,
  queueDbNameFor,
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

/**
 * Delete the pre-isolation, unscoped queue database.
 *
 * DELIBERATE DISCARD — DO NOT "FIX" THIS BY MIGRATING.
 *
 * Entries in that store were written with no owner recorded: `QueuedAnnotation`
 * has no user id field, so there is no correct identity to migrate them to.
 * Re-homing them under whoever signs in next would replay an unknown musician's
 * strokes into that musician's account — the precise cross-user leak this
 * per-user namespacing exists to close. Unrecoverable-looking offline strokes are
 * the correct trade: they are gone, and nothing belonging to someone else
 * survives.
 *
 * Errors are swallowed: a browser that blocks `deleteDatabase` (another tab
 * holding the store open) must not break the current user's own queue. The
 * legacy store simply lingers unused until it can be removed.
 */
async function retireLegacyQueueDb(): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  try {
    // `databases()` is unavailable in some browsers; then we cannot cheaply
    // check, and leaving the store in place is harmless because nothing reads it.
    if (typeof indexedDB.databases !== 'function') return;
    const existing = await indexedDB.databases();
    if (!existing.some((info) => info.name === LEGACY_QUEUE_DB_NAME)) return;
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase(LEGACY_QUEUE_DB_NAME);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    });
  } catch {
    // Best-effort cleanup; never blocks the scoped queue below.
  }
}

/**
 * Open one already-resolved, user-scoped queue database.
 *
 * Returns `null` for a null/blank name, which every call site must treat as
 * "perform no IndexedDB I/O". There is deliberately no default name and no
 * fallback branch: the only names that reach this function come from
 * `queueDbNameFor`, so the unscoped `QUEUE_DB_NAME` cannot re-enter through a
 * refactor that forgets to scope.
 */
async function openDb(dbName: string | null): Promise<IDBDatabase | null> {
  if (!dbName) return null;
  if (typeof indexedDB === 'undefined') {
    throw new Error('IndexedDB unavailable');
  }
  await retireLegacyQueueDb();

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, 1);
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

/** Read a user's queue. Returns [] for a null db name — no I/O is performed. */
async function readAll(dbName: string | null): Promise<QueuedAnnotation[]> {
  if (!dbName) return [];
  const db = await openDb(dbName);
  if (!db) return [];
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

/** Replace a user's queue. A no-op for a null db name — no I/O is performed. */
async function writeAll(dbName: string | null, items: QueuedAnnotation[]): Promise<void> {
  if (!dbName) return;
  const db = await openDb(dbName);
  if (!db) return;
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
  /**
   * Session user id. REQUIRED for any persistence: the queue database is
   * namespaced per user, so a null id means no IndexedDB access at all rather
   * than a shared store.
   */
  userId: string | null;
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
  userId,
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

  // The resolved per-user database name, or null when there is no user. `null`
  // means this hook performs no IndexedDB I/O at all and reports an empty,
  // synced queue — fail closed rather than fall back to a shared store.
  const dbName = queueDbNameFor(userId);
  const dbNameRef = useRef<string | null>(dbName);
  dbNameRef.current = dbName;

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
  //
  // `dbName` is a dependency so switching accounts on a shared tablet reloads
  // the new user's queue instead of continuing to display (and later flush)
  // the previous musician's strokes.
  useEffect(() => {
    if (!enabled) return;
    if (!dbName) {
      // No identity to scope by: clear anything left from a previous user so it
      // cannot be shown or replayed, and do not touch IndexedDB.
      setQueue([]);
      queueRef.current = [];
      return;
    }
    let cancelled = false;
    void readAll(dbName)
      .then((items) => {
        if (cancelled) return;
        queueRef.current = items;
        setQueue(items);
      })
      .catch(() => {
        // No IndexedDB (private mode, etc.): the app still works, just not
        // offline-durable. Not worth surfacing as an error.
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, dbName]);

  const enqueue = useCallback(async (annotation: Omit<QueuedAnnotation, 'attempts'>) => {
    // Without a scoped store there is nowhere safe to persist this stroke, and
    // an in-memory queue would be flushed under a later user's session.
    if (!dbNameRef.current) return;
    const withAttempts: QueuedAnnotation = { ...annotation, attempts: 0 };
    const merged = mergeQueue(queueRef.current, [withAttempts]);
    queueRef.current = merged;
    setQueue(merged);
    try {
      await writeAll(dbNameRef.current, merged);
    } catch {
      // Persistence failure: the in-memory queue still flushes this session.
    }
  }, []);

  const flush = useCallback(async () => {
    if (!enabled || syncingRef.current) return;
    // Fail closed: with no user id there is no queue that is provably ours, so
    // there is nothing it is safe to send.
    if (!dbNameRef.current) return;
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
        await writeAll(dbNameRef.current, remaining);
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
      await writeAll(dbNameRef.current, []);
    } catch {
      // Nothing more to do.
    }
  }, []);

  return {
    queue,
    // With no user id there is no queue to show or send, so the honest state is
    // 'synced' rather than a phantom 'pending' the user cannot clear.
    syncState: dbName
      ? deriveSyncState({ online, queueLength: queue.length, syncing, lastError })
      : 'synced',
    enqueue,
    flush,
    clear,
  };
}

/**
 * Delete one user's offline annotation queue.
 *
 * Called on sign-out. The queue is per-user IndexedDB, so deleting the database
 * named for the departing user is the whole purge — no shared store is touched,
 * because there is no longer one.
 *
 * Returns false (never throws) when there is no id or IndexedDB is
 * unavailable, so the caller's sign-out sequence is never blocked.
 */
export async function purgeOfflineAnnotationQueue(userId: string | null | undefined): Promise<boolean> {
  const dbName = queueDbNameFor(userId);
  if (!dbName || typeof indexedDB === 'undefined') return false;
  try {
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase(dbName);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      // Blocked means another tab still holds it open. Resolving rather than
      // hanging keeps sign-out moving; the store is per-user and never read
      // again once this user is gone.
      request.onblocked = () => resolve();
    });
    return true;
  } catch {
    return false;
  }
}

/** True when the queue has reached its cap and is dropping the oldest work. */
export function queueIsFull(queue: QueuedAnnotation[]): boolean {
  return queue.length >= MAX_QUEUED_ANNOTATIONS;
}
