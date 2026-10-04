import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import { processScheduledPublish, checkScheduledContent, checkEventReminders } from '../scheduler';
import { addJob } from '@/lib/jobs/queue';
import { invalidatePageCache } from '@/lib/cache';
import type { PublishScheduledJobData } from '@/lib/jobs/definitions';

const mockPageFindMany = vi.fn();
const mockPageFindUnique = vi.fn();
const mockPageUpdate = vi.fn();
const mockAnnouncementFindMany = vi.fn();
const mockAnnouncementFindUnique = vi.fn();
const mockAnnouncementUpdate = vi.fn();
const mockEventFindMany = vi.fn();
const mockAnnouncementUpdateMany = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    page: {
      findMany: (...args: unknown[]) => mockPageFindMany(...args),
      findUnique: (...args: unknown[]) => mockPageFindUnique(...args),
      update: (...args: unknown[]) => mockPageUpdate(...args),
    },
    announcement: {
      findMany: (...args: unknown[]) => mockAnnouncementFindMany(...args),
      findUnique: (...args: unknown[]) => mockAnnouncementFindUnique(...args),
      update: (...args: unknown[]) => mockAnnouncementUpdate(...args),
      updateMany: (...args: unknown[]) => mockAnnouncementUpdateMany(...args),
    },
    event: {
      findMany: (...args: unknown[]) => mockEventFindMany(...args),
    },
  },
}));

vi.mock('@/lib/jobs/queue', () => ({
  addJob: vi.fn().mockResolvedValue({ id: 'job-123' }),
  createWorker: vi.fn(),
  QUEUE_NAMES: { SCHEDULED: 'eccb-scheduled' },
}));

