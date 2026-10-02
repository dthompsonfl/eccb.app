/**
 * Send-path tests: opt-in gating and prune-on-404/410.
 *
 * web-push is mocked wholesale so the tests assert OUR policy (consent gate,
 * prune classification), not web-push's internals.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSendNotification = vi.hoisted(() => vi.fn());
const mockSetVapidDetails = vi.hoisted(() => vi.fn());

vi.mock('web-push', () => ({
  default: {
    sendNotification: mockSendNotification,
    setVapidDetails: mockSetVapidDetails,
    generateVAPIDKeys: vi.fn(() => ({ publicKey: 'pub', privateKey: 'priv' })),
  },
}));

const mockPushSubscriptionFindMany = vi.hoisted(() => vi.fn());
const mockPushSubscriptionDeleteMany = vi.hoisted(() => vi.fn());
const mockPushSubscriptionUpdate = vi.hoisted(() => vi.fn());
const mockUserPreferencesFindUnique = vi.hoisted(() => vi.fn());
const mockSystemSettingFindMany = vi.hoisted(() => vi.fn());
const mockSystemSettingFindUnique = vi.hoisted(() => vi.fn());
const mockSystemSettingCreateMany = vi.hoisted(() => vi.fn());

vi.mock('@/lib/db', () => ({
  prisma: {
    pushSubscription: {
      findMany: mockPushSubscriptionFindMany,
      deleteMany: mockPushSubscriptionDeleteMany,
      update: mockPushSubscriptionUpdate,
    },
    userPreferences: {
      findUnique: mockUserPreferencesFindUnique,
    },
    systemSetting: {
      findMany: mockSystemSettingFindMany,
      findUnique: mockSystemSettingFindUnique,
      createMany: mockSystemSettingCreateMany,
    },
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { sendPushToUser, isExpiredSubscriptionStatus } from '../send';
import { __resetPushSettingsMemoForTests } from '../settings';

const CONSENTED = { pushEnabled: true, pushConsentedAt: new Date('2026-01-01') };
const NOT_CONSENTED = { pushEnabled: false, pushConsentedAt: null };

const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/abc123';
const PAYLOAD = { title: 'Rehearsal', body: 'Thursday at 7pm' };

function storedSubscription(overrides: Partial<{ id: string; endpoint: string }> = {}) {
  return {
    id: overrides.id ?? 'sub-1',
    endpoint: overrides.endpoint ?? ENDPOINT,
    p256dh: 'p256dh-key',
    auth: 'auth-secret',
  };
}

/** A web-push rejection carrying an HTTP status, as the real library throws. */
function statusError(statusCode: number): Error {
  return Object.assign(new Error(`push failed: ${statusCode}`), { statusCode });
}

