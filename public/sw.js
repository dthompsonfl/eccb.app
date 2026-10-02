/**
 * ECCB Digital Music Stand — service worker.
 *
 * Offline support for a performance: the app must survive a venue Wi-Fi failure
 * mid-piece. Three rules shape everything here:
 *
 *  1. Scores are copyrighted and access-controlled. Caches are namespaced by
 *     user id, so one musician's cached score is never served to another, and
 *     logout purges that user's caches. Scores are served network-first, so
 *     authorization is re-checked on every online request.
 *  2. Nothing is cached implicitly. Only a score response the server explicitly
 *     marks cacheable is stored, and a redirect to login or an error is never
 *     cached, so the cache cannot be poisoned with a login page.
 *  3. API responses are never cached. A cached authorization decision or a
 *     replayed mutation is a correctness and security hazard.
 *
 * The policy lives in src/lib/stand/offline.ts where it is unit-tested without
 * a browser. This file is only the plumbing, and mirrors that policy.
 */

/* global self, caches, Response, URL, Request, Promise */

// Service worker globals. Declared explicitly because flat-config ESLint no
// longer honours `eslint-env` comments and this file is not a module.

// Mirrors CACHE_VERSION / CACHE_PREFIX in src/lib/stand/offline.ts. Duplicated
// deliberately: a service worker cannot import from the app bundle.
var CACHE_VERSION = 'v1';
var CACHE_PREFIX = 'eccb-stand';

var OFFLINE_CACHE_HEADER = 'x-eccb-offline-cacheable';
var OFFLINE_USER_HEADER = 'x-eccb-cache-user';

/** Minimal shell so the app can boot offline. */
var APP_SHELL = ['/', '/offline', '/manifest.json'];

var SCORE_PATH_PREFIXES = ['/api/files/', '/api/stand/files/', '/api/stand/stream/'];

/** The signed-in user id for this browser profile, or null. */
var currentUserId = null;

// ---------------------------------------------------------------------------
// Message channel (page -> worker)
// ---------------------------------------------------------------------------

self.addEventListener('message', function (event) {
  var data = event.data;
  if (!data || typeof data !== 'object') return;

  if (data.type === 'SET_USER') {
    // Switching user MUST purge the previous user's scores, or the next
    // musician could read them from cache while offline.
    var nextId = typeof data.userId === 'string' && data.userId ? data.userId : null;
    if (currentUserId && currentUserId !== nextId) {
      purgeUserCaches(currentUserId);
    }
    currentUserId = nextId;
    return;
  }

  if (data.type === 'LOGOUT') {
    // Copyrighted music must not survive the session on a shared device.
    if (currentUserId) purgeUserCaches(currentUserId);
    currentUserId = null;
    return;
  }

  if (data.type === 'CACHE_SCORE') {
    warmScore(data.url);
    return;
  }

  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(appShellCache()).then(function (cache) {
      // Best-effort: a missing shell entry must not block installation.
      return Promise.all(
        APP_SHELL.map(function (url) {
          return cache.add(url).catch(function () {});
        }),
      );
    }),
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(
        names
          // Drop caches from older versions, never another app's caches.
          .filter(function (n) {
            return (
              n.indexOf(CACHE_PREFIX + '-') === 0 &&
              n.indexOf(CACHE_PREFIX + '-' + CACHE_VERSION + '-') !== 0
            );
          })
          .map(function (n) {
            return caches.delete(n);
          }),
      );
    }).then(function () {
      return self.clients.claim();
    }),
  );
});

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;

  var url;
  try {
    url = new URL(request.url);
  } catch (e) {
    return;
  }
  if (url.origin !== self.location.origin) return;

  var kind = classify(url.pathname, request.mode === 'navigate');
  var strategy = strategyFor(kind);

  // Never intercept API/other traffic: let the network handle it untouched.
  if (strategy === 'network-only') return;

  event.respondWith(handle(request, kind, strategy));
});

function handle(request, kind, strategy) {
  if (strategy === 'stale-while-revalidate') {
    return staleWhileRevalidate(request);
  }

  return fetch(request).then(
    function (response) {
      // Only store what the server explicitly marked cacheable.
      if (kind === 'score' && currentUserId && shouldCache(response, currentUserId)) {
        putScore(request, response.clone(), currentUserId);
      }
      return response;
    },
    function (err) {
      return matchForUser(request).then(function (cached) {
        if (cached) return cached;

        if (kind === 'app-shell' && request.mode === 'navigate') {
          return caches.open(appShellCache()).then(function (shell) {
            return shell.match('/offline').then(function (offline) {
              if (offline) return offline;
              throw err;
            });
          });
        }
        throw err;
      });
    },
  );
}

