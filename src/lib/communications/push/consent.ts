/**
 * Push consent — the gate in front of every send.
 *
 * Design rule, and the reason this file exists as its own module: **no push is
 * ever sent to a member who has not affirmatively opted in.** Consent is read
 * from `UserPreferences.pushEnabled` AND `pushConsentedAt`:
 *
 *   - `pushEnabled` DEFAULT FALSE in the schema, so a member with no
 *     preferences row at all is OFF.
 *   - `pushConsentedAt` must be non-null. A row that somehow has
 *     pushEnabled = true but no consent timestamp is treated as OFF, so a
 *     bad migration default or a manual DB edit still cannot enrol somebody.
 *
 * Both conditions are required. Checking one alone leaves a single-point
 * failure for the privacy gate.
 */

import { prisma } from '@/lib/db';

export interface PushConsent {
  pushEnabled: boolean;
  consentedAt: Date | null;
}

/**
 * Read a member's push consent.
 *
 * A missing UserPreferences row is a legitimate state (most members have never
 * touched settings) and means NOT opted in — not an error.
 */
export async function getPushConsent(userId: string): Promise<PushConsent> {
  const row = await prisma.userPreferences.findUnique({
    where: { userId },
    select: { pushEnabled: true, pushConsentedAt: true },
  });

  if (!row) return { pushEnabled: false, consentedAt: null };

  return {
    pushEnabled: row.pushEnabled === true && row.pushConsentedAt !== null,
    consentedAt: row.pushConsentedAt,
  };
}

/** True only for a member who has both the flag and a consent timestamp. */
export async function hasPushConsent(userId: string): Promise<boolean> {
  const consent = await getPushConsent(userId);
  return consent.pushEnabled;
}

/**
 * Record (or revoke) consent.
 *
 * Revoking clears `pushConsentedAt` as well as the flag: "opted out now" and
 * "opted out and then back in" must not look identical in the consent record,
 * and a re-grant must stamp a fresh timestamp.
 *
 * Revoking also deletes every registered endpoint for the member. Consent to be
 * contacted is what makes the stored endpoints legitimate (GDPR Art. 6(1)(a));
 * withdrawing it means the endpoint URLs are no longer needed and must go.
 */
export async function setPushConsent(
  userId: string,
  pushEnabled: boolean,
): Promise<PushConsent> {
  const consentedAt = pushEnabled ? new Date() : null;

  await prisma.userPreferences.upsert({
    where: { userId },
    create: {
      userId,
      pushEnabled,
      pushConsentedAt: consentedAt,
    },
    update: {
      pushEnabled,
      pushConsentedAt: consentedAt,
    },
  });

  if (!pushEnabled) {
    await prisma.pushSubscription.deleteMany({ where: { userId } });
  }

  return { pushEnabled, consentedAt };
}
