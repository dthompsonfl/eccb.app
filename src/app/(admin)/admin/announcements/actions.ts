'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db';
import { requirePermission } from '@/lib/auth/guards';
import { auditLog } from '@/lib/services/audit';
import { deliverAnnouncementNotifications } from '@/lib/notifications/announcement-delivery';
import { z } from 'zod';
import {
  ANNOUNCEMENT_CREATE,
  ANNOUNCEMENT_VIEW_ALL,
} from '@/lib/auth/permission-constants';
import type { AnnouncementType, AnnouncementAudience, ContentStatus } from '@prisma/client';

// Validation schema for announcements
const announcementSchema = z.object({
  title: z.string().min(1, 'Title is required').max(200, 'Title must be 200 characters or less'),
  content: z.string().min(1, 'Content is required'),
  type: z.enum(['INFO', 'WARNING', 'URGENT', 'EVENT']),
  audience: z.enum(['ALL', 'MEMBERS', 'ADMINS']),
  targetRoles: z.array(z.string()).optional(),
  isUrgent: z.boolean().optional(),
  isPinned: z.boolean().optional(),
  status: z.enum(['DRAFT', 'SCHEDULED', 'PUBLISHED', 'ARCHIVED']),
  publishAt: z.string().optional(),
  expiresAt: z.string().optional(),
});

export interface AnnouncementFormData {
  title: string;
  content: string;
  type: AnnouncementType;
  audience: AnnouncementAudience;
  targetRoles?: string[];
  isUrgent?: boolean;
  isPinned?: boolean;
  status: ContentStatus;
  publishAt?: Date | null;
  expiresAt?: Date | null;
}

/**
 * Create a new announcement
 */
export async function createAnnouncement(data: AnnouncementFormData) {
  const { user } = await requirePermission(ANNOUNCEMENT_CREATE);

  try {
    const validated = announcementSchema.parse({
      ...data,
      publishAt: data.publishAt?.toISOString(),
      expiresAt: data.expiresAt?.toISOString(),
    });

    const announcement = await prisma.announcement.create({
      data: {
        title: validated.title,
        content: validated.content,
        type: validated.type as AnnouncementType,
        audience: validated.audience as AnnouncementAudience,
        targetRoles: validated.targetRoles as unknown as string | undefined,
        isUrgent: validated.isUrgent ?? false,
        isPinned: validated.isPinned ?? false,
        status: validated.status as ContentStatus,
        publishAt: validated.publishAt ? new Date(validated.publishAt) : null,
        expiresAt: validated.expiresAt ? new Date(validated.expiresAt) : null,
        createdBy: user.id,
        publishedAt: validated.status === 'PUBLISHED' ? new Date() : null,
      },
    });

    await auditLog({
      action: 'announcement.create',
      entityType: 'Announcement',
      entityId: announcement.id,
      newValues: { title: announcement.title, type: announcement.type },
    });

    // If published, send notifications to relevant users
    if (validated.status === 'PUBLISHED') {
      await deliverAnnouncementNotifications(announcement.id).catch((error) => {
      console.error('Failed to deliver announcement notifications:', error);
    });
    }

    revalidatePath('/admin/announcements');
    revalidatePath('/news');
    revalidatePath('/member');

    return { success: true, id: announcement.id };
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      return { success: false, error: error.issues[0].message };
    }
    console.error('Failed to create announcement:', error);
    return { success: false, error: 'Failed to create announcement' };
  }
}

/**
 * Update an existing announcement
 */
export async function updateAnnouncement(id: string, data: Partial<AnnouncementFormData>) {
  await requirePermission(ANNOUNCEMENT_CREATE);

  try {
    const existing = await prisma.announcement.findUnique({
      where: { id },
      select: { status: true, title: true },
    });

    if (!existing) {
      return { success: false, error: 'Announcement not found' };
    }

    const updateData: Record<string, unknown> = {};

    if (data.title !== undefined) updateData.title = data.title;
    if (data.content !== undefined) updateData.content = data.content;
    if (data.type !== undefined) updateData.type = data.type;
    if (data.audience !== undefined) updateData.audience = data.audience;
    if (data.targetRoles !== undefined) updateData.targetRoles = data.targetRoles;
    if (data.isUrgent !== undefined) updateData.isUrgent = data.isUrgent;
    if (data.isPinned !== undefined) updateData.isPinned = data.isPinned;
    if (data.status !== undefined) {
      updateData.status = data.status;
      if (data.status === 'PUBLISHED' && existing.status !== 'PUBLISHED') {
        updateData.publishedAt = new Date();
      }
    }
    if (data.publishAt !== undefined) updateData.publishAt = data.publishAt;
    if (data.expiresAt !== undefined) updateData.expiresAt = data.expiresAt;

    const announcement = await prisma.announcement.update({
      where: { id },
      data: updateData,
    });

    await auditLog({
      action: 'announcement.update',
      entityType: 'Announcement',
      entityId: announcement.id,
      newValues: { title: announcement.title },
    });

    // If newly published, send notifications
    if (data.status === 'PUBLISHED' && existing.status !== 'PUBLISHED') {
      await deliverAnnouncementNotifications(announcement.id).catch((error) => {
      console.error('Failed to deliver announcement notifications:', error);
    });
    }

    revalidatePath('/admin/announcements');
    revalidatePath(`/admin/announcements/${id}`);
    revalidatePath('/news');
    revalidatePath('/member');

    return { success: true };
  } catch (error: unknown) {
    console.error('Failed to update announcement:', error);
    return { success: false, error: 'Failed to update announcement' };
  }
}

