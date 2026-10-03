import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { env } from '@/lib/env';
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';
import { extractSessionToken } from '@/lib/websocket/stand-socket-path';

/**
 * Authorization guard for setup and repair operations.
 *
 * SECURITY MODEL
 * --------------
 * Two distinct concerns are deliberately kept apart:
 *
 *   1. READINESS — "is the system installed?" (migrations applied, a
 *      super-admin exists, auth secret present). This is what src/proxy.ts
 *      uses to redirect browsers to /setup, and what getSetupState() reports.
 *      Readiness is *not* a security decision.
 *
 *   2. AUTHORIZATION — "is this caller allowed to run migrations, seed the
 *      database, or reset/repair it?" Readiness NEVER grants this. A healthy
 *      production system rejects destructive setup calls exactly like an
 *      unhealthy one does.
 *
 * Historically these were conflated: validateSetupRequest returned null
 * (allow) whenever getSetupState().readyForLogin was true, so an
 * unauthenticated client could POST {"action":"reset"} to /api/setup/repair
 * against a fully-installed production system. The tests in
 * src/lib/__tests__/setup-guard.test.ts now pin that shut.
 *
 * Rules for a destructive setup operation (migrate / seed / reset / full):
 *
 *   a. SETUP_MODE must be truthy. Read from process.env first so an operator
 *      can disable setup at runtime without a rebuild, then the env schema.
 *   b. If SETUP_TOKEN is configured it MUST be presented in `x-setup-token`
 *      and compared in constant time. When configured it is required — there
 *      is no "no token = no auth" path.
 *   c. If SETUP_TOKEN is NOT configured, a valid, non-banned SUPER_ADMIN
 *      session must exist. This keeps first-run install possible (no admin
 *      exists yet) while ensuring an installed system cannot be re-seeded or
 *      reset anonymously.
 *   d. In production the token is mandatory. A production deployment that
 *      reaches a setup endpoint without SETUP_TOKEN is a misconfiguration and
 *      is treated as a hard denial rather than silently opening a path.
 */

/** Comparison that does not leak length or content through timing. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Still burn a comparison so the failure path costs roughly the same.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

function readSetupMode(): boolean {
  const raw = process.env.SETUP_MODE ?? env.SETUP_MODE;
  return String(raw ?? '')
    .trim()
    .split(/\s+/)[0]
    .toLowerCase() === 'true';
}

function readSetupToken(): string | undefined {
  const token = process.env.SETUP_TOKEN ?? env.SETUP_TOKEN;
  return token && token.length > 0 ? token : undefined;
}

function deny(status: number, error: string, extra?: Record<string, unknown>): NextResponse {
  return NextResponse.json({ success: false, error, ...extra }, { status });
}

function bearerToken(request: Request): string | undefined {
  const header = request.headers.get('authorization');
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1];
}

function parseCookies(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

/**
 * Best-effort resolution of the caller from a Better Auth session cookie.
 * Returns null when there is no session, the session is invalid, or the
 * database cannot be reached (fail closed).
 */
async function getSessionUserId(request: Request): Promise<string | null> {
  const cookie = request.headers.get('cookie');
  // Strip Better Auth's `.signature` suffix before the lookup: the cookie holds
  // `${token}.${hmac}` and only the part before the dot is the Session.token
  // column value. Without this the query matches nothing and every setup-guard
  // check fails closed for a genuinely signed-in super admin.
  const raw =
    parseCookies(cookie ?? '')['better-auth.session_token'] ??
    parseCookies(cookie ?? '')['__Secure-better-auth.session_token'];
  const token = extractSessionToken(raw);

  if (!token) return null;

  try {
    const session = await prisma.session.findFirst({
      where: { token },
      select: { userId: true, expiresAt: true },
    });
    if (!session) return null;
    if (session.expiresAt && session.expiresAt.getTime() < Date.now()) return null;
    return session.userId;
  } catch {
    return null;
  }
}

async function isActiveSuperAdmin(userId: string): Promise<boolean> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { banned: true, deletedAt: true },
    });
    if (!user || user.banned || user.deletedAt) return false;

    const role = await prisma.userRole.findFirst({
      where: { userId, role: { name: 'SUPER_ADMIN' } },
      select: { id: true },
    });
    return role !== null;
  } catch {
    return false;
  }
}

