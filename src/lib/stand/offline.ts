/**
 * Offline score caching policy.
 *
 * ## Why this is a separate, pure module
 *
 * A service worker that caches copyrighted scores is a data-leak risk: a shared
 * performance tablet must not show the previous player's music, and one member's
 * cached score must never be served to another. Those rules are security policy,
 * not implementation detail, so they live here where they can be tested without
 * a service worker, a network, or a browser.
 *
 * ## The isolation model
 *
 * Every cache name is namespaced by user id. A cache for user A is never
 * consulted when serving user B, and logout purges the user's caches. The
 * service worker therefore cannot accidentally serve cross-user content: the
 * lookup key itself is user-scoped.
 *
 * A second defence: score responses are only cached when the server explicitly
 * marks them cacheable for that user. An un-marked response is never stored, so
 * "cached by accident" is not a state the system can reach.
 */

/** Bump when the caching format changes, so old caches are discarded. */
export const CACHE_VERSION = 'v1';

export const CACHE_PREFIX = 'eccb-stand';

export type ResourceKind = 'app-shell' | 'static-asset' | 'score' | 'api' | 'other';

export interface ParsedRequest {
  kind: ResourceKind;
  /** Path with any user-specific query stripped. */
  path: string;
  /** Whether the request is a navigation (document) request. */
  isNavigation: boolean;
  method: string;
}

const SCORE_PATH_PREFIXES = [
  '/api/files/',
  '/api/stand/files/',
  '/api/stand/stream/',
];

/** Classify a request so the right caching strategy applies. */
export function classifyRequest(input: {
  url: string;
  method?: string;
  isNavigation?: boolean;
}): ParsedRequest {
  const method = (input.method ?? 'GET').toUpperCase();
  let path = '/';

  try {
    path = new URL(input.url, 'http://localhost').pathname;
  } catch {
    path = '/';
  }

  if (SCORE_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    return { kind: 'score', path, isNavigation: input.isNavigation ?? false, method };
  }

  if (path.startsWith('/api/')) {
    return { kind: 'api', path, isNavigation: input.isNavigation ?? false, method };
  }

  // Next.js build output and other immutable static assets.
  if (
    path.startsWith('/_next/static/') ||
    /\.(?:js|css|woff2?|png|jpe?g|svg|ico|webp)$/i.test(path)
  ) {
    return { kind: 'static-asset', path, isNavigation: input.isNavigation ?? false, method };
  }

  if (input.isNavigation || method === 'GET') {
    return { kind: 'app-shell', path, isNavigation: input.isNavigation ?? false, method };
  }

  return { kind: 'other', path, isNavigation: false, method };
}

/** How a given request should be served. */
export type CacheStrategy =
  | 'network-only'
  | 'cache-first'
  | 'stale-while-revalidate'
  | 'network-first';

export function strategyFor(kind: ResourceKind): CacheStrategy {
  switch (kind) {
    case 'score':
      // Scores are copyrighted and access-controlled: always ask the server
      // first. A cached copy is only a fallback for a genuine offline failure,
      // which is why this is network-first rather than cache-first.
      return 'network-first';
    case 'static-asset':
      return 'stale-while-revalidate';
    case 'app-shell':
      return 'network-first';
    case 'api':
    case 'other':
    default:
      // Never cache API responses implicitly; a cached mutation or a cached
      // authorization decision is a correctness and security hazard.
      return 'network-only';
  }
}

/** Per-user cache name. The user id is the isolation boundary. */
export function cacheNameFor(userId: string, kind: ResourceKind): string {
  return `${CACHE_PREFIX}-${CACHE_VERSION}-${kind}-${userId}`;
}

/** Every cache name that belongs to a user. Used to purge on logout. */
export function allCacheNamesFor(userId: string): string[] {
  return (['app-shell', 'static-asset', 'score'] as ResourceKind[]).map((kind) =>
    cacheNameFor(userId, kind),
  );
}

/**
 * Whether a cache name belongs to a user.
 *
 * The service worker uses this to decide, before reading a cache, whether the
 * cache it is about to open could contain another user's scores.
 */
export function cacheBelongsToUser(cacheName: string, userId: string): boolean {
  return allCacheNamesFor(userId).includes(cacheName);
}

/** Every cache name this app owns, for a full cleanup. */
export function isAppCacheName(cacheName: string): boolean {
  return cacheName.startsWith(`${CACHE_PREFIX}-${CACHE_VERSION}-`);
}

