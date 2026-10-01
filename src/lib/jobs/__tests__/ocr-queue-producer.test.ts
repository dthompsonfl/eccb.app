import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The OCR queue had no producer.
 *
 * src/workers/index.ts has always called startOcrWorker(), so production ran a
 * BullMQ consumer and a Redis connection for the dedicated OCR queue that never
 * received a job — a repo-wide search for 'ocr.process' matched only the worker
 * file. These tests pin the producer to the contract the worker already
 * implements, so the queue cannot silently become orphaned again.
 */

const mockGetQueue = vi.fn();
const mockInitializeQueues = vi.fn();
const mockAdd = vi.fn();
const mockGetJob = vi.fn();
const mockLoggerInfo = vi.fn();

vi.mock('../queue', () => ({
  getQueue: (...a: unknown[]) => mockGetQueue(...a),
  initializeQueues: (...a: unknown[]) => mockInitializeQueues(...a),
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    info: (...a: unknown[]) => mockLoggerInfo(...a),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { queueOcrProcess, OCR_JOB_NAMES } from '../smart-upload';

describe('queueOcrProcess', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetQueue.mockReturnValue({ add: mockAdd, getJob: mockGetJob });
    mockGetJob.mockResolvedValue(null);
    mockAdd.mockResolvedValue({ id: 'ocr_process_session-1' });
  });

  it('initializes queues before enqueuing', async () => {
    await queueOcrProcess({ sessionId: 'session-1' });
    expect(mockInitializeQueues).toHaveBeenCalled();
  });

  it('targets the OCR queue, not the Smart Upload queue', async () => {
    await queueOcrProcess({ sessionId: 'session-1' });
    expect(mockGetQueue).toHaveBeenCalledWith('OCR');
  });

  it('uses the job name the OCR worker consumes', async () => {
    await queueOcrProcess({ sessionId: 'session-1' });
    expect(OCR_JOB_NAMES.PROCESS).toBe('ocr.process');
    expect(mockAdd).toHaveBeenCalledWith('ocr.process', expect.anything(), expect.anything());
  });

  it('passes the sessionId the worker reads', async () => {
    await queueOcrProcess({ sessionId: 'session-1' });
    const [, data] = mockAdd.mock.calls[0];
    expect(data).toMatchObject({ sessionId: 'session-1' });
  });

  it('forwards OCR option overrides', async () => {
    await queueOcrProcess({
      sessionId: 'session-1',
      options: { ocrEngine: 'tesseract', maxOcrPages: 5 },
    });
    const [, data] = mockAdd.mock.calls[0];
    expect(data.options).toMatchObject({ ocrEngine: 'tesseract', maxOcrPages: 5 });
  });

  it('carries overwriteExistingMetadata so a re-OCR cannot silently clobber edits', async () => {
    await queueOcrProcess({ sessionId: 'session-1', overwriteExistingMetadata: true });
    const [, data] = mockAdd.mock.calls[0];
    expect(data.overwriteExistingMetadata).toBe(true);
  });

  it('retries with exponential backoff', async () => {
    await queueOcrProcess({ sessionId: 'session-1' });
    const [, , opts] = mockAdd.mock.calls[0];
    expect(opts.attempts).toBeGreaterThanOrEqual(2);
    expect(opts.backoff.type).toBe('exponential');
  });

  it('derives a deterministic jobId so a job is not duplicated per session', async () => {
    await queueOcrProcess({ sessionId: 'session-1' });
    const [, , opts] = mockAdd.mock.calls[0];
    expect(opts.jobId).toBe('ocr_process_session-1');
  });

  it('replaces a still-pending job for the same session (idempotent re-request)', async () => {
    // Hold a direct reference: mock.results[0].value is the *promise* returned
    // by getJob, not the resolved job object.
    const existing = {
      getState: vi.fn().mockResolvedValue('waiting'),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    mockGetJob.mockResolvedValue(existing);

    await queueOcrProcess({ sessionId: 'session-1' });

    expect(existing.remove).toHaveBeenCalled();
    expect(mockAdd).toHaveBeenCalled();
  });

  it('does not remove a job that is already running', async () => {
    const existing = {
      getState: vi.fn().mockResolvedValue('active'),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    mockGetJob.mockResolvedValue(existing);

    await queueOcrProcess({ sessionId: 'session-1' });

    expect(existing.remove).not.toHaveBeenCalled();
    expect(mockAdd).toHaveBeenCalled();
  });

  it('throws a clear error when the queue is unavailable', async () => {
    mockGetQueue.mockReturnValue(undefined);
    await expect(queueOcrProcess({ sessionId: 'session-1' })).rejects.toThrow(
      /OCR queue not initialized/,
    );
  });

  it('never logs PDF content or OCR text', async () => {
    await queueOcrProcess({ sessionId: 'session-1' });
    const logged = JSON.stringify(mockLoggerInfo.mock.calls);
    expect(logged).toContain('session-1');
    // Only identifiers and the job id should be logged.
    expect(logged).not.toMatch(/%PDF|base64|ocrText/i);
  });
});
