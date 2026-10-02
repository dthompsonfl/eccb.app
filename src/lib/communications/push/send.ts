/**
 * Push send path — the web-push channel of the communications system.
 *
 * This is the push sibling of src/lib/email.ts: same contract shape
 * (a `send*` that resolves to a result object, never throws at the caller),
 * same out-of-the-box-safe behaviour when the transport is not configured.
 *
 * Three invariants, each of them load-bearing:
 *
 *  1. CONSENT FIRST. A member without consent is never even looked up for
 *     subscriptions, let alone sent to. The gate is `hasPushConsent()`, which
 *     requires BOTH pushEnabled and a consent timestamp.
 *  2. PRUNE ON 404/410. A push service answers 404/410 when an endpoint is gone
 *     (browser profile reset, permission revoked, subscription expired). Those
 *     rows are dead weight that will never deliver again, so they are deleted.
 *     Any other status is a transient transport failure and the row is KEPT —
 *     deleting on 500/429 would silently unsubscribe every member whenever a
 *     push service had a bad afternoon.
 *  3. NO KEY, NO SEND. With no VAPID pair configured, nothing is attempted and
 *     the caller is told `skipped: 'not-configured'` rather than being handed a
 *     silent no-op success.
 */

import webpush from 'web-push';
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';
import { hasPushConsent } from './consent';
import { getPushSettings, isPushEnabled } from './settings';

export interface PushPayload {
  title: string;
  body: string;
  /** Relative in-app path, e.g. '/member/notifications'. */
  url?: string;
  /** Coarse grouping tag; the service worker collapses same-tag notifications. */
  tag?: string;
}

export interface PushSendResult {
  /** True when at least one endpoint accepted the payload. */
  success: boolean;
  /** Number of endpoints that delivered. */
  delivered: number;
  /** Number of endpoints that were pruned as gone (404/410). */
  pruned: number;
  /** Number of endpoints that failed for a transient reason. */
  failed: number;
  /** Endpoints deleted, exposed for tests and diagnostics. */
  prunedEndpoints: string[];
  /** Why nothing was sent, when applicable. */
  skipped?: 'not-consented' | 'not-configured' | 'disabled' | 'no-subscriptions';
  error?: string;
}

interface StoredSubscription {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

/**
 * True for the two statuses that mean "this endpoint will never work again".
 *
 * 404 = endpoint no longer exists. 410 = subscription explicitly gone.
 * Everything else (401/403 misconfiguration, 429 rate limited, 5xx push service
 * outage) is transient or a server-side problem, not a dead endpoint.
 */
export function isExpiredSubscriptionStatus(status: number | undefined): boolean {
  return status === 404 || status === 410;
}

/** Extract an HTTP status from a web-push / fetch rejection. */
function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const candidate = error as { statusCode?: unknown; status?: unknown };
  if (typeof candidate.statusCode === 'number') return candidate.statusCode;
  if (typeof candidate.status === 'number') return candidate.status;
  return undefined;
}

/**
 * Send one payload to every active endpoint belonging to a member.
 *
 * Returns a result object rather than throwing: a push failure must never
 * break the in-app notification or email that accompanies it.
 */
export async function sendPushToUser(
  userId: string,
  payload: PushPayload,
): Promise<PushSendResult> {
  const empty: PushSendResult = {
    success: false,
    delivered: 0,
    pruned: 0,
    failed: 0,
    prunedEndpoints: [],
  };

  // 1. Consent gate, before anything else. Fail closed.
  if (!(await hasPushConsent(userId))) {
    return { ...empty, skipped: 'not-consented' };
  }

  if (!(await isPushEnabled())) {
    return { ...empty, skipped: 'disabled' };
  }

  const settings = await getPushSettings();
  if (!settings.vapidPublicKey || !settings.vapidPrivateKey) {
    return { ...empty, skipped: 'not-configured' };
  }

  let subscriptions: StoredSubscription[];
  try {
    subscriptions = await prisma.pushSubscription.findMany({
      where: { userId, active: true },
      select: { id: true, endpoint: true, p256dh: true, auth: true },
    });
  } catch (error) {
    logger.error('Push subscription lookup failed', error instanceof Error ? error : new Error(String(error)));
    return { ...empty, error: 'Subscription lookup failed' };
  }

  if (subscriptions.length === 0) {
    return { ...empty, skipped: 'no-subscriptions' };
  }

  webpush.setVapidDetails(
    settings.vapidSubject,
    settings.vapidPublicKey,
    settings.vapidPrivateKey,
  );

  let delivered = 0;
  let pruned = 0;
  let failed = 0;
  const prunedEndpoints: string[] = [];

  for (const sub of subscriptions) {
    try {
      await webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth },
        },
        JSON.stringify(payload),
      );
      delivered += 1;
      await touchSubscription(sub.id);
    } catch (error) {
      const status = statusOf(error);
      if (status !== undefined && isExpiredSubscriptionStatus(status)) {
        pruned += 1;
        prunedEndpoints.push(sub.endpoint);
        await pruneSubscription(sub.id, status);
      } else {
        failed += 1;
        logger.warn(
          `Push delivery failed for subscription ${sub.id} (status ${status ?? 'unknown'})`,
        );
      }
    }
  }

  return { success: delivered > 0, delivered, pruned, failed, prunedEndpoints };
}

/** Update liveness without touching `updatedAt` semantics elsewhere. */
async function touchSubscription(id: string): Promise<void> {
  try {
    await prisma.pushSubscription.update({
      where: { id },
      data: { lastSeen: new Date() },
    });
  } catch {
    // Liveness bookkeeping is not worth failing a send over.
  }
}

/**
 * Delete a dead subscription.
 *
 * Scoped deleteMany on `id` rather than `delete()` so a row already reaped by a
 * concurrent send does not turn into an unhandled P2025 rejection.
 */
async function pruneSubscription(id: string, status: number): Promise<void> {
  try {
    await prisma.pushSubscription.deleteMany({ where: { id } });
    logger.info(`Pruned expired push subscription ${id} (status ${status})`);
  } catch (error) {
    logger.error('Failed to prune push subscription', error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * Send a payload to many members.
 *
 * Individual failures are contained: one member's dead endpoint never stops the
 * rest of the fan-out.
 */
export async function sendPushToUsers(
  userIds: string[],
  payload: PushPayload,
): Promise<{ deliveredUsers: number; skippedUsers: number }> {
  let deliveredUsers = 0;
  let skippedUsers = 0;

  for (const userId of userIds) {
    const result = await sendPushToUser(userId, payload);
    if (result.success) deliveredUsers += 1;
    else skippedUsers += 1;
  }

  return { deliveredUsers, skippedUsers };
}
