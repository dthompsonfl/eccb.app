/**
 * Sign-out sequence shared by the member and admin headers.
 *
 * Offline per-user state on a shared rehearsal tablet must not outlive the
 * session that created it. That covers TWO stores, and they need purging on
 * opposite sides of `signOut()`:
 *
 *  1. **Service-worker score caches** (Cache Storage, addressed via ambient
 *     service-worker state) — purged BEFORE ending the session, because
 *     afterwards there is no user context to purge for. The worker is also told
 *     which user is signed in at every `setServiceWorkerUser` call site.
 *  2. **The offline annotation queue** (IndexedDB, addressed by an explicit
 *     per-user database name) — purged AFTER `signOut()`, because the name is
 *     derived from the departing user's id rather than from session state, so it
 *     remains resolvable once the session has ended but not before the redirect.
 *
 * Both were previously missing, so cached scores AND another musician's queued
 * annotation strokes outlived the session that created them.
 *
 * Extracted so the ordering and the failure behaviour can be tested directly
 * rather than through a dropdown.
 */
export async function performSignOut(deps: {
  /** Id of the user departing, used to purge their IndexedDB stores. */
  userId?: string | null;
  purgeOfflineScores: () => void;
  /**
   * Erase the departing user's other local state (the offline annotation
   * queue). Called after `signOut()` and before `redirect()`.
   */
  purgeUserData?: (userId: string) => void;
  signOut: () => Promise<unknown>;
  redirect?: () => void;
}): Promise<void> {
  const { userId, purgeOfflineScores, purgeUserData, signOut, redirect } = deps;

  // Purge BEFORE ending the session: after signOut there is no longer a user
  // context, and the point is to erase the departing user's cached state.
  try {
    purgeOfflineScores();
  } catch {
    // Never block sign-out on cache cleanup — a failed purge must not strand
    // the member in a signed-in state.
  }

  await signOut();

  // The annotation queue is addressed by an explicit id, so it can still be
  // resolved here. No id means nothing was ever written under an identity we
  // can name, so there is nothing to purge.
  if (userId && purgeUserData) {
    try {
      purgeUserData(userId);
    } catch {
      // Same contract as the cache purge: cleanup failure must not strand the
      // member signed in, and must not swallow the redirect.
    }
  }

  redirect?.();
}