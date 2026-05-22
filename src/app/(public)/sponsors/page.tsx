import Image from 'next/image';
import Link from 'next/link';
import { SponsorLevel } from '@prisma/client';
import { prisma } from '@/lib/db';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Building2, ExternalLink, Heart } from 'lucide-react';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Our Sponsors | Emerald Coast Community Band',
  description: 'Thank you to the generous sponsors who support the Emerald Coast Community Band.',
};

const tierLabels: Record<SponsorLevel, string> = {
  PLATINUM: 'Platinum Sponsors',
  GOLD: 'Gold Sponsors',
  SILVER: 'Silver Sponsors',
  BRONZE: 'Bronze Sponsors',
  COMMUNITY: 'Community Partners',
  IN_KIND: 'In-Kind Sponsors',
};

const tierOrder: SponsorLevel[] = [
  SponsorLevel.PLATINUM,
  SponsorLevel.GOLD,
  SponsorLevel.SILVER,
  SponsorLevel.BRONZE,
  SponsorLevel.COMMUNITY,
  SponsorLevel.IN_KIND,
];

export default async function SponsorsPage() {
  const now = new Date();
  const sponsors = await prisma.sponsor.findMany({
    where: {
      isActive: true,
      OR: [{ startsAt: null }, { startsAt: { lte: now } }],
      AND: [{ OR: [{ endsAt: null }, { endsAt: { gte: now } }] }],
    },
    orderBy: [{ level: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
  });

  return (
    <div className="w-full py-12 md:py-16">
      <div className="mb-16 text-center">
        <div className="mb-4 inline-flex items-center gap-2 text-primary">
          <Heart className="h-8 w-8" />
        </div>
        <h1 className="mb-4 text-4xl font-bold tracking-tight">Our Sponsors</h1>
        <p className="mx-auto max-w-2xl text-xl text-muted-foreground">
          We are grateful for the generous support of sponsors who help us bring quality music to the Emerald Coast community.
        </p>
      </div>

      {sponsors.length === 0 ? (
        <Card className="mx-auto max-w-3xl">
          <CardContent className="py-12 text-center">
            <Building2 className="mx-auto mb-4 h-12 w-12 text-muted-foreground/40" />
            <h2 className="mb-2 text-2xl font-bold">Sponsor listings are being finalized</h2>
            <p className="mb-6 text-muted-foreground">
              Local businesses and community partners can support concerts, rehearsal needs, music purchases, and youth outreach.
            </p>
            <Button asChild>
              <Link href="/contact">Ask about sponsorship</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-12">
          {tierOrder.map((level) => {
            const tierSponsors = sponsors.filter((sponsor) => sponsor.level === level);
            if (tierSponsors.length === 0) return null;

            return (
              <section key={level}>
                <h2 className="mb-6 text-center text-2xl font-bold">{tierLabels[level]}</h2>
                <div className={level === SponsorLevel.PLATINUM ? 'grid gap-6 md:grid-cols-2' : 'grid gap-6 md:grid-cols-2 lg:grid-cols-3'}>
                  {tierSponsors.map((sponsor) => (
                    <Card key={sponsor.id} className={level === SponsorLevel.PLATINUM ? 'border-2 border-primary' : ''}>
                      <CardHeader>
                        <CardTitle className="flex items-center gap-3">
                          {sponsor.logoUrl ? (
                            <span className="relative block h-14 w-24 shrink-0 overflow-hidden rounded bg-muted">
                              <Image src={sponsor.logoUrl} alt={`${sponsor.name} logo`} fill sizes="96px" className="object-contain p-2" unoptimized />
                            </span>
                          ) : (
                            <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded bg-muted">
                              <Building2 className="h-7 w-7 text-muted-foreground" />
                            </span>
                          )}
                          <span>{sponsor.name}</span>
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-4">
                        {sponsor.description && <p className="text-sm text-muted-foreground">{sponsor.description}</p>}
                        {sponsor.websiteUrl && (
                          <Button asChild variant="outline" size="sm">
                            <a href={sponsor.websiteUrl} target="_blank" rel="noopener noreferrer">
                              Visit website <ExternalLink className="ml-2 h-4 w-4" />
                            </a>
                          </Button>
                        )}
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}

      <section className="mt-16">
        <Card className="border-primary/20 bg-primary/5">
          <CardContent className="p-8 text-center md:p-12">
            <h2 className="mb-4 text-2xl font-bold">Become a Sponsor</h2>
            <p className="mx-auto mb-6 max-w-2xl text-muted-foreground">
              Sponsorship helps fund sheet music, concert logistics, equipment, community performances, and member programming.
            </p>
            <Button asChild>
              <Link href="/contact">Contact us about sponsorship</Link>
            </Button>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
