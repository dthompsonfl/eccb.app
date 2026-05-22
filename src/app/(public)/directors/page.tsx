import type { ReactNode } from 'react';
import Image from 'next/image';
import { prisma } from '@/lib/db';
import { Card, CardContent } from '@/components/ui/card';
import { Award, Mail, Music, Users } from 'lucide-react';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Our Directors | Emerald Coast Community Band',
  description: 'Meet the directors, board members, and leadership team of the Emerald Coast Community Band.',
};

export default async function DirectorsPage() {
  const profiles = await prisma.leadershipProfile.findMany({
    where: { isPublished: true },
    orderBy: [{ profileType: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
  });

  const directors = profiles.filter((profile) => profile.profileType === 'DIRECTOR');
  const boardMembers = profiles.filter((profile) => profile.profileType === 'BOARD');
  const otherLeaders = profiles.filter((profile) => !['DIRECTOR', 'BOARD'].includes(profile.profileType));

  return (
    <div className="w-full py-12 md:py-16">
      <div className="mb-16 text-center">
        <h1 className="mb-4 text-4xl font-bold tracking-tight">Our Leadership</h1>
        <p className="mx-auto max-w-2xl text-xl text-muted-foreground">
          Meet the dedicated directors, board members, and volunteers who guide the Emerald Coast Community Band.
        </p>
      </div>

      <LeadershipSection
        title="Music Directors"
        icon={<Music className="h-8 w-8 text-primary" />}
        profiles={directors}
        emptyTitle="Director profiles are being finalized"
        emptyDescription="The band can publish director bios from the admin leadership workspace as soon as they are ready."
      />

      <LeadershipSection
        title="Board of Directors"
        icon={<Award className="h-8 w-8 text-primary" />}
        profiles={boardMembers}
        emptyTitle="Board profiles are being finalized"
        emptyDescription="Board member details can be managed from the admin leadership workspace."
        compact
      />

      {otherLeaders.length > 0 && (
        <LeadershipSection
          title="Band Leadership"
          icon={<Users className="h-8 w-8 text-primary" />}
          profiles={otherLeaders}
          emptyTitle=""
          emptyDescription=""
          compact
        />
      )}

      <section className="mt-16">
        <Card className="border-primary/20 bg-primary/5">
          <CardContent className="p-8 md:p-12">
            <h2 className="mb-4 text-2xl font-bold">About Our Leadership</h2>
            <div className="max-w-none space-y-4 text-muted-foreground">
              <p>
                The Emerald Coast Community Band is led by dedicated musicians and volunteers who share a passion for bringing quality music to the community.
              </p>
              <p>
                Our leadership team supports artistic direction, member experience, concert operations, communications, and stewardship of the band&apos;s long-term mission.
              </p>
            </div>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

function LeadershipSection({
  title,
  icon,
  profiles,
  emptyTitle,
  emptyDescription,
  compact = false,
}: {
  title: string;
  icon: ReactNode;
  profiles: {
    id: string;
    name: string;
    role: string;
    bio: string | null;
    photoUrl: string | null;
    email: string | null;
  }[];
  emptyTitle: string;
  emptyDescription: string;
  compact?: boolean;
}) {
  return (
    <section className="mb-16">
      <div className="mb-8 flex items-center gap-3">
        {icon}
        <h2 className="text-3xl font-bold">{title}</h2>
      </div>

      {profiles.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Users className="mx-auto mb-4 h-10 w-10 text-muted-foreground/40" />
            <h3 className="text-lg font-semibold">{emptyTitle}</h3>
            <p className="mx-auto mt-2 max-w-xl text-muted-foreground">{emptyDescription}</p>
          </CardContent>
        </Card>
      ) : (
        <div className={compact ? 'grid gap-6 md:grid-cols-2 lg:grid-cols-4' : 'grid gap-8 md:grid-cols-2 lg:grid-cols-3'}>
          {profiles.map((profile) => (
            <Card key={profile.id} className="overflow-hidden">
              <div className={compact ? 'relative mx-auto mt-6 h-24 w-24 overflow-hidden rounded-full bg-muted' : 'relative aspect-square bg-muted'}>
                {profile.photoUrl ? (
                  <Image
                    src={profile.photoUrl}
                    alt={profile.name}
                    fill
                    sizes={compact ? '96px' : '(min-width: 1024px) 33vw, (min-width: 768px) 50vw, 100vw'}
                    className="object-cover"
                    unoptimized
                  />
                ) : (
                  <div className="flex h-full items-center justify-center">
                    <Users className={compact ? 'h-10 w-10 text-muted-foreground/30' : 'h-24 w-24 text-muted-foreground/30'} />
                  </div>
                )}
              </div>
              <CardContent className={compact ? 'p-6 text-center' : 'p-6'}>
                <h3 className="text-xl font-bold">{profile.name}</h3>
                <p className="mb-3 font-medium text-primary">{profile.role}</p>
                {profile.bio && <p className="text-sm text-muted-foreground">{profile.bio}</p>}
                {profile.email && (
                  <a className="mt-4 inline-flex items-center gap-2 text-sm text-primary hover:underline" href={`mailto:${profile.email}`}>
                    <Mail className="h-4 w-4" /> Contact
                  </a>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}
