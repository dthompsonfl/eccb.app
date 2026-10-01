import { Metadata } from 'next';
import { requireAuth, getUserWithProfile } from '@/lib/auth/guards';
import { prisma } from '@/lib/db';
import { formatDate } from '@/lib/date';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { AuthorizedDownloadButton } from '@/components/music/authorized-download-button';
import {
  Music,
  Search,
  FileText,
  Filter,
  SortAsc,
} from 'lucide-react';

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

export default async function MemberMusicPage() {
  const _session = await requireAuth();
  const user = await getUserWithProfile();

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

  const assignments = await getAssignedMusic(user.member.id);

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

      {/* Search and Filters */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-col sm:flex-row gap-4">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search music..."
                className="pl-9"
              />
            </div>
            <Button variant="outline">
              <Filter className="mr-2 h-4 w-4" />
              Filter
            </Button>
            <Button variant="outline">
              <SortAsc className="mr-2 h-4 w-4" />
              Sort
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Music List */}
      {assignments.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16">
            <Music className="h-16 w-16 text-muted-foreground mb-4" />
            <h2 className="text-xl font-semibold">No Music Assigned</h2>
            <p className="text-muted-foreground mt-2 text-center max-w-md">
              You don't have any music assigned yet. Check back later or contact
              the librarian if you believe this is an error.
            </p>
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
                            {piece.difficulty.replace('_', ' ')}
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
