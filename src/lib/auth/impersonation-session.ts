import { getSession } from '@/lib/auth/guards';

/**
 * Returns the id of the admin who opened the current impersonation session,
 * or null when the user is signed in normally.
 *
 * Better Auth's admin plugin declares `impersonatedBy` in its schema and sets
 * it when it creates an impersonated session, but omits it from the inferred
 * `Session` type, so it is read through a narrow structural type rather than
 * `any`. There is no `any` here and no hardcoded string to drift out of sync:
 * the shape is what the plugin's own schema declares.
 */
interface AttributedSession {
  impersonatedBy?: string | null;
}

/** Read the actor id off a session object, or null if it is not impersonated. */
export function getImpersonatingAdminId(session: unknown): string | null {
  const value = (session as { session?: AttributedSession } | null | undefined)?.session
    ?.impersonatedBy;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** True when the current session is an impersonation session. */
export async function isImpersonating(): Promise<boolean> {
  const session = await getSession();
  return getImpersonatingAdminId(session) !== null;
}