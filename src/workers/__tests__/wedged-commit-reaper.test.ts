/**
 * Wedged Smart Upload commit-lock reaper.
 *
 * `commitSmartUploadSession` takes a CAS lock: it only transitions
 * `commitStatus` from NOT_STARTED/FAILED/null to IN_PROGRESS. Every normal exit
 * releases it — but a SIGKILL in between strands it forever.
 *
 * That combination is guaranteed to happen here: `scripts/start.ts` escalates
 * to SIGKILL after SHUTDOWN_GRACE_MS (30s), while Smart Upload jobs are
 * documented as legitimately running for 30+ minutes. Before this reaper, every
 * subsequent commit matched zero rows on the CAS and threw "already being
 * committed by another process", with a manual database edit as the only
 * recovery.
 *
 * These tests pin the automatic release.
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
  reapWedgedSmartUploadCommits,
  SMART_UPLOAD_WEDGED_COMMIT_AFTER_MS,
} from '../scheduler';

beforeEach(() => {
  vi.clearAllMocks();
  mockSession.updateMany.mockResolvedValue({ count: 0 });
});

describe('reapWedgedSmartUploadCommits', () => {
  it('returns the number of released locks', async () => {
    mockSession.updateMany.mockResolvedValue({ count: 3 });
    await expect(reapWedgedSmartUploadCommits()).resolves.toBe(3);
  });

  it('resets a stranded lock to FAILED, not NOT_STARTED', async () => {
    await reapWedgedSmartUploadCommits();

    const arg = mockSession.updateMany.mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };

    // FAILED is an accepted CAS origin (the CAS accepts NOT_STARTED/FAILED/null),
    // so the next attempt proceeds. NOT_STARTED would also work but discards the
    // failure context the operator needs.
    expect(arg.data.commitStatus).toBe('FAILED');
    // An abandoned commit is not a clean bill of health: a human should look.
    expect(arg.data.requiresHumanReview).toBe(true);
  });

  it('only targets sessions whose commitStatus is IN_PROGRESS', async () => {
    await reapWedgedSmartUploadCommits();

    const arg = mockSession.updateMany.mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
    };
    expect(arg.where.commitStatus).toBe('IN_PROGRESS');
  });

  it('applies an age cutoff so a genuinely running commit is never clobbered', async () => {
    await reapWedgedSmartUploadCommits();

    const arg = mockSession.updateMany.mock.calls[0]?.[0] as {
      where: { updatedAt: { lt: Date } };
    };
    const cutoff = arg.where.updatedAt.lt.getTime();

    // The cutoff must sit in the past by the threshold — a commit in flight
    // touches updatedAt, so a recent timestamp protects it.
    const age = Date.now() - cutoff;
    expect(age).toBeGreaterThanOrEqual(SMART_UPLOAD_WEDGED_COMMIT_AFTER_MS - 5_000);
    expect(age).toBeLessThanOrEqual(SMART_UPLOAD_WEDGED_COMMIT_AFTER_MS + 5_000);
  });

  it('uses a threshold far longer than the stale-session reaper', () => {
    // If these were equal, releasing a wedged commit could race a session the
    // stale reaper was simultaneously moving to review.
    expect(SMART_UPLOAD_WEDGED_COMMIT_AFTER_MS).toBeGreaterThan(60 * 60 * 1000);
  });
});
