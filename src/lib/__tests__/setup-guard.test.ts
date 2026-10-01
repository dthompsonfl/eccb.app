import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock NextResponse
vi.mock('next/server', async () => {
  return {
    NextResponse: {
      json: (body: any, init?: any) => ({
        body,
        status: init?.status || 200,
      }),
    },
  };
});

// Env singleton is still consulted, but process.env wins when set.
let mockSetupMode = false;
let mockSetupToken: string | undefined = undefined;

vi.mock('@/lib/env', () => ({
  env: {
    get SETUP_MODE() {
      return mockSetupMode;
    },
    get SETUP_TOKEN() {
      return mockSetupToken;
    },
  },
}));

// Prisma is used for (a) audit writes, (b) session lookup, (c) super-admin
// resolution. Default to "database unreachable / no rows" so an anonymous
// caller can never be treated as an admin.
const mockSessionFindFirst = vi.fn();
const mockUserFindUnique = vi.fn();
const mockUserRoleFindFirst = vi.fn();
const mockAuditCreate = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    session: { findFirst: (...a: any[]) => mockSessionFindFirst(...a) },
    user: { findUnique: (...a: any[]) => mockUserFindUnique(...a) },
    userRole: { findFirst: (...a: any[]) => mockUserRoleFindFirst(...a) },
    auditLog: { create: (...a: any[]) => mockAuditCreate(...a) },
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  validateSetupRequest,
  validateSetupReadRequest,
  validateDestructiveConfirmation,
} from '../setup/setup-guard';

/** Make `cookie` contain a session token the prisma mock will resolve. */
function requestWithSession(sessionToken: string, extraHeaders: Record<string, string> = {}) {
  return new Request('http://localhost', {
    headers: {
      cookie: `better-auth.session_token=${sessionToken}`,
      ...extraHeaders,
    },
  });
}

/** Arrange prisma so the given session token resolves to a super-admin. */
function grantSuperAdmin(sessionToken = 'sess-admin') {
  mockSessionFindFirst.mockImplementation(async ({ where }: any) =>
    where.token === sessionToken
      ? { userId: 'user-1', expiresAt: new Date(Date.now() + 60_000) }
      : null,
  );
  mockUserFindUnique.mockResolvedValue({ banned: false, deletedAt: null });
  mockUserRoleFindFirst.mockResolvedValue({ id: 'role-1' });
}

