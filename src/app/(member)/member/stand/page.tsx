import { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { prisma } from '@/lib/db';
import { auth } from '@/lib/auth/config';
import { isStandEnabled } from '@/lib/stand/settings';
import { headers } from 'next/headers';
import { formatDate, formatTime } from '@/lib/date';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  BookOpen,
  Calendar,
  Clock,
  Library,
} from 'lucide-react';
import { StandLibrarySearch } from '@/components/member/stand/StandLibrarySearch';

export const metadata: Metadata = {
  title: 'Music Stand',
};

export const dynamic = 'force-dynamic';

export default async function StandHubPage() {
  // Kill-switch: if the stand feature is disabled, show 404
  if (!(await isStandEnabled())) {
    notFound();
  }

  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) redirect('/login');

  // Upcoming events that have music assigned
  const upcomingEvents = await prisma.event.findMany({
    where: {
      isPublished: true,
      startTime: { gte: new Date() },
      music: { some: {} },
    },
    include: {
      music: {
        include: {
          piece: { include: { composer: { select: { fullName: true } } } },
        },
        orderBy: { sortOrder: 'asc' },
      },
      _count: { select: { music: true } },
    },
    orderBy: { startTime: 'asc' },
    take: 10,
  });

  // Past events with music (last 20) – for post-rehearsal review
  const pastEvents = await prisma.event.findMany({
    where: {
      isPublished: true,
      endTime: { lt: new Date() },
      music: { some: {} },
    },
    include: {
      _count: { select: { music: true } },
    },
    orderBy: { startTime: 'desc' },
    take: 20,
  });

  // All music pieces in the library (published, not archived)
  const allPieces = await prisma.musicPiece.findMany({
    where: { isArchived: false },
    include: {
      composer: { select: { fullName: true } },
      files: {
        where: { mimeType: 'application/pdf', isArchived: false },
        select: { id: true, storageKey: true, partLabel: true },
        take: 1,
      },
    },
    orderBy: { title: 'asc' },
  });

  const eventTypeColors: Record<string, 'default' | 'secondary' | 'outline'> = {
    REHEARSAL: 'secondary',
    CONCERT: 'default',
    MEETING: 'outline',
    SOCIAL: 'outline',
    OTHER: 'outline',
  };

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div>
        <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
          <BookOpen className="h-8 w-8 text-teal-600" />
          Music Stand
        </h1>
        <p className="text-muted-foreground mt-1">
          Open your digital music stand for rehearsals, concerts, or personal practice.
        </p>
      </div>

      <Tabs defaultValue="events">
        <TabsList>
          <TabsTrigger value="events" className="gap-2">
            <Calendar className="h-4 w-4" />
            Events
          </TabsTrigger>
          <TabsTrigger value="library" className="gap-2">
            <Library className="h-4 w-4" />
            Library ({allPieces.length})
          </TabsTrigger>
          <TabsTrigger value="past" className="gap-2">
            <Clock className="h-4 w-4" />
            Past Events
          </TabsTrigger>
        </TabsList>

        {/* ── Upcoming Events ─────────────────────────────────────────── */}
        <TabsContent value="events" className="space-y-4 mt-4">
          {upcomingEvents.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-12">
                <Calendar className="h-12 w-12 text-muted-foreground/30 mb-4" />
                <h3 className="text-lg font-medium">No upcoming events with music</h3>
                <p className="text-sm text-muted-foreground mt-1">
                  Browse the library tab to practice on your own time.
                </p>
              </CardContent>
            </Card>
          ) : (
            upcomingEvents.map((event) => (
              <Card key={event.id} className="overflow-hidden hover:border-teal-400 transition-colors">
                <CardContent className="p-4 sm:p-6">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap mb-2">
                        <Badge variant={eventTypeColors[event.type]}>{event.type}</Badge>
                        <Badge variant="outline" className="text-teal-700 border-teal-300">
                          {event._count.music} piece{event._count.music !== 1 ? 's' : ''}
                        </Badge>
                      </div>
                      <h3 className="text-lg font-semibold truncate">{event.title}</h3>
                      <div className="flex flex-wrap gap-4 text-sm text-muted-foreground mt-1">
                        <span className="flex items-center gap-1">
                          <Calendar className="h-3.5 w-3.5" />
                          {formatDate(event.startTime)}
                        </span>
                        <span className="flex items-center gap-1">
                          <Clock className="h-3.5 w-3.5" />
                          {formatTime(event.startTime)}
                        </span>
                      </div>

                      {/* Program preview */}
                      <div className="mt-3 flex flex-wrap gap-1">
                        {event.music.slice(0, 4).map((em) => (
                          <span
                            key={em.id}
                            className="text-xs bg-muted rounded px-2 py-0.5 text-muted-foreground truncate max-w-[180px]"
                            title={em.piece.title}
                          >
                            {em.piece.title}
                          </span>
                        ))}
                        {event._count.music > 4 && (
                          <span className="text-xs text-muted-foreground">
                            +{event._count.music - 4} more
                          </span>
                        )}
                      </div>
                    </div>

                    <Button asChild className="bg-teal-700 hover:bg-teal-800 shrink-0">
                      <Link href={`/member/stand/${event.id}`}>
                        <BookOpen className="mr-2 h-4 w-4" />
                        Open Stand
                      </Link>
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))
          )}
        </TabsContent>

        {/* ── Library Browser ─────────────────────────────────────────── */}
        <TabsContent value="library" className="mt-4">
          <StandLibrarySearch pieces={allPieces.map((p) => ({
            id: p.id,
            title: p.title,
            composer: p.composer?.fullName ?? null,
            hasPdf: p.files.length > 0,
          }))} />
        </TabsContent>

        {/* ── Past Events ─────────────────────────────────────────── */}
        <TabsContent value="past" className="space-y-3 mt-4">
          {pastEvents.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-12">
                <Clock className="h-12 w-12 text-muted-foreground/30 mb-4" />
                <h3 className="text-lg font-medium">No past events yet</h3>
              </CardContent>
            </Card>
          ) : (
            pastEvents.map((event) => (
              <Card key={event.id} className="hover:border-primary/30 transition-colors">
                <CardContent className="p-4">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <h3 className="font-medium">{event.title}</h3>
                      <div className="text-sm text-muted-foreground">
                        {formatDate(event.startTime)} · {event._count.music} piece{event._count.music !== 1 ? 's' : ''}
                      </div>
                    </div>
                    <Button asChild variant="outline" size="sm">
                      <Link href={`/member/stand/${event.id}`}>
                        <BookOpen className="mr-2 h-4 w-4" />
                        Review
                      </Link>
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
