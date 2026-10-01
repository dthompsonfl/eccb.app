import { describe, it, expect } from 'vitest';
import { requiresTwoFactorChallenge } from '@/lib/auth/two-factor-client';

/**
 * The two-factor plugin was configured but unreachable at the login screen.
 *
 * Its `/sign-in/email` after-hook returns `{ twoFactorRedirect: true }` and, in
 * the same breath, destroys the session the credential step just created. The
 * old login form destructured only `{ error }`, so for a user with 2FA enabled
 * a correct password produced neither an error nor a session: the user was
 * signed out with no explanation and no way forward.
 *
 * These tests pin the detection that closes that hole.
 */
describe('requiresTwoFactorChallenge', () => {
  it('detects the challenge flag', () => {
    expect(requiresTwoFactorChallenge({ twoFactorRedirect: true })).toBe(true);
  });

  it('does not fire on an ordinary successful sign-in', () => {
    // The plugin returns a normal session payload when no 2FA is configured.
    expect(
      requiresTwoFactorChallenge({
        redirect: false,
        token: 'abc',
        user: { id: 'u1', email: 'a@b.c' },
      }),
    ).toBe(false);
  });

  it('treats an explicit false as no challenge', () => {
    expect(requiresTwoFactorChallenge({ twoFactorRedirect: false })).toBe(false);
  });

  it('tolerates a missing response', () => {
    // An undefined body must not be read as "challenge required", or an
    // unrelated response shape would strand users on a dead-end screen.
    expect(requiresTwoFactorChallenge(undefined)).toBe(false);
    expect(requiresTwoFactorChallenge(null)).toBe(false);
  });

  it('is strict about the value being exactly true', () => {
    expect(requiresTwoFactorChallenge({ twoFactorRedirect: 'true' })).toBe(false);
    expect(requiresTwoFactorChallenge({ twoFactorRedirect: 1 })).toBe(false);
  });
});