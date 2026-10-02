import { prisma } from '@/lib/db';
import { ContentStatus } from '@prisma/client';
import { auditLog } from './audit';
import {
  cacheGet,
  cacheSet,
  invalidatePageCache,
  invalidateAnnouncementCache,
  cacheKeys,
  CACHE_CONFIG,
} from '@/lib/cache';
import { normalizePageContent } from '@/lib/cms/page-content';
import {
  isPagePubliclyVisible,
  getEffectivePublishAt,
  publicPageVisibilityWhere,
} from '@/lib/cms/page-visibility';

export interface CreatePageData {
  slug: string;
  title: string;
  content: string; // Changed from Prisma.InputJsonValue to string to match Prisma schema
  description?: string;
  isPublished?: boolean;
}

/**
 * Cached page data structure
 */
interface CachedPageData {
  id: string;
  slug: string;
  title: string;
  content: string;
  rawMarkdown: string | null;
  description: string | null;
  status: string;
  metaTitle: string | null;
  metaDescription: string | null;
  ogImage: string | null;
  publishedAt: Date | null;
  scheduledFor: Date | null;
  publishAt: Date | null;
  updatedAt: Date | null;
  createdAt: Date;
}

/**
 * Cached page metadata structure (lighter weight for metadata only)
 */
interface CachedPageMeta {
  title: string;
  metaTitle: string | null;
  metaDescription: string | null;
}

export class CmsService {
  /**
   * Get page by slug with caching
   * Uses Redis cache with 5-minute TTL for published pages
   */
  static async getPageBySlug(slug: string, onlyPublished: boolean = true): Promise<CachedPageData | null> {
    // Only cache published pages
    if (onlyPublished) {
      const now = new Date();
      const cacheKey = cacheKeys.page(slug);
      
      const cached = await cacheGet<CachedPageData>(cacheKey);
      if (cached) {
        // Re-check visibility against the *current* clock. The cached entry is a
        // snapshot of the row, not a pre-baked decision, so a page whose
        // publishAt was still in the future when this entry was written becomes
        // readable the moment the instant passes — no restart, no cache flush.
        if (!isPagePubliclyVisible(cached, now)) {
          return null;
        }
        return cached;
      }
      
      // Fetch from database, applying the same visibility rule in SQL so an
      // unpublished page is never even loaded on a cold cache.
      const page = await prisma.page.findFirst({
        where: {
          slug,
          ...publicPageVisibilityWhere(now),
        },
      });
      
      if (page) {
        const pageData: CachedPageData = {
          id: page.id,
          slug: page.slug,
          title: page.title,
          content: normalizePageContent(page.content).body,
          rawMarkdown: page.rawMarkdown,
          description: page.description,
          status: page.status,
          metaTitle: page.metaTitle,
          metaDescription: page.metaDescription,
          ogImage: page.ogImage,
          publishedAt: page.publishedAt,
          scheduledFor: page.scheduledFor,
          publishAt: page.publishAt,
          updatedAt: page.updatedAt,
          createdAt: page.createdAt,
        };

        // Never cache a page past its own publish instant: cap the TTL at the
        // remaining wait so the entry expires on its own schedule even if no
        // request arrives after the page goes live.
        const publishAt = getEffectivePublishAt(page);
        const ttl = publishAt
          ? Math.max(1, Math.min(CACHE_CONFIG.PAGE_TTL, Math.ceil((publishAt.getTime() - now.getTime()) / 1000)))
          : CACHE_CONFIG.PAGE_TTL;

        await cacheSet(cacheKey, pageData, ttl);
        return pageData;
      }
      
      return null;
    }
    
    // For unpublished pages (admin use), don't cache
    const page = await prisma.page.findFirst({
      where: {
        slug,
      },
    });

    if (!page) {
      return null;
    }

    return {
      ...page,
      content: normalizePageContent(page.content).body,
    } as CachedPageData;
  }

  /**
   * Get page metadata by slug (lighter weight, cached longer)
   */
  static async getPageMetaBySlug(slug: string): Promise<CachedPageMeta | null> {
    const now = new Date();
    const cacheKey = cacheKeys.pageMeta(slug);
    
    const cached = await cacheGet<CachedPageMeta>(cacheKey);
    if (cached) {
      // The cached entry is a bare {title, metaTitle, metaDescription} projection
      // with no status column, so it cannot carry its own visibility. Metadata
      // is only ever written for pages that were already visible (see the query
      // below), so a cache hit is safe to return; the visibility decision that
      // mattered happened at write time against the same rule.
      return cached;
    }
    
    // Only emit metadata for pages that are actually publicly visible. Without
    // this filter a DRAFT or still-scheduled page leaked its title and
    // description into <head> (and to crawlers) for the metadata TTL.
    const page = await prisma.page.findFirst({
      where: {
        slug,
        ...publicPageVisibilityWhere(now),
      },
      select: {
        title: true,
        metaTitle: true,
        metaDescription: true,
        publishAt: true,
        scheduledFor: true,
      },
    });
    
    if (page) {
      const metaData: CachedPageMeta = {
        title: page.title,
        metaTitle: page.metaTitle,
        metaDescription: page.metaDescription,
      };
      
      // Never cache metadata past the page's own publish instant.
      const publishAt = getEffectivePublishAt({
        status: ContentStatus.PUBLISHED,
        publishAt: page.publishAt,
        scheduledFor: page.scheduledFor,
      });
      const ttl = publishAt
        ? Math.max(1, Math.min(CACHE_CONFIG.PAGE_META_TTL, Math.ceil((publishAt.getTime() - now.getTime()) / 1000)))
        : CACHE_CONFIG.PAGE_META_TTL;

      await cacheSet(cacheKey, metaData, ttl);
      return metaData;
    }
    
    return null;
  }

