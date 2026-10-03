import { Metadata } from 'next';
import { requireAuth, getUserWithProfile } from '@/lib/auth/guards';
import { prisma } from '@/lib/db';
import { formatDate } from '@/lib/date';
import { difficultyLabel } from '@/lib/accessibility/plain-language';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AuthorizedDownloadButton } from '@/components/music/authorized-download-button';
import Link from 'next/link';
import { Music, Search, FileText } from 'lucide-react';

export const metadata: Metadata = {
  title: 'My Music',
};

async function getAssignedMusic(memberId: string) {
  return prisma.musicAssignment.findMany({
    where: { memberId },
    include: {
      piece: {
        include: {
          composer: true,
          arranger: true,
          files: {
            where: {
              OR: [
                { fileType: 'FULL_SCORE' },
                { fileType: 'PART' },
              ],
            },
          },
          parts: {
            include: {
              instrument: true,
              file: true,
            },
          },
        },
      },
    },
    orderBy: { assignedAt: 'desc' },
  });
}

interface MemberMusicPageProps {
  searchParams: Promise<{ q?: string }>;
}

export default async function MemberMusicPage({ searchParams }: MemberMusicPageProps) {
  const _session = await requireAuth();
  const user = await getUserWithProfile();
  const { q } = await searchParams;
  const query = (q ?? '').trim();

  if (!user?.member) {
    return (
      <div className="flex flex-col items-center justify-center py-16">
        <Music className="h-16 w-16 text-muted-foreground mb-4" />
        <h2 className="text-xl font-semibold">No Member Profile</h2>
        <p className="text-muted-foreground mt-2">
          Please contact an administrator to set up your member profile.
        </p>
      </div>
    );
  }

  const allAssignments = await getAssignedMusic(user.member.id);

  /* Search was a decorative input: it had no value, no handler and no effect,
     so a member who typed a title and pressed Enter got the same list back and
     no explanation. It is a plain GET form now, which means it works with the
     keyboard alone and without JavaScript. */
  const assignments = query
    ? allAssignments.filter(({ piece, partName }) => {
        const haystack = [
          piece.title,
          piece.subtitle,
          piece.composer?.fullName,
          piece.arranger?.fullName,
          partName,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return haystack.includes(query.toLowerCase());
      })
    : allAssignments;

  // Get member's instruments for filtering parts
  const memberInstruments = user.member.instruments.map(i => i.instrument.name);

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">My Music</h1>
          <p className="text-muted-foreground">
            Music assigned to you for upcoming performances.
          </p>
        </div>
      </div>

      {/* Search.
          The "Filter" and "Sort" buttons that used to sit here had no onClick
          at all: tapping them did nothing and said nothing, which for this
          audience is worse than not offering them. They have been removed
          rather than left as decoration that lies about being a control. */}
      <Card>
        <CardContent className="pt-6">
          <form method="get" action="/member/music" className="flex flex-col gap-3">
            <Label htmlFor="music-search" className="text-base font-medium">
              Find a piece
            </Label>
            <div className="flex flex-col sm:flex-row gap-3">
              <div className="relative flex-1">
                <Search
                  className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground"
                  aria-hidden="true"
                />
                <Input
                  id="music-search"
                  name="q"
                  type="search"
                  defaultValue={query}
                  placeholder="Type a title or composer"
                  aria-describedby="music-search-help"
                  className="pl-10 h-12 text-base"
                />
              </div>
              <Button type="submit" size="lg" className="h-12 px-6 text-base">
                Search
              </Button>
              {query && (
                <Button asChild variant="outline" size="lg" className="h-12 px-6 text-base">
                  <Link href="/member/music">Clear</Link>
                </Button>
              )}
            </div>
            <p id="music-search-help" className="text-sm text-muted-foreground">
              {query
                ? `Showing ${assignments.length} of ${allAssignments.length} pieces for "${query}".`
                : 'Search by title, composer, or your part name.'}
            </p>
          </form>
        </CardContent>
      </Card>

      {/* Music List */}
      {assignments.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16">
            <Music className="h-16 w-16 text-muted-foreground mb-4" aria-hidden="true" />
            {query ? (
              <>
                <h2 className="text-xl font-semibold">Nothing matched your search</h2>
                <p className="text-muted-foreground mt-2 text-center max-w-md">
                  No piece of your music has &quot;{query}&quot; in its title,
                  composer or part name. Check the spelling, or search for part of
                  the title instead.
                </p>
                <Button asChild variant="outline" size="lg" className="mt-6 h-12 px-6 text-base">
                  <Link href="/member/music">Show all my music</Link>
                </Button>
              </>
            ) : (
              <>
                <h2 className="text-xl font-semibold">No Music Assigned</h2>
                <p className="text-muted-foreground mt-2 text-center max-w-md">
                  You don't have any music assigned yet. Check back later or contact
                  the librarian if you believe this is an error.
                </p>
                <Button asChild variant="outline" size="lg" className="mt-6 h-12 px-6 text-base">
                  <Link href="/contact">Ask the band office</Link>
                </Button>
              </>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {assignments.map((assignment) => {
            const piece = assignment.piece;
            
            // Find relevant parts for this member's instruments
            const relevantParts = piece.parts.filter(part =>
              memberInstruments.includes(part.instrument.name) ||
              assignment.partName === part.partName
            );

            return (
              <Card key={assignment.id}>
                <CardContent className="p-6">
                  <div className="flex flex-col lg:flex-row lg:items-start gap-4">
                    {/* Piece Info */}
                    <div className="flex-1">
                      <div className="flex items-start gap-3">
                        <div className="flex-shrink-0 w-12 h-12 bg-primary/10 rounded-lg flex items-center justify-center">
                          <FileText className="h-6 w-6 text-primary" />
                        </div>
                        <div>
                          <h3 className="font-semibold text-lg">{piece.title}</h3>
                          {piece.subtitle && (
                            <p className="text-muted-foreground">{piece.subtitle}</p>
                          )}
                          <div className="flex flex-wrap items-center gap-2 mt-2 text-sm text-muted-foreground">
                            {piece.composer && (
                              <span>{piece.composer.fullName}</span>
                            )}
                            {piece.composer && piece.arranger && (
                              <span>•</span>
                            )}
                            {piece.arranger && (
                              <span>arr. {piece.arranger.fullName}</span>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Assignment details */}
                      <div className="mt-4 flex flex-wrap items-center gap-2">
                        {assignment.partName && (
                          <Badge variant="secondary">
                            Part: {assignment.partName}
                          </Badge>
                        )}
                        {piece.difficulty && (
                          <Badge variant="outline">
                            {difficultyLabel(piece.difficulty)}
                          </Badge>
                        )}
                        {assignment.dueDate && (
                          <Badge variant="outline">
                            Due: {formatDate(assignment.dueDate)}
                          </Badge>
                        )}
                      </div>

                      {assignment.notes && (
                        <p className="mt-3 text-sm text-muted-foreground bg-muted p-3 rounded-lg">
                          {assignment.notes}
                        </p>
                      )}
                    </div>

                    {/* Downloads */}
                    <div className="lg:w-64 space-y-2">
                      <h4 className="font-medium text-sm text-muted-foreground mb-2">
                        Download Parts
                      </h4>

                      {/* Assigned part.
                          Downloads go through AuthorizedDownloadButton, which
                          POSTs to /api/files/download-url. That endpoint
                          performs session, CSRF, rate-limit, and per-piece
                          assignment authorization before returning a
                          short-lived signed URL. The previous markup linked
                          straight to `/api/music/download/${fileId}` — a route
                          that does not exist, and one that would have had no
                          signed token even if it did. */}
                      {relevantParts.length > 0 ? (
                        relevantParts.map((part) =>
                          part.file ? (
                            <AuthorizedDownloadButton
                              key={part.id}
                              storageKey={part.file.storageKey}
                              label={`${part.partName} (${part.instrument.name})`}
                              variant="outline"
                              className="w-full justify-start"
                            />
                          ) : (
                            <Button
                              key={part.id}
                              variant="outline"
                              className="w-full justify-start"
                              disabled
                            >
                              <FileText
                                className="mr-2 h-4 w-4"
                                aria-hidden="true"
                              />
                              {part.partName} ({part.instrument.name}) —
                              file unavailable
                            </Button>
                          ),
                        )
                      ) : (
                        <p className="text-sm text-muted-foreground">
                          No parts available for your instruments.
                        </p>
                      )}

                      {/* Full score if available */}
                      {(() => {
                        const fullScore = piece.files.find(
                          (f) => f.fileType === 'FULL_SCORE',
                        );
                        if (!fullScore) return null;
                        return (
                          <AuthorizedDownloadButton
                            storageKey={fullScore.storageKey}
                            label="Full Score"
                            variant="ghost"
                            className="w-full justify-start text-muted-foreground"
                          />
                        );
                      })()}
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
