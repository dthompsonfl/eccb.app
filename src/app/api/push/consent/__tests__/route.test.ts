/**
 * Consent route tests.
 *
 * The critical case is the strict-boolean check: a truthy non-boolean must not
 * be able to switch push on, because consent has to be an unambiguous act.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockGetSession = vi.hoisted(() => vi.fn());
const mockGetPushConsent = vi.hoisted(() => vi.fn());
const mockSetPushConsent = vi.hoisted(() => vi.fn());

vi.mock('@/lib/auth/guards', () => ({ getSession: mockGetSession }));
vi.mock('@/lib/rate-limit', () => ({ applyRateLimit: vi.fn().mockResolvedValue(null) }));
vi.mock('@/lib/csrf', () => ({ csrfValidationResponse: vi.fn().mockReturnValue(null) }));
vi.mock('@/lib/communications/push/consent', () => ({
  getPushConsent: mockGetPushConsent,
  setPushConsent: mockSetPushConsent,
}));

import { GET, PATCH } from '../route';

const SESSION = { user: { id: 'user-1' } };

function patchRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/push/consent', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('/api/push/consent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(SESSION);
    mockGetPushConsent.mockResolvedValue({
      pushEnabled: false,
      consentedAt: null,
    });
    mockSetPushConsent.mockResolvedValue({
      pushEnabled: true,
      consentedAt: new Date('2026-01-01'),
    });
  });

  describe('GET', () => {
    it('returns the stored consent state', async () => {
      mockGetPushConsent.mockResolvedValue({
        pushEnabled: true,
        consentedAt: new Date('2026-01-01'),
      });

      const res = await GET(
        new NextRequest('http://localhost/api/push/consent'),
      );
      const body = (await res.json()) as { pushEnabled: boolean };

      expect(res.status).toBe(200);
      expect(body.pushEnabled).toBe(true);
      expect(mockGetPushConsent).toHaveBeenCalledWith('user-1');
    });

    it('reports pushEnabled false when the member has never consented', async () => {
      const res = await GET(
        new NextRequest('http://localhost/api/push/consent'),
      );

      expect(((await res.json()) as { pushEnabled: boolean }).pushEnabled).toBe(false);
    });

    it('returns 401 when unauthenticated', async () => {
      mockGetSession.mockResolvedValue(null);

      const res = await GET(new NextRequest('http://localhost/api/push/consent'));

      expect(res.status).toBe(401);
    });
  });

  describe('PATCH', () => {
    it('grants consent for the session user', async () => {
      const res = await PATCH(patchRequest({ enabled: true }));

      expect(res.status).toBe(200);
      expect(mockSetPushConsent).toHaveBeenCalledWith('user-1', true);
    });

    it('revokes consent for the session user', async () => {
      mockSetPushConsent.mockResolvedValue({
        pushEnabled: false,
        consentedAt: null,
      });

      const res = await PATCH(patchRequest({ enabled: false }));

      expect(res.status).toBe(200);
      expect(mockSetPushConsent).toHaveBeenCalledWith('user-1', false);
    });

    it('rejects a truthy non-boolean so consent cannot be granted by accident', async () => {
      for (const enabled of ['true', 1, 'yes', {}, []]) {
        const res = await PATCH(patchRequest({ enabled }));

        expect(res.status).toBe(400);
      }
      expect(mockSetPushConsent).not.toHaveBeenCalled();
    });

    it('rejects a body with no `enabled` key', async () => {
      const res = await PATCH(patchRequest({}));

      expect(res.status).toBe(400);
      expect(mockSetPushConsent).not.toHaveBeenCalled();
    });

    it('returns 401 when unauthenticated', async () => {
      mockGetSession.mockResolvedValue(null);

      const res = await PATCH(patchRequest({ enabled: true }));

      expect(res.status).toBe(401);
      expect(mockSetPushConsent).not.toHaveBeenCalled();
    });

    it('ignores a userId in the body', async () => {
      await PATCH(patchRequest({ userId: 'victim', enabled: true }));

      expect(mockSetPushConsent).toHaveBeenCalledWith('user-1', true);
    });
  });
});