  /**
   * Create or update page with cache invalidation
   */
  static async upsertPage(data: CreatePageData) {
    // Invalidate cache before update
    await invalidatePageCache(data.slug);
    
    const page = await prisma.page.upsert({
      where: { slug: data.slug },
      update: {
        title: data.title,
        content: data.content,
        description: data.description,
        status: data.isPublished ? ContentStatus.PUBLISHED : ContentStatus.DRAFT,
        publishedAt: data.isPublished ? new Date() : undefined,
      },
      create: {
        slug: data.slug,
        title: data.title,
        content: data.content,
        description: data.description,
        status: data.isPublished ? ContentStatus.PUBLISHED : ContentStatus.DRAFT,
        publishedAt: data.isPublished ? new Date() : undefined,
      },
    });

    await auditLog({
      action: 'cms.page.upsert',
      entityType: 'Page',
      entityId: page.id,
      newValues: page,
    });

    // Invalidate cache after update
    await invalidatePageCache(page.slug);

    return page;
  }

  /**
   * Delete a page by ID with cache invalidation
   */
  static async deletePage(id: string) {
    const page = await prisma.page.findUnique({
      where: { id },
      select: { slug: true },
    });
    
    if (page) {
      await invalidatePageCache(page.slug);
    }
    
    const deleted = await prisma.page.delete({
      where: { id },
    });
    
    await auditLog({
      action: 'cms.page.delete',
      entityType: 'Page',
      entityId: id,
      newValues: { slug: page?.slug },
    });
    
    return deleted;
  }

  /**
   * Create an announcement with cache invalidation
   */
  static async createAnnouncement(data: {
    title: string;
    content: string;
    type: 'INFO' | 'WARNING' | 'URGENT' | 'EVENT';
    expiresAt?: Date;
  }) {
    const announcement = await prisma.announcement.create({
      data: {
        ...data,
      },
    });

    await auditLog({
      action: 'cms.announcement.create',
      entityType: 'Announcement',
      entityId: announcement.id,
      newValues: announcement,
    });

    // Invalidate announcement cache
    await invalidateAnnouncementCache();

    return announcement;
  }

  /**
   * List announcements with caching
   */
  static async listAnnouncements(onlyActive: boolean = true) {
    const cacheKey = cacheKeys.announcementList(onlyActive);
    
    const cached = await cacheGet<Awaited<ReturnType<typeof prisma.announcement.findMany>>>(cacheKey);
    if (cached) {
      return cached;
    }
    
    const announcements = await prisma.announcement.findMany({
      where: onlyActive ? {
        OR: [
          { expiresAt: null },
          { expiresAt: { gt: new Date() } }
        ]
      } : {},
      orderBy: { createdAt: 'desc' },
    });
    
    // Cache for 2 minutes
    await cacheSet(cacheKey, announcements, CACHE_CONFIG.ANNOUNCEMENT_TTL);
    
    return announcements;
  }

  /**
   * Update announcement with cache invalidation
   */
  static async updateAnnouncement(id: string, data: {
    title?: string;
    content?: string;
    type?: 'INFO' | 'WARNING' | 'URGENT' | 'EVENT';
    expiresAt?: Date | null;
  }) {
    const announcement = await prisma.announcement.update({
      where: { id },
      data,
    });

    await auditLog({
      action: 'cms.announcement.update',
      entityType: 'Announcement',
      entityId: announcement.id,
      newValues: announcement,
    });

    // Invalidate announcement cache
    await invalidateAnnouncementCache();

    return announcement;
  }

  /**
   * Delete announcement with cache invalidation
   */
  static async deleteAnnouncement(id: string) {
    const announcement = await prisma.announcement.delete({
      where: { id },
    });

    await auditLog({
      action: 'cms.announcement.delete',
      entityType: 'Announcement',
      entityId: id,
      newValues: { title: announcement.title },
    });

    // Invalidate announcement cache
    await invalidateAnnouncementCache();

    return announcement;
  }
}