describe('sendPushToUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetPushSettingsMemoForTests();

    // Platform enabled + a stored key pair, the normal configured state.
    mockSystemSettingFindUnique.mockImplementation(async ({ where }: { where: { key: string } }) => {
      if (where.key === 'push.enabled') return { value: 'true' };
      return null;
    });
    mockSystemSettingFindMany.mockResolvedValue([
      { key: 'push.vapidPublicKey', value: 'stored-public-key' },
      { key: 'push.vapidPrivateKey', value: 'stored-private-key' },
      { key: 'push.vapidSubject', value: 'mailto:admin@eccb.org' },
    ]);
    mockSystemSettingCreateMany.mockResolvedValue({ count: 3 });

    mockUserPreferencesFindUnique.mockResolvedValue(CONSENTED);
    mockPushSubscriptionFindMany.mockResolvedValue([storedSubscription()]);
    mockPushSubscriptionDeleteMany.mockResolvedValue({ count: 1 });
    mockPushSubscriptionUpdate.mockResolvedValue({});
    mockSendNotification.mockResolvedValue({ statusCode: 201 });
  });

  // -------------------------------------------------------------------------
  // Opt-in gating
  // -------------------------------------------------------------------------

  describe('opt-in gating', () => {
    it('sends nothing to a member who has not opted in', async () => {
      mockUserPreferencesFindUnique.mockResolvedValue(NOT_CONSENTED);

      const result = await sendPushToUser('user-1', PAYLOAD);

      expect(result.success).toBe(false);
      expect(result.skipped).toBe('not-consented');
      expect(result.delivered).toBe(0);
      expect(mockSendNotification).not.toHaveBeenCalled();
    });

    it('does not even look up subscriptions for a member who has not opted in', async () => {
      // Checking consent first is what makes the gate cheap and unfalsifiable:
      // a non-consented member's endpoint inventory is never even read.
      mockUserPreferencesFindUnique.mockResolvedValue(NOT_CONSENTED);

      await sendPushToUser('user-1', PAYLOAD);

      expect(mockPushSubscriptionFindMany).not.toHaveBeenCalled();
    });

    it('sends nothing when the member has no preferences row at all', async () => {
      mockUserPreferencesFindUnique.mockResolvedValue(null);

      const result = await sendPushToUser('user-1', PAYLOAD);

      expect(result.skipped).toBe('not-consented');
      expect(mockSendNotification).not.toHaveBeenCalled();
    });

    it('sends nothing when pushEnabled is true but the consent timestamp is missing', async () => {
      mockUserPreferencesFindUnique.mockResolvedValue({
        pushEnabled: true,
        pushConsentedAt: null,
      });

      const result = await sendPushToUser('user-1', PAYLOAD);

      expect(result.skipped).toBe('not-consented');
      expect(mockSendNotification).not.toHaveBeenCalled();
    });

    it('sends nothing when the admin master switch is off', async () => {
      mockSystemSettingFindUnique.mockImplementation(
        async ({ where }: { where: { key: string } }) =>
          where.key === 'push.enabled' ? { value: 'false' } : null,
      );

      const result = await sendPushToUser('user-1', PAYLOAD);

      expect(result.skipped).toBe('disabled');
      expect(mockSendNotification).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  describe('delivery to a consenting member', () => {
    it('sends to every active endpoint and reports the count', async () => {
      mockPushSubscriptionFindMany.mockResolvedValue([
        storedSubscription({ id: 'sub-1', endpoint: 'https://push.example/1' }),
        storedSubscription({ id: 'sub-2', endpoint: 'https://push.example/2' }),
      ]);

      const result = await sendPushToUser('user-1', PAYLOAD);

      expect(result.success).toBe(true);
      expect(result.delivered).toBe(2);
      expect(mockSendNotification).toHaveBeenCalledTimes(2);
    });

    it('passes the stored endpoint and keys to web-push', async () => {
      await sendPushToUser('user-1', PAYLOAD);

      expect(mockSendNotification).toHaveBeenCalledWith(
        { endpoint: ENDPOINT, keys: { p256dh: 'p256dh-key', auth: 'auth-secret' } },
        JSON.stringify(PAYLOAD),
      );
    });

    it('only reads active subscriptions for this member', async () => {
      await sendPushToUser('user-1', PAYLOAD);

      expect(mockPushSubscriptionFindMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'user-1', active: true } }),
      );
    });

    it('reports no-subscriptions when the member has none', async () => {
      mockPushSubscriptionFindMany.mockResolvedValue([]);

      const result = await sendPushToUser('user-1', PAYLOAD);

      expect(result.skipped).toBe('no-subscriptions');
      expect(result.success).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Prune on 404/410
  // -------------------------------------------------------------------------

  describe('pruning expired subscriptions', () => {
    it('deletes the subscription when the push service answers 410', async () => {
      mockSendNotification.mockRejectedValue(statusError(410));

      const result = await sendPushToUser('user-1', PAYLOAD);

      expect(mockPushSubscriptionDeleteMany).toHaveBeenCalledWith({
        where: { id: 'sub-1' },
      });
      expect(result.pruned).toBe(1);
      expect(result.prunedEndpoints).toEqual([ENDPOINT]);
      expect(result.success).toBe(false);
      expect(result.delivered).toBe(0);
    });

    it('deletes the subscription when the push service answers 404', async () => {
      mockSendNotification.mockRejectedValue(statusError(404));

      const result = await sendPushToUser('user-1', PAYLOAD);

      expect(mockPushSubscriptionDeleteMany).toHaveBeenCalledWith({
        where: { id: 'sub-1' },
      });
      expect(result.pruned).toBe(1);
    });

    it('accepts a raw fetch-style `status` field as well as web-push `statusCode`', async () => {
      mockSendNotification.mockRejectedValue(
        Object.assign(new Error('gone'), { status: 410 }),
      );

      const result = await sendPushToUser('user-1', PAYLOAD);

      expect(result.pruned).toBe(1);
      expect(mockPushSubscriptionDeleteMany).toHaveBeenCalledTimes(1);
    });

    it('deletes only the dead endpoint when a fan-out is partly expired', async () => {
      mockPushSubscriptionFindMany.mockResolvedValue([
        storedSubscription({ id: 'sub-live', endpoint: 'https://push.example/live' }),
        storedSubscription({ id: 'sub-dead', endpoint: 'https://push.example/dead' }),
      ]);
      mockSendNotification
        .mockResolvedValueOnce({ statusCode: 201 })
        .mockRejectedValueOnce(statusError(410));

      const result = await sendPushToUser('user-1', PAYLOAD);

      expect(result.delivered).toBe(1);
      expect(result.pruned).toBe(1);
      expect(result.prunedEndpoints).toEqual(['https://push.example/dead']);
      expect(mockPushSubscriptionDeleteMany).toHaveBeenCalledTimes(1);
      expect(mockPushSubscriptionDeleteMany).toHaveBeenCalledWith({
        where: { id: 'sub-dead' },
      });
    });

    it('KEEPS the subscription on a transient 500 so an outage cannot unsubscribe members', async () => {
      mockSendNotification.mockRejectedValue(statusError(500));

      const result = await sendPushToUser('user-1', PAYLOAD);

      expect(mockPushSubscriptionDeleteMany).not.toHaveBeenCalled();
      expect(result.pruned).toBe(0);
      expect(result.failed).toBe(1);
    });

    it('KEEPS the subscription on 429 rate limiting', async () => {
      mockSendNotification.mockRejectedValue(statusError(429));

      const result = await sendPushToUser('user-1', PAYLOAD);

      expect(mockPushSubscriptionDeleteMany).not.toHaveBeenCalled();
      expect(result.failed).toBe(1);
    });

    it('KEEPS the subscription on a network error with no status at all', async () => {
      mockSendNotification.mockRejectedValue(new Error('ECONNRESET'));

      const result = await sendPushToUser('user-1', PAYLOAD);

      expect(mockPushSubscriptionDeleteMany).not.toHaveBeenCalled();
      expect(result.failed).toBe(1);
    });

    it('classifies exactly 404 and 410 as expired', () => {
      expect(isExpiredSubscriptionStatus(404)).toBe(true);
      expect(isExpiredSubscriptionStatus(410)).toBe(true);
      for (const status of [400, 401, 403, 413, 429, 500, 502, 503]) {
        expect(isExpiredSubscriptionStatus(status)).toBe(false);
      }
      expect(isExpiredSubscriptionStatus(undefined)).toBe(false);
    });
  });
});
