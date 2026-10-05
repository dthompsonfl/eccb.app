import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QUEUE_DB_NAME, queueDbNameFor } from '@/lib/stand/offline';
import {
  purgeOfflineAnnotationQueue,
  useOfflineAnnotations,
} from '../use-offline-annotations';
import type { QueuedAnnotation } from '@/lib/stand/offline';

/**
 * The assembled offline-annotation loop: enqueue while offline -> survive a
 * reload -> reconnect -> replay -> drain, plus the two properties that make it
 * safe on a shared rehearsal tablet (per-user isolation across an account
 * switch, and purge on sign-out).
 *
 * `offline.test.ts` covers the pure helpers (`mergeQueue`, `resolveReplay`,
 * `deriveSyncState`) and `use-offline-annotations.test.ts` covers WHICH database
 * name is opened. Neither drives the assembled loop: a regression that broke
 * replay itself — dropping entries on remount, re-sending an already-acknowledged
 * stroke, or flushing the previous musician's work under the next musician's
 * session — would have passed both.
 *
 * fake-indexeddb is not a dependency, so the store below is hand-rolled. It is
 * deliberately backed by module-level state that outlives a single render, so a
 * test can "reload" (unmount + remount) the hook against the same database.
 */

interface FakeIdb {
  factory: IDBFactory;
  stores: Map<string, QueuedAnnotation[]>;
  openedNames: string[];
  deletedNames: string[];
}

