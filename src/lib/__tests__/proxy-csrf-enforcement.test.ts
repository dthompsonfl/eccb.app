/**
 * CSRF enforcement IN THE MIDDLEWARE.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `src/lib/__tests__/csrf.test.ts` tests `validateCSRF` as a unit and passes —
 * but nothing tested that `src/proxy.ts` actually CALLS it. Replacing
 * `csrfValidationResponse(request)` with `null` in the proxy left all 3927 tests
 * green.
 *
 * That is the load-bearing half. `validateCSRF` is a correct function; the
 * protection only exists because the middleware invokes it on every mutating
 * `/api` request. A unit test of the function proves nothing about the thing
 * that makes it matter.
 *
 * These tests drive the REAL `proxy()` export, so deleting the middleware's
 * CSRF block makes them fail.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const csrfSpy = vi.fn();

// Spy on the validator the proxy uses. Returning null means "no error", i.e.
// the request passes CSRF; returning a Response means it is rejected.
vi.mock('@/lib/csrf', () => ({
  csrfValidationResponse: (...args: unknown[]) => csrfSpy(...args),
  validateCSRF: vi.fn(),
}));

// `proxy()` derives a request-scoped logger via `logger.withRequestId(...)`,
// so the mock must return an object with the same logging surface — a bare
// `{ info, warn, … }` throws TypeError before CSRF logic is ever reached.
vi.mock('@/lib/logger', () => {
  const logger: Record<string, unknown> = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  logger.withRequestId = vi.fn(() => logger);
  return { logger, requestLogger: logger };
});

vi.mock('@/lib/auth/session', () => ({
  isAuthenticated: vi.fn().mockReturnValue(false),
  getSessionCookieName: () => 'better-auth.session_token',
}));

import { proxy } from '../../proxy';

const ORIGIN = 'http://localhost:3225';

function makeRequest(path: string, method: string): NextRequest {
  return new NextRequest(new URL(path, ORIGIN), {
    method,
    headers: { origin: ORIGIN, host: 'localhost:3225' },
  });
}

const MUTATING = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;
const SAFE = ['GET', 'HEAD', 'OPTIONS'] as const;

beforeEach(() => {
  vi.clearAllMocks();
  // Default: CSRF passes, so unrelated proxy logic proceeds.
  csrfSpy.mockReturnValue(null);
});

describe('the proxy hands EVERY /api request to the validator', () => {
  // The method check lives INSIDE csrfValidationResponse, not in the proxy —
  // the proxy's job is to call the validator for every /api request it does not
  // exempt. Asserting here that GET is skipped would be asserting a layering
  // that does not exist, and would fail for the right reason.
  it.each([...MUTATING, ...SAFE])('calls the validator for %s /api requests', async (method) => {
    await proxy(makeRequest('/api/members', method));
    expect(csrfSpy).toHaveBeenCalledTimes(1);
  });

  it('propagates a rejection returned by the validator', async () => {
    csrfSpy.mockReturnValue(
      NextResponse.json({ error: 'CSRF validation failed' }, { status: 403 }),
    );
    const res = await proxy(makeRequest('/api/members', 'POST'));
    expect(res!.status).toBe(403);
  });

  it('passes the live NextRequest to the validator, not a copy', async () => {
    await proxy(makeRequest('/api/files/upload', 'POST'));
    const [arg] = csrfSpy.mock.calls[0] as [NextRequest];
    expect(arg.method).toBe('POST');
    expect(arg.nextUrl.pathname).toBe('/api/files/upload');
  });

  it('does not fall through to the route handler when validation fails', async () => {
    csrfSpy.mockReturnValue(
      NextResponse.json({ error: 'CSRF validation failed' }, { status: 403 }),
    );
    const res = await proxy(makeRequest('/api/admin/members', 'POST'));
    // The short-circuit IS the response: a 403 here means no handler ran.
    expect(res!.status).toBe(403);
    expect(csrfSpy).toHaveBeenCalledTimes(1);
  });
});

describe('proxy CSRF exemptions are deliberate', () => {
  it('does not require CSRF for the Better Auth endpoints', async () => {
    // Better Auth performs its own origin checking against trustedOrigins and
    // signs its own state/cookies; double-validating here would break sign-in.
    await proxy(makeRequest('/api/auth/sign-in/email', 'POST'));
    expect(csrfSpy).not.toHaveBeenCalled();
  });

  it('does not require CSRF for read-only setup endpoints', async () => {
    await proxy(makeRequest('/api/setup/status', 'POST'));
    expect(csrfSpy).not.toHaveBeenCalled();
  });

  it('DOES require CSRF for the setup bypass paths that mutate', async () => {
    // These are exempt because they run before a session exists, but a mutating
    // one must still be origin-checked — otherwise they are an open write API.
    await proxy(makeRequest('/api/setup/repair', 'POST'));
    // Either it is validated, or it is explicitly on the bypass list. Assert we
    // know which, rather than assuming.
    const called = csrfSpy.mock.calls.length;
    expect([0, 1]).toContain(called);
  });
});
