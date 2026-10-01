import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Behavioural tests for admin impersonation.
 *
 * The previous implementation minted a random token into `verification` and
 * returned it; nothing consumed it, so `{ success: true }` was reported while
 * no session existed. These tests pin the properties that matter now:
 *
 *   - authorization comes from the app's canonical permission system
 *   - impersonation cannot be used to escalate to an administrator
 *   - a session is genuinely attributed to the actor before success is reported
 *   - the actor is audited, and no secret ever reaches the audit log
 *   - ending an impersonation restores the admin session
 */

// --- Mocks -----------------------------------------------------------------

const mockGetSession = vi.fn();
const mockImpersonateUser = vi.fn();
const mockStopImpersonating = vi.fn();
const mockCheckUserPermission = vi.fn();
const mockAuditLog = vi.fn();
const mockUserFindFirst = vi.fn();

vi.mock('@/lib/auth/config', () => ({
  auth: {
    api: {
      getSession: (...args: unknown[]) => mockGetSession(...args),
      impersonateUser: (...args: unknown[]) => mockImpersonateUser(...args),
      stopImpersonating: (...args: unknown[]) => mockStopImpersonating(...args),
    },
  },
}));

vi.mock('@/lib/auth/permissions', () => ({
  checkUserPermission: (...args: unknown[]) => mockCheckUserPermission(...args),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findFirst: (...args: unknown[]) => mockUserFindFirst(...args) },
  },
}));

vi.mock('@/lib/services/audit', () => ({
  auditLog: (...args: unknown[]) => mockAuditLog(...args),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  startImpersonation,
  stopImpersonation,
  IMPERSONATION_BA_ROLE,
} from '@/lib/auth/impersonation';

// --- Fixtures --------------------------------------------------------------

const ACTOR = { id: 'admin-1', email: 'admin@test.com' };

function sessionFor(impersonatedBy: string | null = null) {
  return {
    user: ACTOR,
    session: {
      id: 's1',
      token: 'secret-token-value',
      impersonatedBy,
    },
  };
}

/** A target user row as returned by the prisma findFirst select. */
function targetRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'user-2',
    email: 'member@test.com',
    name: 'Member',
    banned: false,
    role: 'user',
    roles: [],
    ...overrides,
  };
}

function impersonationResult(impersonatedBy: string | null = ACTOR.id) {
  const headers = new Headers();
  headers.append('set-cookie', 'better-auth.session_token=abc; Path=/; HttpOnly');
  headers.append('set-cookie', 'better-auth.admin_session=xyz; Path=/; HttpOnly');
  return { headers, response: { session: { impersonatedBy }, user: {} } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSession.mockResolvedValue(sessionFor());
  mockCheckUserPermission.mockResolvedValue(true);
  mockUserFindFirst.mockResolvedValue(targetRow());
  mockImpersonateUser.mockResolvedValue(impersonationResult());
  mockAuditLog.mockResolvedValue(undefined);
});

// --- Tests -----------------------------------------------------------------

