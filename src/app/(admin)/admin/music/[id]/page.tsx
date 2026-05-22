import { notFound } from 'next/navigation';
import Link from 'next/link';
import { prisma } from '@/lib/db';
import { requirePermission } from '@/lib/auth/guards';
import { formatDate } from '@/lib/date';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  ArrowLeft,
  Edit,
  FileText,
  Users,
  Calendar,
} from 'lucide-react';
import { MusicFilesList } from '@/components/admin/music/music-files-list';
import { MusicAssignments } from '@/components/admin/music/music-assignments';

import { MUSIC_VIEW_ALL } from '@/lib/auth/permission-constants';
interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function MusicDetailPage({ params }: PageProps) {
  await requirePermission(MUSIC_VIEW_ALL);
  const { id } = await params;

  const [piece, instruments] = await Promise.all([
    prisma.musicPiece.findUnique({
      where: { id },
      include: {
        composer: true,
        arranger: true,
        publisher: true,
        files: {
          include: {
            parts: {
              include: { instrument: true },
            },
            versions: {
              orderBy: { version: 'desc' },
              take: 10,
            },
          },
          orderBy: { uploadedAt: 'asc' },
        },
        assignments: {
          include: {
            member: {
              include: {
                user: true,
                instruments: {
                  where: { isPrimary: true },
                  include: { instrument: true },
                },
              },
            },
          },
          orderBy: { assignedAt: 'desc' },
        },
        eventMusic: {
          include: {
            event: true,
          },
          take: 10,
          orderBy: { event: { startTime: 'desc' } },
        },
      },
    }),
    prisma.instrument.findMany({
      orderBy: [{ family: 'asc' }, { sortOrder: 'asc' }],
    }),
  ]);

  if (!piece) {
    notFound();
  }

  const difficultyLabels: Record<string, string> = {
    GRADE_1: 'Grade 1 (Very Easy)',
    GRADE_2: 'Grade 2 (Easy)',
    GRADE_3: 'Grade 3 (Medium)',
    GRADE_4: 'Grade 4 (Medium Advanced)',
    GRADE_5: 'Grade 5 (Advanced)',
    GRADE_6: 'Grade 6 (Professional)',
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href="/admin/music">
            <Button variant="outline" size="icon">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <h1 className="text-3xl font-bold tracking-tight">{piece.title}</h1>
            {piece.subtitle && (
              <p className="text-muted-foreground">{piece.subtitle}</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Link href={`/admin/music/${id}/edit`}>
            <Button>
              <Edit className="mr-2 h-4 w-4" />
              Edit
            </Button>
          </Link>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-3">
        {/* Main Info */}
        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle>Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-sm text-muted-foreground">Composer</p>
                <p className="font-medium">
                  {piece.composer
                    ? `${piece.composer.firstName} ${piece.composer.lastName}`
                    : 'Unknown'}
                </p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Arranger</p>
                <p className="font-medium">
                  {piece.arranger
                    ? `${piece.arranger.firstName} ${piece.arranger.lastName}`
                    : 'N/A'}
                </p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Publisher</p>
                <p className="font-medium">{piece.publisher?.name || 'N/A'}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Catalog Number</p>
                <p className="font-medium">{piece.catalogNumber || 'N/A'}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Genre</p>
                <p className="font-medium">{piece.genre || 'N/A'}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Difficulty</p>
                <p className="font-medium">
                  {piece.difficulty ? difficultyLabels[piece.difficulty] || piece.difficulty : 'N/A'}
                </p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Duration</p>
                <p className="font-medium">
                  {piece.duration ? `${piece.duration} minutes` : 'N/A'}
                </p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Status</p>
                <Badge variant={piece.isArchived ? 'secondary' : 'default'}>
                  {piece.isArchived ? 'Archived' : 'Active'}
                </Badge>
              </div>
            </div>
            {piece.notes && (
              <div>
                <p className="text-sm text-muted-foreground">Notes</p>
                <p className="mt-1">{piece.notes}</p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Stats */}
        <div className="space-y-6">
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-4">
                <div className="p-2 bg-primary/10 rounded-lg">
                  <FileText className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{piece.files.length}</p>
                  <p className="text-sm text-muted-foreground">Files</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-4">
                <div className="p-2 bg-blue-500/10 rounded-lg">
                  <Users className="h-5 w-5 text-blue-500" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{piece.assignments.length}</p>
                  <p className="text-sm text-muted-foreground">Assigned</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-4">
                <div className="p-2 bg-amber-500/10 rounded-lg">
                  <Calendar className="h-5 w-5 text-amber-500" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{piece.eventMusic.length}</p>
                  <p className="text-sm text-muted-foreground">Events</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="files" className="space-y-4">
        <TabsList>
          <TabsTrigger value="files">
            <FileText className="mr-2 h-4 w-4" />
            Files ({piece.files.length})
          </TabsTrigger>
          <TabsTrigger value="assignments">
            <Users className="mr-2 h-4 w-4" />
            Assignments ({piece.assignments.length})
          </TabsTrigger>
          <TabsTrigger value="events">
            <Calendar className="mr-2 h-4 w-4" />
            Events ({piece.eventMusic.length})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="files">
          <MusicFilesList pieceId={piece.id} files={piece.files} instruments={instruments} />
        </TabsContent>

        <TabsContent value="assignments">
          <MusicAssignments pieceId={piece.id} assignments={piece.assignments} />
        </TabsContent>

        <TabsContent value="events">
          <Card>
            <CardHeader>
              <CardTitle>Event History</CardTitle>
              <CardDescription>
                Events where this piece has been performed or scheduled
              </CardDescription>
            </CardHeader>
            <CardContent>
              {piece.eventMusic.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">
                  This piece has not been scheduled for any events yet.
                </p>
              ) : (
                <div className="space-y-4">
                  {piece.eventMusic.map((em) => (
                    <div
                      key={em.id}
                      className="flex items-center justify-between border-b pb-4 last:border-0"
                    >
                      <div>
                        <Link
                          href={`/admin/events/${em.event.id}`}
                          className="font-medium hover:underline"
                        >
                          {em.event.title}
                        </Link>
                        <p className="text-sm text-muted-foreground">
                          {formatDate(em.event.startTime)}
                        </p>
                      </div>
                      <Badge variant={em.event.isCancelled ? 'destructive' : 'default'}>
                        {em.event.isCancelled ? 'Cancelled' : 'Scheduled'}
                      </Badge>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