/**
 * Delete an announcement
 */
export async function deleteAnnouncement(id: string) {
  await requirePermission(ANNOUNCEMENT_CREATE);

  try {
    const announcement = await prisma.announcement.delete({
      where: { id },
    });

    await auditLog({
      action: 'announcement.delete',
      entityType: 'Announcement',
      entityId: id,
      newValues: { title: announcement.title },
    });

    revalidatePath('/admin/announcements');
    revalidatePath('/news');
    revalidatePath('/member');

    return { success: true };
  } catch (error: unknown) {
    console.error('Failed to delete announcement:', error);
    return { success: false, error: 'Failed to delete announcement' };
  }
}

/**
 * Toggle pin status for an announcement
 */
export async function toggleAnnouncementPin(id: string) {
  await requirePermission(ANNOUNCEMENT_CREATE);

  try {
    const announcement = await prisma.announcement.findUnique({
      where: { id },
      select: { isPinned: true, title: true },
    });

    if (!announcement) {
      return { success: false, error: 'Announcement not found' };
    }

    await prisma.announcement.update({
      where: { id },
      data: { isPinned: !announcement.isPinned },
    });

    await auditLog({
      action: announcement.isPinned ? 'announcement.unpin' : 'announcement.pin',
      entityType: 'Announcement',
      entityId: id,
      newValues: { title: announcement.title },
    });

    revalidatePath('/admin/announcements');
    revalidatePath('/news');

    return { success: true };
  } catch (error: unknown) {
    console.error('Failed to toggle pin:', error);
    return { success: false, error: 'Failed to update pin status' };
  }
}

/**
 * Publish a draft announcement
 */
export async function publishAnnouncement(id: string) {
  await requirePermission(ANNOUNCEMENT_CREATE);

  try {
    const announcement = await prisma.announcement.update({
      where: { id },
      data: {
        status: 'PUBLISHED',
        publishedAt: new Date(),
        publishAt: new Date(),
      },
    });

    await auditLog({
      action: 'announcement.publish',
      entityType: 'Announcement',
      entityId: id,
      newValues: { title: announcement.title },
    });

    // Send notifications
    await deliverAnnouncementNotifications(id).catch((error) => {
      console.error('Failed to deliver announcement notifications:', error);
    });

    revalidatePath('/admin/announcements');
    revalidatePath(`/admin/announcements/${id}`);
    revalidatePath('/news');
    revalidatePath('/member');

    return { success: true };
  } catch (error: unknown) {
    console.error('Failed to publish announcement:', error);
    return { success: false, error: 'Failed to publish announcement' };
  }
}

/**
 * Archive an announcement
 */
export async function archiveAnnouncement(id: string) {
  await requirePermission(ANNOUNCEMENT_CREATE);

  try {
    const announcement = await prisma.announcement.update({
      where: { id },
      data: { status: 'ARCHIVED' },
    });

    await auditLog({
      action: 'announcement.archive',
      entityType: 'Announcement',
      entityId: id,
      newValues: { title: announcement.title },
    });

    revalidatePath('/admin/announcements');
    revalidatePath('/news');
    revalidatePath('/member');

    return { success: true };
  } catch (error: unknown) {
    console.error('Failed to archive announcement:', error);
    return { success: false, error: 'Failed to archive announcement' };
  }
}

/**
 * Get a single announcement by ID
 */
export async function getAnnouncement(id: string) {
  await requirePermission(ANNOUNCEMENT_VIEW_ALL);

  try {
    const announcement = await prisma.announcement.findUnique({
      where: { id },
      include: {
        author: {
          select: { id: true, name: true, email: true },
        },
      },
    });

    return announcement;
  } catch (error) {
    console.error('Failed to get announcement:', error);
    return null;
  }
}

