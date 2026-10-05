import { describe, expect, it } from 'vitest';
import {
  CACHE_VERSION,
  LEGACY_QUEUE_DB_NAME,
  MAX_QUEUED_ANNOTATIONS,
  OFFLINE_CACHE_HEADER,
  OFFLINE_USER_HEADER,
  QUEUE_DB_NAME,
  allCacheNamesFor,
  cacheBelongsToUser,
  cacheNameFor,
  classifyRequest,
  deriveSyncState,
  isAppCacheName,
  markScoreResponseCacheable,
  mergeQueue,
  queueDbNameFor,
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

/**
 * The server side of the opt-in.
 *
 * `shouldCacheScoreResponse` is the consumer; this is the producer. Nothing set
 * `X-Eccb-Offline-Cacheable` anywhere, so the whole offline-score path was dead
 * code that read as a working feature. These tests pin the three gates that
 * make it safe to set the header at all.
 */
describe('markScoreResponseCacheable', () => {
  it('opts a response in when the feature is on and a user is known', () => {
    const h = markScoreResponseCacheable({ headers: new Headers(), enabled: true, userId: 'user-a' });
    expect(h.get(OFFLINE_CACHE_HEADER)).toBe('true');
    // The owner header is what stops a misrouted response being stored for the
    // wrong person even if the opt-in is present.
    expect(h.get(OFFLINE_USER_HEADER)).toBe('user-a');
  });

  it('stays silent when the admin setting disables offline', () => {
    const h = markScoreResponseCacheable({ headers: new Headers(), enabled: false, userId: 'user-a' });
    expect(h.get(OFFLINE_CACHE_HEADER)).toBeNull();
    expect(h.get(OFFLINE_USER_HEADER)).toBeNull();
  });

  it('stays silent when there is no authenticated user', () => {
    for (const userId of [null, undefined, '']) {
      const h = markScoreResponseCacheable({ headers: new Headers(), enabled: true, userId });
      expect(h.get(OFFLINE_CACHE_HEADER), String(userId)).toBeNull();
    }
  });

  it('produces a response the consumer then accepts', () => {
    // End-to-end through the real Headers object, not a fake getter.
    const h = markScoreResponseCacheable({ headers: new Headers(), enabled: true, userId: 'user-a' });
    expect(shouldCacheScoreResponse({ status: 200, headers: h, userId: 'user-a' }).cache).toBe(true);
    // ...and still refuses it for anyone else.
    expect(shouldCacheScoreResponse({ status: 200, headers: h, userId: 'user-b' }).cache).toBe(false);
  });

  it('never makes an error status cacheable, whatever the status', () => {
    // The header alone is not enough: a 401/403/404/302 carrying it would be
    // refused by shouldCacheScoreResponse, which is the second line of defence.
    for (const status of [302, 401, 403, 404, 500]) {
      const h = markScoreResponseCacheable({
        headers: new Headers(),
        enabled: true,
        userId: 'user-a',
      });
      expect(shouldCacheScoreResponse({ status, headers: h, userId: 'user-a' }).cache, `status ${status}`).toBe(
        false,
      );
    }
  });

  it('does not mutate unrelated headers', () => {
    const h = new Headers({ 'Content-Type': 'application/pdf' });
    markScoreResponseCacheable({ headers: h, enabled: true, userId: 'user-a' });
    expect(h.get('Content-Type')).toBe('application/pdf');
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

describe('per-user offline queue isolation', () => {
  // The offline queue used to live in one fixed IndexedDB ('eccb-offline') with
  // no user dimension, so on a shared rehearsal tablet user B loaded user A's
  // queued strokes and POSTed them under B's session. The database NAME is the
  // isolation boundary, exactly as it is for score caches.
  it('gives two different users two different database names', () => {
    expect(queueDbNameFor('user-a')).not.toBe(queueDbNameFor('user-b'));
  });

  it('includes the user id in the database name', () => {
    expect(queueDbNameFor('user-a')).toContain('user-a');
    expect(queueDbNameFor('user-b')).toContain('user-b');
  });

  it('never returns a name that could collide with another user', () => {
    // Prefix collisions must not exist: 'a' and 'a-b' must not produce names
    // where one is a prefix-concatenation of the other.
    expect(queueDbNameFor('a')).not.toBe(queueDbNameFor('a-b'));
  });

  it('namespaces by cache version so a format bump discards old queues', () => {
    expect(queueDbNameFor('user-a')).toContain(CACHE_VERSION);
    expect(queueDbNameFor('user-a')).toContain(QUEUE_DB_NAME);
  });

  it('fails closed with no user id rather than falling back to a shared store', () => {
    // null is the fail-closed answer: with no identity there is nothing to scope
    // by, and a shared fallback is exactly the leak being fixed.
    expect(queueDbNameFor(null)).toBeNull();
    expect(queueDbNameFor(undefined)).toBeNull();
    expect(queueDbNameFor('')).toBeNull();
    expect(queueDbNameFor('   ')).toBeNull();
    expect(queueDbNameFor('\t\n ')).toBeNull();
  });

  it('trims the user id so padding cannot fork one user into two queues', () => {
    expect(queueDbNameFor('  user-a  ')).toBe(queueDbNameFor('user-a'));
  });

  it('exposes the legacy unscoped name only so the migration can retire it', () => {
    expect(LEGACY_QUEUE_DB_NAME).toBe(QUEUE_DB_NAME);
    // ...and it must never be a live queue name for a real user.
    expect(queueDbNameFor('user-a')).not.toBe(LEGACY_QUEUE_DB_NAME);
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
