import { Metadata } from 'next';
import Link from 'next/link';
import { prisma } from '@/lib/db';
import { requirePermission } from '@/lib/auth/guards';
import { MUSIC_CREATE } from '@/lib/auth/permission-constants';
import { MusicForm } from '@/components/admin/music/music-form';
import { Button } from '@/components/ui/button';
import { ArrowLeft } from 'lucide-react';

export const metadata: Metadata = {
  title: 'Add Music',
};

async function getFormData() {
  const [composers, arrangers, publishers, instruments] = await Promise.all([
    prisma.person.findMany({ orderBy: { lastName: 'asc' } }),
    prisma.person.findMany({ orderBy: { lastName: 'asc' } }),
    prisma.publisher.findMany({ orderBy: { name: 'asc' } }),
    prisma.instrument.findMany({ orderBy: { sortOrder: 'asc' } }),
  ]);

  return { composers, arrangers, publishers, instruments };
}

export default async function NewMusicPage() {
  // Adding to the library is a create capability, not merely a shell role.
  await requirePermission(MUSIC_CREATE);

  const { composers, arrangers, publishers, instruments } = await getFormData();

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link href="/admin/music">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div>
          <h1 className="text-2xl font-bold">Add Music</h1>
          <p className="text-muted-foreground">
            Add a new piece to the music library.
          </p>
        </div>
      </div>

      <MusicForm
        composers={composers}
        arrangers={arrangers}
        publishers={publishers}
        instruments={instruments}
      />
    </div>
  );
}
