/**
 * Push subscription registration and removal.
 *
 * The service layer between the HTTP routes and Prisma. Routes stay thin so the
 * authorization and consent rules are unit-testable without an HTTP harness.
 *
 * Duplicate handling: `endpoint` is UNIQUE in the schema, and every write here
 * goes through an upsert keyed on it. Re-subscribing from the same browser —
 * which happens every time the user reloads the page, or presses the toggle
 * twice — updates the existing row rather than inserting another. That keeps
 * one browser to one row and, importantly, keeps `auth`/`p256dh` fresh, because
 * a browser can rotate those keys while keeping the same endpoint.
 *
 * Ownership: an endpoint that moves to a different account (shared tablet, user
 * signs out and someone else signs in and subscribes) is REASSIGNED, not
 * duplicated. The endpoint is what the push service routes to; leaving it
 * pointing at the previous user would deliver their notifications to the wrong
 * person's browser, which is a data-disclosure bug, not a cosmetic duplicate.
 */

import { prisma } from '@/lib/db';
import { hasPushConsent } from './consent';

export interface PushSubscriptionInput {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export type SubscribeResult =
  | { success: true; subscriptionId: string; reassigned: boolean }
  | { success: false; error: 'not-consented' | 'invalid' };

export type UnsubscribeResult =
  | { success: true; removed: number }
  | { success: false; error: 'invalid' };

/**
 * Validate a browser-supplied subscription.
 *
 * The endpoint must be an absolute https URL: the push service endpoint is
 * always https, and accepting anything else would let a caller register an
 * arbitrary URL that the server later POSTs a signed payload to. That is an SSRF
 * primitive, so this check is a security control, not input tidying.
 */
export function isValidPushSubscription(value: unknown): value is PushSubscriptionInput {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { endpoint?: unknown; keys?: unknown };

  if (typeof candidate.endpoint !== 'string' || candidate.endpoint.length === 0) {
    return false;
  }
  if (candidate.endpoint.length > 2048) return false;

  try {
    const url = new URL(candidate.endpoint);
    if (url.protocol !== 'https:') return false;
  } catch {
    return false;
  }

  if (typeof candidate.keys !== 'object' || candidate.keys === null) return false;
  const keys = candidate.keys as { p256dh?: unknown; auth?: unknown };
  if (typeof keys.p256dh !== 'string' || keys.p256dh.length === 0) return false;
  if (typeof keys.auth !== 'string' || keys.auth.length === 0) return false;

  return true;
}

/**
 * Register (or refresh) a push subscription for a member.
 *
 * Refuses unless the member has already granted consent. Consent is a separate,
 * explicit act: a caller cannot ride along on a POST that happens to carry a
 * subscription payload and enrol a member who never asked for push.
 */
export async function subscribeUser(
  userId: string,
  subscription: unknown,
): Promise<SubscribeResult> {
  if (!isValidPushSubscription(subscription)) {
    return { success: false, error: 'invalid' };
  }

  if (!(await hasPushConsent(userId))) {
    return { success: false, error: 'not-consented' };
  }

  const existing = await prisma.pushSubscription.findUnique({
    where: { endpoint: subscription.endpoint },
    select: { id: true, userId: true },
  });

  const record = await prisma.pushSubscription.upsert({
    where: { endpoint: subscription.endpoint },
    create: {
      userId,
      endpoint: subscription.endpoint,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
      active: true,
    },
    update: {
      // Always refresh the keys: a browser may rotate them under a stable
      // endpoint, and a stale `auth` secret makes every later send fail 401.
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
      active: true,
      userId,
      lastSeen: new Date(),
    },
    select: { id: true },
  });

  return {
    success: true,
    subscriptionId: record.id,
    reassigned: existing !== null && existing.userId !== userId,
  };
}

/**
 * Remove a member's push subscription for one endpoint.
 *
 * Scoped to `userId` as well as the endpoint: a caller cannot unsubscribe
 * somebody else's browser by guessing an endpoint URL.
 *
 * Removing the last endpoint revokes consent too. Consent exists to justify
 * holding the endpoint; with no endpoints left there is nothing to send, and a
 * lingering "enabled" flag would re-arm push silently the moment the member
 * opened the app again on a new device.
 */
export async function unsubscribeUser(
  userId: string,
  endpoint: unknown,
): Promise<UnsubscribeResult> {
  if (typeof endpoint !== 'string' || endpoint.length === 0) {
    return { success: false, error: 'invalid' };
  }

  const result = await prisma.pushSubscription.deleteMany({
    where: { userId, endpoint },
  });

  if (result.count > 0) {
    const remaining = await prisma.pushSubscription.count({ where: { userId } });
    if (remaining === 0) {
      await prisma.userPreferences.updateMany({
        where: { userId },
        data: { pushEnabled: false, pushConsentedAt: null },
      });
    }
  }

  return { success: true, removed: result.count };
}

/** Remove every endpoint for a member (the "turn push off everywhere" action). */
export async function unsubscribeAllForUser(userId: string): Promise<{ removed: number }> {
  const result = await prisma.pushSubscription.deleteMany({ where: { userId } });
  await prisma.userPreferences.updateMany({
    where: { userId },
    data: { pushEnabled: false, pushConsentedAt: null },
  });
  return { removed: result.count };
}
