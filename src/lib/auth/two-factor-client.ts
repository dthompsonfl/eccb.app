/**
 * Client-side helpers for the Better Auth two-factor plugin.
 *
 * ## Why the plugin is registered but unreachable
 *
 * `twoFactor()` was configured in `src/lib/auth/config.ts` and
 * `twoFactorClient()` in `src/lib/auth/client.ts`, but nothing ever called the
 * plugin's endpoints: no enrolment UI, and — critically — the login form never
 * looked at the `twoFactorRedirect` flag the plugin returns from its
 * `/sign-in/email` after-hook. A user with 2FA enabled who entered a correct
 * password was silently dropped at the door, because the flag that would have
 * prompted for the second factor was ignored.
 *
 * ## Why the flag is read through a cast
 *
 * The plugin injects `twoFactorRedirect` from a response *after-hook*, not from
 * the endpoint's declared return type, so it is absent from the inferred type
 * of `authClient.signIn.email()`. The runtime contract is nonetheless explicit
 * and stable: when `user.twoFactorEnabled` is true, the hook deletes the
 * provisional session, sets a short-lived httpOnly `two_factor` cookie, and
 * returns `{ twoFactorRedirect: true }`.
 *
 * Reading it through this narrow structural type rather than `any` means a
 * change to the surrounding response shape still fails to compile.
 */

interface TwoFactorSignInResponse {
  twoFactorRedirect?: boolean;
}

/**
 * True when a successful password sign-in still needs a second factor.
 *
 * When true, NO session exists yet: Better Auth has already destroyed the
 * session the credential step created. The caller must run the challenge
 * (`verifyTotp` / `verifyBackupCode`) before any protected route will resolve.
 */
export function requiresTwoFactorChallenge(response: unknown): boolean {
  return (response as TwoFactorSignInResponse | null | undefined)?.twoFactorRedirect === true;
}