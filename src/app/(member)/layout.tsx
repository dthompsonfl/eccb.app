import { requireAuth, getUserWithProfile, getSession } from '@/lib/auth/guards';
import { MemberSidebar } from '@/components/member/sidebar';
import { MemberHeader } from '@/components/member/header';
import { ImpersonationBanner } from '@/components/auth/impersonation-banner';
import { getImpersonatingAdminId } from '@/lib/auth/impersonation-session';
import { isFeatureEnabled, FEATURES } from '@/lib/feature-flags';

export default async function MemberLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireAuth();
  const user = await getUserWithProfile();

  // While impersonating, the admin is rendered the member experience with the
  // target's identity. Make that state impossible to miss.
  const session = await getSession();
  const impersonatedBy = getImpersonatingAdminId(session);

  const enabledFeatures = {
    musicStand: isFeatureEnabled(FEATURES.MUSIC_STAND),
  };

  return (
    <div className="flex min-h-screen">
      <MemberSidebar user={user} enabledFeatures={enabledFeatures} />
      <div className="flex flex-1 flex-col lg:pl-64">
        {impersonatedBy && user ? <ImpersonationBanner targetEmail={user.email} /> : null}
        <MemberHeader user={user} />
        <main className="flex-1 p-6 lg:p-8">
          {children}
        </main>
      </div>
    </div>
  );
}