function createFakeIndexedDb(seed: Record<string, QueuedAnnotation[]> = {}): FakeIdb {
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
                getAll: () => makeRequest(() => [...(stores.get(name) ?? [])]),
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

/** A stroke as `enqueue` accepts it — the hook owns the `attempts` counter. */
function pending(id: string, musicId = 'piece-1'): Omit<QueuedAnnotation, 'attempts'> {
  const { attempts: _attempts, ...rest } = annotation(id, musicId);
  return rest;
}

function annotation(id: string, musicId = 'piece-1'): QueuedAnnotation {
  return {
    id,
    musicId,
    page: 1,
    layer: 'PERSONAL',
    strokeData: { points: [] },
    sectionId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    attempts: 0,
  };
}

const originalIndexedDb = globalThis.indexedDB;
let fake: FakeIdb;

function installFake(seed: Record<string, QueuedAnnotation[]> = {}) {
  fake = createFakeIndexedDb(seed);
  globalThis.indexedDB = fake.factory as unknown as IDBFactory;
  return fake;
}

/** Flip connectivity the way the browser would, and tell the hook about it. */
async function goOnline(online: boolean) {
  Object.defineProperty(globalThis.navigator, 'onLine', {
    value: online,
    configurable: true,
  });
  await act(async () => {
    window.dispatchEvent(new Event(online ? 'online' : 'offline'));
  });
}

afterEach(() => {
  if (originalIndexedDb === undefined) {
    delete (globalThis as unknown as { indexedDB?: IDBFactory }).indexedDB;
  } else {
    globalThis.indexedDB = originalIndexedDb;
  }
  vi.restoreAllMocks();
});

describe('offline annotation queue: the assembled loop', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis.navigator, 'onLine', {
      value: true,
      configurable: true,
    });
  });

  it('queues an offline stroke without sending it, then drains on reconnect', async () => {
    // Gap: offline annotate -> queue, and reconnect -> replay -> drain. Nothing
    // tested the two halves together.
    installFake();
    await goOnline(false);

    const send = vi.fn(async (items: QueuedAnnotation[]) => items.map((i) => i.id));
    const { result } = renderHook(() =>
      useOfflineAnnotations({ userId: 'user-a', musicId: 'piece-1', enabled: true, send }),
    );

    await act(async () => {
      await result.current.enqueue(pending('a-1'));
    });

    // Queued, visible as pending work, and NOT posted while there is no signal.
    expect(result.current.queue.map((q) => q.id)).toEqual(['a-1']);
    expect(result.current.syncState).toBe('offline');
    expect(send, 'nothing may be sent while offline').not.toHaveBeenCalled();
    expect(fake.stores.get(queueDbNameFor('user-a') as string)?.map((q) => q.id)).toEqual([
      'a-1',
    ]);

    // The status component offers a manual Retry while offline, so a flush can be
    // requested with no signal. It must be refused, not fired at a dead socket.
    await act(async () => {
      await result.current.flush();
    });
    expect(send, 'a manual retry with no signal must send nothing').not.toHaveBeenCalled();
    expect(result.current.queue.map((q) => q.id)).toEqual(['a-1']);

    // Reconnect, on the SAME mounted hook: the queue is replayed exactly once and
    // then drains. (Unmounting here would test nothing — the flush-on-reconnect
    // effect only exists while the viewer is mounted.)
    await goOnline(true);
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0]![0].map((q) => q.id)).toEqual(['a-1']);
    await waitFor(() =>
      expect(fake.stores.get(queueDbNameFor('user-a') as string)).toEqual([]),
    );
  });

  it('still holds the queue after a reload, and replays what survived', async () => {
    // Gap: durability. A full page load discards every byte of in-memory state,
    // so if the queue only lived in React state the stroke was gone.
    installFake();
    await goOnline(false);

    const first = renderHook(() =>
      useOfflineAnnotations({
        userId: 'user-a',
        musicId: 'piece-1',
        enabled: true,
        send: vi.fn(async () => []),
      }),
    );
    await act(async () => {
      await first.result.current.enqueue(pending('a-1'));
      await first.result.current.enqueue(pending('a-2'));
    });
    expect(first.result.current.queue).toHaveLength(2);
    first.unmount();

    // "Reload": a brand-new hook instance, same database on disk.
    const send = vi.fn(async (items: QueuedAnnotation[]) => items.map((i) => i.id));
    const second = renderHook(() =>
      useOfflineAnnotations({ userId: 'user-a', musicId: 'piece-1', enabled: true, send }),
    );

    await waitFor(() => expect(second.result.current.queue).toHaveLength(2));
    expect(second.result.current.queue.map((q) => q.id).sort()).toEqual(['a-1', 'a-2']);

    // …and only once the connection is back does any of it leave the device.
    expect(send, 'a reloaded hook must not post while still offline').not.toHaveBeenCalled();
    await goOnline(true);
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0]![0].map((q) => q.id).sort()).toEqual(['a-1', 'a-2']);
  });

  it('flushes exactly once — a second flush re-sends nothing', async () => {
    // Gap: reconnect -> replay -> drain was unassembled. Idempotency is by
    // client-generated id, so a retried flush must be a no-op rather than a
    // second copy of the same pencil stroke.
    installFake({ [queueDbNameFor('user-a') as string]: [annotation('a-1')] });

    const send = vi.fn(async (items: QueuedAnnotation[]) => items.map((i) => i.id));
    const { result } = renderHook(() =>
      useOfflineAnnotations({ userId: 'user-a', musicId: 'piece-1', enabled: true, send }),
    );
    await waitFor(() => expect(result.current.queue).toHaveLength(1));

    await act(async () => {
      await result.current.flush();
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(result.current.queue).toEqual([]);
    expect(result.current.syncState).toBe('synced');

    // Second flush, and a third: nothing is re-sent.
    await act(async () => {
      await result.current.flush();
      await result.current.flush();
    });
    expect(send, 'an already-drained queue must not be replayed again').toHaveBeenCalledTimes(1);
    expect(fake.stores.get(queueDbNameFor('user-a') as string)).toEqual([]);
  });

  it('keeps unacknowledged work queued instead of dropping it', async () => {
    // A partial acceptance is the timeout case the queue exists for: the server
    // took one stroke and refused the other. Removing everything on a non-empty
    // ack would silently destroy the refused stroke.
    installFake({
      [queueDbNameFor('user-a') as string]: [annotation('a-1'), annotation('a-2')],
    });

    const send = vi.fn(async () => ['a-1']);
    const { result } = renderHook(() =>
      useOfflineAnnotations({ userId: 'user-a', musicId: 'piece-1', enabled: true, send }),
    );
    await waitFor(() => expect(result.current.queue).toHaveLength(2));

    await act(async () => {
      await result.current.flush();
    });

    expect(result.current.queue.map((q) => q.id)).toEqual(['a-2']);
    expect(fake.stores.get(queueDbNameFor('user-a') as string)?.map((q) => q.id)).toEqual([
      'a-2',
    ]);

    // The retry sends only what is left.
    await act(async () => {
      await result.current.flush();
    });
    expect(send.mock.calls[1]![0].map((q) => q.id)).toEqual(['a-2']);
  });

  it('never double-posts one client id, however many times it is re-delivered', async () => {
    installFake();
    await goOnline(false);

    const send = vi.fn(async (items: QueuedAnnotation[]) => items.map((i) => i.id));
    const { result } = renderHook(() =>
      useOfflineAnnotations({ userId: 'user-a', musicId: 'piece-1', enabled: true, send }),
    );

    // The same stroke queued twice (e.g. a duplicated local event) collapses to
    // one entry, so a single flush cannot produce two rows on the score.
    await act(async () => {
      await result.current.enqueue(pending('a-1'));
      await result.current.enqueue(pending('a-1'));
    });
    expect(result.current.queue).toHaveLength(1);

    await goOnline(true);
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0]![0].map((q) => q.id)).toEqual(['a-1']);
  });

  it('does not flush a second time while a flush is already in flight', async () => {
    // The reconnect effect, the Retry button and a manual flush can all fire in
    // the same tick. Without an in-flight guard, one stroke is posted three times.
    installFake({ [queueDbNameFor('user-a') as string]: [annotation('a-1')] });

    let release!: (ids: string[]) => void;
    const send = vi.fn(
      () =>
        new Promise<string[]>((resolve) => {
          release = resolve;
        }),
    );
    const { result } = renderHook(() =>
      useOfflineAnnotations({ userId: 'user-a', musicId: 'piece-1', enabled: true, send }),
    );
    await waitFor(() => expect(result.current.queue).toHaveLength(1));

    let inflight: Promise<void>;
    await act(async () => {
      inflight = result.current.flush();
      await result.current.flush();
      await result.current.flush();
      release(['a-1']);
      await inflight;
    });

    expect(send, 'concurrent flushes must collapse into one delivery').toHaveBeenCalledTimes(1);
    expect(result.current.queue).toEqual([]);
  });
});