/** Persist an audit record for privileged setup activity. Never throws. */
async function recordSetupAudit(params: {
  action: string;
  outcome: 'allowed' | 'denied';
  reason?: string;
  actorId?: string | null;
  request: Request;
}): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        userId: params.actorId ?? undefined,
        userName: params.actorId ? 'super-admin' : 'anonymous',
        ipAddress:
          params.request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
          params.request.headers.get('x-real-ip'),
        userAgent: params.request.headers.get('user-agent'),
        action: `setup.${params.action}`,
        entityType: 'SystemSetup',
        newValues: JSON.stringify({
          outcome: params.outcome,
          reason: params.reason ?? null,
        }),
      },
    });
  } catch (error) {
    logger.error(
      'Failed to write setup audit log',
      error instanceof Error ? error : new Error(String(error)),
    );
  }
}

/**
 * Guard for read-only setup status endpoints.
 *
 * The installer needs to read progress before any admin exists, so this is
 * deliberately weaker than the mutation guard — but it never mutates and never
 * returns secrets. Once a token is configured it is required.
 */
export async function validateSetupReadRequest(
  request: Request,
): Promise<NextResponse | null> {
  if (!readSetupMode()) {
    return deny(403, 'Setup mode is disabled');
  }

  const token = readSetupToken();
  if (token) {
    const presented = request.headers.get('x-setup-token') ?? bearerToken(request);
    if (!presented || !safeEqual(presented, token)) {
      await recordSetupAudit({
        action: 'read',
        outcome: 'denied',
        reason: 'invalid_token',
        request,
      });
      return deny(401, 'Invalid setup token');
    }
    return null;
  }

  const userId = await getSessionUserId(request);
  if (!userId || !(await isActiveSuperAdmin(userId))) {
    await recordSetupAudit({
      action: 'read',
      outcome: 'denied',
      reason: 'no_token_no_admin',
      request,
    });
    return deny(401, 'Setup status requires a valid setup token or super-admin session');
  }
  return null;
}

/**
 * Guard for destructive setup/repair operations.
 *
 * Returns `null` when the caller is authorized, otherwise a NextResponse to
 * return directly. A healthy application does NOT bypass this guard.
 */
export async function validateSetupRequest(request: Request): Promise<NextResponse | null> {
  // ── Gate 1: explicit maintenance enablement ──────────────────────────────
  // Readiness is intentionally not consulted. An installed production system
  // is exactly the case this must deny.
  if (!readSetupMode()) {
    return deny(403, 'Setup mode is disabled');
  }

  // ── Gate 2: proof of possession ─────────────────────────────────────────
  const token = readSetupToken();

  if (token) {
    const presented = request.headers.get('x-setup-token') ?? bearerToken(request);
    if (!presented || !safeEqual(presented, token)) {
      await recordSetupAudit({
        action: 'mutate',
        outcome: 'denied',
        reason: 'invalid_token',
        request,
      });
      return deny(401, 'Invalid setup token');
    }
    await recordSetupAudit({ action: 'mutate', outcome: 'allowed', reason: 'token', request });
    return null;
  }

  // No token configured.
  if (isProduction()) {
    // Fail closed: production setup must be explicitly unlocked with a token.
    await recordSetupAudit({
      action: 'mutate',
      outcome: 'denied',
      reason: 'token_required_in_production',
      request,
    });
    logger.error(
      'Blocked setup operation: SETUP_TOKEN is not configured in production. ' +
        'Destructive setup endpoints stay disabled.',
    );
    return deny(403, 'Setup operations require a configured SETUP_TOKEN in production');
  }

  // ── Gate 3: non-production fallback requires an existing super-admin ────
  const userId = await getSessionUserId(request);
  if (!userId || !(await isActiveSuperAdmin(userId))) {
    await recordSetupAudit({
      action: 'mutate',
      outcome: 'denied',
      reason: 'no_token_no_admin',
      actorId: userId,
      request,
    });
    return deny(401, 'Setup operations require a valid setup token or super-admin session');
  }

  await recordSetupAudit({
    action: 'mutate',
    outcome: 'allowed',
    reason: 'super_admin',
    actorId: userId,
    request,
  });
  return null;
}

/**
 * Second, independent confirmation for irreversible operations.
 * The caller must pass a `confirm` value equal to the action name.
 */
export function validateDestructiveConfirmation(
  action: string,
  confirm: unknown,
): NextResponse | null {
  if (confirm === action) return null;
  return deny(400, `Destructive action '${action}' requires an explicit confirmation`, {
    requiredConfirmValue: action,
  });
}