vi.mock('@/lib/cache', () => ({
  invalidatePageCache: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

function makeJob(contentId: string): Job<PublishScheduledJobData> {
  return {
    id: 'job-1',
    name: 'publish.scheduled',
    data: {
      contentType: 'page',
      contentId,
      scheduledFor: new Date().toISOString(),
    },
    updateProgress: vi.fn().mockResolvedValue(undefined),
    returnvalue: null,
  } as unknown as Job<PublishScheduledJobData>;
}

const PAST = new Date(Date.now() - 60_000);
const FUTURE = new Date(Date.now() + 60 * 60_000);

describe('scheduled publish worker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('processScheduledPublish', () => {
    it('publishes a page whose publishAt has passed and clears the schedule', async () => {
      mockPageFindUnique.mockResolvedValue({
        id: 'page-1',
        slug: 'concert',
        title: 'Concert',
        status: 'SCHEDULED',
        publishAt: PAST,
        scheduledFor: PAST,
        publishedAt: null,
      });
      mockPageUpdate.mockResolvedValue({ id: 'page-1' });

      await processScheduledPublish(makeJob('page-1'));

      expect(mockPageUpdate).toHaveBeenCalledTimes(1);
      const update = mockPageUpdate.mock.calls[0][0];
      expect(update.where).toEqual({ id: 'page-1' });
      expect(update.data.status).toBe('PUBLISHED');
      // Both schedule columns cleared, or the next tick would re-queue it.
      expect(update.data.publishAt).toBeNull();
      expect(update.data.scheduledFor).toBeNull();
      expect(update.data.publishedAt).toBeInstanceOf(Date);
    });

    it('does NOT publish a page whose publishAt is still in the future', async () => {
      mockPageFindUnique.mockResolvedValue({
        id: 'page-2',
        slug: 'future',
        title: 'Future',
        status: 'SCHEDULED',
        publishAt: FUTURE,
        scheduledFor: FUTURE,
        publishedAt: null,
      });

      await processScheduledPublish(makeJob('page-2'));

      expect(mockPageUpdate).not.toHaveBeenCalled();
      expect(invalidatePageCache).not.toHaveBeenCalled();
    });

    it('publishes a due page even when its status is already PUBLISHED', async () => {
      mockPageFindUnique.mockResolvedValue({
        id: 'page-3',
        slug: 'live-with-gate',
        title: 'Live With Gate',
        status: 'PUBLISHED',
        publishAt: PAST,
        scheduledFor: null,
        publishedAt: null,
      });
      mockPageUpdate.mockResolvedValue({ id: 'page-3' });

      await processScheduledPublish(makeJob('page-3'));

      expect(mockPageUpdate).toHaveBeenCalledTimes(1);
      expect(mockPageUpdate.mock.calls[0][0].data.status).toBe('PUBLISHED');
    });

    it('leaves a DRAFT page alone', async () => {
      mockPageFindUnique.mockResolvedValue({
        id: 'page-4',
        slug: 'draft',
        title: 'Draft',
        status: 'DRAFT',
        publishAt: null,
        scheduledFor: null,
        publishedAt: null,
      });

      await processScheduledPublish(makeJob('page-4'));

      expect(mockPageUpdate).not.toHaveBeenCalled();
    });

    it('preserves the original publishedAt when re-publishing', async () => {
      const original = new Date('2026-01-01T00:00:00.000Z');
      mockPageFindUnique.mockResolvedValue({
        id: 'page-5',
        slug: 'republish',
        title: 'Republish',
        status: 'PUBLISHED',
        publishAt: PAST,
        scheduledFor: null,
        publishedAt: original,
      });
      mockPageUpdate.mockResolvedValue({ id: 'page-5' });

      await processScheduledPublish(makeJob('page-5'));

      expect(mockPageUpdate.mock.calls[0][0].data.publishedAt).toEqual(original);
    });

    it('invalidates the page cache so the public route sees the change', async () => {
      mockPageFindUnique.mockResolvedValue({
        id: 'page-6',
        slug: 'cached-slug',
        title: 'Cached',
        status: 'SCHEDULED',
        publishAt: PAST,
        scheduledFor: null,
        publishedAt: null,
      });
      mockPageUpdate.mockResolvedValue({ id: 'page-6' });

      await processScheduledPublish(makeJob('page-6'));

      // Without this the public route would keep serving the stale cached
      // record until the TTL expired, so publishing would appear to do nothing.
      expect(invalidatePageCache).toHaveBeenCalledWith('cached-slug');
    });

    it('throws when the page does not exist', async () => {
      mockPageFindUnique.mockResolvedValue(null);

      await expect(processScheduledPublish(makeJob('missing'))).rejects.toThrow(
        /Page not found/,
      );
    });
  });

  describe('checkScheduledContent', () => {
    it('queues only pages that are actually due', async () => {
      const due = new Date(Date.now() - 1000);
      mockPageFindMany.mockResolvedValue([
        { id: 'due-1', title: 'Due', slug: 'due-1', publishAt: due, scheduledFor: due },
      ]);
      mockAnnouncementFindMany.mockResolvedValue([]);

      await checkScheduledContent();

      // The due predicate is pushed into SQL so future-scheduled pages are never
      // returned in the first place.
      const where = mockPageFindMany.mock.calls[0][0].where;
      expect(where.status).toEqual({ in: ['SCHEDULED', 'PUBLISHED'] });
      expect(where.OR).toEqual([
        { publishAt: { lte: expect.any(Date) } },
        { scheduledFor: { lte: expect.any(Date) } },
      ]);

      expect(addJob).toHaveBeenCalledTimes(1);
      expect(addJob).toHaveBeenCalledWith(
        'publish.scheduled',
        expect.objectContaining({ contentType: 'page', contentId: 'due-1' }),
        expect.objectContaining({ jobId: expect.stringContaining('due-1') }),
      );
    });

    it('queues nothing when no page is due', async () => {
      mockPageFindMany.mockResolvedValue([]);
      mockAnnouncementFindMany.mockResolvedValue([]);

      await checkScheduledContent();

      expect(addJob).not.toHaveBeenCalled();
    });

    it('uses a deterministic jobId so the per-minute tick cannot double-queue', async () => {
      const due = new Date(Date.now() - 1000);
      mockPageFindMany.mockResolvedValue([
        { id: 'due-2', title: 'Due', slug: 'due-2', publishAt: due, scheduledFor: null },
      ]);
      mockAnnouncementFindMany.mockResolvedValue([]);

      await checkScheduledContent();
      await checkScheduledContent();

      const firstId = vi.mocked(addJob).mock.calls[0][2]?.jobId;
      const secondId = vi.mocked(addJob).mock.calls[1][2]?.jobId;
      expect(firstId).toBe(secondId);
    });

    it('excludes soft-deleted pages from the due scan', async () => {
      mockPageFindMany.mockResolvedValue([]);
      mockAnnouncementFindMany.mockResolvedValue([]);

      await checkScheduledContent();

      expect(mockPageFindMany.mock.calls[0][0].where.deletedAt).toBeNull();
    });
  });

  describe('startup handling', () => {
    it('publishes pages that fell due while the worker was down', async () => {
      // Simulates the boot-time sweep: a page whose instant passed during
      // downtime is still picked up, because the scan is purely time-based and
      // does not depend on a job having been enqueued at the original instant.
      const overdueByAnHour = new Date(Date.now() - 60 * 60_000);
      mockPageFindMany.mockResolvedValue([
        {
          id: 'overdue',
          title: 'Overdue',
          slug: 'overdue',
          publishAt: overdueByAnHour,
          scheduledFor: null,
        },
      ]);
      mockAnnouncementFindMany.mockResolvedValue([]);

      await checkScheduledContent();

      expect(addJob).toHaveBeenCalledWith(
        'publish.scheduled',
        expect.objectContaining({ contentId: 'overdue' }),
        expect.objectContaining({ jobId: expect.stringContaining('overdue') }),
      );
    });
  });

  /**
   * Reminder de-duplication.
   *
   * `checkEventReminders()` runs on EVERY scheduler tick (default 60s). An event
   * sits inside the 24h window for a full day, so without a stable `jobId` the
   * same event was enqueued once per minute — up to 1,440 duplicate reminders
   * per event per day, each emailing every RSVP'd active member.
   *
   * BullMQ ignores an `add` whose `jobId` already exists, so the id IS the
   * dedup. These tests pin that the id is deterministic across ticks and
   * distinct per (event, reminderType).
   */
  describe('checkEventReminders de-duplication', () => {
    const EVENT = {
      id: 'event-abc',
      title: 'Spring Concert',
      startTime: new Date(Date.now() + 12 * 60 * 60_000), // 12h out: in BOTH windows
    };

    beforeEach(() => {
      vi.clearAllMocks();
      mockEventFindMany.mockResolvedValue([EVENT]);
    });

    it('passes a deterministic jobId so repeat ticks collapse to one job', async () => {
      await checkEventReminders();

      const calls = vi.mocked(addJob).mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        const options = call[2] as { jobId?: string } | undefined;
        // No jobId means the storm returns.
        expect(options?.jobId, 'every reminder enqueue must carry a jobId').toBeTruthy();
      }

      // Second tick in the same window must produce identical ids.
      const firstIds = calls.map((c) => (c[2] as { jobId?: string }).jobId);
      vi.mocked(addJob).mockClear();
      await checkEventReminders();
      const secondIds = vi.mocked(addJob).mock.calls.map((c) => (c[2] as { jobId?: string }).jobId);
      expect(secondIds).toEqual(firstIds);
    });

    it('uses a distinct id per reminder type for the same event', async () => {
      await checkEventReminders();

      const ids = vi.mocked(addJob).mock.calls.map((c) => (c[2] as { jobId?: string }).jobId);
      expect(ids).toContain('reminder-event-24h-event-abc');
      expect(ids).toContain('reminder-event-1h-event-abc');
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('namespaces the id by event so two events do not collide', async () => {
      mockEventFindMany.mockResolvedValue([
        EVENT,
        { id: 'event-xyz', title: 'Another', startTime: EVENT.startTime },
      ]);

      await checkEventReminders();

      const ids = vi.mocked(addJob).mock.calls.map((c) => (c[2] as { jobId?: string }).jobId);
      expect(ids.some((id) => id?.includes('event-abc'))).toBe(true);
      expect(ids.some((id) => id?.includes('event-xyz'))).toBe(true);
    });
  });
});
