import { notFound } from 'next/navigation';
import Link from 'next/link';
import { prisma } from '@/lib/db';
import { requirePermission } from '@/lib/auth/guards';
import { Button } from '@/components/ui/button';
import { ArrowLeft } from 'lucide-react';
import { MusicForm } from '@/components/admin/music/music-form';

import { MUSIC_EDIT } from '@/lib/auth/permission-constants';
interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function EditMusicPage({ params }: PageProps) {
  await requirePermission(MUSIC_EDIT);
  const { id } = await params;

  const [piece, composers, arrangers, publishers, instruments] = await Promise.all([
    prisma.musicPiece.findUnique({
      where: { id },
    }),
    // Get all people who have composed pieces or could be a composer (all people for now)
    prisma.person.findMany({
      select: {
        id: true,
        firstName: true,
        lastName: true,
      },
      orderBy: { lastName: 'asc' },
    }),
    // Get all people who could be an arranger (all people for now)
    prisma.person.findMany({
      select: {
        id: true,
        firstName: true,
        lastName: true,
      },
      orderBy: { lastName: 'asc' },
    }),
    prisma.publisher.findMany({
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    prisma.instrument.findMany({
      select: { id: true, name: true, family: true },
      orderBy: [{ family: 'asc' }, { name: 'asc' }],
    }),
  ]);

  if (!piece) {
    notFound();
  }

  const formattedComposers = composers.map((c) => ({
    ...c,
    fullName: `${c.lastName}, ${c.firstName}`,
  }));

  const formattedArrangers = arrangers.map((a) => ({
    ...a,
    fullName: `${a.lastName}, ${a.firstName}`,
  }));

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href={`/admin/music/${id}`}>
          <Button variant="outline" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Edit Music</h1>
          <p className="text-muted-foreground">
            Update details for &quot;{piece.title}&quot;
          </p>
        </div>
      </div>

      <MusicForm
        composers={formattedComposers}
        arrangers={formattedArrangers}
        publishers={publishers}
        instruments={instruments}
        initialData={{
          id: piece.id,
          title: piece.title,
          subtitle: piece.subtitle || undefined,
          composerId: piece.composerId || undefined,
          arrangerId: piece.arrangerId || undefined,
          publisherId: piece.publisherId || undefined,
          difficulty: piece.difficulty || undefined,
          duration: piece.duration || undefined,
          genre: piece.genre || undefined,
          style: piece.style || undefined,
          catalogNumber: piece.catalogNumber || undefined,
          notes: piece.notes || undefined,
        }}
      />
    </div>
  );
}
