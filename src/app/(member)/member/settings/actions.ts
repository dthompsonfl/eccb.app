'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db';
import {
  serializeNotificationPreferences,
  type NotificationPreferences,
} from '@/lib/notifications/preferences';

const notificationPreferencesSchema = z.object({
  eventReminders: z.boolean(),
  musicAssignments: z.boolean(),
  announcements: z.boolean(),
});

export async function updateNotificationPreferences(
  input: NotificationPreferences,
): Promise<{ success: true } | { success: false; error: string }> {
  const session = await requireAuth();
  const parsed = notificationPreferencesSchema.safeParse(input);

  if (!parsed.success) {
    return { success: false, error: 'Invalid notification preferences.' };
  }

  try {
    const existing = await prisma.userPreferences.findUnique({
      where: { userId: session.user.id },
      select: { otherSettings: true },
    });

    const otherSettings = serializeNotificationPreferences(
      existing?.otherSettings,
      parsed.data,
    );

    await prisma.userPreferences.upsert({
      where: { userId: session.user.id },
      create: {
        userId: session.user.id,
        otherSettings,
      },
      update: { otherSettings },
    });

    revalidatePath('/member/settings');
    return { success: true };
  } catch (error) {
    console.error('Failed to update notification preferences:', error);
    return { success: false, error: 'Failed to save notification preferences.' };
  }
}
