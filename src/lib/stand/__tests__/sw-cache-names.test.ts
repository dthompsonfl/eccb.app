/**
 * Service-worker cache naming: isolation, and one implementation.
 *
 * Bug this pins: `public/sw.js` wrote the app-shell cache under a fixed name
 * (`eccb-stand-v1-app-shell`, no user suffix) while `matchForUser` READ it and
 * `purgeUserCaches` DELETED it as `cacheNameForUser('app-shell', userId)`. The
 * app shell was therefore written to one cache and read/purged under another: it
 * was never served and never purged, so a shell captured while signed in
 * survived logout. Once offline score caching goes live, that stale cache is a
 * cross-user leak — a cached `/member/...` navigation embeds the member's name.
 *
 * `public/sw.js` is a classic worker script served from /sw.js and cannot import
 * from the app bundle, so the pure naming policy lives here, in the app module
 * graph, where Vitest can see it. `public/sw.js` is then verified against this
 * module by executing the real worker source in a sandbox — see the "service
 * worker parity" block below — so the two cannot drift apart.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CACHE_PREFIX, CACHE_VERSION, cacheNameFor } from '../offline';
import {
  ANON_USER,
  appShellCacheName,
  scoreCacheName,
  staticAssetCacheName,
} from '../sw-cache-names';

const KINDS = [
  { kind: 'app-shell' as const, name: appShellCacheName },
  { kind: 'static-asset' as const, name: staticAssetCacheName },
  { kind: 'score' as const, name: scoreCacheName },
];

describe('service worker cache names', () => {
  it('gives two users different names for every kind', () => {
    for (const { kind, name } of KINDS) {
      expect(name('user-a'), `${kind} a`).not.toBe(name('user-b'));
      expect(name('user-a'), `${kind} a`).toContain('user-a');
      expect(name('user-b'), `${kind} b`).toContain('user-b');
    }
  });

  it('falls back to the anon bucket when there is no user', () => {
    for (const { kind, name } of KINDS) {
      expect(name(null), `${kind} null`).toBe(cacheNameFor(ANON_USER, kind));
      expect(name(undefined), `${kind} undefined`).toBe(name(null));
      expect(name(''), `${kind} empty`).toBe(name(null));
      expect(name('   '), `${kind} blank`).toBe(name(null));
    }
  });

  it('uses the offline.ts cacheNameFor format so the reader cannot drift', () => {
    // matchForUser and purgeUserCaches in public/sw.js build names from
    // cacheNameForUser(). If the writer used a different format the shell would
    // again be written to a cache that is never read or purged.
    for (const { kind, name } of KINDS) {
      expect(name('user-a'), kind).toBe(cacheNameFor('user-a', kind));
    }
    expect(appShellCacheName('user-a')).toBe('eccb-stand-v1-app-shell-user-a');
  });

  it('never leaks one user id into another user cache name', () => {
    for (const { kind, name } of KINDS) {
      expect(name('user-a'), kind).not.toContain('user-b');
      expect(name('user-b'), kind).not.toContain('user-a');
    }
  });

  it('keeps every generated name recognisable as an app cache', () => {
    for (const { kind, name } of KINDS) {
      expect(name('user-a').startsWith(`${CACHE_PREFIX}-${CACHE_VERSION}-${kind}`), kind).toBe(
        true,
      );
    }
  });
});

// -----------------------------------------------------------------------------
// public/sw.js parity
// -----------------------------------------------------------------------------
//
// The worker cannot import the module above, so the real worker source is
// executed here against a fake Cache API. This is what makes the isolation
// claims in public/sw.js verified rather than asserted in a comment.

interface RecordedListener {
  (event: unknown): void;
}

interface Sandbox {
  install(): Promise<void>;
  send(message: unknown): void;
  caches: Map<string, Set<string>>;
  cacheNames(): string[];
  appShellCache(): string;
  staticAssetCache(): string;
  matchForUser(request: Request): Promise<Response | undefined>;
  purgeUserCaches(userId: string): Promise<void>;
  listeners: Map<string, RecordedListener[]>;
}

function createCacheStorage(): {
  storage: Map<string, Set<string>>;
  api: unknown;
  deleteCalls: string[];
  addCalls: Array<{ cache: string; url: string }>;
} {
  const storage = new Map<string, Set<string>>();
  const deleteCalls: string[] = [];
  const addCalls: Array<{ cache: string; url: string }> = [];

  const api = {
    async open(name: string) {
      if (!storage.has(name)) storage.set(name, new Set());
      const entries = storage.get(name)!;
      const keyOf = (req: RequestInfo | URL) => {
        const r = req as Request;
        return typeof r === 'string' ? r : (r?.url ?? String(req));
      };
      return {
        async add(req: RequestInfo | URL) {
          const url = keyOf(req);
          addCalls.push({ cache: name, url });
          entries.add(url);
        },
        async put(req: RequestInfo | URL) {
          entries.add(keyOf(req));
        },
        async match(req: RequestInfo | URL) {
          const url = keyOf(req);
          return entries.has(url)
            ? new Response('cached:' + url, { status: 200 })
            : undefined;
        },
        async delete() {
          return true;
        },
      };
    },
    async keys() {
      return [...storage.keys()];
    },
    async delete(name: string) {
      deleteCalls.push(name);
      return storage.delete(name);
    },
  };

  return { storage, api, deleteCalls, addCalls };
}

/** Run the real public/sw.js against a fake worker environment. */
function mountServiceWorker(): Sandbox & { addCalls: Array<{ cache: string; url: string }> } {
  const source = readFileSync(join(process.cwd(), 'public', 'sw.js'), 'utf8');

  const listeners = new Map<string, RecordedListener[]>();
  const on = (type: string, fn: RecordedListener) => {
    const list = listeners.get(type) ?? [];
    list.push(fn);
    listeners.set(type, list);
  };

  const { storage, api: caches, addCalls } = createCacheStorage();

  const fakeSelf = {
    addEventListener: on,
    location: { origin: 'https://band.example.org' },
    clients: { claim: async () => {}, matchAll: async () => [] },
    registration: { showNotification: async () => {} },
    skipWaiting: () => {},
  };

  const fetchStub = async () => new Response('network', { status: 200 });

  // The worker is a classic script: wrap it in a function so its top-level vars
  // and functions stay private, then hand back the ones under test.
  const factory = new Function(
    'self',
    'caches',
    'fetch',
    `${source}\n;return { appShellCache: appShellCache, staticAssetCache: staticAssetCache, matchForUser: matchForUser, purgeUserCaches: purgeUserCaches, setUser: function (id) { currentUserId = id; } };`,
  );

  const exported = factory(fakeSelf, caches, fetchStub) as {
    appShellCache: () => string;
    staticAssetCache: () => string;
    matchForUser: (r: Request) => Promise<Response | undefined>;
    purgeUserCaches: (u: string) => void;
    setUser: (id: string | null) => void;
  };

  const dispatch = (type: string, event: Record<string, unknown>) => {
    for (const fn of listeners.get(type) ?? []) fn(event);
  };

  return {
    caches: storage,
    cacheNames: () => [...storage.keys()],
    addCalls,
    listeners,
    async install() {
      let waited: Promise<unknown> | null = null;
      for (const fn of listeners.get('install') ?? []) {
        fn({ waitUntil: (p: Promise<unknown>) => (waited = p) });
      }
      // The fake Cache API is async throughout, so let the microtask queue
      // drain rather than assuming a fixed tick count.
      for (let i = 0; i < 20 && waited; i++) await Promise.resolve();
      await waited;
    },
    appShellCache: exported.appShellCache,
    staticAssetCache: exported.staticAssetCache,
    matchForUser: exported.matchForUser,
    purgeUserCaches: (u: string) => exported.purgeUserCaches(u),
    send(message: unknown) {
      dispatch('message', { data: message });
    },
    // Test-side helper mirroring the worker's own SET_USER message handling.
    setUser(id: string | null) {
      exported.setUser(id);
    },
  };
}

