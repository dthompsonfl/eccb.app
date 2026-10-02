import { describe, expect, it } from 'vitest';
import {
  CACHE_VERSION,
  MAX_QUEUED_ANNOTATIONS,
  OFFLINE_CACHE_HEADER,
  OFFLINE_USER_HEADER,
  allCacheNamesFor,
  cacheBelongsToUser,
  cacheNameFor,
  classifyRequest,
  deriveSyncState,
  isAppCacheName,
  mergeQueue,
  resolveReplay,
  shouldCacheScoreResponse,
  strategyFor,
  type QueuedAnnotation,
} from '../offline';

const headers = (map: Record<string, string>) => ({
  get: (name: string) => map[name] ?? null,
});

describe('request classification', () => {
  it('classifies score deliveries', () => {
    for (const path of ['/api/files/abc.pdf', '/api/stand/files/x.pdf', '/api/stand/stream/y.pdf']) {
      expect(classifyRequest({ url: path }).kind, path).toBe('score');
    }
  });

  it('classifies other API routes as api, never as cacheable scores', () => {
    expect(classifyRequest({ url: '/api/stand/annotations' }).kind).toBe('api');
    expect(classifyRequest({ url: '/api/admin/uploads' }).kind).toBe('api');
  });

  it('classifies static assets', () => {
    expect(classifyRequest({ url: '/_next/static/chunk.js' }).kind).toBe('static-asset');
    expect(classifyRequest({ url: '/logo.svg' }).kind).toBe('static-asset');
  });

  it('classifies navigations as app shell', () => {
    expect(classifyRequest({ url: '/member/stand', isNavigation: true }).kind).toBe('app-shell');
  });

  it('classifies an absolute URL correctly', () => {
    expect(classifyRequest({ url: 'https://band.example.org/api/files/a.pdf' }).kind).toBe('score');
  });
});

describe('cache strategy', () => {
  it('never caches API responses implicitly', () => {
    // A cached authorization decision or mutation is a security hazard.
    expect(strategyFor('api')).toBe('network-only');
    expect(strategyFor('other')).toBe('network-only');
  });

  it('serves scores network-first so authorization is always re-checked', () => {
    expect(strategyFor('score')).toBe('network-first');
  });

  it('uses stale-while-revalidate for static assets', () => {
    expect(strategyFor('static-asset')).toBe('stale-while-revalidate');
  });
});

describe('per-user cache isolation', () => {
  it('namespaces every cache by user', () => {
    expect(cacheNameFor('user-a', 'score')).toContain('user-a');
    expect(cacheNameFor('user-b', 'score')).toContain('user-b');
  });

  it('gives two users different score caches', () => {
    expect(cacheNameFor('user-a', 'score')).not.toBe(cacheNameFor('user-b', 'score'));
  });

  it('recognises only the requesting user’s caches', () => {
    const mine = cacheNameFor('user-a', 'score');
    expect(cacheBelongsToUser(mine, 'user-a')).toBe(true);
    // The critical property: user B must never open user A's score cache.
    expect(cacheBelongsToUser(mine, 'user-b')).toBe(false);
  });

  it('lists every cache a user owns, for logout purge', () => {
    const names = allCacheNamesFor('user-a');
    expect(names).toHaveLength(3);
    expect(names.every((n) => cacheBelongsToUser(n, 'user-a'))).toBe(true);
    expect(names.some((n) => cacheBelongsToUser(n, 'user-b'))).toBe(false);
  });

  it('recognises its own caches and not arbitrary ones', () => {
    expect(isAppCacheName(cacheNameFor('user-a', 'score'))).toBe(true);
    expect(isAppCacheName('some-other-app-cache')).toBe(false);
    expect(isAppCacheName(`eccb-stand-${CACHE_VERSION}-score-user-a`)).toBe(true);
  });
});

describe('score response caching', () => {
  const ok = headers({ [OFFLINE_CACHE_HEADER]: 'true' });

  it('caches a successful, opted-in response for the right user', () => {
    expect(shouldCacheScoreResponse({ status: 200, headers: ok, userId: 'user-a' }).cache).toBe(true);
  });

  it('refuses to cache when the server did not opt in', () => {
    // Defence in depth: caching is opt-in, never implicit.
    const r = shouldCacheScoreResponse({ status: 200, headers: headers({}), userId: 'user-a' });
    expect(r.cache).toBe(false);
    expect(r.reason).toMatch(/did not opt/i);
  });

  it('never caches an error or a redirect to login', () => {
    for (const status of [302, 401, 403, 404, 500]) {
      expect(
        shouldCacheScoreResponse({ status, headers: ok, userId: 'user-a' }).cache,
        `status ${status}`,
      ).toBe(false);
    }
  });

  it('never caches for an unauthenticated user', () => {
    const r = shouldCacheScoreResponse({ status: 200, headers: ok, userId: null });
    expect(r.cache).toBe(false);
    expect(r.reason).toMatch(/authenticated/i);
  });

  it('refuses a response owned by a different user', () => {
    // A misrouted response must not be stored for the wrong person even when
    // the opt-in header is present.
    const r = shouldCacheScoreResponse({
      status: 200,
      headers: headers({ [OFFLINE_CACHE_HEADER]: 'true', [OFFLINE_USER_HEADER]: 'user-b' }),
      userId: 'user-a',
    });
    expect(r.cache).toBe(false);
    expect(r.reason).toMatch(/different user/i);
  });

  it('accepts a response whose owner matches', () => {
    const r = shouldCacheScoreResponse({
      status: 200,
      headers: headers({ [OFFLINE_CACHE_HEADER]: 'true', [OFFLINE_USER_HEADER]: 'user-a' }),
      userId: 'user-a',
    });
    expect(r.cache).toBe(true);
  });

  it('accepts a case-insensitive opt-in header', () => {
    const r = shouldCacheScoreResponse({
      status: 200,
      headers: headers({ [OFFLINE_CACHE_HEADER]: 'TRUE' }),
      userId: 'user-a',
    });
    expect(r.cache).toBe(true);
  });
});

