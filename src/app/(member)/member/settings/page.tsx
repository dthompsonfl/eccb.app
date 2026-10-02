import { requireAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db';
import { MemberSettingsForm } from '@/components/member/settings-form';
import { TwoFactorSettings } from '@/components/auth/two-factor-settings';
import { getNotificationPreferences } from '@/lib/notifications/preferences';

export const dynamic = 'force-dynamic';

export default async function MemberSettingsPage() {
  const session = await requireAuth();

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: {
      id: true,
      name: true,
      email: true,
      emailVerified: true,
      twoFactorEnabled: true,
      userPreferences: {
        select: { otherSettings: true },
      },
    },
  });

  if (!user) {
    throw new Error('User not found');
  }

  const notificationPreferences = getNotificationPreferences(
    user.userPreferences?.otherSettings,
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
        <p className="text-muted-foreground">
          Manage your account settings and preferences
        </p>
      </div>

      <MemberSettingsForm
        user={user}
        initialNotificationPreferences={notificationPreferences}
      />

      <TwoFactorSettings enabled={user.twoFactorEnabled} />
    </div>
  );
}