describe('validateSetupRequest', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SETUP_MODE;
    delete process.env.SETUP_TOKEN;
    mockSetupMode = false;
    mockSetupToken = undefined;
    // Default: no session resolves.
    mockSessionFindFirst.mockResolvedValue(null);
    mockUserFindUnique.mockResolvedValue(null);
    mockUserRoleFindFirst.mockResolvedValue(null);
    mockAuditCreate.mockResolvedValue({});
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  // ── Regression: the actual exploit ───────────────────────────────────────
  describe('regression: healthy production system is not a bypass', () => {
    it('denies an unauthenticated reset even though setup is enabled', async () => {
      mockSetupMode = true;
      const res = (await validateSetupRequest(
        new Request('http://localhost', { method: 'POST' }),
      )) as any;

      expect(res).not.toBeNull();
      expect(res.status).toBe(401);
    });

    it('denies when SETUP_TOKEN is configured but not presented', async () => {
      mockSetupMode = true;
      mockSetupToken = 'correct-horse-battery-staple';
      const res = (await validateSetupRequest(new Request('http://localhost'))) as any;

      expect(res).not.toBeNull();
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Invalid setup token');
    });

    it('denies a wrong token', async () => {
      mockSetupMode = true;
      mockSetupToken = 'correct-horse-battery-staple';
      const res = (await validateSetupRequest(
        new Request('http://localhost', { headers: { 'x-setup-token': 'guess' } }),
      )) as any;

      expect(res.status).toBe(401);
    });

    it('accepts the correct token', async () => {
      mockSetupMode = true;
      mockSetupToken = 'correct-horse-battery-staple';
      const res = await validateSetupRequest(
        new Request('http://localhost', {
          headers: { 'x-setup-token': 'correct-horse-battery-staple' },
        }),
      );

      expect(res).toBeNull();
    });
  });

  // ── Setup mode gating ───────────────────────────────────────────────────
  it('returns 403 if SETUP_MODE is false', async () => {
    mockSetupMode = false;
    const res = (await validateSetupRequest(new Request('http://localhost'))) as any;

    expect(res).not.toBeNull();
    expect(res?.status).toBe(403);
    expect(res?.body?.error).toBe('Setup mode is disabled');
  });

  it('respects a process.env SETUP_MODE=false override of env.SETUP_MODE=true', async () => {
    mockSetupMode = true;
    process.env.SETUP_MODE = 'false';
    const res = (await validateSetupRequest(new Request('http://localhost'))) as any;

    expect(res?.status).toBe(403);
    expect(res.body.error).toBe('Setup mode is disabled');
  });

  it('honours a process.env SETUP_MODE=true override', async () => {
    mockSetupMode = false;
    process.env.SETUP_MODE = 'true';
    mockSetupToken = undefined;
    grantSuperAdmin();

    const res = await validateSetupRequest(requestWithSession('sess-admin'));
    expect(res).toBeNull();
  });

  // ── Production must never fall back to "no token = open" ───────────────
  it('denies in production when no SETUP_TOKEN is configured', async () => {
    process.env.NODE_ENV = 'production';
    mockSetupMode = true;
    // Even a real super-admin session is denied: production requires a token
    // so that the destructive surface is opt-in via deployment config.
    grantSuperAdmin();

    const res = (await validateSetupRequest(requestWithSession('sess-admin'))) as any;
    expect(res).not.toBeNull();
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('SETUP_TOKEN');
  });

  it('denies in production with no token and no session', async () => {
    process.env.NODE_ENV = 'production';
    mockSetupMode = true;
    const res = (await validateSetupRequest(new Request('http://localhost'))) as any;
    expect(res?.status).toBe(403);
  });

  it('allows in production when a token is configured and correct', async () => {
    process.env.NODE_ENV = 'production';
    mockSetupMode = true;
    mockSetupToken = 'prod-token-value';
    const res = await validateSetupRequest(
      new Request('http://localhost', { headers: { 'x-setup-token': 'prod-token-value' } }),
    );
    expect(res).toBeNull();
  });

  // ── Non-production fallback requires an authenticated super-admin ──────
  it('denies a non-super-admin session', async () => {
    mockSetupMode = true;
    mockSessionFindFirst.mockResolvedValue({
      userId: 'user-2',
      expiresAt: new Date(Date.now() + 60_000),
    });
    mockUserFindUnique.mockResolvedValue({ banned: false, deletedAt: null });
    mockUserRoleFindFirst.mockResolvedValue(null); // not a super admin

    const res = (await validateSetupRequest(requestWithSession('sess-member'))) as any;
    expect(res?.status).toBe(401);
  });

  it('denies a banned super-admin', async () => {
    mockSetupMode = true;
    mockSessionFindFirst.mockResolvedValue({
      userId: 'user-1',
      expiresAt: new Date(Date.now() + 60_000),
    });
    mockUserFindUnique.mockResolvedValue({ banned: true, deletedAt: null });
    mockUserRoleFindFirst.mockResolvedValue({ id: 'role-1' });

    const res = (await validateSetupRequest(requestWithSession('sess-banned'))) as any;
    expect(res?.status).toBe(401);
  });

  it('denies an expired session', async () => {
    mockSetupMode = true;
    mockSessionFindFirst.mockResolvedValue({
      userId: 'user-1',
      expiresAt: new Date(Date.now() - 1_000),
    });

    const res = (await validateSetupRequest(requestWithSession('sess-expired'))) as any;
    expect(res?.status).toBe(401);
  });

  it('fails closed when the database is unreachable', async () => {
    mockSetupMode = true;
    mockSessionFindFirst.mockRejectedValue(new Error('ECONNREFUSED'));

    const res = (await validateSetupRequest(requestWithSession('sess-admin'))) as any;
    expect(res?.status).toBe(401);
  });

  it('allows a valid super-admin session when no token is configured (non-production)', async () => {
    mockSetupMode = true;
    grantSuperAdmin('sess-admin');

    const res = await validateSetupRequest(requestWithSession('sess-admin'));
    expect(res).toBeNull();
  });

  // ── Auditing ────────────────────────────────────────────────────────────
  it('writes an audit record for allowed operations', async () => {
    mockSetupMode = true;
    mockSetupToken = 'tok';
    await validateSetupRequest(
      new Request('http://localhost', { headers: { 'x-setup-token': 'tok' } }),
    );
    expect(mockAuditCreate).toHaveBeenCalled();
    expect(mockAuditCreate.mock.calls[0][0].data.action).toBe('setup.mutate');
  });

  it('writes an audit record for denied operations', async () => {
    mockSetupMode = true;
    await validateSetupRequest(new Request('http://localhost'));
    expect(mockAuditCreate).toHaveBeenCalled();
    expect(mockAuditCreate.mock.calls[0][0].data.action).toBe('setup.mutate');
  });

  it('never writes the setup token into the audit log', async () => {
    mockSetupMode = true;
    mockSetupToken = 'super-secret-token';
    await validateSetupRequest(
      new Request('http://localhost', { headers: { 'x-setup-token': 'super-secret-token' } }),
    );
    const serialized = JSON.stringify(mockAuditCreate.mock.calls[0][0].data);
    expect(serialized).not.toContain('super-secret-token');
  });

  it('never writes the setup token into the error response', async () => {
    mockSetupMode = true;
    mockSetupToken = 'super-secret-token';
    const res = (await validateSetupRequest(new Request('http://localhost'))) as any;
    expect(JSON.stringify(res.body)).not.toContain('super-secret-token');
  });
});

