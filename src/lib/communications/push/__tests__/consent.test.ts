/**
 * Consent gate tests.
 *
 * These are the privacy-critical assertions: a member who has not opted in must
 * be treated as opted out by EVERY reader, including the ones that are supposed
 * to be the authoritative check. The mutations these defend against are:
 * defaulting push on, dropping the consent timestamp requirement, and treating
 * a missing preferences row as consent.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockUserPreferencesFindUnique = vi.hoisted(() => vi.fn());
const mockUserPreferencesUpsert = vi.hoisted(() => vi.fn());
const mockUserPreferencesUpdateMany = vi.hoisted(() => vi.fn());
const mockPushSubscriptionDeleteMany = vi.hoisted(() => vi.fn());
const mockPushSubscriptionCount = vi.hoisted(() => vi.fn());

vi.mock('@/lib/db', () => ({
  prisma: {
    userPreferences: {
      findUnique: mockUserPreferencesFindUnique,
      upsert: mockUserPreferencesUpsert,
      updateMany: mockUserPreferencesUpdateMany,
    },
    pushSubscription: {
      deleteMany: mockPushSubscriptionDeleteMany,
      count: mockPushSubscriptionCount,
    },
  },
}));

import { getPushConsent, hasPushConsent, setPushConsent } from '../consent';

const USER = 'user-1';

describe('push consent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUserPreferencesUpsert.mockResolvedValue({});
    mockUserPreferencesUpdateMany.mockResolvedValue({ count: 1 });
    mockPushSubscriptionDeleteMany.mockResolvedValue({ count: 0 });
  });

  describe('default is OFF', () => {
    it('treats a member with no preferences row as not consented', async () => {
      mockUserPreferencesFindUnique.mockResolvedValue(null);

      const consent = await getPushConsent(USER);

      expect(consent.pushEnabled).toBe(false);
      expect(consent.consentedAt).toBeNull();
      expect(await hasPushConsent(USER)).toBe(false);
    });

    it('treats an existing row with pushEnabled false as not consented', async () => {
      mockUserPreferencesFindUnique.mockResolvedValue({
        pushEnabled: false,
        pushConsentedAt: new Date('2026-01-01'),
      });

      expect(await hasPushConsent(USER)).toBe(false);
    });

    it('refuses consent when pushEnabled is true but no consent timestamp exists', async () => {
      // Defence in depth: a bad migration default or a hand-edited row must not
      // be enough to enrol somebody.
      mockUserPreferencesFindUnique.mockResolvedValue({
        pushEnabled: true,
        pushConsentedAt: null,
      });

      expect(await hasPushConsent(USER)).toBe(false);
    });
  });

  describe('granting consent', () => {
    it('stamps a consent timestamp and persists the flag', async () => {
      const before = Date.now();
      mockUserPreferencesFindUnique.mockResolvedValue({
        pushEnabled: true,
        pushConsentedAt: new Date(),
      });

      const result = await setPushConsent(USER, true);

      expect(result.pushEnabled).toBe(true);
      expect(result.consentedAt).toBeInstanceOf(Date);
      expect(result.consentedAt!.getTime()).toBeGreaterThanOrEqual(before);
      expect(mockUserPreferencesUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: USER },
          create: expect.objectContaining({ userId: USER, pushEnabled: true }),
          update: expect.objectContaining({ pushEnabled: true }),
        }),
      );
    });

    it('does not delete endpoints when consent is granted', async () => {
      await setPushConsent(USER, true);

      expect(mockPushSubscriptionDeleteMany).not.toHaveBeenCalled();
    });

    it('reports consent once both the flag and the timestamp are present', async () => {
      mockUserPreferencesFindUnique.mockResolvedValue({
        pushEnabled: true,
        pushConsentedAt: new Date('2026-01-01T00:00:00Z'),
      });

      expect(await hasPushConsent(USER)).toBe(true);
    });
  });

  describe('revoking consent', () => {
    it('clears both the flag and the consent timestamp', async () => {
      await setPushConsent(USER, false);

      expect(mockUserPreferencesUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: { pushEnabled: false, pushConsentedAt: null },
        }),
      );
    });

    it('deletes every stored endpoint for the member', async () => {
      // The endpoint URLs are personal data held under the consent just
      // withdrawn — Art. 7(3) withdrawal has to reach the stored data, not
      // just the flag.
      await setPushConsent(USER, false);

      expect(mockPushSubscriptionDeleteMany).toHaveBeenCalledWith({
        where: { userId: USER },
      });
    });
  });
});
