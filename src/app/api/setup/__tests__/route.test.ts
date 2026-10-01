import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST, GET } from '../route';
import { validateSetupRequest } from '@/lib/setup/setup-guard';
import { applyRateLimit } from '@/lib/rate-limit';
import { csrfValidationResponse } from '@/lib/csrf';
import * as helpers from '@/lib/__tests__/test-helpers';

vi.mock('@/lib/setup/setup-guard');
vi.mock('@/lib/rate-limit', () => ({
  applyRateLimit: vi.fn(async () => null),
}));
vi.mock('@/lib/csrf', () => ({
  csrfValidationResponse: vi.fn(() => null),
}));

/**
 * The route now applies rate limiting and CSRF validation *before* the setup
 * authorization guard (the proxy no longer blanket-exempts /api/setup). These
 * mocks keep the handler tests focused on the action dispatch logic; the guards
 * themselves are covered in:
 *   - src/lib/__tests__/setup-guard.test.ts   (authorization)
 *   - src/lib/__tests__/proxy-security.test.ts (boundary)
 */
function makeRequest(body: unknown) {
  const req = helpers.createMockRequest({
    method: 'POST',
    url: '/api/setup',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  req.json = async () => body as any;
  return req as unknown as Request;
}

describe('/api/setup route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // default: guards pass
    (validateSetupRequest as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (applyRateLimit as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (csrfValidationResponse as unknown as ReturnType<typeof vi.fn>).mockReturnValue(null);
  });

  it('returns 400 when passed an invalid action', async () => {
    const request = makeRequest({ action: 'foobar' });
    const response = await POST(request);
    const json = await (response as any).json();
    expect(json.success).toBe(false);
    // zod should reject because the action is not one of the allowed enum values
    expect(json.error).toMatch(/expected one of/);
    expect((response as any).status).toBe(400);
  });

  it('returns success for init action with valid connection', async () => {
    // stub the migration check so the init path succeeds without hitting a real DB
    vi.spyOn(
      await import('@/lib/setup/schema-automation'),
      'checkMigrationStatus',
    ).mockReturnValue({ applied: false, pendingCount: 0 });

    const request = makeRequest({ action: 'init', config: { host: 'localhost' } });
    const response = await POST(request);
    const json = await (response as any).json();
    expect(json.success).toBe(true);
    expect(json.message).toBe('Connection successful');
  });

  it('returns 400 for init when connection test throws', async () => {
    vi.spyOn(
      await import('@/lib/setup/schema-automation'),
      'checkMigrationStatus',
    ).mockImplementation(() => {
      throw new Error('bad');
    });
    const request = makeRequest({ action: 'init' });
    const response = await POST(request);
    const json = await (response as any).json();
    expect(json.success).toBe(false);
    expect(json.error).toMatch(/bad/);
    expect((response as any).status).toBe(400);
  });

  // ── Security boundary: a healthy system is NOT a bypass ─────────────────
  describe('security boundary', () => {
    it('does not reach the handler when the guard denies', async () => {
      (validateSetupRequest as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        new Response(JSON.stringify({ success: false, error: 'Setup mode is disabled' }), {
          status: 403,
        }),
      );

      const response = await POST(makeRequest({ action: 'full' }));
      const json = await (response as any).json();

      // The denial is passed through verbatim — no migration, no seed.
      expect(json.success).toBe(false);
      expect(json.error).toBe('Setup mode is disabled');
      expect((response as any).status).toBe(403);
    });

    it('does not reach the handler when rate limited', async () => {
      (applyRateLimit as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        new Response(JSON.stringify({ error: 'Too many requests' }), { status: 429 }),
      );

      const response = await POST(makeRequest({ action: 'full' }));
      expect((response as any).status).toBe(429);

      // The guard must not even be consulted when the rate limiter rejects.
      expect(validateSetupRequest).not.toHaveBeenCalled();
    });

    it('does not reach the handler when CSRF validation fails', async () => {
      (csrfValidationResponse as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
        new Response(JSON.stringify({ error: 'CSRF validation failed' }), {
          status: 403,
        }),
      );

      const response = await POST(makeRequest({ action: 'seed' }));
      expect((response as any).status).toBe(403);
      expect(validateSetupRequest).not.toHaveBeenCalled();
    });
  });
});

describe('/api/setup GET (read-only status)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (applyRateLimit as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (csrfValidationResponse as unknown as ReturnType<typeof vi.fn>).mockReturnValue(null);
  });

  it('serves status without a session when the read guard allows it', async () => {
    // The read guard is intentionally weaker so the installer can poll before
    // any admin exists.
    const { validateSetupReadRequest } = await import('@/lib/setup/setup-guard');
    (validateSetupReadRequest as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    // GET /api/setup reports status from the synchronous migration check
    // (checkMigrationStatus), not from the async getSetupState() cache.
    vi.spyOn(
      await import('@/lib/setup/schema-automation'),
      'checkMigrationStatus',
    ).mockReturnValue({ applied: true, pendingCount: 0 });

    const request = makeRequest(undefined);
    const response = await GET(request);
    const json = await (response as any).json();

    expect(json.success).toBe(true);
    // SetupPhase.COMPLETE is the lowercase string 'complete'.
    expect(json.phase).toBe('complete');
    // Must not leak secrets.
    expect(JSON.stringify(json)).not.toMatch(/secret|password|token/i);
  });

  it('denies status when the read guard denies', async () => {
    const { validateSetupReadRequest } = await import('@/lib/setup/setup-guard');
    (validateSetupReadRequest as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ success: false, error: 'Invalid setup token' }), {
        status: 401,
      }),
    );

    const response = await GET(makeRequest(undefined));
    expect((response as any).status).toBe(401);
  });
});
