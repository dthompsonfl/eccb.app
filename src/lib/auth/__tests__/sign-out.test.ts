import { describe, it, expect, vi } from 'vitest';
import { performSignOut } from '@/lib/auth/sign-out';

/**
 * Offline score caches in the service worker are namespaced per user id so one
 * musician's music is never shown to the next on a shared rehearsal tablet.
 * That guarantee depends on the cache being purged at sign-out — previously it
 * was never called, so cached scores outlived the session that created them.
 */
describe('performSignOut', () => {
  it('purges per-user cached scores before ending the session', async () => {
    const order: string[] = [];
    const purgeOfflineScores = vi.fn(() => order.push('purge'));
    const signOut = vi.fn(async () => {
      order.push('signOut');
    });

    await performSignOut({ purgeOfflineScores, signOut });

    expect(purgeOfflineScores).toHaveBeenCalledTimes(1);
    expect(signOut).toHaveBeenCalledTimes(1);
    // Purging must happen BEFORE the session ends — afterwards there is no user
    // context to purge for.
    expect(order).toEqual(['purge', 'signOut']);
  });

  it('still signs out when cache purge throws', async () => {
    // A failed purge must never strand the member in a signed-in state.
    const purgeOfflineScores = vi.fn(() => {
      throw new Error('cache unavailable');
    });
    const signOut = vi.fn().mockResolvedValue(undefined);

    await expect(performSignOut({ purgeOfflineScores, signOut })).resolves.toBeUndefined();
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it('redirects only after the session has ended', async () => {
    const order: string[] = [];
    const signOut = vi.fn(async () => {
      order.push('signOut');
    });
    const redirect = vi.fn(() => order.push('redirect'));

    await performSignOut({
      purgeOfflineScores: vi.fn(() => order.push('purge')),
      signOut,
      redirect,
    });

    expect(order).toEqual(['purge', 'signOut', 'redirect']);
  });

  it('propagates a sign-out failure rather than reporting success', async () => {
    const signOut = vi.fn().mockRejectedValue(new Error('network'));

    await expect(
      performSignOut({ purgeOfflineScores: vi.fn(), signOut }),
    ).rejects.toThrow('network');
  });

  it('works without a redirect callback', async () => {
    const signOut = vi.fn().mockResolvedValue(undefined);

    await expect(
      performSignOut({ purgeOfflineScores: vi.fn(), signOut }),
    ).resolves.toBeUndefined();
  });

  /**
   * The offline ANNOTATION queue is also per-user state on the same shared
   * tablet. Leaving it behind means the next musician to sign in loads the
   * previous musician's queued strokes and replays them under their own
   * session. It is purged AFTER signOut (unlike the score cache, which is
   * purged before) because the annotation store lives in IndexedDB and is
   * addressed by the departing user's id — an explicit value, not ambient
   * session state — so it does not need a live session to resolve.
   */
  describe('purgeUserData', () => {
    it('purges the departing user\'s offline annotation queue', async () => {
      const purgeUserData = vi.fn();

      await performSignOut({
        userId: 'user-a',
        purgeOfflineScores: vi.fn(),
        purgeUserData,
        signOut: vi.fn().mockResolvedValue(undefined),
      });

      expect(purgeUserData).toHaveBeenCalledTimes(1);
      expect(purgeUserData).toHaveBeenCalledWith('user-a');
    });

    it('purges user data after signOut but before the redirect', async () => {
      // The redirect ends the page. Anything not done by then never happens.
      const order: string[] = [];

      await performSignOut({
        userId: 'user-a',
        purgeOfflineScores: vi.fn(),
        purgeUserData: vi.fn((_id: string) => {
          order.push('purgeUserData');
        }),
        signOut: vi.fn(async () => {
          order.push('signOut');
        }),
        redirect: vi.fn(() => order.push('redirect')),
      });

      expect(order).toEqual(['signOut', 'purgeUserData', 'redirect']);
    });

    it('still signs out and redirects when the user-data purge throws', async () => {
      // A failed IndexedDB cleanup must never strand the member signed in.
      const purgeUserData = vi.fn(() => {
        throw new Error('indexeddb blocked');
      });
      const signOut = vi.fn().mockResolvedValue(undefined);
      const redirect = vi.fn();

      await expect(
        performSignOut({
          userId: 'user-a',
          purgeOfflineScores: vi.fn(),
          purgeUserData,
          signOut,
          redirect,
        }),
      ).resolves.toBeUndefined();
      expect(signOut).toHaveBeenCalledTimes(1);
      expect(redirect).toHaveBeenCalledTimes(1);
    });

    it('works when no user-data purge is supplied', async () => {
      const signOut = vi.fn().mockResolvedValue(undefined);
      await expect(
        performSignOut({ userId: 'user-a', purgeOfflineScores: vi.fn(), signOut }),
      ).resolves.toBeUndefined();
      expect(signOut).toHaveBeenCalledTimes(1);
    });

    it('skips the user-data purge when there is no user id to purge for', async () => {
      // No id means no identity; guessing one would risk deleting the wrong
      // person's queue, and skipping is safe because nothing was ever written
      // under a null identity.
      const purgeUserData = vi.fn();
      const signOut = vi.fn().mockResolvedValue(undefined);

      await performSignOut({
        userId: null,
        purgeOfflineScores: vi.fn(),
        purgeUserData,
        signOut,
      });

      expect(purgeUserData).not.toHaveBeenCalled();
      expect(signOut).toHaveBeenCalledTimes(1);
    });

    it('keeps the score purge before signOut and the user purge after it', async () => {
      // The two purges sit on opposite sides of signOut deliberately: the score
      // cache purge needs the live session, the annotation store purge needs the
      // departing id. Neither may be reordered.
      const order: string[] = [];

      await performSignOut({
        userId: 'user-a',
        purgeOfflineScores: () => order.push('purgeOfflineScores'),
        purgeUserData: () => order.push('purgeUserData'),
        signOut: async () => {
          order.push('signOut');
        },
        redirect: () => order.push('redirect'),
      });

      expect(order).toEqual(['purgeOfflineScores', 'signOut', 'purgeUserData', 'redirect']);
    });
  });
});
