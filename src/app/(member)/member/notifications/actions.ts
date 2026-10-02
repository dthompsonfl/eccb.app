'use server';

import { revalidatePath } from 'next/cache';
import { requireAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db';

export async function markNotificationRead(notificationId: string): Promise<void> {
  const session = await requireAuth();

  await prisma.userNotification.updateMany({
    where: {
      id: notificationId,
      userId: session.user.id,
      isRead: false,
    },
    data: {
      isRead: true,
      readAt: new Date(),
    },
  });

  revalidatePath('/member/notifications');
}

export async function markAllNotificationsRead(): Promise<void> {
  const session = await requireAuth();

  await prisma.userNotification.updateMany({
    where: {
      userId: session.user.id,
      isRead: false,
    },
    data: {
      isRead: true,
      readAt: new Date(),
    },
  });

  revalidatePath('/member/notifications');
}
