/**
 * HTTP-layer tests for the push subscribe / unsubscribe / consent routes.
 *
 * These assert the authorization and status-code contract at the edge:
 * unauthenticated callers get 401, a member without consent gets 403 on
 * subscribe (not a silent success), and unsubscribe works for the session user.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockGetSession = vi.hoisted(() => vi.fn());
const mockSubscribeUser = vi.hoisted(() => vi.fn());
const mockUnsubscribeUser = vi.hoisted(() => vi.fn());
const mockUnsubscribeAllForUser = vi.hoisted(() => vi.fn());
const mockGetPushConsent = vi.hoisted(() => vi.fn());
const mockSetPushConsent = vi.hoisted(() => vi.fn());

vi.mock('@/lib/auth/guards', () => ({ getSession: mockGetSession }));
vi.mock('@/lib/rate-limit', () => ({ applyRateLimit: vi.fn().mockResolvedValue(null) }));
vi.mock('@/lib/csrf', () => ({ csrfValidationResponse: vi.fn().mockReturnValue(null) }));
vi.mock('@/lib/communications/push/subscriptions', () => ({
  subscribeUser: mockSubscribeUser,
  unsubscribeUser: mockUnsubscribeUser,
  unsubscribeAllForUser: mockUnsubscribeAllForUser,
}));
vi.mock('@/lib/communications/push/consent', () => ({
  getPushConsent: mockGetPushConsent,
  setPushConsent: mockSetPushConsent,
}));

import { POST, DELETE } from '../route';

const SESSION = { user: { id: 'user-1', email: 'm@eccb.org' } };
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/abc123';

function request(body: unknown, method = 'POST'): NextRequest {
  return new NextRequest('http://localhost/api/push/subscribe', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST/DELETE /api/push/subscribe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(SESSION);
    mockSubscribeUser.mockResolvedValue({ success: true, subscriptionId: 'sub-1', reassigned: false });
    mockUnsubscribeUser.mockResolvedValue({ success: true, removed: 1 });
    mockUnsubscribeAllForUser.mockResolvedValue({ removed: 2 });
  });

  describe('POST', () => {
    it('registers the subscription for the session user', async () => {
      const res = await POST(request({ subscription: { endpoint: ENDPOINT } }));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true, subscriptionId: 'sub-1' });
      expect(mockSubscribeUser).toHaveBeenCalledWith('user-1', {
        endpoint: ENDPOINT,
      });
    });

    it('returns 401 when unauthenticated', async () => {
      mockGetSession.mockResolvedValue(null);

      const res = await POST(request({ subscription: { endpoint: ENDPOINT } }));

      expect(res.status).toBe(401);
      expect(mockSubscribeUser).not.toHaveBeenCalled();
    });

    it('returns 403 when the member has not consented', async () => {
      mockSubscribeUser.mockResolvedValue({ success: false, error: 'not-consented' });

      const res = await POST(request({ subscription: { endpoint: ENDPOINT } }));

      expect(res.status).toBe(403);
      expect((await res.json()).error).toContain('not enabled');
    });

    it('returns 400 for an invalid subscription payload', async () => {
      mockSubscribeUser.mockResolvedValue({ success: false, error: 'invalid' });

      const res = await POST(request({ subscription: { endpoint: 'http://evil.example' } }));

      expect(res.status).toBe(400);
    });

    it('takes the user from the session only, never from the request body', async () => {
      // A userId in the body must not be able to subscribe somebody else.
      await POST(request({ userId: 'victim', subscription: { endpoint: ENDPOINT } }));

      expect(mockSubscribeUser).toHaveBeenCalledWith('user-1', { endpoint: ENDPOINT });
      expect(mockSubscribeUser.mock.calls[0][0]).not.toBe('victim');
    });
  });

  describe('DELETE', () => {
    it('unsubscribes the endpoint for the session user', async () => {
      const res = await DELETE(request({ endpoint: ENDPOINT }, 'DELETE'));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true, removed: 1 });
      expect(mockUnsubscribeUser).toHaveBeenCalledWith('user-1', ENDPOINT);
    });

    it('removes every endpoint when `all` is true', async () => {
      const res = await DELETE(request({ all: true }, 'DELETE'));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true, removed: 2 });
      expect(mockUnsubscribeAllForUser).toHaveBeenCalledWith('user-1');
    });

    it('returns 401 when unauthenticated', async () => {
      mockGetSession.mockResolvedValue(null);

      const res = await DELETE(request({ endpoint: ENDPOINT }, 'DELETE'));

      expect(res.status).toBe(401);
      expect(mockUnsubscribeUser).not.toHaveBeenCalled();
    });

    it('returns 400 for a missing endpoint', async () => {
      mockUnsubscribeUser.mockResolvedValue({ success: false, error: 'invalid' });

      const res = await DELETE(request({}, 'DELETE'));

      expect(res.status).toBe(400);
    });

    it('ignores a userId supplied in the body', async () => {
      await DELETE(request({ endpoint: ENDPOINT, userId: 'victim' }, 'DELETE'));

      expect(mockUnsubscribeUser).toHaveBeenCalledWith('user-1', ENDPOINT);
    });
  });
});
