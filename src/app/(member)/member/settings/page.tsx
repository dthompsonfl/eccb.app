import { requireAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db';
import { MemberSettingsForm } from '@/components/member/settings-form';
import { TwoFactorSettings } from '@/components/auth/two-factor-settings';
import { PrivacySettings } from '@/components/member/privacy-settings';

export default async function MemberSettingsPage() {
  const session = await requireAuth();

  // Get user details
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: {
      id: true,
      name: true,
      email: true,
      emailVerified: true,
      twoFactorEnabled: true,
      member: { select: { firstName: true, lastName: true } },
    },
  });

  if (!user) {
    throw new Error('User not found');
  }

  // The name-to-confirm phrase is shown to the member, so derive it from the
  // same server-side source the API compares against. `Member` is nullable —
  // a portal account can exist with no band profile — so fall back to the
  // account display name rather than rendering an empty prompt.
  const confirmPhrase =
    user.member && user.member.firstName
      ? `${user.member.firstName} ${user.member.lastName}`
      : (user.name ?? '');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
        <p className="text-muted-foreground">
          Manage your account settings and preferences
        </p>
      </div>

      <MemberSettingsForm user={user} />

      <TwoFactorSettings enabled={user.twoFactorEnabled} />

      <PrivacySettings memberName={confirmPhrase} />
    </div>
  );
}