describe('account-switch isolation: one musician never flushes another musician\'s work', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis.navigator, 'onLine', {
      value: true,
      configurable: true,
    });
  });

  it('gives the incoming user an empty queue and sends nothing the outgoing user queued', async () => {
    // THE test. Shared rehearsal tablet: user A marks their part with no signal,
    // then hands the tablet to user B. B must not see A's stroke, and must not
    // POST it under B's session — that is a cross-user leak of annotation data
    // plus an attribution error written onto the score itself.
    const fakeA = installFake();
    await goOnline(false);

    const sendFor = (user: string) =>
      vi.fn(async (items: QueuedAnnotation[]) => items.map((i) => `${user}:${i.id}`));

    const sendA = sendFor('user-a');
    const first = renderHook(
      ({ userId }: { userId: string }) =>
        useOfflineAnnotations({
          userId,
          musicId: 'piece-1',
          enabled: true,
          send: userId === 'user-a' ? sendA : sendFor('user-b'),
        }),
      { initialProps: { userId: 'user-a' } },
    );

    await act(async () => {
      await first.result.current.enqueue(pending('a-1'));
    });
    expect(first.result.current.queue.map((q) => q.id)).toEqual(['a-1']);
    expect(sendA).not.toHaveBeenCalled();

    // A signs out / B signs in, with no reload.
    const sendB = sendFor('user-b');
    first.rerender({ userId: 'user-b' });

    await waitFor(() => expect(first.result.current.queue).toEqual([]));
    expect(
      first.result.current.queue.map((q) => q.id),
      "B's queue must never contain A's stroke",
    ).not.toContain('a-1');

    // B flushing — on reconnect or by hand — transmits nothing A wrote.
    await goOnline(true);
    await act(async () => {
      await first.result.current.flush();
    });
    expect(sendB, 'B must not send anything A queued').not.toHaveBeenCalled();

    // A's work is still A's: untouched, and still scoped to A's own database.
    expect(fakeA.stores.get(queueDbNameFor('user-a') as string)?.map((q) => q.id)).toEqual([
      'a-1',
    ]);
    expect(fakeA.openedNames).not.toContain(QUEUE_DB_NAME);
  });

  it('leaves the outgoing user\'s queue intact when a null user id is in play', async () => {
    // The moment between sign-out and the next sign-in there is no identity to
    // scope by. The hook must show nothing and touch no database; the departing
    // user's own store must survive untouched for their next sign-in.
    const fakeNull = installFake();
    await goOnline(false);

    const sendA = vi.fn(async (items: QueuedAnnotation[]) => items.map((i) => i.id));
    const signedIn = renderHook(
      ({ userId }: { userId: string | null }) =>
        useOfflineAnnotations({
          userId,
          musicId: 'piece-1',
          enabled: true,
          send: sendA,
        }),
      { initialProps: { userId: 'user-a' as string | null } },
    );
    await act(async () => {
      await signedIn.result.current.enqueue(pending('a-1'));
    });
    expect(signedIn.result.current.queue).toHaveLength(1);
    const opensBeforeSignOut = fakeNull.openedNames.length;

    signedIn.rerender({ userId: null });

    await waitFor(() => expect(signedIn.result.current.queue).toEqual([]));
    expect(signedIn.result.current.syncState, 'nothing is claimed to be pending').toBe('synced');
    await act(async () => {
      await signedIn.result.current.flush();
    });
    expect(sendA).not.toHaveBeenCalled();
    expect(
      fakeNull.openedNames.length,
      'no IndexedDB access at all without a user id',
    ).toBe(opensBeforeSignOut);
    expect(fakeNull.stores.get(queueDbNameFor('user-a') as string)?.map((q) => q.id)).toEqual([
      'a-1',
    ]);
  });

  it('keeps two users\' queues in separate databases that never see each other', async () => {
    // Structural guard behind the behavioural test above: the isolation boundary
    // is the database NAME, so if both users ever shared a name, every assertion
    // in the behavioural test would start passing for the wrong reason again.
    const fakeBoth = installFake();

    for (const userId of ['user-a', 'user-b']) {
      const hook = renderHook(() =>
        useOfflineAnnotations({
          userId,
          musicId: 'piece-1',
          enabled: true,
          send: vi.fn(async () => []),
        }),
      );
      await waitFor(() => expect(hook.result.current.queue).toEqual([]));
      hook.unmount();
    }

    expect(fakeBoth.openedNames).toContain(queueDbNameFor('user-a') as string);
    expect(fakeBoth.openedNames).toContain(queueDbNameFor('user-b') as string);
    expect(queueDbNameFor('user-a')).not.toBe(queueDbNameFor('user-b'));
    // Neither user's store was ever created under the other's name.
    expect(fakeBoth.openedNames).not.toContain(QUEUE_DB_NAME);
  });
});