// =============================================================================
// Response marking
// =============================================================================

/** Header the server sets to opt a score response into offline caching. */
export const OFFLINE_CACHE_HEADER = 'X-Eccb-Offline-Cacheable';

/** Header carrying the user id a cached response belongs to. */
export const OFFLINE_USER_HEADER = 'X-Eccb-Cache-User';

/**
 * Decide whether a score response may be stored.
 *
 * Requires an explicit opt-in header AND a successful status. A redirect, an
 * error, or a response the server did not mark is never cached, so a
 * redirect-to-login cannot poison the cache with a login page.
 */
export function shouldCacheScoreResponse(args: {
  status: number;
  headers: { get(name: string): string | null };
  userId: string | null;
}): { cache: boolean; reason: string } {
  const { status, headers, userId } = args;

  if (!userId) {
    return { cache: false, reason: 'no authenticated user' };
  }
  if (status < 200 || status >= 300) {
    // Never cache an error, a redirect to login, or a partial response.
    return { cache: false, reason: `non-2xx status ${status}` };
  }
  if (headers.get(OFFLINE_CACHE_HEADER)?.toLowerCase() !== 'true') {
    return { cache: false, reason: 'server did not opt this response in' };
  }

  const owner = headers.get(OFFLINE_USER_HEADER);
  if (owner && owner !== userId) {
    // Defence in depth: a misrouted response must not be stored for the wrong
    // person even if the opt-in header is present.
    return { cache: false, reason: 'response owned by a different user' };
  }

  return { cache: true, reason: 'ok' };
}

// =============================================================================
// Offline annotation queue
// =============================================================================

export interface QueuedAnnotation {
  /** Client-generated id. Makes replay idempotent. */
  id: string;
  musicId: string;
  page: number;
  layer: 'PERSONAL' | 'SECTION' | 'DIRECTOR';
  strokeData: Record<string, unknown>;
  sectionId?: string | null;
  createdAt: string;
  /** How many times replay has been attempted. */
  attempts: number;
}

/** Store name for the offline queue. */
export const QUEUE_DB_NAME = 'eccb-offline';
export const QUEUE_STORE_NAME = 'annotations';

/** Upper bound so a long offline stretch cannot grow without limit. */
export const MAX_QUEUED_ANNOTATIONS = 500;

/**
 * Fold a replayed batch into the queue, dropping duplicates.
 *
 * Idempotency is by client-generated id: replaying the same annotation after a
 * flaky connection must not create a second copy of the same stroke. Entries
 * that arrive already queued are ignored rather than duplicated, and the queue
 * is trimmed oldest-first when it exceeds the cap.
 */
export function mergeQueue(
  existing: QueuedAnnotation[],
  incoming: QueuedAnnotation[],
): QueuedAnnotation[] {
  const byId = new Map<string, QueuedAnnotation>();
  for (const item of existing) byId.set(item.id, item);

  for (const item of incoming) {
    if (!byId.has(item.id)) byId.set(item.id, item);
  }

  const merged = [...byId.values()].sort((a, b) =>
    a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt.localeCompare(b.createdAt),
  );

  return merged.length > MAX_QUEUED_ANNOTATIONS
    ? merged.slice(merged.length - MAX_QUEUED_ANNOTATIONS)
    : merged;
}

/**
 * Select what to replay now, and remove those from the queue.
 *
 * A caller sends `incomingIds` after a successful POST; those are removed so a
 * later flush cannot resend them. Anything not confirmed stays queued.
 */
export function resolveReplay(
  queued: QueuedAnnotation[],
  incomingIds: readonly string[],
): { remaining: QueuedAnnotation[]; replayed: QueuedAnnotation[] } {
  const confirmed = new Set(incomingIds);
  return {
    replayed: queued.filter((q) => confirmed.has(q.id)),
    remaining: queued.filter((q) => !confirmed.has(q.id)),
  };
}

export type SyncState = 'offline' | 'pending' | 'syncing' | 'synced' | 'error';

/**
 * Derive the user-visible sync state.
 *
 * A queued annotation with `syncedAt` set is complete; one without is still
 * pending, which is what the user must be able to see before a performance.
 */
export function deriveSyncState(args: {
  online: boolean;
  queueLength: number;
  syncing: boolean;
  lastError?: string | null;
}): SyncState {
  if (!args.online) return 'offline';
  if (args.syncing) return 'syncing';
  if (args.lastError) return 'error';
  return args.queueLength === 0 ? 'synced' : 'pending';
}
