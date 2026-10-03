import { notFound } from 'next/navigation';
import Link from 'next/link';
import { prisma } from '@/lib/db';
import { requireAuth } from '@/lib/auth/guards';
import { formatDate } from '@/lib/date';
import { difficultyLabel } from '@/lib/accessibility/plain-language';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import {
  Music,
  ArrowLeft,
  Download,
  FileMusic,
  Calendar,
} from 'lucide-react';

interface MusicDetailPageProps {
  params: Promise<{ id: string }>;
}

const difficultyColors: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  GRADE_1: 'secondary',
  GRADE_2: 'secondary',
  GRADE_3: 'outline',
  GRADE_4: 'default',
  GRADE_5: 'default',
  GRADE_6: 'destructive',
};

/* Labels come from the shared plain-language map so the list page and the
   detail page cannot drift apart — they used to, and did. */

export default async function MemberMusicDetailPage({ params }: MusicDetailPageProps) {
  const resolvedParams = await params;
  const session = await requireAuth();

  // Get member for this user
  const member = await prisma.member.findFirst({
    where: { userId: session.user.id },
    select: { id: true },
  });

  const piece = await prisma.musicPiece.findUnique({
    where: { id: resolvedParams.id },
    include: {
      composer: true,
      arranger: true,
      publisher: true,
      files: {
        orderBy: { uploadedAt: 'desc' },
      },
      eventMusic: {
        include: {
          event: {
            select: {
              id: true,
              title: true,
              startTime: true,
              type: true,
            },
          },
        },
        orderBy: {
          event: { startTime: 'desc' },
        },
        take: 10,
      },
      assignments: member ? {
        where: { memberId: member.id },
      } : undefined,
    },
  });

  if (!piece) {
    notFound();
  }

  const isAssigned = piece.assignments && piece.assignments.length > 0;
  const assignment = piece.assignments?.[0];

  // Separate upcoming and past events
  const now = new Date();
  const upcomingEvents = piece.eventMusic.filter(em => em.event.startTime > now);
  const pastEvents = piece.eventMusic.filter(em => em.event.startTime <= now);

  // Format duration
  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${String(secs).padStart(2, '0')}`;
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link href="/member/music">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold tracking-tight">{piece.title}</h1>
            {isAssigned && (
              <Badge variant="default">Assigned to You</Badge>
            )}
          </div>
          {piece.composer && (
            <p className="text-muted-foreground">
              by {piece.composer.fullName}
              {piece.arranger && ` / arr. ${piece.arranger.fullName}`}
            </p>
          )}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Main Content */}
        <div className="lg:col-span-2 space-y-6">
          {/* Music Details */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Music className="h-5 w-5" />
                Details
              </CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-4 sm:grid-cols-2">
                {piece.composer && (
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Composer</dt>
                    <dd className="mt-1">{piece.composer.fullName}</dd>
                  </div>
                )}
                {piece.arranger && (
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Arranger</dt>
                    <dd className="mt-1">{piece.arranger.fullName}</dd>
                  </div>
                )}
                {piece.publisher && (
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Publisher</dt>
                    <dd className="mt-1">{piece.publisher.name}</dd>
                  </div>
                )}
                {piece.difficulty && (
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Difficulty</dt>
                    <dd className="mt-1">
                      <Badge variant={difficultyColors[piece.difficulty]}>
                        {difficultyLabel(piece.difficulty)}
                      </Badge>
                    </dd>
                  </div>
                )}
                {piece.duration && (
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Duration</dt>
                    <dd className="mt-1">{formatDuration(piece.duration)}</dd>
                  </div>
                )}
                {piece.genre && (
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Genre</dt>
                    <dd className="mt-1">{piece.genre}</dd>
                  </div>
                )}
                {piece.style && (
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Style</dt>
                    <dd className="mt-1">{piece.style}</dd>
                  </div>
                )}
              </dl>

              {piece.notes && (
                <>
                  <Separator className="my-4" />
                  <div>
                    <h4 className="text-sm font-medium text-muted-foreground mb-2">Notes</h4>
                    <p className="whitespace-pre-wrap">{piece.notes}</p>
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          {/* Music Files (Only for assigned members) */}
          {isAssigned && piece.files.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <FileMusic className="h-5 w-5" />
                  Music Files
                </CardTitle>
                <CardDescription>
                  Download your parts for this piece
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {piece.files.map((file) => (
                    <div
                      key={file.id}
                      className="flex items-center justify-between p-3 rounded-lg border bg-muted/30"
                    >
                      <div className="flex items-center gap-3">
                        <FileMusic className="h-5 w-5 text-muted-foreground" />
                        <div>
                          <p className="font-medium">{file.fileName}</p>
                          <p className="text-sm text-muted-foreground">
                            {(file.fileSize / 1024).toFixed(1)} KB • {file.fileType}
                          </p>
                        </div>
                      </div>
                      <Button variant="outline" size="sm" asChild>
                        <a href={`/api/files/${file.storageKey}`} download={file.fileName}>
                          <Download className="mr-2 h-4 w-4" />
                          Download
                        </a>
                      </Button>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Not Assigned Message */}
          {!isAssigned && piece.files.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <FileMusic className="h-5 w-5" />
                  Music Files
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-center py-6">
                  <FileMusic className="mx-auto h-12 w-12 text-muted-foreground" />
                  <h3 className="mt-4 text-lg font-semibold">Files Available</h3>
                  <p className="text-muted-foreground">
                    This piece has {piece.files.length} file{piece.files.length !== 1 ? 's' : ''} available.
                    Once this music is assigned to you, you&apos;ll be able to download your parts.
                  </p>
                </div>
              </CardContent>
            </Card>
          )}
        </div>

        {/* Sidebar */}
        <div className="space-y-6">
          {/* Assignment Info */}
          {assignment && (
            <Card>
              <CardHeader>
                <CardTitle>Your Assignment</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center gap-3">
                  <Calendar className="h-5 w-5 text-muted-foreground" />
                  <div>
                    <p className="text-sm text-muted-foreground">Assigned</p>
                    <p className="font-medium">{formatDate(assignment.assignedAt)}</p>
                  </div>
                </div>
                {assignment.notes && (
                  <div>
                    <p className="text-sm text-muted-foreground">Notes</p>
                    <p className="mt-1">{assignment.notes}</p>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Upcoming Performances */}
          {upcomingEvents.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Upcoming Performances</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {upcomingEvents.map((em) => (
                    <Link
                      key={em.event.id}
                      href={`/member/events/${em.event.id}`}
                      className="flex items-center justify-between p-2 rounded-lg hover:bg-muted transition-colors"
                    >
                      <div>
                        <p className="font-medium text-sm">{em.event.title}</p>
                        <p className="text-xs text-muted-foreground">
                          {formatDate(em.event.startTime, 'MMM d, yyyy')}
                        </p>
                      </div>
                      <Badge variant="outline" className="text-xs">
                        {em.event.type}
                      </Badge>
                    </Link>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Past Performances */}
          {pastEvents.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Past Performances</CardTitle>
                <CardDescription>
                  Previously performed {pastEvents.length} time{pastEvents.length !== 1 ? 's' : ''}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {pastEvents.slice(0, 5).map((em) => (
                    <div
                      key={em.event.id}
                      className="flex items-center justify-between text-sm"
                    >
                      <span className="text-muted-foreground truncate">
                        {em.event.title}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {formatDate(em.event.startTime, 'MMM yyyy')}
                      </span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
