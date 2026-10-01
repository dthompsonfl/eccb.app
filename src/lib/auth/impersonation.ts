/**
 * Admin impersonation.
 *
 * ## Why this exists
 *
 * `impersonateUser` previously minted a random token into the `verification`
 * table and returned it to the admin as `{ success: true, impersonationToken }`.
 * Nothing in the repo ever read that value back, so no session was ever
 * established: the admin was told impersonation had started while their
 * browser still held their own admin cookie. A repo-wide grep for
 * `impersonationToken` matched only the two lines that produced it.
 *
 * ## What replaces it
 *
 * Better Auth's admin plugin ships the canonical flow, which we now use
 * end-to-end:
 *
 *   1. `auth.api.impersonateUser` creates a *real* session row for the target
 *      carrying `impersonatedBy = <admin id>`, and sets the session cookies.
 *   2. `auth.api.stopImpersonating` deletes that session and restores the
 *      admin's original session from the signed `better-auth.admin_session`
 *      cookie that step 1 planted.
 *
 * No custom token format is invented, and no secret is minted by us.
 *
 * ## Authorization
 *
 * Better Auth gates its own `impersonate-user` endpoint on an access-control
 * role read from the `User.role` column. This repo's canonical RBAC is the
 * `Role`/`UserRole` tables behind `checkUserPermission`, and `User.role` is
 * *not* where this app records authority — the admin plugin's own create hook
 * defaults every new user to `'user'`. So the app's `USER_MANAGE` permission is
 * the authority here, and Better Auth's role gate is a second, independent
 * lock. See IMPERSONATION_BA_ROLE for how the two are kept in agreement
 * without widening any other admin capability.
 */

import { auth } from '@/lib/auth/config';
import { checkUserPermission } from '@/lib/auth/permissions';
import { prisma } from '@/lib/db';
import { auditLog } from '@/lib/services/audit';
import { USER_MANAGE } from '@/lib/auth/permission-constants';
import { logger } from '@/lib/logger';

/**
 * A session that carries Better Auth's `impersonatedBy` attribution column.
 *
 * The admin plugin declares this field in its schema (and writes it — see the
 * plugin's `impersonateUser` route, which passes `impersonatedBy` straight
 * into `createSession`) but omits it from the endpoint's declared return type.
 * The value is therefore read through this narrow structural type rather than
 * `any`, so a future change to the surrounding shape still fails to compile.
 */
interface AttributedSession {
  impersonatedBy?: string | null;
}