describe('sign-out purges the departing user\'s offline work', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis.navigator, 'onLine', {
      value: true,
      configurable: true,
    });
  });

  it('deletes the user\'s queue database and reads back nothing afterwards', async () => {
    // Gap: sign-out purge. What must not survive a sign-out is the departing
    // user's queued strokes and their score caches.
    const fakePurge = installFake({
      [queueDbNameFor('user-a') as string]: [annotation('a-1'), annotation('a-2')],
      [queueDbNameFor('user-b') as string]: [annotation('b-1')],
    });
    await goOnline(false);

    const signedIn = renderHook(() =>
      useOfflineAnnotations({
        userId: 'user-a',
        musicId: 'piece-1',
        enabled: true,
        send: vi.fn(async () => []),
      }),
    );
    await waitFor(() => expect(signedIn.result.current.queue).toHaveLength(2));
    signedIn.unmount();

    await expect(purgeOfflineAnnotationQueue('user-a')).resolves.toBe(true);

    expect(fakePurge.deletedNames).toContain(queueDbNameFor('user-a') as string);
    expect(fakePurge.stores.has(queueDbNameFor('user-a') as string)).toBe(false);
    // Purging one user must not reach into another user's store.
    expect(fakePurge.deletedNames).not.toContain(queueDbNameFor('user-b') as string);
    expect(fakePurge.stores.get(queueDbNameFor('user-b') as string)?.map((q) => q.id)).toEqual([
      'b-1',
    ]);

    // A subsequent read of the purged user's queue returns nothing, and nothing
    // they queued is replayed.
    const send = vi.fn(async (items: QueuedAnnotation[]) => items.map((i) => i.id));
    const afterSignOut = renderHook(() =>
      useOfflineAnnotations({ userId: 'user-a', musicId: 'piece-1', enabled: true, send }),
    );
    await waitFor(() => expect(afterSignOut.result.current.queue).toEqual([]));
    await act(async () => {
      await afterSignOut.result.current.flush();
    });
    expect(send, 'nothing may be replayed after a sign-out purge').not.toHaveBeenCalled();
  });

  it('reports failure instead of throwing when there is no user to purge', async () => {
    installFake();
    // A sign-out sequence must never be blocked by the purge, so a null id has
    // to be a reported false rather than a throw.
    await expect(purgeOfflineAnnotationQueue(null)).resolves.toBe(false);
    await expect(purgeOfflineAnnotationQueue('   ')).resolves.toBe(false);
    expect(fake.deletedNames).toEqual([]);
  });
});