describe('public/sw.js cache naming parity', () => {
  let sw: ReturnType<typeof mountServiceWorker>;

  beforeEach(() => {
    sw = mountServiceWorker();
  });

  it('names the app-shell cache per user, matching the policy module', () => {
    sw.setUser('user-a');
    expect(sw.appShellCache()).toBe(appShellCacheName('user-a'));
    expect(sw.appShellCache()).not.toBe(appShellCacheName('user-b'));

    sw.setUser('user-b');
    expect(sw.appShellCache()).toBe(appShellCacheName('user-b'));

    sw.setUser(null);
    expect(sw.appShellCache()).toBe(appShellCacheName(null));
  });

  it('names the static-asset cache per user, matching the policy module', () => {
    sw.setUser('user-a');
    expect(sw.staticAssetCache()).toBe(staticAssetCacheName('user-a'));
  });

  it('installs the app shell into the cache the current user reads from', async () => {
    // The bug: install wrote to `eccb-stand-v1-app-shell` while matchForUser
    // looked in `eccb-stand-v1-app-shell-<user>`.
    sw.setUser('user-a');
    await sw.install();

    expect(sw.cacheNames()).toEqual([appShellCacheName('user-a')]);
    expect(sw.addCalls.every((c) => c.cache === appShellCacheName('user-a'))).toBe(true);
    expect(sw.cacheNames()).not.toContain('eccb-stand-v1-app-shell');
  });

  it('purges exactly the cache install populated on logout', async () => {
    sw.setUser('user-a');
    await sw.install();
    expect(sw.cacheNames()).toEqual([appShellCacheName('user-a')]);

    await sw.purgeUserCaches('user-a');
    expect(sw.cacheNames()).not.toContain(appShellCacheName('user-a'));
  });

  it('leaves another user cache untouched on logout', async () => {
    sw.setUser('user-a');
    sw.caches.set(appShellCacheName('user-a'), new Set(['/']));
    sw.caches.set(appShellCacheName('user-b'), new Set(['/']));

    await sw.purgeUserCaches('user-a');

    expect(sw.cacheNames()).toEqual([appShellCacheName('user-b')]);
  });

  it('serves a cached app-shell response to the owning user', async () => {
    sw.setUser('user-a');
    sw.caches.set(appShellCacheName('user-a'), new Set(['https://band.example.org/member']));
    const found = await sw.matchForUser(
      new Request('https://band.example.org/member') as unknown as Request,
    );
    expect(found).toBeDefined();
  });

  it('purges the install-time anon shell on LOGOUT', async () => {
    // install runs before SET_USER, so the pre-cached shell lands in the anon
    // bucket — and that fetch carried the signed-in member's cookies.
    await sw.install();
    expect(sw.cacheNames()).toEqual([appShellCacheName(null)]);

    sw.send({ type: 'LOGOUT' });
    await new Promise((r) => setTimeout(r, 0));

    expect(sw.cacheNames()).not.toContain(appShellCacheName(null));
  });

  it('purges the anon shell when the user changes', async () => {
    await sw.install();
    sw.setUser('user-a');
    sw.send({ type: 'SET_USER', userId: 'user-a' });
    expect(sw.cacheNames()).toEqual([]);

    sw.caches.set(appShellCacheName('user-a'), new Set(['/']));
    sw.caches.set(appShellCacheName(null), new Set(['/']));

    sw.send({ type: 'SET_USER', userId: 'user-b' });
    await new Promise((r) => setTimeout(r, 0));

    // user-a's caches and the anon bucket are both dropped; nothing is created
    // for user-b (its shell is only fetched, never pre-cached, at install).
    expect(sw.cacheNames()).toEqual([]);
  });

  it('refuses every cache lookup when no user is signed in', async () => {
    sw.setUser('user-a');
    sw.caches.set(appShellCacheName('user-a'), new Set(['https://band.example.org/member']));
    sw.setUser(null);

    const found = await sw.matchForUser(
      new Request('https://band.example.org/member') as unknown as Request,
    );
    expect(found).toBeUndefined();
  });
});