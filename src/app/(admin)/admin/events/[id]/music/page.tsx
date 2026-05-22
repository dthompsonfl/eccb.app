import { notFound } from 'next/navigation';
import Link from 'next/link';
import { prisma } from '@/lib/db';
import { requirePermission } from '@/lib/auth/guards';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ArrowLeft, Music } from 'lucide-react';
import { EventMusicManager } from '@/components/admin/events/EventMusicManager';

import { EVENT_EDIT } from '@/lib/auth/permission-constants';
interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function AdminEventMusicPage({ params }: PageProps) {
  await requirePermission(EVENT_EDIT);
  const { id } = await params;

  const [event, allPieces] = await Promise.all([
    prisma.event.findUnique({
      where: { id },
      include: {
        music: {
          include: {
            piece: {
              include: {
                composer: { select: { firstName: true, lastName: true } },
                files: {
                  where: { mimeType: 'application/pdf', isArchived: false },
                  select: { id: true },
                  take: 1,
                },
              },
            },
          },
          orderBy: { sortOrder: 'asc' },
        },
      },
    }),
    prisma.musicPiece.findMany({
      where: { isArchived: false },
      include: {
        composer: { select: { firstName: true, lastName: true } },
      },
      orderBy: { title: 'asc' },
    }),
  ]);

  if (!event) notFound();

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href={`/admin/events/${id}`}>
            <Button variant="outline" size="icon">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <Music className="h-6 w-6 text-primary" />
              Manage Program
            </h1>
            <p className="text-muted-foreground">{event.title}</p>
          </div>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Event Program</CardTitle>
          <CardDescription>
            Add, remove, and reorder music pieces for this event. Members will see this
            program on their Digital Music Stand.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <EventMusicManager
            eventId={id}
            eventMusic={event.music.map((em) => ({
              id: em.id,
              sortOrder: em.sortOrder,
              piece: {
                id: em.piece.id,
                title: em.piece.title,
                composer: em.piece.composer
                  ? `${em.piece.composer.firstName} ${em.piece.composer.lastName}`
                  : null,
                hasPdf: em.piece.files.length > 0,
              },
            }))}
            library={allPieces.map((p) => ({
              id: p.id,
              title: p.title,
              composer: p.composer
                ? `${p.composer.firstName} ${p.composer.lastName}`
                : null,
            }))}
          />
        </CardContent>
      </Card>
    </div>
  );
}
