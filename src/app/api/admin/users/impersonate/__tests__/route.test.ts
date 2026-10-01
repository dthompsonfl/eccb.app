// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Route-level tests for impersonation.
 *
 * The regression these guard against is specific and severe: the old route
 * returned `{ success: true, impersonationToken }` while establishing nothing.
 * The token was never consumed by any code, so the admin's browser kept its
 * own admin cookie and the UI cheerfully reported impersonation had started.
 *
 * The load-bearing assertion is therefore that Better Auth's `Set-Cookie`
 * headers are forwarded onto the HTTP response. Dropping them reproduces the
 * original bug exactly, no matter what the JSON body says.
 */

const mockStartImpersonation = vi.fn();
const mockStopImpersonation = vi.fn();
const mockApplyRateLimit = vi.fn();

vi.mock('@/lib/auth/impersonation', () => ({
  startImpersonation: (...args: unknown[]) => mockStartImpersonation(...args),
  stopImpersonation: (...args: unknown[]) => mockStopImpersonation(...args),
}));

vi.mock('@/lib/rate-limit', () => ({
  applyRateLimit: (...args: unknown[]) => mockApplyRateLimit(...args),
}));

vi.mock('@/lib/csrf', () => ({
  validateCSRF: vi.fn().mockReturnValue({ valid: true }),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { POST as impersonate } from '../route';
import { POST as stopImpersonate } from '../stop/route';

/** Minimal NextRequest stand-in; these routes only read headers and the body. */
function makeRequest(body: unknown, headers: Record<string, string> = {}): any {
  return {
    headers: new Headers(headers),
    json: async () => body,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApplyRateLimit.mockResolvedValue(null);
});

describe('POST /api/admin/users/impersonate', () => {
  it('forwards every Set-Cookie Better Auth produced', async () => {
    mockStartImpersonation.mockResolvedValue({
      success: true,
      setCookies: [
        'better-auth.session_token=impersonated; Path=/; HttpOnly; SameSite=Lax',
        'better-auth.admin_session=admin-ref; Path=/; HttpOnly; SameSite=Lax',
        'better-auth.session_data=cache; Path=/; HttpOnly',
      ],
      impersonatedUser: { id: 'user-2', email: 'member@test.com', name: 'Member' },
    });

    const response = await impersonate(makeRequest({ userId: 'user-2' }));
    const cookies: string[] = response.headers.getSetCookie();

    // Each cookie must survive independently — a single combined header, or a
    // dropped cookie, both silently break the session.
    expect(cookies).toHaveLength(3);
    expect(cookies.some((c: string) => c.startsWith('better-auth.session_token='))).toBe(true);
    expect(cookies.some((c: string) => c.startsWith('better-auth.admin_session='))).toBe(true);
  });

  it('reports the impersonated identity and forbids caching', async () => {
    mockStartImpersonation.mockResolvedValue({
      success: true,
      setCookies: ['better-auth.session_token=x; Path=/'],
      impersonatedUser: { id: 'user-2', email: 'member@test.com', name: 'Member' },
    });

    const response = await impersonate(makeRequest({ userId: 'user-2' }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      success: true,
      impersonatedUser: { id: 'user-2', email: 'member@test.com', name: 'Member' },
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('never returns a token for the caller to redeem', async () => {
    mockStartImpersonation.mockResolvedValue({
      success: true,
      setCookies: ['better-auth.session_token=x; Path=/'],
      impersonatedUser: { id: 'user-2', email: 'member@test.com', name: null },
    });

    const body = await (await impersonate(makeRequest({ userId: 'user-2' }))).json();

    // The old contract returned `impersonationToken` for a client to redeem.
    // Nothing consumed it; the session is now carried entirely in cookies.
    expect(body).not.toHaveProperty('impersonationToken');
  });

  it('passes the incoming cookies through so Better Auth sees the admin session', async () => {
    mockStartImpersonation.mockResolvedValue({
      success: true,
      setCookies: [],
      impersonatedUser: { id: 'user-2', email: 'm@test.com', name: null },
    });

    await impersonate(
      makeRequest({ userId: 'user-2' }, { cookie: 'better-auth.session_token=abc' }),
    );

    expect(mockStartImpersonation).toHaveBeenCalledWith(
      'user-2',
      expect.any(Headers),
    );
    const forwarded = mockStartImpersonation.mock.calls[0][1] as Headers;
    expect(forwarded.get('cookie')).toBe('better-auth.session_token=abc');
  });

  it('propagates a refusal with its status and no cookies', async () => {
    mockStartImpersonation.mockResolvedValue({
      success: false,
      error: 'Cannot impersonate an administrator',
      status: 403,
    });

    const response = await impersonate(makeRequest({ userId: 'user-2' }));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toEqual({ success: false, error: 'Cannot impersonate an administrator' });
    expect(response.headers.getSetCookie()).toHaveLength(0);
  });

  it('rejects a malformed request before touching auth', async () => {
    const response = await impersonate(makeRequest({ userId: '' }));

    expect(response.status).toBe(400);
    expect(mockStartImpersonation).not.toHaveBeenCalled();
  });

  it('honours rate limiting', async () => {
    const limited = new Response('rate limited', { status: 429 });
    mockApplyRateLimit.mockResolvedValue(limited);

    const response = await impersonate(makeRequest({ userId: 'user-2' }));

    expect(response.status).toBe(429);
    expect(mockStartImpersonation).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/users/impersonate/stop', () => {
  it('forwards the cookies that restore the admin session', async () => {
    mockStopImpersonation.mockResolvedValue({
      success: true,
      setCookies: ['better-auth.session_token=admin-restored; Path=/; HttpOnly'],
      restoredUser: { id: 'admin-1', email: 'admin@test.com' },
    });

    const response = await stopImpersonate(makeRequest({}));
    const cookies = response.headers.getSetCookie();

    expect(cookies.some((c: string) => c.includes('admin-restored'))).toBe(true);
    expect((await response.json()).restoredUser.email).toBe('admin@test.com');
  });

  it('reports "not impersonating" as a 400', async () => {
    mockStopImpersonation.mockResolvedValue({
      success: false,
      error: 'You are not impersonating anyone',
      status: 400,
    });

    const response = await stopImpersonate(makeRequest({}));

    expect(response.status).toBe(400);
    expect(response.headers.getSetCookie()).toHaveLength(0);
  });
});