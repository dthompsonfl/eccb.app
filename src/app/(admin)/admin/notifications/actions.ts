'use server';

import { prisma } from '@/lib/db';
import { requireAuth } from '@/lib/auth/guards';
import { revalidatePath } from 'next/cache';
import { logger } from '@/lib/logger';

/**
 * Notification read-state server actions.
 *
 * Authorization is enforced server-side: every action resolves the caller's
 * own session and scopes the UPDATE to `userId = session.user.id`. A caller
 * can therefore never mark another user's notification as read, and cannot
 * enumerate or read anyone else's notifications.
 */

interface ActionResult {
  success: boolean;
  error?: string;
}

/** Mark a single notification as read. Scoped to the caller's own records. */
export async function markNotificationRead(
  notificationId: string,
): Promise<ActionResult> {
  try {
    const session = await requireAuth();
    const userId = session?.user?.id;
    if (!userId) {
      return { success: false, error: 'Not authenticated' };
    }

    if (!notificationId || typeof notificationId !== 'string') {
      return { success: false, error: 'Invalid notification id' };
    }

    // The `userId` filter is the authorization check. If the notification does
    // not belong to this user, the update matches nothing.
    const result = await prisma.userNotification.updateMany({
      where: {
        id: notificationId,
        userId,
        isRead: false,
      },
      data: {
        isRead: true,
        readAt: new Date(),
        updatedBy: userId,
      },
    });

    if (result.count === 0) {
      // Either it was already read, or it is not this user's notification.
      // The distinction is not disclosed to the caller.
      return { success: true };
    }

    revalidatePath('/admin/notifications');
    revalidatePath('/member/notifications');
    return { success: true };
  } catch (error) {
    logger.error(
      'Failed to mark notification as read',
      error instanceof Error ? error : new Error(String(error)),
    );
    return { success: false, error: 'Could not mark notification as read' };
  }
}

/** Mark every one of the caller's unread notifications as read. */
export async function markAllNotificationsRead(): Promise<ActionResult> {
  try {
    const session = await requireAuth();
    const userId = session?.user?.id;
    if (!userId) {
      return { success: false, error: 'Not authenticated' };
    }

    const result = await prisma.userNotification.updateMany({
      where: { userId, isRead: false },
      data: {
        isRead: true,
        readAt: new Date(),
        updatedBy: userId,
      },
    });

    revalidatePath('/admin/notifications');
    revalidatePath('/member/notifications');
    // `result.count` is intentionally not returned: the caller learns only
    // whether the action succeeded, not how many records it touched.
    void result;
    return { success: true };
  } catch (error) {
    logger.error(
      'Failed to mark all notifications as read',
      error instanceof Error ? error : new Error(String(error)),
    );
    return { success: false, error: 'Could not mark all notifications as read' };
  }
}