describe('validateSetupReadRequest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SETUP_MODE;
    delete process.env.SETUP_TOKEN;
    mockSetupMode = true;
    mockSetupToken = undefined;
    mockSessionFindFirst.mockResolvedValue(null);
    mockUserFindUnique.mockResolvedValue(null);
    mockUserRoleFindFirst.mockResolvedValue(null);
    mockAuditCreate.mockResolvedValue({});
  });

  it('denies when setup mode is off', async () => {
    mockSetupMode = false;
    const res = (await validateSetupReadRequest(new Request('http://localhost'))) as any;
    expect(res?.status).toBe(403);
  });

  it('requires the token when one is configured', async () => {
    mockSetupToken = 'tok';
    const denied = (await validateSetupReadRequest(new Request('http://localhost'))) as any;
    expect(denied?.status).toBe(401);

    const allowed = await validateSetupReadRequest(
      new Request('http://localhost', { headers: { 'x-setup-token': 'tok' } }),
    );
    expect(allowed).toBeNull();
  });

  it('falls back to a super-admin session when no token is configured', async () => {
    grantSuperAdmin('sess-admin');
    expect(await validateSetupReadRequest(requestWithSession('sess-admin'))).toBeNull();
    expect((await validateSetupReadRequest(new Request('http://localhost')))?.status).toBe(401);
  });
});

describe('validateDestructiveConfirmation', () => {
  it('passes when confirm matches the action', () => {
    expect(validateDestructiveConfirmation('reset', 'reset')).toBeNull();
  });

  it('denies a missing confirmation', () => {
    const res = validateDestructiveConfirmation('reset', undefined) as any;
    expect(res.status).toBe(400);
  });

  it('denies a wrong confirmation value', () => {
    const res = validateDestructiveConfirmation('reset', true) as any;
    expect(res.status).toBe(400);
  });

  it('tells the caller what value to send', () => {
    const res = validateDestructiveConfirmation('reset', undefined) as any;
    expect(res.body.requiredConfirmValue).toBe('reset');
  });
});