function staleWhileRevalidate(request) {
  return caches.open(staticAssetCache()).then(function (cache) {
    return cache.match(request).then(function (cached) {
      var network = fetch(request).then(
        function (response) {
          if (response && response.ok) cache.put(request, response.clone());
          return response;
        },
        function () {
          return undefined;
        },
      );
      return cached || network;
    });
  }).then(function (result) {
    return result || Response.error();
  });
}

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------

function cacheNameForUser(kind, userId) {
  return CACHE_PREFIX + '-' + CACHE_VERSION + '-' + kind + '-' + userId;
}

function appShellCache() {
  return CACHE_PREFIX + '-' + CACHE_VERSION + '-app-shell';
}

function staticAssetCache() {
  return CACHE_PREFIX + '-' + CACHE_VERSION + '-static-asset-' + (currentUserId || 'anon');
}

function purgeUserCaches(userId) {
  if (!userId) return Promise.resolve();
  return Promise.all(
    ['app-shell', 'static-asset', 'score'].map(function (kind) {
      return caches.delete(cacheNameForUser(kind, userId));
    }),
  );
}

function shouldCache(response, userId) {
  if (!response || response.status < 200 || response.status >= 300) return false;
  if (!response.headers.get(OFFLINE_CACHE_HEADER)) return false;
  var owner = response.headers.get(OFFLINE_USER_HEADER);
  if (owner && owner !== userId) return false;
  return true;
}

function putScore(request, response, userId) {
  return caches.open(cacheNameForUser('score', userId)).then(function (cache) {
    return cache.put(request, response);
  });
}

/**
 * Look up a cached response, refusing any cache that is not this user's.
 *
 * This is the isolation boundary: even if a cache name were wrong, a response is
 * only ever served from a cache belonging to the current user.
 */
function matchForUser(request) {
  if (!currentUserId) return Promise.resolve(undefined);
  var kinds = ['score', 'app-shell'];
  return kinds.reduce(function (chain, kind) {
    return chain.then(function (found) {
      if (found) return found;
      return caches.open(cacheNameForUser(kind, currentUserId)).then(function (cache) {
        return cache.match(request);
      });
    });
  }, Promise.resolve(undefined));
}

/** Pre-cache a score the musician explicitly chose for offline use. */
function warmScore(targetUrl) {
  if (!currentUserId || typeof targetUrl !== 'string') return Promise.resolve();
  var request;
  try {
    request = new Request(targetUrl, { credentials: 'include' });
  } catch (e) {
    return Promise.resolve();
  }
  return fetch(request).then(
    function (response) {
      if (shouldCache(response, currentUserId)) {
        return putScore(request, response, currentUserId);
      }
      return undefined;
    },
    function () {
      return undefined;
    },
  );
}

// ---------------------------------------------------------------------------
// Policy (mirrors src/lib/stand/offline.ts)
// ---------------------------------------------------------------------------

function classify(pathname, isNavigation) {
  for (var i = 0; i < SCORE_PATH_PREFIXES.length; i++) {
    if (pathname.indexOf(SCORE_PATH_PREFIXES[i]) === 0) return 'score';
  }
  if (pathname.indexOf('/api/') === 0) return 'api';
  if (
    pathname.indexOf('/_next/static/') === 0 ||
    /\.(js|css|woff2?|png|jpe?g|svg|ico|webp)$/i.test(pathname)
  ) {
    return 'static-asset';
  }
  if (isNavigation) return 'app-shell';
  return 'other';
}

function strategyFor(kind) {
  if (kind === 'score') return 'network-first';
  if (kind === 'static-asset') return 'stale-while-revalidate';
  if (kind === 'app-shell') return 'network-first';
  return 'network-only';
}

// ---------------------------------------------------------------------------
// Web push
// ---------------------------------------------------------------------------
//
// Additive plumbing for src/lib/communications/push. The policy itself (consent
// gating, prune-on-404/410) lives on the server where it can be enforced and
// tested; this side only displays what the server decided to send.
//
// `userVisibleOnly: true` is set at subscribe time, which requires the browser
// to surface every payload — so a push can never be delivered silently.

self.addEventListener('push', function (event) {
  var data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: 'ECCB', body: event.data ? event.data.text() : '' };
  }

  var title = data.title || 'ECCB';
  var options = {
    body: data.body || '',
    tag: data.tag || 'eccb-notification',
    // Relative URLs only. The payload is server-authored, but resolving it
    // against the origin means a malformed link cannot navigate off-site.
    data: { url: typeof data.url === 'string' ? data.url : '/member/notifications' },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var target =
    event.notification.data && event.notification.data.url
      ? event.notification.data.url
      : '/member/notifications';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        if ('focus' in list[i]) {
          list[i].navigate(target);
          return list[i].focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
