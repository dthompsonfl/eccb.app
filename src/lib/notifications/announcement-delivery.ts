import { prisma } from '@/lib/db';
import { sendEmail } from '@/lib/email';
import { env } from '@/lib/env';
import { sendPushToMembers } from '@/lib/communications/push/notify';
import { isNotificationPreferenceEnabled } from './preferences';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

type Recipient = {
  id: string;
  email: string | null;
  name: string | null;
  userPreferences: { otherSettings: string | null } | null;
};

export async function deliverAnnouncementNotifications(
  announcementId: string,
): Promise<void> {
  const announcement = await prisma.announcement.findUnique({
    where: { id: announcementId },
  });

  if (!announcement) return;

  let users: Recipient[];
  const select = {
    id: true,
    email: true,
    name: true,
    userPreferences: { select: { otherSettings: true } },
  } as const;

  if (announcement.audience === 'ALL') {
    users = await prisma.user.findMany({
      where: {
        member: { isNot: null },
        emailVerified: true,
        banned: false,
      },
      select,
    });
  } else if (announcement.audience === 'MEMBERS') {
    users = await prisma.user.findMany({
      where: {
        member: { status: 'ACTIVE' },
        emailVerified: true,
        banned: false,
      },
      select,
    });
  } else {
    users = await prisma.user.findMany({
      where: {
        roles: {
          some: {
            role: {
              type: { in: ['SUPER_ADMIN', 'ADMIN', 'DIRECTOR', 'STAFF'] },
            },
          },
        },
        emailVerified: true,
        banned: false,
      },
      select,
    });
  }

  const recipients = users.filter((user) =>
    isNotificationPreferenceEnabled(
      user.userPreferences?.otherSettings,
      'announcements',
    ),
  );

  if (recipients.length === 0) return;

  const existingNotifications = await prisma.userNotification.findMany({
    where: {
      announcementId: announcement.id,
      userId: { in: recipients.map((user) => user.id) },
    },
    select: { userId: true },
  });
  const alreadyNotified = new Set(
    existingNotifications.map((notification) => notification.userId),
  );
  const newRecipients = recipients.filter((user) => !alreadyNotified.has(user.id));

  if (newRecipients.length > 0) {
    await prisma.userNotification.createMany({
      data: newRecipients.map((user) => ({
        userId: user.id,
        type: 'ANNOUNCEMENT' as const,
        title: announcement.title,
        message:
          announcement.content.substring(0, 200) +
          (announcement.content.length > 200 ? '...' : ''),
        announcementId: announcement.id,
        linkUrl: '/member/notifications',
        linkText: 'View announcement',
      })),
      skipDuplicates: true,
    });

    await sendPushToMembers(
      newRecipients.map((user) => user.id),
      {
        title: announcement.title,
        body:
          announcement.content.substring(0, 200) +
          (announcement.content.length > 200 ? '...' : ''),
        url: '/member/notifications',
        tag: `announcement-${announcement.id}`,
      },
    ).catch((error: unknown) => {
      console.error('Failed to send announcement push notifications:', error);
    });
  }

  if (!(announcement.isUrgent || announcement.type === 'URGENT')) return;

  const safeTitle = escapeHtml(announcement.title);
  const safeContent = escapeHtml(announcement.content).replace(/\n/g, '<br>');

  const emails = newRecipients
    .filter((user) => Boolean(user.email))
    .map((user) => ({
      to: user.email!,
      subject: `${announcement.isUrgent ? '[URGENT] ' : ''}${announcement.title}`,
      html: `
        <h2>${safeTitle}</h2>
        <p><strong>Type:</strong> ${announcement.type}</p>
        <div style="margin:20px 0;padding:20px;background-color:#f5f5f5;border-radius:8px;">
          ${safeContent}
        </div>
        <p><a href="${env.NEXT_PUBLIC_APP_URL}/member/notifications">View announcement</a></p>
      `,
    }));

  const batchSize = 10;
  for (let i = 0; i < emails.length; i += batchSize) {
    const batch = emails.slice(i, i + batchSize);
    const results = await Promise.allSettled(batch.map((email) => sendEmail(email)));
    for (const result of results) {
      if (result.status === 'rejected') {
        console.error('Failed to send announcement email:', result.reason);
      }
    }
  }
}
