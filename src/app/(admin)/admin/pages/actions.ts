'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db';
import { requirePermission } from '@/lib/auth/guards';
import { auditLog } from '@/lib/services/audit';
import { invalidatePageCache, invalidateAnnouncementCache } from '@/lib/cache';
import { z } from 'zod';
import { ContentStatus, AnnouncementType, AnnouncementAudience } from '@prisma/client';
import {
  CMS_EDIT,
  CMS_DELETE,
  ANNOUNCEMENT_CREATE,
} from '@/lib/auth/permission-constants';
import { normalizePageContent } from '@/lib/cms/page-content';

const pageSchema = z.object({
  title: z.string().min(1, 'Title is required'),
  slug: z.string().min(1, 'URL slug is required').regex(/^[a-z0-9-]+$/, 'Slug can only contain lowercase letters, numbers, and hyphens'),
  content: z.string().optional(),
  rawMarkdown: z.string().optional(),
  description: z.string().optional(),
  status: z.enum(['DRAFT', 'SCHEDULED', 'PUBLISHED', 'ARCHIVED']),
  metaTitle: z.string().optional(),
  metaDescription: z.string().optional(),
  ogImage: z.string().optional(),
  scheduledFor: z.string().optional(),
  publishAt: z.string().optional(),
});

/**
 * Resolve the (status, publishAt, scheduledFor) triple an admin's form input
 * implies.
 *
 * Setting a future publish instant means "withhold until then", so the page is
 * stored as SCHEDULED regardless of which status the select showed — otherwise a
 * PUBLISHED page with a future instant and the legacy `status: 'SCHEDULED'`
 * check in the worker would disagree with what the public site serves. Clearing
 * the instant restores live visibility for an already-published page, but must
 * NOT silently publish a draft: an explicit DRAFT stays a draft.
 */
function resolvePageSchedule(
  status: string,
  rawPublishAt: string | undefined,
): { status: ContentStatus; publishAt: Date | null; scheduledFor: Date | null } {
  const parsed = rawPublishAt ? new Date(rawPublishAt) : null;
  const hasValidInstant = parsed !== null && !Number.isNaN(parsed.getTime());
  const publishAt = hasValidInstant ? parsed : null;

  if (publishAt) {
    return { status: ContentStatus.SCHEDULED, publishAt, scheduledFor: publishAt };
  }

  // No instant: an explicit SCHEDULED status would leave a page permanently
  // unpublished with nothing to unstick it, so fall back to PUBLISHED unless the
  // admin deliberately chose DRAFT or ARCHIVED.
  const resolvedStatus =
    status === 'SCHEDULED' ? ContentStatus.PUBLISHED : (status as ContentStatus);

  return { status: resolvedStatus, publishAt: null, scheduledFor: null };
}

export async function createPage(formData: FormData) {
  const session = await requirePermission(CMS_EDIT);

  try {
    const contentStr = (formData.get('content') as string) || '';
    const normalizedContent = normalizePageContent(contentStr).body;

    const data = {
      title: formData.get('title') as string,
      slug: formData.get('slug') as string,
      content: normalizedContent,
      rawMarkdown: formData.get('rawMarkdown') as string || undefined,
      description: formData.get('description') as string || undefined,
      status: (formData.get('status') as string) || 'DRAFT',
      metaTitle: formData.get('metaTitle') as string || undefined,
      metaDescription: formData.get('metaDescription') as string || undefined,
      ogImage: formData.get('ogImage') as string || undefined,
      scheduledFor: formData.get('scheduledFor') as string || undefined,
      publishAt: formData.get('publishAt') as string || undefined,
    };

    const validated = pageSchema.parse(data);
    const schedule = resolvePageSchedule(validated.status, validated.publishAt);

    // Check if slug is already taken
    const existingPage = await prisma.page.findUnique({
      where: { slug: validated.slug },
    });

    if (existingPage) {
      return { success: false, error: 'A page with this URL already exists' };
    }

    const page = await prisma.page.create({
      data: {
        title: validated.title,
        slug: validated.slug,
        content: validated.content || '',
        rawMarkdown: validated.rawMarkdown,
        description: validated.description,
        status: schedule.status,
        metaTitle: validated.metaTitle,
        metaDescription: validated.metaDescription,
        ogImage: validated.ogImage,
        createdBy: session.user.id,
        publishedAt: schedule.status === ContentStatus.PUBLISHED ? new Date() : null,
        publishAt: schedule.publishAt,
        scheduledFor: schedule.scheduledFor,
      },
    });

    await auditLog({
      action: 'page.create',
      entityType: 'Page',
      entityId: page.id,
      newValues: { title: page.title, slug: page.slug },
    });

    // Invalidate Redis cache for this page
    await invalidatePageCache(page.slug);

    revalidatePath('/admin/pages');
    revalidatePath(`/${page.slug}`);

    return { success: true, pageId: page.id };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, error: error.issues[0].message };
    }
    console.error('Failed to create page:', error);
    return { success: false, error: 'Failed to create page' };
  }
}

