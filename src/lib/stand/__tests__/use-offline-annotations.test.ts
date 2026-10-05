import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { LEGACY_QUEUE_DB_NAME, QUEUE_DB_NAME, queueDbNameFor } from '@/lib/stand/offline';
import { useOfflineAnnotations } from '../use-offline-annotations';
import type { QueuedAnnotation } from '@/lib/stand/offline';

/**
 * The offline annotation queue used to live in ONE fixed IndexedDB
 * (`eccb-offline`) with no user dimension, and `readAll` returned every entry
 * unfiltered. On a shared rehearsal tablet that meant user B loaded user A's
 * queued strokes and POSTed them under B's own session — a cross-user leak of
 * annotation data plus an attribution error on the score.
 *
 * fake-indexeddb is deliberately NOT a dependency, so the store below is a
 * hand-rolled stub good enough to prove which database NAME is opened and what
 * each open returns. That is exactly the boundary the fix moves.
 */

function createFakeIndexedDb(seed: Record<string, QueuedAnnotation[]>) {
  const stores = new Map<string, QueuedAnnotation[]>(
    Object.entries(seed).map(([name, items]) => [name, [...items]]),
  );
  const openedNames: string[] = [];
  const deletedNames: string[] = [];

  function makeRequest<T>(run: () => T) {
    const request: Record<string, unknown> = { result: undefined, error: null };
    queueMicrotask(() => {
      try {
        request.result = run();
        (request.onsuccess as (() => void) | undefined)?.();
      } catch (err) {
        request.error = err;
        (request.onerror as (() => void) | undefined)?.();
      }
    });
    return request as unknown as { onsuccess?: () => void; onerror?: () => void };
  }

  const factory = {
    open(name: string) {
      openedNames.push(name);
      const request: Record<string, unknown> = { result: null, error: null };
      queueMicrotask(() => {
        if (!stores.has(name)) stores.set(name, []);
        const db = {
          name,
          objectStoreNames: { contains: () => true },
          createObjectStore: () => ({ createIndex: () => undefined }),
          transaction: () => {
            // Assign via a getter-backed object so `oncomplete` set AFTER this
            // function returns is still the one the completion microtask calls.
            const handle: { oncomplete?: () => void } = {};
            queueMicrotask(() => handle.oncomplete?.());
            return {
              get oncomplete() {
                return handle.oncomplete;
              },
              set oncomplete(fn: (() => void) | undefined) {
                handle.oncomplete = fn;
              },
              get error() {
                return null;
              },
              objectStore: () => ({
                getAll: () =>
                  makeRequest(() => [...(stores.get(name) ?? [])]),
                clear: () => {
                  stores.set(name, []);
                  return makeRequest(() => undefined);
                },
                put: (item: QueuedAnnotation) => {
                  const existing = stores.get(name) ?? [];
                  stores.set(
                    name,
                    [...existing.filter((q) => q.id !== item.id), item],
                  );
                  return makeRequest(() => undefined);
                },
              }),
            };
          },
          close: () => undefined,
        };
        request.result = db;
        (request.onsuccess as (() => void) | undefined)?.();
      });
      return request;
    },
    deleteDatabase(name: string) {
      deletedNames.push(name);
      stores.delete(name);
      return makeRequest(() => undefined);
    },
    databases() {
      return Promise.resolve(
        [...stores.keys()].map((n) => ({ name: n, version: 1 }) as unknown as IDBDatabaseInfo),
      );
    },
  };

  return { factory, stores, openedNames, deletedNames };
}

function annotation(id: string, musicId = 'piece-1'): QueuedAnnotation {
  return {
    id,
    musicId,
    page: 1,
    layer: 'PERSONAL',
    strokeData: { points: [] },
    createdAt: '2026-01-01T00:00:00.000Z',
    attempts: 0,
  };
}

const originalIndexedDb = globalThis.indexedDB;

function installFake(seed: Record<string, QueuedAnnotation[]>) {
  const fake = createFakeIndexedDb(seed);
  globalThis.indexedDB = fake.factory as unknown as IDBFactory;
  return fake;
}

afterEach(() => {
  if (originalIndexedDb === undefined) {
    delete (globalThis as unknown as { indexedDB?: IDBFactory }).indexedDB;
  } else {
    globalThis.indexedDB = originalIndexedDb;
  }
  vi.restoreAllMocks();
});

