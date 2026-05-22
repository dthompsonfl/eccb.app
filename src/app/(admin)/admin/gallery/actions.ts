'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requirePermission } from '@/lib/auth/guards';
import { CMS_EDIT, CMS_DELETE } from '@/lib/auth/permission-constants';
import { auditLog } from '@/lib/services/audit';

const albumSchema = z.object({
  id: z.string().optional(),
  title: z.string().trim().min(2, 'Album title is required'),
  slug: z.string().trim().min(2).regex(/^[a-z0-9-]+$/, 'Slug must contain lowercase letters, numbers, and hyphens'),
  description: z.string().trim().optional(),
  sortOrder: z.coerce.number().int().min(0).default(0),
  isPublished: z.coerce.boolean().default(false),
});

const imageSchema = z.object({
  id: z.string().optional(),
  albumId: z.string().optional(),
  imageUrl: z.string().trim().url('Image URL must be valid').or(z.literal('')).optional(),
  title: z.string().trim().optional(),
  altText: z.string().trim().min(3, 'Alt text is required'),
  caption: z.string().trim().optional(),
  sortOrder: z.coerce.number().int().min(0).default(0),
  isPublished: z.coerce.boolean().default(false),
});

function parseAlbum(formData: FormData) {
  return albumSchema.parse({
    id: formData.get('id') || undefined,
    title: formData.get('title'),
    slug: formData.get('slug'),
    description: formData.get('description') || undefined,
    sortOrder: formData.get('sortOrder') || 0,
    isPublished: formData.get('isPublished') === 'on' || formData.get('isPublished') === 'true',
  });
}

function parseImage(formData: FormData) {
  return imageSchema.parse({
    id: formData.get('id') || undefined,
    albumId: formData.get('albumId') || undefined,
    imageUrl: formData.get('imageUrl') || undefined,
    title: formData.get('title') || undefined,
    altText: formData.get('altText'),
    caption: formData.get('caption') || undefined,
    sortOrder: formData.get('sortOrder') || 0,
    isPublished: formData.get('isPublished') === 'on' || formData.get('isPublished') === 'true',
  });
}

export async function createGalleryAlbum(formData: FormData) {
  const session = await requirePermission(CMS_EDIT);
  const data = parseAlbum(formData);

  const album = await prisma.galleryAlbum.create({
    data: {
      title: data.title,
      slug: data.slug,
      description: data.description || null,
      sortOrder: data.sortOrder,
      isPublished: data.isPublished,
      updatedBy: session.user.id,
    },
  });

  await auditLog({
    action: 'gallery.album.create',
    entityType: 'GalleryAlbum',
    entityId: album.id,
    newValues: { title: album.title, slug: album.slug },
  });

  revalidatePath('/admin/gallery');
  revalidatePath('/gallery');
}

export async function updateGalleryAlbum(formData: FormData) {
  const session = await requirePermission(CMS_EDIT);
  const data = parseAlbum(formData);
  if (!data.id) throw new Error('Album id is required');

  const previous = await prisma.galleryAlbum.findUnique({ where: { id: data.id } });
  const album = await prisma.galleryAlbum.update({
    where: { id: data.id },
    data: {
      title: data.title,
      slug: data.slug,
      description: data.description || null,
      sortOrder: data.sortOrder,
      isPublished: data.isPublished,
      updatedBy: session.user.id,
    },
  });

  await auditLog({
    action: 'gallery.album.update',
    entityType: 'GalleryAlbum',
    entityId: album.id,
    oldValues: previous,
    newValues: album,
  });

  revalidatePath('/admin/gallery');
  revalidatePath('/gallery');
}

export async function deleteGalleryAlbum(formData: FormData) {
  await requirePermission(CMS_DELETE);
  const id = z.string().min(1).parse(formData.get('id'));
  const previous = await prisma.galleryAlbum.findUnique({ where: { id } });

  await prisma.galleryAlbum.delete({ where: { id } });
  await auditLog({
    action: 'gallery.album.delete',
    entityType: 'GalleryAlbum',
    entityId: id,
    oldValues: previous,
  });

  revalidatePath('/admin/gallery');
  revalidatePath('/gallery');
}

export async function createGalleryImage(formData: FormData) {
  const session = await requirePermission(CMS_EDIT);
  const data = parseImage(formData);

  const image = await prisma.galleryImage.create({
    data: {
      albumId: data.albumId || null,
      imageUrl: data.imageUrl || null,
      title: data.title || null,
      altText: data.altText,
      caption: data.caption || null,
      sortOrder: data.sortOrder,
      isPublished: data.isPublished,
      updatedBy: session.user.id,
    },
  });

  await auditLog({
    action: 'gallery.image.create',
    entityType: 'GalleryImage',
    entityId: image.id,
    newValues: { title: image.title, albumId: image.albumId, isPublished: image.isPublished },
  });

  revalidatePath('/admin/gallery');
  revalidatePath('/gallery');
}

export async function updateGalleryImage(formData: FormData) {
  const session = await requirePermission(CMS_EDIT);
  const data = parseImage(formData);
  if (!data.id) throw new Error('Gallery image id is required');

  const previous = await prisma.galleryImage.findUnique({ where: { id: data.id } });
  const image = await prisma.galleryImage.update({
    where: { id: data.id },
    data: {
      albumId: data.albumId || null,
      imageUrl: data.imageUrl || null,
      title: data.title || null,
      altText: data.altText,
      caption: data.caption || null,
      sortOrder: data.sortOrder,
      isPublished: data.isPublished,
      updatedBy: session.user.id,
    },
  });

  await auditLog({
    action: 'gallery.image.update',
    entityType: 'GalleryImage',
    entityId: image.id,
    oldValues: previous,
    newValues: image,
  });

  revalidatePath('/admin/gallery');
  revalidatePath('/gallery');
}

export async function deleteGalleryImage(formData: FormData) {
  await requirePermission(CMS_DELETE);
  const id = z.string().min(1).parse(formData.get('id'));
  const previous = await prisma.galleryImage.findUnique({ where: { id } });

  await prisma.galleryImage.delete({ where: { id } });
  await auditLog({
    action: 'gallery.image.delete',
    entityType: 'GalleryImage',
    entityId: id,
    oldValues: previous,
  });

  revalidatePath('/admin/gallery');
  revalidatePath('/gallery');
}
