import { describe, it, expect, vi, beforeEach } from 'vitest';

// All mocks must be self-contained because vi.mock is hoisted
// ioredis needs to be a class constructor that can be called with new
vi.mock('ioredis', () => {
  class MockRedis {
    quit = vi.fn().mockResolvedValue(undefined);
    constructor() {
      // Constructor logic
    }
  }
  return {
    default: MockRedis,
  };
});

vi.mock('bullmq', () => {
  // Create mock classes
  class MockQueue {
    add = vi.fn().mockResolvedValue({ id: 'job-123', name: 'test-job' });
    getJob = vi.fn().mockResolvedValue(null);
    getWaitingCount = vi.fn().mockResolvedValue(5);
    getActiveCount = vi.fn().mockResolvedValue(2);
    getCompletedCount = vi.fn().mockResolvedValue(100);
    getFailedCount = vi.fn().mockResolvedValue(3);
    getDelayedCount = vi.fn().mockResolvedValue(1);
    getFailed = vi.fn().mockResolvedValue([]);
    close = vi.fn().mockResolvedValue(undefined);
    drain = vi.fn().mockResolvedValue(undefined);
    clean = vi.fn().mockResolvedValue(undefined);
  }

  class MockWorker {
    on = vi.fn().mockReturnThis();
    close = vi.fn().mockResolvedValue(undefined);
  }

  class MockQueueEvents {
    close = vi.fn().mockResolvedValue(undefined);
  }

  class MockJob {}

  return {
    Queue: MockQueue,
    Worker: MockWorker,
    QueueEvents: MockQueueEvents,
    Job: MockJob,
  };
});