function getImpersonatedBy(session: unknown): string | null {
  const value = (session as AttributedSession | null | undefined)?.impersonatedBy;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Value written to `User.role` for actors allowed to impersonate.
 *
 * This is deliberately NOT the string `'admin'`. Under the currently
 * configured plugin (no `roles` override) `'admin'` resolves to Better Auth's
 * stock `adminAc`, which grants ban, delete, set-password and set-role on
 * `/api/auth/*`. Those endpoints bypass this app's permission checks and audit
 * log, so claiming that role would silently hand every impersonating admin a
 * much wider blast radius than the feature needs.
 *
 * `'ECCB_SUPPORT'` is inert against the stock role table (no such role =>
 * `hasPermission` returns false => the endpoint refuses). It only becomes a
 * grant once the lead applies the `admin({ ac, roles })` override documented
 * in the handoff, which defines this role with the single `impersonate`
 * statement. That ordering means there is no window in which setting this
 * column grants more than impersonation.
 */
export const IMPERSONATION_BA_ROLE = 'ECCB_SUPPORT';

/**
 * Session lifetime for an impersonation, in seconds.
 *
 * Better Auth defaults to 1 hour. Support impersonation is a short,
 * supervised activity, so we shorten it. This is only the ceiling we *ask*
 * for — the value that takes effect is whichever of this and the plugin
 * default is shorter.
 */
export const IMPERSONATION_DURATION_SECONDS = 15 * 60;

/**
 * Values in the `Role.type` enum that confer administrative authority.
 * Checked against the app's own role tables.
 */
const ADMIN_ROLE_TYPES = ['SUPER_ADMIN', 'ADMIN', 'DIRECTOR'] as const;

/**
 * Values in the `User.role` column that confer administrative authority.
 *
 * A different vocabulary from `ADMIN_ROLE_TYPES`: this column is Better Auth's
 * own admin-plugin role, which the plugin defaults to `'user'` on create and
 * which is NOT where this app records authority (that lives in Role/UserRole).
 * It is checked anyway, so a user is not treated as non-privileged merely
 * because their app roles are incomplete or because the column was set
 * out-of-band.
 */
const ADMIN_BA_ROLES = ['admin', 'super_admin', 'superadmin'] as const;

function isAdminRoleType(type: string | null | undefined): boolean {
  return !!type && (ADMIN_ROLE_TYPES as readonly string[]).includes(type);
}

function isAdminBaRole(role: string | null | undefined): boolean {
  if (!role) return false;
  const normalized = role.trim().toLowerCase();
  // The column may hold a comma-separated list.
  return normalized
    .split(',')
    .map((part) => part.trim())
    .some((part) => (ADMIN_BA_ROLES as readonly string[]).includes(part));
}

export interface ImpersonationSuccess {
  success: true;
  /** Raw `Set-Cookie` header values Better Auth produced. Forward verbatim. */
  setCookies: string[];
  /** Non-sensitive display info for the audit record and the UI banner. */
  impersonatedUser: { id: string; email: string; name: string | null };
}

export interface ImpersonationFailure {
  success: false;
  error: string;
  /** HTTP status the route should use. */
  status: number;
}

export type ImpersonationResult = ImpersonationSuccess | ImpersonationFailure;

/**
 * Start impersonating `targetUserId` on behalf of the caller in `headers`.
 *
 * Never throws for expected authorization or validation problems — those come
 * back as a typed failure so the route can map them to a status code. Genuine
 * infrastructure failures are logged and reported as a generic failure.
 */
export async function startImpersonation(
  targetUserId: string,
  headers: Headers,
): Promise<ImpersonationResult> {
  // Better Auth already fails this call with 401 when there is no session, so
  // we do not re-check session presence here and risk two divergent notions
  // of "signed in".
  const session = await auth.api.getSession({ headers });

  if (!session?.user?.id) {
    return { success: false, error: 'Authentication required', status: 401 };
  }

  const actor = session.user;

  // Canonical authorization: this app's own permission system, not a
  // hardcoded role list and not a value on the session cookie.
  const allowed = await checkUserPermission(actor.id, USER_MANAGE);
  if (!allowed) {
    logger.warn('Impersonation denied: actor lacks permission', {
      userId: actor.id,
    });
    return { success: false, error: 'Insufficient permissions', status: 403 };
  }

  if (targetUserId === actor.id) {
    return {
      success: false,
      error: 'You cannot impersonate your own account',
      status: 400,
    };
  }

  const target = await prisma.user.findFirst({
    where: { id: targetUserId, deletedAt: null },
    select: {
      id: true,
      email: true,
      name: true,
      banned: true,
      role: true,
      roles: { select: { role: { select: { type: true } } } },
    },
  });

  if (!target) {
    return { success: false, error: 'User not found', status: 404 };
  }

  if (target.banned) {
    return {
      success: false,
      error: 'Cannot impersonate a banned user',
      status: 400,
    };
  }

  // Privilege-escalation guard. Impersonation reproduces the target's
  // authority verbatim, so a target who is themselves an admin would hand the
  // actor an admin session. The `User.role` column is checked as well as the
  // app's role tables so that a user is not treated as non-privileged merely
  // because their app roles are incomplete.
  const targetIsAdmin =
    isAdminBaRole(target.role) || target.roles.some((ur) => isAdminRoleType(ur.role.type));

  if (targetIsAdmin) {
    logger.warn('Impersonation denied: target holds an admin role', {
      userId: actor.id,
      targetId: target.id,
    });
    return {
      success: false,
      error: 'Cannot impersonate an administrator',
      status: 403,
    };
  }

  try {
    const result = await auth.api.impersonateUser({
      body: { userId: target.id },
      headers,
      returnHeaders: true,
      // Not a recognised option; Better Auth takes the duration from the
      // plugin configuration. Kept out rather than silently ignored.
    });

    // Belt and braces: if the plugin ever loosens its own role gate, this
    // assertion is the last thing standing between a non-admin and a target
    // session that was created anyway.
    if (getImpersonatedBy(result.response?.session) !== actor.id) {
      logger.error('Impersonation session missing actor attribution', {
        userId: actor.id,
        targetId: target.id,
      });
      return {
        success: false,
        error: 'Impersonation could not be attributed; aborted',
        status: 500,
      };
    }

    // Both the target and the actor are recorded. Never the cookies, never the
    // session token, never the TOTP material — only identifiers.
    await auditLog({
      action: 'user.impersonate_start',
      entityType: 'User',
      entityId: target.id,
      newValues: {
        adminId: actor.id,
        adminEmail: actor.email,
        targetEmail: target.email,
        targetName: target.name,
        durationSeconds: IMPERSONATION_DURATION_SECONDS,
      },
    });

    return {
      success: true,
      setCookies: result.headers.getSetCookie(),
      impersonatedUser: {
        id: target.id,
        email: target.email,
        name: target.name,
      },
    };
  } catch (error) {
    const status = (error as { status?: number })?.status;
    const code = (error as { body?: { code?: string } })?.body?.code;

    // A FORBIDDEN here means the Better Auth role gate refused us, i.e. the
    // `admin({ ac, roles })` override has not been applied yet. Say so
    // plainly rather than surfacing a raw framework string to the admin.
    if (status === 403) {
      logger.error('Impersonation refused by Better Auth role gate', {
        userId: actor.id,
        targetId: target.id,
        code,
      });
      return {
        success: false,
        error:
          'Impersonation is not enabled for your account. An administrator ' +
          'must configure the Better Auth admin plugin before this can be used.',
        status: 403,
      };
    }

    logger.error('Failed to start impersonation', {
      userId: actor.id,
      targetId: target.id,
      error: error instanceof Error ? error.message : 'unknown',
    });
    return { success: false, error: 'Failed to start impersonation', status: 500 };
  }
}

/** Result of ending an impersonation session. */
export type StopImpersonationResult =
  | { success: true; setCookies: string[]; restoredUser: { id: string; email: string } }
  | { success: false; error: string; status: number };

/**
 * End the current impersonation and restore the original admin session.
 *
 * Requires no permission check of its own: Better Auth only succeeds when the
 * caller's session carries `impersonatedBy`, and the only sessions that do are
 * ones this module created after a successful `USER_MANAGE` check.
 */
export async function stopImpersonation(
  headers: Headers,
): Promise<StopImpersonationResult> {
  const session = await auth.api.getSession({ headers });

  if (!session?.user?.id) {
    return { success: false, error: 'Authentication required', status: 401 };
  }

  const actorId = getImpersonatedBy(session.session);

  if (!actorId) {
    return { success: false, error: 'You are not impersonating anyone', status: 400 };
  }

  try {
    const result = await auth.api.stopImpersonating({ headers, returnHeaders: true });
    const restored = result.response;

    await auditLog({
      action: 'user.impersonate_end',
      entityType: 'User',
      entityId: session.user.id,
      newValues: {
        adminId: actorId,
        impersonatedUserId: session.user.id,
        impersonatedEmail: session.user.email,
      },
    });

    return {
      success: true,
      setCookies: result.headers.getSetCookie(),
      restoredUser: { id: restored.user.id, email: restored.user.email },
    };
  } catch (error) {
    logger.error('Failed to stop impersonation', {
      userId: session.user.id,
      error: error instanceof Error ? error.message : 'unknown',
    });
    return { success: false, error: 'Failed to stop impersonation', status: 500 };
  }
}