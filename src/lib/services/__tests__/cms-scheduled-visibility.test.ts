import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CmsService } from '../cms.service';
import { cacheGet, cacheSet } from '@/lib/cache';
import { prisma } from '@/lib/db';

vi.mock('@/lib/db', () => ({
  prisma: { page: { findFirst: vi.fn() } },
}));

vi.mock('@/lib/cache', () => ({
  cacheGet: vi.fn(),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  invalidatePageCache: vi.fn().mockResolvedValue(undefined),
  invalidateAnnouncementCache: vi.fn().mockResolvedValue(undefined),
  cacheKeys: {
    page: (slug: string) => `eccb:page:${slug}`,
    pageMeta: (slug: string) => `eccb:page:meta:${slug}`,
    announcementList: (active: boolean) => `eccb:announcements:${active}`,
  },
  CACHE_CONFIG: { PAGE_TTL: 300, PAGE_META_TTL: 600, ANNOUNCEMENT_TTL: 120 },
}));

vi.mock('@/lib/services/audit', () => ({ auditLog: vi.fn() }));

const mockedFindFirst = vi.mocked(prisma.page.findFirst);
const mockedCacheGet = vi.mocked(cacheGet);

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'page-1',
    slug: 'concert',
    title: 'Concert',
    content: 'Body copy',
    rawMarkdown: null,
    description: null,
    status: 'PUBLISHED',
    metaTitle: null,
    metaDescription: null,
    ogImage: null,
    publishedAt: null,
    scheduledFor: null,
    publishAt: null,
    updatedAt: new Date('2026-06-01T00:00:00.000Z'),
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('CmsService.getPageBySlug visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('filters out a page with a future publishAt in the SQL query', async () => {
    const future = new Date(Date.now() + 3_600_000);
    mockedCacheGet.mockResolvedValue(null);
    mockedFindFirst.mockResolvedValue(makeRow({ publishAt: future }));

    // The DB mock ignores the where clause, so simulate the DB applying it: the
    // point is that visibility is part of the query, not only a JS re-check.
    mockedFindFirst.mockImplementation((args: unknown) => {
      const where = (args as { where: { status: string } }).where;
      return Promise.resolve(where.status === 'PUBLISHED' ? null : makeRow());
    });

    const result = await CmsService.getPageBySlug('concert', true);

    expect(mockedFindFirst).toHaveBeenCalledTimes(1);
    const where = mockedFindFirst.mock.calls[0][0].where as Record<string, unknown>;
    expect(where.status).toBe('PUBLISHED');
    expect(JSON.stringify(where)).toContain('publishAt');
    expect(result).toBeNull();
  });

  it('hides a cached record whose publishAt is still in the future', async () => {
    const future = new Date(Date.now() + 3_600_000);
    mockedCacheGet.mockResolvedValue(makeRow({ publishAt: future }));

    // A cache hit must still be validated against the current clock, otherwise a
    // page cached while scheduled would stay hidden forever.
    const result = await CmsService.getPageBySlug('concert', true);

    expect(result).toBeNull();
  });

  it('serves a cached record once its publishAt has passed', async () => {
    const past = new Date(Date.now() - 3_600_000);
    mockedCacheGet.mockResolvedValue(makeRow({ publishAt: past }));

    const result = await CmsService.getPageBySlug('concert', true);

    expect(result).not.toBeNull();
    expect(result?.slug).toBe('concert');
    // No re-query needed: the cached record itself proves the time has passed.
    expect(mockedFindFirst).not.toHaveBeenCalled();
  });

  it('serves a cached record with a null publishAt', async () => {
    mockedCacheGet.mockResolvedValue(makeRow({ publishAt: null }));

    const result = await CmsService.getPageBySlug('concert', true);

    expect(result).not.toBeNull();
  });

  it('caps the cache TTL at the remaining time until publishAt', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T12:00:00.000Z'));

    mockedCacheGet.mockResolvedValue(null);
    mockedFindFirst.mockResolvedValue(makeRow({ publishAt: new Date('2026-06-01T12:00:30.000Z') }));

    await CmsService.getPageBySlug('concert', true);

    // 30s to go-live, so the entry must expire in ~30s rather than the 300s
    // default — it cannot outlive its own publish instant.
    expect(cacheSet).toHaveBeenCalledWith(
      'eccb:page:concert',
      expect.any(Object),
      30,
    );
  });

  it('uses the default TTL for a page with no schedule', async () => {
    mockedCacheGet.mockResolvedValue(null);
    mockedFindFirst.mockResolvedValue(makeRow({ publishAt: null }));

    await CmsService.getPageBySlug('concert', true);

    expect(cacheSet).toHaveBeenCalledWith(
      'eccb:page:concert',
      expect.any(Object),
      300,
    );
  });
});

describe('CmsService.getPageMetaBySlug visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not emit metadata for an unpublished page', async () => {
    mockedCacheGet.mockResolvedValue(null);
    mockedFindFirst.mockResolvedValue(null); // DB applied the visibility filter

    const result = await CmsService.getPageMetaBySlug('secret');

    expect(result).toBeNull();
    expect(cacheSet).not.toHaveBeenCalled();
    const where = mockedFindFirst.mock.calls[0][0].where as Record<string, unknown>;
    expect(where.status).toBe('PUBLISHED');
  });
});