export async function updatePage(id: string, formData: FormData) {
  const session = await requirePermission(CMS_EDIT);

  try {
    const contentStr = (formData.get('content') as string) || '';
    const normalizedContent = normalizePageContent(contentStr).body;

    const data = {
      title: formData.get('title') as string,
      slug: formData.get('slug') as string,
      content: normalizedContent,
      rawMarkdown: formData.get('rawMarkdown') as string || undefined,
      description: formData.get('description') as string || undefined,
      status: formData.get('status') as string,
      metaTitle: formData.get('metaTitle') as string || undefined,
      metaDescription: formData.get('metaDescription') as string || undefined,
      ogImage: formData.get('ogImage') as string || undefined,
      scheduledFor: formData.get('scheduledFor') as string || undefined,
      publishAt: formData.get('publishAt') as string || undefined,
    };

    const validated = pageSchema.parse(data);
    const schedule = resolvePageSchedule(validated.status, validated.publishAt);

    // Check if slug is already taken by another page
    const existingPage = await prisma.page.findFirst({
      where: {
        slug: validated.slug,
        NOT: { id },
      },
    });

    if (existingPage) {
      return { success: false, error: 'A page with this URL already exists' };
    }

    const currentPage = await prisma.page.findUnique({ where: { id } });
    const wasPublished = currentPage?.status === 'PUBLISHED';
    const isNowPublished = schedule.status === ContentStatus.PUBLISHED;

    const page = await prisma.page.update({
      where: { id },
      data: {
        title: validated.title,
        slug: validated.slug,
        content: validated.content || '',
        rawMarkdown: validated.rawMarkdown,
        description: validated.description,
        status: schedule.status,
        metaTitle: validated.metaTitle,
        metaDescription: validated.metaDescription,
        ogImage: validated.ogImage,
        updatedBy: session.user.id,
        // Stamp the first publication only. Re-scheduling a page that was
        // already published, or clearing its schedule, must not rewrite history.
        publishedAt: !wasPublished && isNowPublished ? new Date() : undefined,
        publishAt: schedule.publishAt,
        scheduledFor: schedule.scheduledFor,
      },
    });

    await auditLog({
      action: 'page.update',
      entityType: 'Page',
      entityId: page.id,
      newValues: { title: page.title, slug: page.slug },
    });

    // Invalidate Redis cache for both old and new slugs
    await invalidatePageCache(page.slug);
    if (currentPage?.slug && currentPage.slug !== page.slug) {
      await invalidatePageCache(currentPage.slug);
    }

    revalidatePath('/admin/pages');
    revalidatePath(`/admin/pages/${id}`);
    revalidatePath(`/${page.slug}`);
    if (currentPage?.slug !== page.slug) {
      revalidatePath(`/${currentPage?.slug}`);
    }

    return { success: true };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, error: error.issues[0].message };
    }
    console.error('Failed to update page:', error);
    return { success: false, error: 'Failed to update page' };
  }
}

export async function deletePage(id: string) {
  const _session = await requirePermission(CMS_DELETE);

  try {
    const page = await prisma.page.delete({
      where: { id },
    });

    await auditLog({
      action: 'page.delete',
      entityType: 'Page',
      entityId: id,
      newValues: { title: page.title, slug: page.slug },
    });

    // Invalidate Redis cache for this page
    await invalidatePageCache(page.slug);

    revalidatePath('/admin/pages');
    revalidatePath(`/${page.slug}`);

    return { success: true };
  } catch (error) {
    console.error('Failed to delete page:', error);
    return { success: false, error: 'Failed to delete page' };
  }
}

