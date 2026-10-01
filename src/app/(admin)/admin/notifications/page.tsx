import type { Metadata } from 'next';
import { prisma } from '@/lib/db';
import { requireAuth } from '@/lib/auth/guards';
import { AdminNotificationsClient } from './client';

export const metadata: Metadata = {
  title: 'Notifications | ECCB Admin',
};

export const dynamic = 'force-dynamic';

/** Maximum notifications rendered in one page. */
const PAGE_SIZE = 50;

/**
 * Administrator notification inbox.
 *
 * The admin header's bell icon linked here, but this route did not exist, and
 * nothing in the codebase read UserNotification — so the read state the
 * backend persisted was never displayed or updatable.
 *
 * Reads are strictly scoped to the signed-in administrator's own rows.
 */
export default async function AdminNotificationsPage() {
  const session = await requireAuth();
  const userId = session?.user?.id;

  if (!userId) {
    return null;
  }

  const [notifications, unreadCount] = await Promise.all([
    prisma.userNotification.findMany({
      where: { userId },
      orderBy: [{ isRead: 'asc' }, { createdAt: 'desc' }],
      take: PAGE_SIZE,
      select: {
        id: true,
        type: true,
        title: true,
        message: true,
        linkUrl: true,
        linkText: true,
        isRead: true,
        createdAt: true,
      },
    }),
    prisma.userNotification.count({ where: { userId, isRead: false } }),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Notifications</h1>
        <p className="text-muted-foreground">
          Announcements and reminders addressed to you.
        </p>
      </div>

      <AdminNotificationsClient
        notifications={notifications}
        unreadCount={unreadCount}
      />
    </div>
  );
}
