import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkScheduledContent, checkEventReminders } from '../scheduler';
import { addJob } from '@/lib/jobs/queue';

// Mock the Prisma client
const mockPageFindMany = vi.fn();
const mockAnnouncementFindMany = vi.fn();
const mockEventFindMany = vi.fn();
const mockAnnouncementUpdateMany = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    page: {
      findMany: (...args: any[]) => mockPageFindMany(...args),
    },
    announcement: {
      findMany: (...args: any[]) => mockAnnouncementFindMany(...args),
      updateMany: (...args: any[]) => mockAnnouncementUpdateMany(...args),
    },
    event: {
      findMany: (...args: any[]) => mockEventFindMany(...args),
    },
  },
}));

// Mock the queue module
vi.mock('@/lib/jobs/queue', () => ({
  addJob: vi.fn().mockResolvedValue({ id: 'job-123' }),
  createWorker: vi.fn(),
  QUEUE_NAMES: {
    SCHEDULED: 'eccb-scheduled',
  },
}));

// Mock logger
vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

describe('Scheduler Workers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('checkScheduledContent', () => {
    it('should queue jobs for scheduled pages', async () => {
      const mockPages = [
        { id: 'page-1', title: 'Page 1', scheduledFor: new Date() },
        { id: 'page-2', title: 'Page 2', scheduledFor: new Date() },
      ];
      mockPageFindMany.mockResolvedValue(mockPages);
      mockAnnouncementFindMany.mockResolvedValue([]);

      await checkScheduledContent();

      expect(mockPageFindMany).toHaveBeenCalled();
      expect(addJob).toHaveBeenCalledTimes(2);
      // A deterministic jobId is passed as the third argument so the per-minute
      // tick cannot re-queue a page that is still due.
      expect(addJob).toHaveBeenCalledWith('publish.scheduled', expect.objectContaining({
        contentType: 'page',
        contentId: 'page-1',
      }), expect.objectContaining({ jobId: expect.stringContaining('page-1') }));
      expect(addJob).toHaveBeenCalledWith('publish.scheduled', expect.objectContaining({
        contentType: 'page',
        contentId: 'page-2',
      }), expect.objectContaining({ jobId: expect.stringContaining('page-2') }));
    });

    it('should queue jobs for scheduled announcements', async () => {
      const mockAnnouncements = [
        { id: 'anno-1', title: 'Announcement 1', publishAt: new Date() },
      ];
      mockPageFindMany.mockResolvedValue([]);
      mockAnnouncementFindMany.mockResolvedValue(mockAnnouncements);

      await checkScheduledContent();

      expect(mockAnnouncementFindMany).toHaveBeenCalled();
      expect(addJob).toHaveBeenCalledTimes(1);
      expect(addJob).toHaveBeenCalledWith('publish.scheduled', expect.objectContaining({
        contentType: 'announcement',
        contentId: 'anno-1',
      }));
    });
  });

  describe('checkEventReminders', () => {
    it('should queue reminder jobs for upcoming events', async () => {
      const mockEvents24h = [
        { id: 'event-1', title: 'Event 1', startTime: new Date(Date.now() + 24 * 3600 * 1000) },
      ];
      const mockEvents1h = [
        { id: 'event-2', title: 'Event 2', startTime: new Date(Date.now() + 3600 * 1000) },
      ];

      // First call is for 24h reminders, second for 1h reminders
      mockEventFindMany
        .mockResolvedValueOnce(mockEvents24h)
        .mockResolvedValueOnce(mockEvents1h);

      await checkEventReminders();

      expect(mockEventFindMany).toHaveBeenCalledTimes(2);
      expect(addJob).toHaveBeenCalledTimes(2);
      expect(addJob).toHaveBeenCalledWith('reminder.event', expect.objectContaining({
        eventId: 'event-1',
        reminderType: '24h',
      }));
      expect(addJob).toHaveBeenCalledWith('reminder.event', expect.objectContaining({
        eventId: 'event-2',
        reminderType: '1h',
      }));
    });
  });
});