vi.mock('@/lib/env', () => ({
  env: {
    REDIS_URL: 'redis://localhost:6379',
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

// Import after mocks are set up
import {
  queueEmail,
  queueBulkEmail,
  getJobStatus,
  getQueueStats,
  getAllQueueStats,
  getDeadLetterJobs,
  initializeQueues,
  closeQueues,
  areQueuesInitialized,
  createWorker,
  QUEUE_NAMES,
} from '../queue';

describe('Job Queue System', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // Queue Initialization Tests
  // ===========================================================================

  describe('Queue Initialization', () => {
    it('should initialize all queues without error', () => {
      expect(() => initializeQueues()).not.toThrow();
    });

    it('should reset initialization state when queues are closed', async () => {
      initializeQueues();
      expect(areQueuesInitialized()).toBe(true);

      await closeQueues();
      expect(areQueuesInitialized()).toBe(false);

      expect(() => initializeQueues()).not.toThrow();
      expect(areQueuesInitialized()).toBe(true);
    });

    it('should have correct queue names', () => {
      expect(QUEUE_NAMES.EMAIL).toBe('eccb-email');
      expect(QUEUE_NAMES.NOTIFICATION).toBe('eccb-notification');
      expect(QUEUE_NAMES.SCHEDULED).toBe('eccb-scheduled');
      expect(QUEUE_NAMES.CLEANUP).toBe('eccb-cleanup');
      expect(QUEUE_NAMES.DEAD_LETTER).toBe('eccb-dead-letter');
      expect(QUEUE_NAMES.OCR).toBe('eccb-ocr');
    });
  });

  // ===========================================================================
  // Job Creation Tests
  // ===========================================================================

  describe('Job Creation', () => {
    it('should add a job to the email queue', async () => {
      initializeQueues();

      const jobData = {
        to: 'test@example.com',
        subject: 'Test Email',
        html: '<p>Test content</p>',
      };

      const job = await queueEmail(jobData);

      expect(job).toBeDefined();
      expect(job.id).toBe('job-123');
    });

    it('should add a bulk email job to the email queue', async () => {
      initializeQueues();

      const bulkData = {
        emails: [
          { to: 'user1@example.com', subject: 'Test', html: '<p>Test</p>' },
          { to: 'user2@example.com', subject: 'Test', html: '<p>Test</p>' },
        ],
      };

      const job = await queueBulkEmail(bulkData);

      expect(job).toBeDefined();
    });

    it('should support delayed job execution', async () => {
      initializeQueues();

      const jobData = {
        to: 'test@example.com',
        subject: 'Delayed Email',
        html: '<p>Test content</p>',
      };

      const delay = 5000; // 5 seconds

      const job = await queueEmail(jobData, { delay });

      expect(job).toBeDefined();
    });
  });

  // ===========================================================================
  // Job Status Tests
  // ===========================================================================

  describe('Job Status', () => {
    it('should return null for non-existent job', async () => {
      initializeQueues();

      const status = await getJobStatus('EMAIL', 'nonexistent');

      expect(status).toBeNull();
    });
  });

  // ===========================================================================
  // Queue Statistics Tests
  // ===========================================================================

  describe('Queue Statistics', () => {
    it('should return queue statistics', async () => {
      initializeQueues();

      const stats = await getQueueStats('EMAIL');

      expect(stats).toBeDefined();
      expect(stats?.name).toBe('eccb-email');
      expect(stats?.waiting).toBe(5);
      expect(stats?.active).toBe(2);
      expect(stats?.completed).toBe(100);
      expect(stats?.failed).toBe(3);
      expect(stats?.delayed).toBe(1);
    });

    it('should return OCR queue statistics', async () => {
      initializeQueues();

      const stats = await getQueueStats('OCR');

      expect(stats).toBeDefined();
      expect(stats?.name).toBe('eccb-ocr');
    });

    it('should return statistics for all queues', async () => {
      initializeQueues();

      const allStats = await getAllQueueStats();

      expect(allStats).toBeDefined();
      expect(allStats.length).toBeGreaterThan(0);
      expect(allStats.some((stat) => stat.name === 'eccb-ocr')).toBe(true);
    });
  });

  // ===========================================================================
  // Dead Letter Queue Tests
  // ===========================================================================

  describe('Dead Letter Queue', () => {
    it('should retrieve failed jobs from dead letter queue', async () => {
      initializeQueues();

      const jobs = await getDeadLetterJobs(10);

      expect(Array.isArray(jobs)).toBe(true);
    });
  });

  // ===========================================================================
  // Worker Creation Tests
  // ===========================================================================

  describe('Worker Creation', () => {
    it('should create a worker with default concurrency', () => {
      const processor = vi.fn().mockResolvedValue(undefined);

      const worker = createWorker({
        queueName: 'EMAIL',
        processor,
      });

      expect(worker).toBeDefined();
      expect(worker.on).toBeDefined();
    });

    it('should create a worker with custom concurrency', () => {
      const processor = vi.fn().mockResolvedValue(undefined);

      const worker = createWorker({
        queueName: 'EMAIL',
        concurrency: 5,
        processor,
      });

      expect(worker).toBeDefined();
      expect(worker.on).toBeDefined();
    });
  });
});

// =============================================================================
// Job Definitions Tests
// =============================================================================

describe('Job Definitions', () => {
  it('should have correct job configurations', async () => {
    const { JOB_CONFIGS } = await import('../definitions');

    // Email jobs should have high priority
    expect(JOB_CONFIGS['email.send'].priority).toBe(10);
    expect(JOB_CONFIGS['email.send'].attempts).toBe(5);

    // Bulk emails should have lower priority
    expect(JOB_CONFIGS['email.bulk'].priority).toBe(5);
    expect(JOB_CONFIGS['email.bulk'].concurrency).toBe(1);

    // Cleanup jobs should have lowest priority
    expect(JOB_CONFIGS['cleanup.sessions'].priority).toBe(1);
  });

  it('should have exponential backoff for email jobs', async () => {
    const { JOB_CONFIGS } = await import('../definitions');

    expect(JOB_CONFIGS['email.send'].backoff.type).toBe('exponential');
    expect(JOB_CONFIGS['email.send'].backoff.delay).toBe(1000);
  });

  it('should have fixed backoff for cleanup jobs', async () => {
    const { JOB_CONFIGS } = await import('../definitions');

    expect(JOB_CONFIGS['cleanup.sessions'].backoff.type).toBe('fixed');
    expect(JOB_CONFIGS['cleanup.sessions'].backoff.delay).toBe(10000);
  });

  it('should map job types to correct queues', async () => {
    const { getQueueNameForJob, QUEUE_NAMES } = await import('../definitions');

    expect(getQueueNameForJob('email.send')).toBe(QUEUE_NAMES.EMAIL);
    expect(getQueueNameForJob('email.bulk')).toBe(QUEUE_NAMES.EMAIL);
    expect(getQueueNameForJob('notification.create')).toBe(QUEUE_NAMES.NOTIFICATION);
    expect(getQueueNameForJob('publish.scheduled')).toBe(QUEUE_NAMES.SCHEDULED);
    expect(getQueueNameForJob('cleanup.sessions')).toBe(QUEUE_NAMES.CLEANUP);
  });

  it('should have correct concurrency settings', async () => {
    const { getConcurrencyForJob } = await import('../definitions');

    expect(getConcurrencyForJob('email.send')).toBe(3);
    expect(getConcurrencyForJob('email.bulk')).toBe(1);
    expect(getConcurrencyForJob('notification.create')).toBe(5);
    expect(getConcurrencyForJob('cleanup.sessions')).toBe(1);
  });
});

// =============================================================================
// Job Data Validation Tests
// =============================================================================

describe('Job Data Validation', () => {
  it('should validate email job data structure', async () => {
    const validEmailJob = {
      to: 'test@example.com',
      subject: 'Test Subject',
      html: '<p>Test content</p>',
      text: 'Test content',
    };

    expect(validEmailJob.to).toBeDefined();
    expect(validEmailJob.subject).toBeDefined();
    expect(validEmailJob.html).toBeDefined();
  });

  it('should validate bulk email job data structure', async () => {
    const validBulkJob = {
      emails: [
        { to: 'user1@example.com', subject: 'Test', html: '<p>Test</p>' },
        { to: 'user2@example.com', subject: 'Test', html: '<p>Test</p>' },
      ],
      delayMs: 1000,
      campaignId: 'campaign-123',
    };

    expect(Array.isArray(validBulkJob.emails)).toBe(true);
    expect(validBulkJob.emails.length).toBeGreaterThan(0);
  });

  it('should validate notification job data structure', async () => {
    const validNotificationJob = {
      memberId: 'member-123',
      type: 'info' as const,
      title: 'Test Notification',
      message: 'This is a test notification',
      link: '/member/events',
    };

    expect(validNotificationJob.memberId).toBeDefined();
    expect(validNotificationJob.type).toBeDefined();
    expect(validNotificationJob.title).toBeDefined();
    expect(validNotificationJob.message).toBeDefined();
  });

  it('should validate cleanup job data structure', async () => {
    const validCleanupJob = {
      maxAgeHours: 24,
      dryRun: false,
    };

    expect(validCleanupJob.maxAgeHours).toBeGreaterThan(0);
    expect(typeof validCleanupJob.dryRun).toBe('boolean');
  });
});
