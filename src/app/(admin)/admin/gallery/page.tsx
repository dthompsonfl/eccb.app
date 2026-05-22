import { prisma } from '@/lib/db';
import { requirePermission } from '@/lib/auth/guards';
import { CMS_VIEW_ALL } from '@/lib/auth/permission-constants';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  createGalleryAlbum,
  createGalleryImage,
  deleteGalleryAlbum,
  deleteGalleryImage,
  updateGalleryAlbum,
  updateGalleryImage,
} from './actions';

export default async function AdminGalleryPage() {
  await requirePermission(CMS_VIEW_ALL);

  const [albums, images] = await Promise.all([
    prisma.galleryAlbum.findMany({
      include: { images: true },
      orderBy: [{ sortOrder: 'asc' }, { title: 'asc' }],
    }),
    prisma.galleryImage.findMany({
      include: { album: true },
      orderBy: [{ sortOrder: 'asc' }, { uploadedAt: 'desc' }],
    }),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Gallery</h1>
        <p className="text-muted-foreground">
          Manage public gallery albums and images without code changes.
        </p>
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Create album</CardTitle>
            <CardDescription>Albums group related performance and rehearsal photos.</CardDescription>
          </CardHeader>
          <CardContent>
            <AlbumForm action={createGalleryAlbum} submitLabel="Create album" />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Add image</CardTitle>
            <CardDescription>Use an uploaded asset URL or externally hosted image URL.</CardDescription>
          </CardHeader>
          <CardContent>
            <ImageForm action={createGalleryImage} submitLabel="Add image" albums={albums} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Albums</CardTitle>
          <CardDescription>{albums.length} album records</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {albums.length === 0 ? (
            <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
              No gallery albums exist yet.
            </div>
          ) : (
            albums.map((album) => (
              <div key={album.id} className="rounded-lg border p-4">
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="font-semibold">{album.title}</h2>
                    <p className="text-sm text-muted-foreground">/{album.slug}</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Badge variant={album.isPublished ? 'default' : 'secondary'}>
                        {album.isPublished ? 'Published' : 'Draft'}
                      </Badge>
                      <Badge variant="outline">{album.images.length} images</Badge>
                    </div>
                  </div>
                  <form action={deleteGalleryAlbum}>
                    <input type="hidden" name="id" value={album.id} />
                    <Button type="submit" variant="destructive" size="sm">Delete album</Button>
                  </form>
                </div>
                <AlbumForm
                  action={updateGalleryAlbum}
                  submitLabel="Save album"
                  album={{
                    id: album.id,
                    title: album.title,
                    slug: album.slug,
                    description: album.description ?? '',
                    sortOrder: album.sortOrder,
                    isPublished: album.isPublished,
                  }}
                />
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Images</CardTitle>
          <CardDescription>{images.length} image records</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {images.length === 0 ? (
            <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
              No gallery images exist yet.
            </div>
          ) : (
            images.map((image) => (
              <div key={image.id} className="rounded-lg border p-4">
                <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="font-semibold">{image.title || image.altText}</h2>
                    <p className="text-sm text-muted-foreground">{image.album?.title ?? 'Unassigned'}</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Badge variant={image.isPublished ? 'default' : 'secondary'}>
                        {image.isPublished ? 'Published' : 'Draft'}
                      </Badge>
                    </div>
                  </div>
                  <form action={deleteGalleryImage}>
                    <input type="hidden" name="id" value={image.id} />
                    <Button type="submit" variant="destructive" size="sm">Delete image</Button>
                  </form>
                </div>
                <ImageForm
                  action={updateGalleryImage}
                  submitLabel="Save image"
                  albums={albums}
                  image={{
                    id: image.id,
                    albumId: image.albumId ?? '',
                    imageUrl: image.imageUrl ?? '',
                    title: image.title ?? '',
                    altText: image.altText,
                    caption: image.caption ?? '',
                    sortOrder: image.sortOrder,
                    isPublished: image.isPublished,
                  }}
                />
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function AlbumForm({
  action,
  submitLabel,
  album,
}: {
  action: (formData: FormData) => Promise<void>;
  submitLabel: string;
  album?: { id: string; title: string; slug: string; description: string; sortOrder: number; isPublished: boolean };
}) {
  return (
    <form action={action} className="grid gap-4 md:grid-cols-2">
      {album?.id && <input type="hidden" name="id" value={album.id} />}
      <div className="space-y-2">
        <Label htmlFor={`album-title-${album?.id ?? 'new'}`}>Title</Label>
        <Input id={`album-title-${album?.id ?? 'new'}`} name="title" defaultValue={album?.title} required />
      </div>
      <div className="space-y-2">
        <Label htmlFor={`album-slug-${album?.id ?? 'new'}`}>Slug</Label>
        <Input id={`album-slug-${album?.id ?? 'new'}`} name="slug" defaultValue={album?.slug} required />
      </div>
      <div className="space-y-2 md:col-span-2">
        <Label htmlFor={`album-description-${album?.id ?? 'new'}`}>Description</Label>
        <Textarea id={`album-description-${album?.id ?? 'new'}`} name="description" defaultValue={album?.description} rows={3} />
      </div>
      <div className="space-y-2">
        <Label htmlFor={`album-sort-${album?.id ?? 'new'}`}>Sort order</Label>
        <Input id={`album-sort-${album?.id ?? 'new'}`} name="sortOrder" type="number" min="0" defaultValue={album?.sortOrder ?? 0} />
      </div>
      <label className="flex items-center gap-2 pt-8 text-sm font-medium">
        <input name="isPublished" type="checkbox" defaultChecked={album?.isPublished ?? false} />
        Publish album
      </label>
      <div className="md:col-span-2">
        <Button type="submit">{submitLabel}</Button>
      </div>
    </form>
  );
}

function ImageForm({
  action,
  submitLabel,
  albums,
  image,
}: {
  action: (formData: FormData) => Promise<void>;
  submitLabel: string;
  albums: { id: string; title: string }[];
  image?: {
    id: string;
    albumId: string;
    imageUrl: string;
    title: string;
    altText: string;
    caption: string;
    sortOrder: number;
    isPublished: boolean;
  };
}) {
  return (
    <form action={action} className="grid gap-4 md:grid-cols-2">
      {image?.id && <input type="hidden" name="id" value={image.id} />}
      <div className="space-y-2">
        <Label htmlFor={`image-album-${image?.id ?? 'new'}`}>Album</Label>
        <select
          id={`image-album-${image?.id ?? 'new'}`}
          name="albumId"
          defaultValue={image?.albumId ?? ''}
          className="h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        >
          <option value="">Unassigned</option>
          {albums.map((album) => (
            <option key={album.id} value={album.id}>{album.title}</option>
          ))}
        </select>
      </div>
      <div className="space-y-2">
        <Label htmlFor={`image-title-${image?.id ?? 'new'}`}>Title</Label>
        <Input id={`image-title-${image?.id ?? 'new'}`} name="title" defaultValue={image?.title} />
      </div>
      <div className="space-y-2 md:col-span-2">
        <Label htmlFor={`image-url-${image?.id ?? 'new'}`}>Image URL</Label>
        <Input id={`image-url-${image?.id ?? 'new'}`} name="imageUrl" type="url" defaultValue={image?.imageUrl} />
      </div>
      <div className="space-y-2 md:col-span-2">
        <Label htmlFor={`image-alt-${image?.id ?? 'new'}`}>Alt text</Label>
        <Input id={`image-alt-${image?.id ?? 'new'}`} name="altText" defaultValue={image?.altText} required />
      </div>
      <div className="space-y-2 md:col-span-2">
        <Label htmlFor={`image-caption-${image?.id ?? 'new'}`}>Caption</Label>
        <Textarea id={`image-caption-${image?.id ?? 'new'}`} name="caption" defaultValue={image?.caption} rows={3} />
      </div>
      <div className="space-y-2">
        <Label htmlFor={`image-sort-${image?.id ?? 'new'}`}>Sort order</Label>
        <Input id={`image-sort-${image?.id ?? 'new'}`} name="sortOrder" type="number" min="0" defaultValue={image?.sortOrder ?? 0} />
      </div>
      <label className="flex items-center gap-2 pt-8 text-sm font-medium">
        <input name="isPublished" type="checkbox" defaultChecked={image?.isPublished ?? false} />
        Publish image
      </label>
      <div className="md:col-span-2">
        <Button type="submit">{submitLabel}</Button>
      </div>
    </form>
  );
}
