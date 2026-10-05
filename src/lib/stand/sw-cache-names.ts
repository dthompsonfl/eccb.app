/**
 * Service-worker cache names — the single source of truth.
 *
 * ## Why these live here and not only in public/sw.js
 *
 * `public/sw.js` is a classic worker script served from `/sw.js`. It cannot
 * import from the app bundle, so its naming logic used to be duplicated inline
 * — and the duplicate drifted. The app-shell cache was *written* as
 * `eccb-stand-v1-app-shell` (no user id) while `matchForUser` read it and
 * `purgeUserCaches` deleted it as `eccb-stand-v1-app-shell-<userId>`. The shell
 * was therefore never served and never purged: a shell captured while a member
 * was signed in survived logout forever.
 *
 * That is only tidiness until offline score caching goes live. `classifyRequest`
 * classifies navigations as `app-shell`, and a cached `/member/...` navigation
 * embeds the signed-in member's name. An un-namespaced app-shell cache is then a
 * cross-user leak on a shared performance tablet.
 *
 * ## The rule
 *
 * Every cache is namespaced by user id, and the user id is the isolation
 * boundary. When there is no usable user id the name falls back to a shared
 * `anon` bucket — the same pattern `staticAssetCache()` already used — rather
 * than to a fixed un-suffixed name, so reader and writer can never disagree.
 *
 * These functions are pure and unit-tested. `public/sw.js` mirrors them (it has
 * to), and `__tests__/sw-cache-names.test.ts` executes the real worker source
 * against a fake Cache API to prove the two agree, so drift fails the suite.
 */

import { cacheNameFor, type ResourceKind } from './offline';

/** Shared bucket used when no user id is known (signed out, or before SET_USER). */
export const ANON_USER = 'anon';

/** Normalize any user-id-ish value to a usable bucket segment. */
function bucketFor(userId: string | null | undefined): string {
  if (typeof userId !== 'string') return ANON_USER;
  const trimmed = userId.trim();
  return trimmed === '' ? ANON_USER : trimmed;
}

/**
 * Cache name for a kind and user. Delegates to `cacheNameFor` so the service
 * worker's reader (`matchForUser`/`purgeUserCaches`) and this writer cannot
 * produce different strings for the same owner.
 */
function cacheNameForBucket(kind: ResourceKind, userId: string | null | undefined): string {
  return cacheNameFor(bucketFor(userId), kind);
}

/**
 * App-shell cache: the navigations and `/offline` fallback.
 *
 * Must be namespaced. A cached member page embeds the member's name, so a shared
 * name here leaks across users and defeats the logout purge.
 */
export function appShellCacheName(userId: string | null | undefined): string {
  return cacheNameForBucket('app-shell', userId);
}

/** Immutable build output: JS chunks, CSS, fonts, images. */
export function staticAssetCacheName(userId: string | null | undefined): string {
  return cacheNameForBucket('static-asset', userId);
}

/** Copyrighted score PDFs. Never shared between users. */
export function scoreCacheName(userId: string | null | undefined): string {
  return cacheNameForBucket('score', userId);
}