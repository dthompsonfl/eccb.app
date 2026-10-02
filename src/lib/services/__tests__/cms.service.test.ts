import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CmsService } from '../cms.service';

// Mock the cache module
vi.mock('@/lib/cache', () => ({
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
  cacheDelete: vi.fn(),
  invalidatePageCache: vi.fn(),
  invalidateAnnouncementCache: vi.fn(),
  cacheKeys: {
    page: (slug: string) => `eccb:page:${slug}`,
    pageMeta: (slug: string) => `eccb:page:meta:${slug}`,
    announcementList: (active: boolean) => `eccb:announcements:${active ? 'active' : 'all'}`,
  },
  CACHE_CONFIG: {
    PAGE_TTL: 300,
    PAGE_META_TTL: 600,
    ANNOUNCEMENT_TTL: 120,
  },
}));

// Mock the prisma module
vi.mock('@/lib/db', () => ({
  prisma: {
    page: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      upsert: vi.fn(),
      delete: vi.fn(),
    },
    announcement: {
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

// Mock the audit module
vi.mock('../audit', () => ({
  auditLog: vi.fn(),
}));

import { prisma } from '@/lib/db';
import {
  cacheGet,
  cacheSet,
  invalidatePageCache,
  invalidateAnnouncementCache,
} from '@/lib/cache';

const mockPrisma = vi.mocked(prisma);
const mockCacheGet = vi.mocked(cacheGet);
const mockCacheSet = vi.mocked(cacheSet);
const mockInvalidatePageCache = vi.mocked(invalidatePageCache);
const mockInvalidateAnnouncementCache = vi.mocked(invalidateAnnouncementCache);

describe('CmsService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('getPageBySlug', () => {
    it('should return cached page when available', async () => {
      const cachedPage = {
        id: '1',
        slug: 'about',
        title: 'About Us',
        content: "Legacy page body",
        rawMarkdown: null,
        description: 'About page',
        status: 'PUBLISHED',
        metaTitle: null,
        metaDescription: null,
        ogImage: null,
        publishedAt: new Date(),
        scheduledFor: null,
        updatedAt: new Date(),
        createdAt: new Date(),
      };
      
      mockCacheGet.mockResolvedValueOnce(cachedPage);
      
      const result = await CmsService.getPageBySlug('about', true);
      
      expect(result).toEqual(cachedPage);
      expect(mockCacheGet).toHaveBeenCalledWith('eccb:page:about');
      expect(mockPrisma.page.findFirst).not.toHaveBeenCalled();
    });

    it('should fetch from database and cache on cache miss', async () => {
      const dbPage = {
        id: '1',
        slug: 'about',
        title: 'About Us',
        content: "Legacy page body",
        rawMarkdown: null,
        description: 'About page',
        status: 'PUBLISHED',
        metaTitle: null,
        metaDescription: null,
        ogImage: null,
        publishedAt: new Date(),
        scheduledFor: null,
        publishAt: null,
        updatedAt: new Date(),
        createdAt: new Date(),
      };
      
      mockCacheGet.mockResolvedValueOnce(null);
      (mockPrisma.page.findFirst as any).mockResolvedValueOnce(dbPage);
      mockCacheSet.mockResolvedValueOnce();
      
      const result = await CmsService.getPageBySlug('about', true);
      
      expect(result).toEqual(expect.objectContaining({ slug: 'about' }));
      // The query now carries the full visibility predicate (status, not-deleted,
      // and no future publish instant) rather than a bare status check, so a
      // scheduled page is never loaded on a cold cache.
      expect(mockPrisma.page.findFirst).toHaveBeenCalledWith({
        where: expect.objectContaining({ slug: 'about', status: 'PUBLISHED' }),
      });
      expect(mockCacheSet).toHaveBeenCalledWith(
        'eccb:page:about',
        expect.objectContaining({ slug: 'about' }),
        300
      );
    });

    it('should not cache unpublished pages', async () => {
      const dbPage = {
        id: '1',
        slug: 'draft',
        title: 'Draft Page',
        status: 'DRAFT',
      };
      
      (mockPrisma.page.findFirst as any).mockResolvedValueOnce(dbPage);
      
      const _result = await CmsService.getPageBySlug('draft', false);
      
      expect(mockCacheGet).not.toHaveBeenCalled();
      expect(mockCacheSet).not.toHaveBeenCalled();
      expect(mockPrisma.page.findFirst).toHaveBeenCalled();
    });

    it('should return null when page not found', async () => {
      mockCacheGet.mockResolvedValueOnce(null);
      (mockPrisma.page.findFirst as any).mockResolvedValueOnce(null);
      
      const result = await CmsService.getPageBySlug('nonexistent', true);
      
      expect(result).toBeNull();
    });
  });

  describe('getPageMetaBySlug', () => {
    it('should return cached metadata when available', async () => {
      const cachedMeta = {
        title: 'About Us',
        metaTitle: 'About | ECCB',
        metaDescription: 'Learn about us',
      };
      
      mockCacheGet.mockResolvedValueOnce(cachedMeta);
      
      const result = await CmsService.getPageMetaBySlug('about');
      
      expect(result).toEqual(cachedMeta);
      expect(mockCacheGet).toHaveBeenCalledWith('eccb:page:meta:about');
    });

    it('should fetch metadata from database on cache miss', async () => {
      const dbMeta = {
        title: 'About Us',
        metaTitle: 'About | ECCB',
        metaDescription: 'Learn about us',
      };
      
      mockCacheGet.mockResolvedValueOnce(null);
      (mockPrisma.page.findFirst as any).mockResolvedValueOnce({
        ...dbMeta,
        publishAt: null,
        scheduledFor: null,
      });
      mockCacheSet.mockResolvedValueOnce();
      
      const result = await CmsService.getPageMetaBySlug('about');
      
      expect(result).toEqual(dbMeta);
      // Metadata is only read for publicly visible pages, so the query filters
      // on status and publish instant just like the page read path.
      expect(mockPrisma.page.findFirst).toHaveBeenCalledWith({
        where: expect.objectContaining({ slug: 'about', status: 'PUBLISHED' }),
        select: {
          title: true,
          metaTitle: true,
          metaDescription: true,
          publishAt: true,
          scheduledFor: true,
        },
      });
      expect(mockCacheSet).toHaveBeenCalledWith(
        'eccb:page:meta:about',
        dbMeta,
        600
      );
    });
  });

  describe('upsertPage', () => {
    it('should invalidate cache before and after upsert', async () => {
      const pageData = {
        slug: 'new-page',
        title: 'New Page',
        content: 'Content',
        isPublished: true,
      };
      
      const upsertedPage = {
        id: '1',
        ...pageData,
        status: 'PUBLISHED',
        publishedAt: new Date(),
      };
      
      (mockPrisma.page.upsert as any).mockResolvedValueOnce(upsertedPage);
      
      const _result = await CmsService.upsertPage(pageData);
      
      expect(mockInvalidatePageCache).toHaveBeenCalledTimes(2);
      expect(mockInvalidatePageCache).toHaveBeenNthCalledWith(1, 'new-page');
      expect(mockInvalidatePageCache).toHaveBeenNthCalledWith(2, 'new-page');
      expect(mockPrisma.page.upsert).toHaveBeenCalled();
    });
  });

  describe('deletePage', () => {
    it('should invalidate cache when deleting page', async () => {
      const page = {
        id: '1',
        slug: 'delete-me',
        title: 'Delete Me',
      };
      
      (mockPrisma.page.findUnique as any).mockResolvedValueOnce(page);
      (mockPrisma.page.delete as any).mockResolvedValueOnce(page);
      
      await CmsService.deletePage('1');
      
      expect(mockInvalidatePageCache).toHaveBeenCalledWith('delete-me');
      expect(mockPrisma.page.delete).toHaveBeenCalledWith({ where: { id: '1' } });
    });
  });

  describe('listAnnouncements', () => {
    it('should return cached announcements when available', async () => {
      const cachedAnnouncements = [
        { id: '1', title: 'Announcement 1' },
        { id: '2', title: 'Announcement 2' },
      ];
      
      mockCacheGet.mockResolvedValueOnce(cachedAnnouncements as any);
      
      const result = await CmsService.listAnnouncements(true);
      
      expect(result).toEqual(cachedAnnouncements);
      expect(mockCacheGet).toHaveBeenCalledWith('eccb:announcements:active');
    });

    it('should fetch from database and cache on cache miss', async () => {
      const dbAnnouncements = [
        { id: '1', title: 'Announcement 1', createdAt: new Date() },
        { id: '2', title: 'Announcement 2', createdAt: new Date() },
      ];
      
      mockCacheGet.mockResolvedValueOnce(null);
      (mockPrisma.announcement.findMany as any).mockResolvedValueOnce(dbAnnouncements);
      mockCacheSet.mockResolvedValueOnce();
      
      const result = await CmsService.listAnnouncements(true);
      
      expect(result).toEqual(dbAnnouncements);
      expect(mockPrisma.announcement.findMany).toHaveBeenCalled();
      expect(mockCacheSet).toHaveBeenCalledWith(
        'eccb:announcements:active',
        dbAnnouncements,
        120
      );
    });
  });

  describe('createAnnouncement', () => {
    it('should invalidate cache after creating announcement', async () => {
      const announcementData = {
        title: 'New Announcement',
        content: 'Content',
        type: 'INFO' as const,
      };
      
      const createdAnnouncement = {
        id: '1',
        ...announcementData,
        createdAt: new Date(),
      };
      
      (mockPrisma.announcement.create as any).mockResolvedValueOnce(createdAnnouncement);
      
      const result = await CmsService.createAnnouncement(announcementData);
      
      expect(mockInvalidateAnnouncementCache).toHaveBeenCalled();
      expect(result).toEqual(createdAnnouncement);
    });
  });

  describe('updateAnnouncement', () => {
    it('should invalidate cache after updating announcement', async () => {
      const updateData = {
        title: 'Updated Title',
      };
      
      const updatedAnnouncement = {
        id: '1',
        title: 'Updated Title',
        content: 'Content',
        type: 'INFO',
      };
      
      (mockPrisma.announcement.update as any).mockResolvedValueOnce(updatedAnnouncement);
      
      const result = await CmsService.updateAnnouncement('1', updateData);
      
      expect(mockInvalidateAnnouncementCache).toHaveBeenCalled();
      expect(result).toEqual(updatedAnnouncement);
    });
  });

  describe('deleteAnnouncement', () => {
    it('should invalidate cache after deleting announcement', async () => {
      const deletedAnnouncement = {
        id: '1',
        title: 'Deleted',
        content: 'Content',
      };
      
      (mockPrisma.announcement.delete as any).mockResolvedValueOnce(deletedAnnouncement);
      
      await CmsService.deleteAnnouncement('1');
      
      expect(mockInvalidateAnnouncementCache).toHaveBeenCalled();
      expect(mockPrisma.announcement.delete).toHaveBeenCalledWith({ where: { id: '1' } });
    });
  });
});
