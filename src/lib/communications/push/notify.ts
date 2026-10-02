/**
 * Communications entry point — the push channel wired into the existing
 * in-app notification system.
 *
 * The platform already fans announcements out by writing `UserNotification`
 * rows (src/app/(admin)/admin/announcements/actions.ts) and emailing urgent
 * ones via src/lib/email.ts. Push is the third channel on the same event, not a
 * parallel notification system: `notifyUser()` writes the in-app row AND sends
 * the push, so every producer gets push by calling one function and no
 * producer can forget the consent check.
 *
 * Ordering is deliberate: the in-app row is written FIRST and the push is
 * best-effort afterwards. The durable record of a notification must not depend
 * on a third-party push service being reachable.
 */

import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';
import { sendPushToUser, sendPushToUsers, type PushSendResult } from './send';

export interface NotifyUserInput {
  userIds: string[];
  type: 'ANNOUNCEMENT' | 'EVENT_REMINDER' | 'MUSIC_ASSIGNMENT' | 'ATTENDANCE_REMINDER' | 'SYSTEM';
  title: string;
  message: string;
  linkUrl?: string;
  linkText?: string;
  announcementId?: string;
  eventId?: string;
  /** Opt out of the push leg (e.g. for a notification that is in-app only). */
  push?: boolean;
}

export interface NotifyUsersResult {
  /** How many in-app rows were created. */
  createdInApp: number;
  /** How many members actually received a push. Consent filtered the rest. */
  pushedUsers: number;
  /** Members with no push consent — not an error, just not contacted. */
  skippedUsers: number;
  /** Per-member push outcome, for diagnostics. */
  pushResults: PushSendResult[];
}

/**
 * Fan a notification out to members across in-app and push.
 *
 * Returns counts rather than throwing. A push failure must never roll back or
 * hide the in-app notification.
 */
export async function notifyUsers(input: NotifyUserInput): Promise<NotifyUsersResult> {
  const { userIds, push: wantsPush = true } = input;

  if (userIds.length === 0) {
    return { createdInApp: 0, pushedUsers: 0, skippedUsers: 0, pushResults: [] };
  }

  let createdInApp = 0;
  try {
    const result = await prisma.userNotification.createMany({
      data: userIds.map((userId) => ({
        userId,
        type: input.type,
        title: input.title,
        message: input.message,
        linkUrl: input.linkUrl ?? null,
        linkText: input.linkText ?? null,
        announcementId: input.announcementId ?? null,
        eventId: input.eventId ?? null,
      })),
      skipDuplicates: true,
    });
    createdInApp = result.count;
  } catch (error) {
    logger.error(
      'Failed to write in-app notifications',
      error instanceof Error ? error : new Error(String(error)),
    );
  }

  if (!wantsPush) {
    return { createdInApp, pushedUsers: 0, skippedUsers: userIds.length, pushResults: [] };
  }

  const payload = {
    title: input.title,
    body: input.message,
    ...(input.linkUrl ? { url: input.linkUrl } : {}),
    ...(input.announcementId ? { tag: `announcement-${input.announcementId}` } : {}),
  };

  // Fan out sequentially: a burst of pushes to one push service is exactly how
  // you get 429s back, and the member list here is bounded by an announcement.
  const pushResults: PushSendResult[] = [];
  let pushedUsers = 0;
  let skippedUsers = 0;

  for (const userId of userIds) {
    const result = await sendPushToUserSafely(userId, payload);
    pushResults.push(result);
    if (result.success) pushedUsers += 1;
    else skippedUsers += 1;
  }

  return { createdInApp, pushedUsers, skippedUsers, pushResults };
}

/**
 * Push-only fan-out, for callers that have ALREADY written their in-app rows.
 *
 * Exists so an existing producer can add the push channel without taking over
 * its in-app write — calling notifyUsers() instead would write the
 * UserNotification rows a second time, and UserNotification has no uniqueness
 * constraint, so that duplication would be silent and permanent.
 *
 * Consent is enforced per member inside sendPushToUser(), so a member who has
 * not opted in is simply not contacted.
 */
export async function sendPushToMembers(
  userIds: string[],
  payload: { title: string; body: string; url?: string; tag?: string },
): Promise<{ pushedUsers: number; skippedUsers: number; pushResults: PushSendResult[] }> {
  const pushResults: PushSendResult[] = [];
  let pushedUsers = 0;
  let skippedUsers = 0;

  for (const userId of userIds) {
    const result = await sendPushToUserSafely(userId, payload);
    pushResults.push(result);
    if (result.success) pushedUsers += 1;
    else skippedUsers += 1;
  }

  return { pushedUsers, skippedUsers, pushResults };
}

/** Convenience wrapper for the single-member case. */
export async function notifyUser(
  input: Omit<NotifyUserInput, 'userIds'> & { userId: string },
): Promise<NotifyUsersResult> {
  return notifyUsers({ ...input, userIds: [input.userId] });
}

async function sendPushToUserSafely(
  userId: string,
  payload: { title: string; body: string; url?: string; tag?: string },
): Promise<PushSendResult> {
  try {
    return await sendPushToUser(userId, payload);
  } catch (error) {
    logger.error(
      'Push send threw unexpectedly',
      error instanceof Error ? error : new Error(String(error)),
    );
    return {
      success: false,
      delivered: 0,
      pruned: 0,
      failed: 1,
      prunedEndpoints: [],
      error: 'Push send failed',
    };
  }
}

export { sendPushToUsers };
