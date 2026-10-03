/**
 * Stale Smart Upload session reaper
 *
 * A worker that dies without unwinding (OOM kill, SIGKILL during deploy) leaves a
 * session in PROCESSING forever: BullMQ drops the job and the processor's
 * try/catch never runs. The librarian then sees a permanent spinner. These tests
 * pin the time-based recovery that closes that hole.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSession } = vi.hoisted(() => ({
  mockSession: { findMany: vi.fn(), updateMany: vi.fn() },
}));

vi.mock('@/lib/db', () => ({
  prisma: { smartUploadSession: mockSession },
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  reapStaleSmartUploadSessions,
  SMART_UPLOAD_STALE_AFTER_MS,
} from '../scheduler';

beforeEach(() => {
  vi.clearAllMocks();
  mockSession.updateMany.mockResolvedValue({ count: 0 });
});

describe('reapStaleSmartUploadSessions', () => {
  it('moves an orphaned session to REQUIRES_REVIEW, not FAILED', async () => {
    mockSession.findMany.mockResolvedValue([
      { uploadSessionId: 'orphan-1', status: 'PROCESSING', updatedAt: new Date(0) },
    ]);
    mockSession.updateMany.mockResolvedValue({ count: 1 });

    const count = await reapStaleSmartUploadSessions();

    expect(count).toBe(1);
    const arg = mockSession.updateMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    // REQUIRES_REVIEW because nothing failed — the worker vanished — and that
    // is the state a human can act on.
    expect(arg.data.status).toBe('REQUIRES_REVIEW');
    expect(arg.data.requiresHumanReview).toBe(true);
    expect(arg.data.parseStatus).toBe('STALE_WORKER_TIMEOUT');
  });

  it('only considers sessions still in a non-terminal processing state', async () => {
    mockSession.findMany.mockResolvedValue([]);

    await reapStaleSmartUploadSessions();

    const where = mockSession.findMany.mock.calls[0][0] as {
      where: { status: { in: string[] }; updatedAt: { lt: Date } };
    };
    expect(where.where.status.in).toEqual(['PROCESSING', 'AUTO_COMMITTING']);
    // Committed sessions must never be dragged back into review.
    expect(where.where.status.in).not.toContain('AUTO_COMMITTED');
    expect(where.where.status.in).not.toContain('MANUALLY_APPROVED');
  });

  it('re-asserts the staleness predicate on the write', async () => {
    // A session that resumed between the read and the write must not be clobbered.
    mockSession.findMany.mockResolvedValue([
      { uploadSessionId: 'orphan-1', status: 'PROCESSING', updatedAt: new Date(0) },
    ]);
    mockSession.updateMany.mockResolvedValue({ count: 0 });

    const count = await reapStaleSmartUploadSessions();

    expect(count).toBe(0);
    const where = mockSession.updateMany.mock.calls[0][0] as {
      where: { updatedAt: { lt: Date } };
    };
    expect(where.where.updatedAt.lt).toBeInstanceOf(Date);
  });

  it('does nothing when no sessions are stale', async () => {
    mockSession.findMany.mockResolvedValue([]);

    await expect(reapStaleSmartUploadSessions()).resolves.toBe(0);
    expect(mockSession.updateMany).not.toHaveBeenCalled();
  });

  it('waits longer than the longest plausible legitimate run', () => {
    // Guards the constant against being "tuned" down to something that would
    // reap a session that is still genuinely being worked on.
    expect(SMART_UPLOAD_STALE_AFTER_MS).toBeGreaterThanOrEqual(30 * 60 * 1000);
  });
});