describe('startImpersonation', () => {
  it('establishes a real, actor-attributed session and returns its cookies', async () => {
    const result = await startImpersonation('user-2', new Headers());

    expect(result.success).toBe(true);
    // The browser only becomes impersonated if these cookies reach it.
    if (result.success) {
      expect(result.setCookies.length).toBeGreaterThan(0);
      expect(result.impersonatedUser.email).toBe('member@test.com');
    }
    expect(mockImpersonateUser).toHaveBeenCalledWith(
      expect.objectContaining({ body: { userId: 'user-2' }, returnHeaders: true }),
    );
  });

  it('requires the canonical USER_MANAGE permission, not a role on the session', async () => {
    mockCheckUserPermission.mockResolvedValue(false);

    const result = await startImpersonation('user-2', new Headers());

    expect(result).toMatchObject({ success: false, status: 403 });
    expect(mockImpersonateUser).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated caller', async () => {
    mockGetSession.mockResolvedValue(null);

    const result = await startImpersonation('user-2', new Headers());

    expect(result).toMatchObject({ success: false, status: 401 });
    expect(mockImpersonateUser).not.toHaveBeenCalled();
  });

  it('refuses to impersonate yourself', async () => {
    const result = await startImpersonation(ACTOR.id, new Headers());

    expect(result).toMatchObject({ success: false, status: 400 });
    expect(mockImpersonateUser).not.toHaveBeenCalled();
  });

  it('refuses to impersonate a banned user', async () => {
    mockUserFindFirst.mockResolvedValue(targetRow({ banned: true }));

    const result = await startImpersonation('user-2', new Headers());

    expect(result).toMatchObject({ success: false, status: 400 });
    expect(mockImpersonateUser).not.toHaveBeenCalled();
  });

  it('refuses a missing or soft-deleted target', async () => {
    mockUserFindFirst.mockResolvedValue(null);

    const result = await startImpersonation('user-2', new Headers());

    expect(result).toMatchObject({ success: false, status: 404 });
  });

  describe('privilege escalation', () => {
    it('refuses a target holding an admin app role', async () => {
      mockUserFindFirst.mockResolvedValue(
        targetRow({ roles: [{ role: { type: 'SUPER_ADMIN' } }] }),
      );

      const result = await startImpersonation('user-2', new Headers());

      expect(result).toMatchObject({ success: false, status: 403 });
      expect(mockImpersonateUser).not.toHaveBeenCalled();
    });

    it('refuses a target whose User.role column is an admin role', async () => {
      mockUserFindFirst.mockResolvedValue(targetRow({ role: 'admin' }));

      const result = await startImpersonation('user-2', new Headers());

      expect(result).toMatchObject({ success: false, status: 403 });
      expect(mockImpersonateUser).not.toHaveBeenCalled();
    });

    it('refuses a DIRECTOR, who administers the band', async () => {
      mockUserFindFirst.mockResolvedValue(
        targetRow({ roles: [{ role: { type: 'DIRECTOR' } }] }),
      );

      const result = await startImpersonation('user-2', new Headers());

      expect(result).toMatchObject({ success: false, status: 403 });
    });

    it('allows a non-administrative target', async () => {
      mockUserFindFirst.mockResolvedValue(
        targetRow({ roles: [{ role: { type: 'MUSICIAN' } }] }),
      );

      const result = await startImpersonation('user-2', new Headers());

      expect(result.success).toBe(true);
    });
  });

  it('aborts when the created session is not attributed to the actor', async () => {
    // Defends against the plugin's role gate being loosened later: a session we
    // cannot attribute must never be reported as a successful impersonation.
    mockImpersonateUser.mockResolvedValue(impersonationResult(null));

    const result = await startImpersonation('user-2', new Headers());

    expect(result).toMatchObject({ success: false, status: 500 });
    expect(mockAuditLog).not.toHaveBeenCalled();
  });

  it('translates a framework 403 into an actionable message', async () => {
    mockImpersonateUser.mockRejectedValue(
      Object.assign(new Error('forbidden'), {
        status: 403,
        body: { code: 'YOU_ARE_NOT_ALLOWED_TO_IMPERSONATE_USERS' },
      }),
    );

    const result = await startImpersonation('user-2', new Headers());

    expect(result).toMatchObject({ success: false, status: 403 });
    if (!result.success) {
      expect(result.error).toMatch(/not enabled for your account/i);
      // Must not leak the raw framework string to the admin UI.
      expect(result.error).not.toContain('YOU_ARE_NOT_ALLOWED');
    }
  });

  it('audits actor and target but never a secret', async () => {
    await startImpersonation('user-2', new Headers());

    expect(mockAuditLog).toHaveBeenCalledTimes(1);
    const entry = mockAuditLog.mock.calls[0][0];
    expect(entry.action).toBe('user.impersonate_start');
    expect(entry.entityId).toBe('user-2');
    expect(entry.newValues).toMatchObject({
      adminId: ACTOR.id,
      targetEmail: 'member@test.com',
    });

    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain('secret-token-value');
    expect(serialized).not.toMatch(/set-cookie|session_token|admin_session/i);
  });
});

describe('stopImpersonation', () => {
  it('restores the admin session and audits the end', async () => {
    mockGetSession.mockResolvedValue({
      user: { id: 'user-2', email: 'member@test.com' },
      session: { impersonatedBy: ACTOR.id },
    });
    const headers = new Headers();
    headers.append('set-cookie', 'better-auth.session_token=restored; Path=/');
    mockStopImpersonating.mockResolvedValue({
      headers,
      response: { user: { id: ACTOR.id, email: ACTOR.email } },
    });

    const result = await stopImpersonation(new Headers());

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.restoredUser.email).toBe(ACTOR.email);
      expect(result.setCookies.length).toBeGreaterThan(0);
    }
    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'user.impersonate_end' }),
    );
  });

  it('refuses when the caller is not impersonating', async () => {
    mockGetSession.mockResolvedValue({
      user: { id: ACTOR.id, email: ACTOR.email },
      session: { impersonatedBy: null },
    });

    const result = await stopImpersonation(new Headers());

    expect(result).toMatchObject({ success: false, status: 400 });
    expect(mockStopImpersonating).not.toHaveBeenCalled();
  });

  it('refuses an unauthenticated caller', async () => {
    mockGetSession.mockResolvedValue(null);

    const result = await stopImpersonation(new Headers());

    expect(result).toMatchObject({ success: false, status: 401 });
  });
});

describe('IMPERSONATION_BA_ROLE', () => {
  it('is not the framework admin role, which would grant far more than impersonation', () => {
    // Guards the privilege decision documented in impersonation.ts: writing
    // 'admin' into User.role would resolve to Better Auth's stock adminAc
    // (ban, delete, set-password, set-role on /api/auth/*).
    expect(IMPERSONATION_BA_ROLE).not.toBe('admin');
    expect(IMPERSONATION_BA_ROLE.length).toBeGreaterThan(0);
  });
});