// Announcement actions
const announcementSchema = z.object({
  title: z.string().min(1, 'Title is required'),
  content: z.string().min(1, 'Content is required'),
  type: z.enum(['INFO', 'WARNING', 'URGENT', 'EVENT']),
  audience: z.enum(['ALL', 'MEMBERS', 'ADMINS']),
  isUrgent: z.boolean().optional(),
  isPinned: z.boolean().optional(),
  publishAt: z.string().optional(),
  expiresAt: z.string().optional(),
});

export async function createAnnouncement(formData: FormData) {
  const session = await requirePermission(ANNOUNCEMENT_CREATE);

  try {
    const data = {
      title: formData.get('title') as string,
      content: formData.get('content') as string,
      type: formData.get('type') as string || 'INFO',
      audience: formData.get('audience') as string || 'ALL',
      isUrgent: formData.get('isUrgent') === 'true',
      isPinned: formData.get('isPinned') === 'true',
      publishAt: formData.get('publishAt') as string || undefined,
      expiresAt: formData.get('expiresAt') as string || undefined,
    };

    const validated = announcementSchema.parse(data);

    const announcement = await prisma.announcement.create({
      data: {
        title: validated.title,
        content: validated.content,
        type: validated.type as AnnouncementType,
        audience: validated.audience as AnnouncementAudience,
        isUrgent: validated.isUrgent ?? false,
        isPinned: validated.isPinned ?? false,
        publishAt: validated.publishAt ? new Date(validated.publishAt) : new Date(),
        expiresAt: validated.expiresAt ? new Date(validated.expiresAt) : null,
        createdBy: session.user.id,
      },
    });

    await auditLog({
      action: 'announcement.create',
      entityType: 'Announcement',
      entityId: announcement.id,
      newValues: { title: announcement.title },
    });

    // Invalidate announcement cache
    await invalidateAnnouncementCache();

    revalidatePath('/admin/announcements');
    revalidatePath('/member');

    return { success: true, announcementId: announcement.id };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, error: error.issues[0].message };
    }
    console.error('Failed to create announcement:', error);
    return { success: false, error: 'Failed to create announcement' };
  }
}

export async function updateAnnouncement(id: string, formData: FormData) {
  const _session = await requirePermission(CMS_EDIT);

  try {
    const data = {
      title: formData.get('title') as string,
      content: formData.get('content') as string,
      type: formData.get('type') as string,
      audience: formData.get('audience') as string,
      isUrgent: formData.get('isUrgent') === 'true',
      isPinned: formData.get('isPinned') === 'true',
      publishAt: formData.get('publishAt') as string || undefined,
      expiresAt: formData.get('expiresAt') as string || undefined,
    };

    const validated = announcementSchema.parse(data);

    const announcement = await prisma.announcement.update({
      where: { id },
      data: {
        title: validated.title,
        content: validated.content,
        type: validated.type as AnnouncementType,
        audience: validated.audience as AnnouncementAudience,
        isUrgent: validated.isUrgent ?? false,
        isPinned: validated.isPinned ?? false,
        publishAt: validated.publishAt ? new Date(validated.publishAt) : undefined,
        expiresAt: validated.expiresAt ? new Date(validated.expiresAt) : null,
      },
    });

    await auditLog({
      action: 'announcement.update',
      entityType: 'Announcement',
      entityId: announcement.id,
      newValues: { title: announcement.title },
    });

    // Invalidate announcement cache
    await invalidateAnnouncementCache();

    revalidatePath('/admin/announcements');
    revalidatePath(`/admin/announcements/${id}`);
    revalidatePath('/member');

    return { success: true };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, error: error.issues[0].message };
    }
    console.error('Failed to update announcement:', error);
    return { success: false, error: 'Failed to update announcement' };
  }
}

export async function deleteAnnouncement(id: string) {
  const _session = await requirePermission(CMS_DELETE);

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

    // Invalidate announcement cache
    await invalidateAnnouncementCache();

    revalidatePath('/admin/announcements');
    revalidatePath('/member');

    return { success: true };
  } catch (error) {
    console.error('Failed to delete announcement:', error);
    return { success: false, error: 'Failed to delete announcement' };
  }
}