function annotation(id: string, createdAt = '2026-01-01T00:00:00.000Z'): QueuedAnnotation {
  return {
    id,
    musicId: 'piece-1',
    page: 1,
    layer: 'PERSONAL',
    strokeData: { points: [] },
    createdAt,
    attempts: 0,
  };
}

describe('offline annotation queue', () => {
  it('deduplicates by id so replay cannot double a stroke', () => {
    const a = annotation('ann-1');
    const merged = mergeQueue([a], [annotation('ann-1')]);
    expect(merged).toHaveLength(1);
  });

  it('adds genuinely new annotations', () => {
    const merged = mergeQueue([annotation('ann-1')], [annotation('ann-2')]);
    expect(merged).toHaveLength(2);
  });

  it('keeps the original entry when a duplicate arrives with changes', () => {
    const original = { ...annotation('ann-1'), attempts: 3 };
    const merged = mergeQueue([original], [{ ...annotation('ann-1'), attempts: 0 }]);
    expect(merged[0].attempts).toBe(3);
  });

  it('orders oldest first', () => {
    const merged = mergeQueue(
      [annotation('b', '2026-01-02T00:00:00.000Z')],
      [annotation('a', '2026-01-01T00:00:00.000Z')],
    );
    expect(merged.map((q) => q.id)).toEqual(['a', 'b']);
  });

  it('caps the queue and keeps the newest entries', () => {
    const many = Array.from({ length: MAX_QUEUED_ANNOTATIONS + 50 }, (_, i) =>
      annotation(`ann-${i}`, new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString()),
    );
    const merged = mergeQueue([], many);
    expect(merged.length).toBeLessThanOrEqual(MAX_QUEUED_ANNOTATIONS);
    // The most recent survives.
    expect(merged[merged.length - 1].id).toBe(`ann-${many.length - 1}`);
  });

  it('removes only confirmed entries after a successful replay', () => {
    const queued = [annotation('a'), annotation('b'), annotation('c')];
    const { replayed, remaining } = resolveReplay(queued, ['a', 'c']);
    expect(replayed.map((q) => q.id)).toEqual(['a', 'c']);
    expect(remaining.map((q) => q.id)).toEqual(['b']);
  });

  it('keeps unconfirmed entries so nothing is silently lost', () => {
    const { remaining } = resolveReplay([annotation('a')], []);
    expect(remaining).toHaveLength(1);
  });

  it('is idempotent across repeated flushes', () => {
    let queue = mergeQueue([], [annotation('a'), annotation('b')]);
    const first = resolveReplay(queue, ['a', 'b']);
    queue = first.remaining;
    // A second flush of the same ids must not resurrect anything.
    const second = resolveReplay(queue, ['a', 'b']);
    expect(second.remaining).toHaveLength(0);
    expect(second.replayed).toHaveLength(0);
  });
});

describe('sync state', () => {
  it('is offline when there is no connection, even with a queue', () => {
    expect(deriveSyncState({ online: false, queueLength: 3, syncing: false })).toBe('offline');
  });

  it('is synced when online with an empty queue', () => {
    expect(deriveSyncState({ online: true, queueLength: 0, syncing: false })).toBe('synced');
  });

  it('is pending when online with unsent annotations', () => {
    expect(deriveSyncState({ online: true, queueLength: 2, syncing: false })).toBe('pending');
  });

  it('is syncing during a flush', () => {
    expect(deriveSyncState({ online: true, queueLength: 2, syncing: true })).toBe('syncing');
  });

  it('surfaces an error', () => {
    expect(
      deriveSyncState({ online: true, queueLength: 1, syncing: false, lastError: 'boom' }),
    ).toBe('error');
  });

  it('reports offline even while syncing, since nothing will succeed', () => {
    expect(deriveSyncState({ online: false, queueLength: 1, syncing: true })).toBe('offline');
  });
});
