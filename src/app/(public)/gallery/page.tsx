import Image from 'next/image';
import { prisma } from '@/lib/db';
import { Card, CardContent } from '@/components/ui/card';
import { Calendar, Camera, Music, Users } from 'lucide-react';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Photo Gallery | Emerald Coast Community Band',
  description: 'Photos from Emerald Coast Community Band concerts, rehearsals, and community events.',
};

export default async function GalleryPage() {
  const albums = await prisma.galleryAlbum.findMany({
    where: { isPublished: true },
    include: {
      images: {
        where: { isPublished: true },
        orderBy: [{ sortOrder: 'asc' }, { uploadedAt: 'desc' }],
      },
    },
    orderBy: [{ sortOrder: 'asc' }, { title: 'asc' }],
  });

  const publishedImages = albums.flatMap((album) => album.images.map((image) => ({ ...image, albumTitle: album.title })));

  return (
    <div className="w-full py-12 md:py-16">
      <div className="mb-16 text-center">
        <Camera className="mx-auto mb-4 h-10 w-10 text-primary" />
        <h1 className="mb-4 text-4xl font-bold tracking-tight">Photo Gallery</h1>
        <p className="mx-auto max-w-2xl text-xl text-muted-foreground">
          Explore moments from concerts, rehearsals, and community performances.
        </p>
      </div>

      {publishedImages.length === 0 ? (
        <Card className="mx-auto max-w-3xl">
          <CardContent className="py-12 text-center">
            <Camera className="mx-auto mb-4 h-12 w-12 text-muted-foreground/40" />
            <h2 className="mb-4 text-2xl font-bold">Gallery photos are being curated</h2>
            <p className="mx-auto mb-6 max-w-xl text-muted-foreground">
              The band can publish concert photos and event albums from the admin gallery workspace.
            </p>
            <div className="mx-auto grid max-w-lg gap-4 text-sm text-muted-foreground md:grid-cols-3">
              <div className="flex items-center justify-center gap-2">
                <Music className="h-4 w-4" /> Concert photos
              </div>
              <div className="flex items-center justify-center gap-2">
                <Users className="h-4 w-4" /> Rehearsal shots
              </div>
              <div className="flex items-center justify-center gap-2">
                <Calendar className="h-4 w-4" /> Event highlights
              </div>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-12">
          {albums.map((album) => {
            if (album.images.length === 0) return null;
            return (
              <section key={album.id}>
                <div className="mb-6">
                  <h2 className="text-2xl font-bold">{album.title}</h2>
                  {album.description && <p className="mt-2 max-w-3xl text-muted-foreground">{album.description}</p>}
                </div>
                <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
                  {album.images.map((image) => (
                    <Card key={image.id} className="overflow-hidden">
                      <div className="relative aspect-[4/3] bg-muted">
                        {image.imageUrl ? (
                          <Image src={image.imageUrl} alt={image.altText} fill sizes="(min-width: 1024px) 33vw, (min-width: 768px) 50vw, 100vw" className="object-cover" unoptimized />
                        ) : (
                          <div className="flex h-full items-center justify-center">
                            <Camera className="h-12 w-12 text-muted-foreground/40" />
                          </div>
                        )}
                      </div>
                      {(image.title || image.caption) && (
                        <CardContent className="p-4">
                          {image.title && <h3 className="font-semibold">{image.title}</h3>}
                          {image.caption && <p className="mt-1 text-sm text-muted-foreground">{image.caption}</p>}
                        </CardContent>
                      )}
                    </Card>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}

      <section className="mt-16">
        <Card className="bg-muted/50">
          <CardContent className="p-8 text-center">
            <h2 className="mb-4 text-2xl font-bold">Share Your Photos</h2>
            <p className="mx-auto max-w-xl text-muted-foreground">
              Have photos from one of our events? Contact the band so we can review and add them to the public gallery.
            </p>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