describe('useOfflineAnnotations user scoping', () => {
  beforeEach(() => {
    // jsdom reports online; keep flush deterministic.
    Object.defineProperty(globalThis.navigator, 'onLine', {
      value: true,
      configurable: true,
    });
  });

  it('never touches IndexedDB when there is no user id', async () => {
    // Fail closed: with no identity there is nothing to scope by, so the hook
    // must do no I/O at all rather than opening a shared store.
    const fake = installFake({});

    const { result } = renderHook(() =>
      useOfflineAnnotations({
        userId: null,
        musicId: 'piece-1',
        enabled: true,
        send: vi.fn(async () => []),
      }),
    );

    await waitFor(() => expect(result.current.queue).toEqual([]));

    expect(fake.openedNames).toEqual([]);
    expect(fake.deletedNames).toEqual([]);
    expect(result.current.queue).toEqual([]);
    // An empty queue with nothing to send reports synced, not pending.
    expect(result.current.syncState).toBe('synced');
  });

  it('never opens the shared or legacy database for a signed-in user', async () => {
    const fake = installFake({});

    renderHook(() =>
      useOfflineAnnotations({
        userId: 'user-a',
        musicId: 'piece-1',
        enabled: true,
        send: vi.fn(async () => []),
      }),
    );

    await waitFor(() => expect(fake.openedNames.length).toBeGreaterThan(0));

    expect(fake.openedNames).not.toContain(QUEUE_DB_NAME);
    expect(fake.openedNames).not.toContain(LEGACY_QUEUE_DB_NAME);
    expect(fake.openedNames.every((n) => n === queueDbNameFor('user-a'))).toBe(true);
  });

  it("loads only the signed-in user's own queue", async () => {
    // THE cross-user test: user A has two strokes queued. User B's hook must
    // not see them, because B's read targets a different database entirely.
    const fake = installFake({
      [queueDbNameFor('user-a') as string]: [annotation('a-1'), annotation('a-2')],
      [queueDbNameFor('user-b') as string]: [annotation('b-1')],
    });

    const { result } = renderHook(() =>
      useOfflineAnnotations({
        userId: 'user-b',
        musicId: 'piece-1',
        enabled: true,
        send: vi.fn(async () => []),
      }),
    );

    await waitFor(() => expect(result.current.queue.length).toBe(1));
    expect(result.current.queue.map((q) => q.id)).toEqual(['b-1']);
    expect(result.current.queue.map((q) => q.id)).not.toContain('a-1');
    // And it never even opened user A's database.
    expect(fake.openedNames).not.toContain(queueDbNameFor('user-a'));
  });

  it('reloads the queue when the signed-in user changes', async () => {
    // Without userId in the mount effect's deps, switching accounts on a shared
    // tablet keeps showing the previous musician's queue.
    installFake({
      [queueDbNameFor('user-a') as string]: [annotation('a-1')],
      [queueDbNameFor('user-b') as string]: [annotation('b-1')],
    });

    const { result, rerender } = renderHook(
      ({ userId }: { userId: string | null }) =>
        useOfflineAnnotations({
          userId,
          musicId: 'piece-1',
          enabled: true,
          send: vi.fn(async () => []),
        }),
      { initialProps: { userId: 'user-a' as string | null } },
    );

    await waitFor(() => expect(result.current.queue.map((q) => q.id)).toEqual(['a-1']));

    rerender({ userId: 'user-b' });
    await waitFor(() => expect(result.current.queue.map((q) => q.id)).toEqual(['b-1']));
  });

  it('enqueues into the signed-in user\'s own store only', async () => {
    const fake = installFake({});

    const { result } = renderHook(() =>
      useOfflineAnnotations({
        userId: 'user-a',
        musicId: 'piece-1',
        enabled: true,
        send: vi.fn(async () => []),
      }),
    );

    await act(async () => {
      await result.current.enqueue({
        id: 'a-1',
        musicId: 'piece-1',
        page: 1,
        layer: 'PERSONAL',
        strokeData: { points: [] },
        sectionId: null,
        createdAt: '2026-01-01T00:00:00.000Z',
      });
    });

    const aStore = fake.stores.get(queueDbNameFor('user-a') as string);
    expect(aStore?.map((q) => q.id)).toEqual(['a-1']);
    // User B's store must not exist at all, let alone contain A's stroke.
    expect(fake.stores.has(queueDbNameFor('user-b') as string)).toBe(false);
  });

  it('flushes only the entries belonging to the current user and piece', async () => {
    const send = vi.fn(async () => ['b-1']);
    installFake({
      [queueDbNameFor('user-a') as string]: [annotation('a-1')],
      [queueDbNameFor('user-b') as string]: [annotation('b-1'), annotation('b-other', 'piece-2')],
    });

    const { result } = renderHook(() =>
      useOfflineAnnotations({
        userId: 'user-b',
        musicId: 'piece-1',
        enabled: true,
        send,
      }),
    );

    await waitFor(() => expect(result.current.queue.length).toBe(2));
    await act(async () => {
      await result.current.flush();
    });

    const sent = send.mock.calls[0][0] as QueuedAnnotation[];
    expect(sent.map((q) => q.id)).toEqual(['b-1']);
  });

  it('retires the legacy unscoped store on the first scoped open', async () => {
    // The legacy database holds strokes with no owner recorded. They are
    // DISCARDED, not migrated: attributing them to whoever happens to sign in
    // next would recreate the exact leak this change fixes.
    const fake = installFake({
      [LEGACY_QUEUE_DB_NAME]: [annotation('orphan-1'), annotation('orphan-2')],
    });

    const { result } = renderHook(() =>
      useOfflineAnnotations({
        userId: 'user-a',
        musicId: 'piece-1',
        enabled: true,
        send: vi.fn(async () => []),
      }),
    );

    await waitFor(() => expect(fake.deletedNames).toContain(LEGACY_QUEUE_DB_NAME));

    // Orphaned strokes never surface for the new user.
    await waitFor(() => expect(result.current.queue).toEqual([]));
    expect(result.current.queue.map((q) => q.id)).not.toContain('orphan-1');
  });

  it('does nothing at all when offline queueing is disabled', async () => {
    const fake = installFake({
      [queueDbNameFor('user-a') as string]: [annotation('a-1')],
    });

    const { result } = renderHook(() =>
      useOfflineAnnotations({
        userId: 'user-a',
        musicId: 'piece-1',
        enabled: false,
        send: vi.fn(async () => []),
      }),
    );

    await waitFor(() => expect(result.current.queue).toEqual([]));
    expect(fake.openedNames).toEqual([]);
  });
});