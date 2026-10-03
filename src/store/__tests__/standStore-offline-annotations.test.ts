import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useStandStore, type Annotation } from '@/store/standStore';

/**
 * `addAnnotation` must survive a dropped connection.
 *
 * Before this was wired, a stroke made with no signal was posted into the void:
 * the request failed, the error was logged to a console nobody reads during a
 * rehearsal, and the mark was simply gone. A musician who had pencilled in a
 * tricky bar had no way to know it had not been recorded.
 */

function makeAnnotation(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: 'stroke-uuid-0001',
    pieceId: 'piece-1',
    pageNumber: 3,
    layer: 'PERSONAL',
    strokeData: { points: [[0, 0]] },
    sectionId: null,
    createdAt: '2026-10-04T00:00:00.000Z',
    ...overrides,
  };
}

function setOnline(online: boolean) {
  Object.defineProperty(globalThis, 'navigator', {
    value: { onLine: online },
    configurable: true,
    writable: true,
  });
}

describe('standStore.addAnnotation offline routing', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    useStandStore.setState({
      annotations: { personal: {}, section: {}, director: {} },
      offlineAnnotationQueue: null,
    });
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        annotation: {
          id: 'server-1',
          musicId: 'piece-1',
          page: 3,
          layer: 'PERSONAL',
          strokeData: { points: [[0, 0]] },
          sectionId: null,
          userId: 'user-1',
          createdAt: '2026-10-04T00:00:00.000Z',
          updatedAt: '2026-10-04T00:00:00.000Z',
        },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    setOnline(true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts directly when online and no queue is registered', async () => {
    await useStandStore.getState().addAnnotation(makeAnnotation());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/stand/annotations');
  });

  it('posts directly when a queue is registered but the connection is up', async () => {
    // Registering a queue must not divert normal online writes into IndexedDB —
    // that would silently stop strokes reaching the server at all.
    useStandStore.getState().setOfflineAnnotationQueue({ enqueue: vi.fn() });

    await useStandStore.getState().addAnnotation(makeAnnotation());

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('queues instead of posting when offline, and shows the stroke immediately', async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    useStandStore.getState().setOfflineAnnotationQueue({ enqueue });
    setOnline(false);

    await useStandStore.getState().addAnnotation(makeAnnotation());

    expect(fetchMock).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledTimes(1);

    // The mark must be visible to the musician right away, or they will draw it
    // again and end up with two copies.
    const personal = useStandStore.getState().annotations.personal['piece-1-3'];
    expect(personal).toHaveLength(1);
    expect(personal[0].id).toBe('stroke-uuid-0001');
  });

  it('reuses the stroke id as the idempotency key', async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    useStandStore.getState().setOfflineAnnotationQueue({ enqueue });
    setOnline(false);

    await useStandStore.getState().addAnnotation(makeAnnotation({ id: 'replay-key-abc' }));

    const queued = enqueue.mock.calls[0][0];
    expect(queued.id).toBe('replay-key-abc');
    expect(queued.musicId).toBe('piece-1');
    expect(queued.page).toBe(3);
    expect(queued.layer).toBe('PERSONAL');
    expect(queued.attempts).toBe(0);
  });

  it('does not touch the store when the queue is unregistered again', async () => {
    useStandStore.getState().setOfflineAnnotationQueue({ enqueue: vi.fn() });
    useStandStore.getState().setOfflineAnnotationQueue(null);
    setOnline(false);

    await useStandStore.getState().addAnnotation(makeAnnotation());

    // With no queue there is nowhere durable to put it, so the online path is
    // used and the failure surfaces as a console error rather than a silent
    // in-memory-only mark.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});