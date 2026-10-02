/**
 * Subscribe / unsubscribe / duplicate-endpoint tests.
 *
 * The endpoint-uniqueness assertions matter more than they look: the endpoint
 * is the push service's identifier for a browser profile, and the schema makes
 * it UNIQUE. These tests assert the code actually uses that key (upsert on
 * endpoint, not create) so a browser cannot accumulate rows across reloads.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPushSubscriptionFindUnique = vi.hoisted(() => vi.fn());
const mockPushSubscriptionUpsert = vi.hoisted(() => vi.fn());
const mockPushSubscriptionDeleteMany = vi.hoisted(() => vi.fn());
const mockPushSubscriptionCount = vi.hoisted(() => vi.fn());
const mockUserPreferencesFindUnique = vi.hoisted(() => vi.fn());
const mockUserPreferencesUpdateMany = vi.hoisted(() => vi.fn());

vi.mock('@/lib/db', () => ({
  prisma: {
    pushSubscription: {
      findUnique: mockPushSubscriptionFindUnique,
      upsert: mockPushSubscriptionUpsert,
      deleteMany: mockPushSubscriptionDeleteMany,
      count: mockPushSubscriptionCount,
    },
    userPreferences: {
      findUnique: mockUserPreferencesFindUnique,
      updateMany: mockUserPreferencesUpdateMany,
    },
  },
}));

import {
  subscribeUser,
  unsubscribeUser,
  unsubscribeAllForUser,
  isValidPushSubscription,
} from '../subscriptions';

const USER = 'user-1';
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/abc123';

function validSubscription(overrides: { endpoint?: string; p256dh?: string; auth?: string } = {}) {
  return {
    endpoint: overrides.endpoint ?? ENDPOINT,
    keys: {
      p256dh: overrides.p256dh ?? 'p256dh-key',
      auth: overrides.auth ?? 'auth-secret',
    },
  };
}

describe('push subscriptions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: consenting member, no existing row at that endpoint.
    mockUserPreferencesFindUnique.mockResolvedValue({
      pushEnabled: true,
      pushConsentedAt: new Date('2026-01-01'),
    });
    mockPushSubscriptionFindUnique.mockResolvedValue(null);
    mockPushSubscriptionUpsert.mockResolvedValue({ id: 'sub-1' });
    mockPushSubscriptionDeleteMany.mockResolvedValue({ count: 1 });
    mockPushSubscriptionCount.mockResolvedValue(0);
    mockUserPreferencesUpdateMany.mockResolvedValue({ count: 1 });
  });

  // -------------------------------------------------------------------------
  // Validation (SSRF guard)
  // -------------------------------------------------------------------------

  describe('validation', () => {
    it('accepts a well-formed https subscription', () => {
      expect(isValidPushSubscription(validSubscription())).toBe(true);
    });

    it('rejects a non-https endpoint', () => {
      // The server POSTs a signed payload to this URL, so a http:// or
      // file:// endpoint would be an SSRF primitive.
      expect(
        isValidPushSubscription(validSubscription({ endpoint: 'http://evil.example/x' })),
      ).toBe(false);
      expect(
        isValidPushSubscription(validSubscription({ endpoint: 'file:///etc/passwd' })),
      ).toBe(false);
    });

    it('rejects an endpoint that is not a URL at all', () => {
      expect(isValidPushSubscription(validSubscription({ endpoint: 'not-a-url' }))).toBe(
        false,
      );
    });

    it('rejects missing or empty keys', () => {
      expect(isValidPushSubscription({ endpoint: ENDPOINT })).toBe(false);
      expect(isValidPushSubscription({ endpoint: ENDPOINT, keys: {} })).toBe(false);
      expect(
        isValidPushSubscription({ endpoint: ENDPOINT, keys: { p256dh: '', auth: 'x' } }),
      ).toBe(false);
    });

    it('rejects non-objects', () => {
      expect(isValidPushSubscription(null)).toBe(false);
      expect(isValidPushSubscription('endpoint')).toBe(false);
      expect(isValidPushSubscription(undefined)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Subscribe
  // -------------------------------------------------------------------------

  describe('subscribeUser', () => {
    it('stores the subscription for the consenting member', async () => {
      const result = await subscribeUser(USER, validSubscription());

      expect(result.success).toBe(true);
      expect(mockPushSubscriptionUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { endpoint: ENDPOINT },
          create: expect.objectContaining({
            userId: USER,
            endpoint: ENDPOINT,
            p256dh: 'p256dh-key',
            auth: 'auth-secret',
          }),
        }),
      );
    });

    it('refuses to subscribe a member who has not opted in', async () => {
      mockUserPreferencesFindUnique.mockResolvedValue({
        pushEnabled: false,
        pushConsentedAt: null,
      });

      const result = await subscribeUser(USER, validSubscription());

      expect(result).toEqual({ success: false, error: 'not-consented' });
      expect(mockPushSubscriptionUpsert).not.toHaveBeenCalled();
    });

    it('refuses when consent is granted but has no timestamp', async () => {
      mockUserPreferencesFindUnique.mockResolvedValue({
        pushEnabled: true,
        pushConsentedAt: null,
      });

      expect((await subscribeUser(USER, validSubscription())).success).toBe(false);
      expect(mockPushSubscriptionUpsert).not.toHaveBeenCalled();
    });

    it('rejects an invalid subscription before touching the database', async () => {
      const result = await subscribeUser(USER, { endpoint: 'http://evil.example' });

      expect(result).toEqual({ success: false, error: 'invalid' });
      expect(mockPushSubscriptionUpsert).not.toHaveBeenCalled();
    });

    // -----------------------------------------------------------------------
    // Duplicate endpoints
    // -----------------------------------------------------------------------

    it('upserts on the endpoint so re-subscribing cannot duplicate the row', async () => {
      mockPushSubscriptionFindUnique.mockResolvedValue({
        id: 'sub-1',
        userId: USER,
      });

      await subscribeUser(USER, validSubscription());

      // The upsert key is the endpoint alone. If this ever became a create(),
      // a browser reloading the page would insert a second row for the same
      // endpoint on every visit.
      expect(mockPushSubscriptionUpsert).toHaveBeenCalledWith(
        expect.objectContaining({ where: { endpoint: ENDPOINT } }),
      );
      expect(mockPushSubscriptionFindUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { endpoint: ENDPOINT } }),
      );
    });

    it('refreshes rotated keys on an existing endpoint', async () => {
      // A browser may rotate p256dh/auth while keeping the same endpoint; a
      // stale `auth` secret makes every later send fail with 401.
      mockPushSubscriptionFindUnique.mockResolvedValue({ id: 'sub-1', userId: USER });

      await subscribeUser(USER, validSubscription({ p256dh: 'new-p', auth: 'new-a' }));

      const call = mockPushSubscriptionUpsert.mock.calls[0][0];
      expect(call.update).toEqual(
        expect.objectContaining({ p256dh: 'new-p', auth: 'new-a', active: true }),
      );
    });

    it('reports a same-user re-subscribe as not a reassignment', async () => {
      mockPushSubscriptionFindUnique.mockResolvedValue({ id: 'sub-1', userId: USER });

      const result = await subscribeUser(USER, validSubscription());

      expect(result).toEqual({
        success: true,
        subscriptionId: 'sub-1',
        reassigned: false,
      });
    });

    it('reassigns an endpoint owned by a different account instead of duplicating it', async () => {
      // Shared tablet: user A's browser, now user B. Leaving the endpoint on A
      // would deliver A's notifications to B's screen.
      mockPushSubscriptionFindUnique.mockResolvedValue({ id: 'sub-1', userId: 'user-other' });

      const result = await subscribeUser(USER, validSubscription());

      expect(result.success).toBe(true);
      expect(result).toMatchObject({ reassigned: true });
      expect(mockPushSubscriptionUpsert.mock.calls[0][0].update.userId).toBe(USER);
    });
  });

  // -------------------------------------------------------------------------
  // Unsubscribe
  // -------------------------------------------------------------------------

  describe('unsubscribeUser', () => {
    it('deletes the endpoint scoped to the calling member', async () => {
      // Scoping by userId is the authorization: a caller cannot remove
      // somebody else's browser by guessing an endpoint URL.
      const result = await unsubscribeUser(USER, ENDPOINT);

      expect(result).toEqual({ success: true, removed: 1 });
      expect(mockPushSubscriptionDeleteMany).toHaveBeenCalledWith({
        where: { userId: USER, endpoint: ENDPOINT },
      });
    });

    it('revokes consent when the last endpoint is removed', async () => {
      mockPushSubscriptionCount.mockResolvedValue(0);

      await unsubscribeUser(USER, ENDPOINT);

      expect(mockUserPreferencesUpdateMany).toHaveBeenCalledWith({
        where: { userId: USER },
        data: { pushEnabled: false, pushConsentedAt: null },
      });
    });

    it('keeps consent when other endpoints remain', async () => {
      mockPushSubscriptionCount.mockResolvedValue(2);

      await unsubscribeUser(USER, ENDPOINT);

      expect(mockUserPreferencesUpdateMany).not.toHaveBeenCalled();
    });

    it('is a no-op that does not touch consent when the endpoint was not registered', async () => {
      mockPushSubscriptionDeleteMany.mockResolvedValue({ count: 0 });

      const result = await unsubscribeUser(USER, ENDPOINT);

      expect(result).toEqual({ success: true, removed: 0 });
      expect(mockUserPreferencesUpdateMany).not.toHaveBeenCalled();
    });

    it('rejects a non-string endpoint', async () => {
      expect((await unsubscribeUser(USER, undefined)).success).toBe(false);
      expect((await unsubscribeUser(USER, 42)).success).toBe(false);
      expect(mockPushSubscriptionDeleteMany).not.toHaveBeenCalled();
    });
  });

  describe('unsubscribeAllForUser', () => {
    it('removes every endpoint and revokes consent', async () => {
      mockPushSubscriptionDeleteMany.mockResolvedValue({ count: 3 });

      const result = await unsubscribeAllForUser(USER);

      expect(result).toEqual({ removed: 3 });
      expect(mockPushSubscriptionDeleteMany).toHaveBeenCalledWith({
        where: { userId: USER },
      });
      expect(mockUserPreferencesUpdateMany).toHaveBeenCalledWith({
        where: { userId: USER },
        data: { pushEnabled: false, pushConsentedAt: null },
      });
    });
  });
});
