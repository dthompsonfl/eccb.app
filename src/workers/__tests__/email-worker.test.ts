import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendEmailMock = vi.fn();
const createWorkerMock = vi.fn();
const closeMock = vi.fn().mockResolvedValue(undefined);

vi.mock('@/lib/email', () => ({
  sendEmail: (...args: any[]) => sendEmailMock(...args),
}));

vi.mock('@/lib/jobs/queue', () => ({
  createWorker: (...args: any[]) => createWorkerMock(...args),
}));

vi.mock('@/lib/jobs/definitions', () => ({
  JOB_CONFIGS: {
    'email.send': { concurrency: 2 },
    'email.bulk': { concurrency: 5 },
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

import {
  startEmailWorker,
  stopEmailWorker,
  isEmailWorkerRunning,
} from '../email-worker';

describe('email worker startup', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    closeMock.mockResolvedValue(undefined);
    createWorkerMock.mockReturnValue({ close: closeMock });
    sendEmailMock.mockResolvedValue({ success: true, method: 'test' });
    await stopEmailWorker();
  });

  it('starts a single worker for all email job types and is idempotent', async () => {
    startEmailWorker();
    startEmailWorker();

    expect(createWorkerMock).toHaveBeenCalledTimes(1);
    expect(isEmailWorkerRunning()).toBe(true);

    const [{ queueName, concurrency, processor }] = createWorkerMock.mock.calls[0] as [any];
    expect(queueName).toBe('EMAIL');
    expect(concurrency).toBe(5);

    const sendJob = {
      id: 'job-send',
      name: 'email.send',
      data: {
        to: 'member@example.com',
        subject: 'Hello',
        html: '<p>Hello</p>',
      },
      updateProgress: vi.fn().mockResolvedValue(undefined),
    };

    const bulkJob = {
      id: 'job-bulk',
      name: 'email.bulk',
      data: {
        emails: [
          { to: 'a@example.com', subject: 'A', html: '<p>A</p>' },
          { to: 'b@example.com', subject: 'B', html: '<p>B</p>' },
        ],
        delayMs: 0,
      },
      updateProgress: vi.fn().mockResolvedValue(undefined),
    };

    await expect(processor(sendJob)).resolves.toBeUndefined();
    await expect(processor(bulkJob)).resolves.toBeUndefined();

    expect(sendEmailMock).toHaveBeenCalledTimes(3);
  });

  it('throws for unknown job names instead of silently consuming them', async () => {
    startEmailWorker();

    const [{ processor }] = createWorkerMock.mock.calls[0] as [any];

    await expect(
      processor({
        id: 'job-unknown',
        name: 'email.other',
        data: {},
        updateProgress: vi.fn().mockResolvedValue(undefined),
      })
    ).rejects.toThrow('Unknown job type: email.other');
  });
});
