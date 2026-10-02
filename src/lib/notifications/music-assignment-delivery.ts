import { prisma } from '@/lib/db';
import { sendPushToMembers } from '@/lib/communications/push/notify';
import { isNotificationPreferenceEnabled } from './preferences';

export async function deliverMusicAssignmentNotifications(
  pieceId: string,
  memberIds: string[],
): Promise<void> {
  if (memberIds.length === 0) return;

  const [piece, members] = await Promise.all([
    prisma.musicPiece.findUnique({
      where: { id: pieceId },
      select: { title: true },
    }),
    prisma.member.findMany({
      where: { id: { in: memberIds } },
      select: {
        id: true,
        user: {
          select: {
            id: true,
            userPreferences: { select: { otherSettings: true } },
          },
        },
      },
    }),
  ]);

  if (!piece) return;

  const linkUrl = `/member/music?pieceId=${encodeURIComponent(pieceId)}`;
  const candidateUsers = members
    .flatMap((member) => (member.user ? [member.user] : []))
    .filter((user) =>
      isNotificationPreferenceEnabled(
        user.userPreferences?.otherSettings,
        'musicAssignments',
      ),
    );

  if (candidateUsers.length === 0) return;

  const recentlyNotified = await prisma.userNotification.findMany({
    where: {
      userId: { in: candidateUsers.map((user) => user.id) },
      type: 'MUSIC_ASSIGNMENT',
      linkUrl,
      createdAt: { gte: new Date(Date.now() - 5 * 60 * 1000) },
    },
    select: { userId: true },
  });
  const existing = new Set(recentlyNotified.map((item) => item.userId));

  const recipients = candidateUsers.filter((user) => !existing.has(user.id));
  if (recipients.length === 0) return;

  await prisma.userNotification.createMany({
    data: recipients.map((user) => ({
      userId: user.id,
      type: 'MUSIC_ASSIGNMENT' as const,
      title: 'New music assigned',
      message: `${piece.title} has been assigned to you.`,
      linkUrl,
      linkText: 'Open music library',
    })),
    skipDuplicates: true,
  });

  await sendPushToMembers(
    recipients.map((user) => user.id),
    {
      title: 'New music assigned',
      body: `${piece.title} has been assigned to you.`,
      url: linkUrl,
      tag: `music-assignment-${pieceId}`,
    },
  ).catch((error: unknown) => {
    console.error('Failed to send music assignment push notifications:', error);
  });
}
