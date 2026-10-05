/**
 * Commit — page coverage against the REAL source page count
 *
 * The bug this file pins: the commit-time coverage gate derived its
 * `totalPages` from the union of the ranges the produced PARTS CLAIM
 * (`Math.max(...parts.map(p => p.pageRange[1]))`). Parts covering pages 1-8 of
 * a 20-page score therefore reported `totalPages = 8`,
 * `coversAllPagesExactlyOnce = true`, and the commit proceeded — pages 9-20
 * were invisible to the gate. Interior holes were caught; a truncated tail
 * was not.
 *
 * The fix proves coverage against `SmartUploadSession.sourcePageCount`, the
 * authoritative page count of the ORIGINAL PDF computed live by
 * `src/lib/services/pdf-source.ts` and persisted at the producing sites
 * (processor, second-pass worker, resplit route).
 *
 * Fail-closed: when `sourcePageCount` is NULL the true document length was
 * never recorded, so the split cannot be verified. The session is flagged
 * `requiresHumanReview` instead of the gate silently trusting the claimed
 * span — the same posture `smart-upload-worker.ts` already takes when the page
 * count is unavailable.
 *
 * Every commit entry point is exercised separately below (single approve
 * route, bulk approve route, and the autonomous AUTO_COMMIT job) because a
 * BYPASSED gate — not a wrong one — is the failure mode being closed, and all
 * three funnel through the same `commitSmartUploadSessionToLibrary` call.
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

// ---------------------------------------------------------------------------
// Prisma mock setup (must precede the imports below)
// ---------------------------------------------------------------------------
const mockTx = {
  person: { findFirst: vi.fn(), create: vi.fn() },
  publisher: { findUnique: vi.fn(), create: vi.fn() },
  musicPiece: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  musicFile: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  musicFileVersion: { count: vi.fn(), create: vi.fn() },
  musicPart: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), count: vi.fn() },
  instrument: { findFirst: vi.fn(), create: vi.fn() },
  smartUploadSession: { update: vi.fn() },
  musicAssignment: { findMany: vi.fn(async () => []), create: vi.fn(async () => ({ id: 'a1' })) },
  musicAssignmentHistory: { create: vi.fn(async () => ({})) },
};

vi.mock('@/lib/db', () => ({
  prisma: {
    smartUploadSession: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      updateMany: vi.fn(),
      update: vi.fn(),
    },
    musicFile: { findFirst: vi.fn() },
    musicPiece: { findUnique: vi.fn() },
    musicPart: { count: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock('@/lib/smart-upload/part-routing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/smart-upload/part-routing')>();
  return { ...actual, loadRoutingRoster: async () => [] };
});

vi.mock('@/lib/services/storage', () => ({
  deleteFile: vi.fn(async () => undefined),
  downloadFile: vi.fn(),
  uploadFile: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Entry-point scaffolding. The approve and bulk-approve routes and the
// autonomous worker are all imported for real; only their auth/storage/queue
// edges are mocked, so the coverage gate under test is the production one.
const mockGetSession = vi.hoisted(() => vi.fn());
const mockRequirePermission = vi.hoisted(() => vi.fn(async () => undefined));
const mockApplyRateLimit = vi.hoisted(() => vi.fn(async () => null));
const mockCreateWorker = vi.hoisted(() => vi.fn());

vi.mock('@/lib/auth/guards', () => ({ getSession: mockGetSession }));
vi.mock('@/lib/auth/permissions', () => ({ requirePermission: mockRequirePermission }));
vi.mock('@/lib/rate-limit', () => ({ applyRateLimit: mockApplyRateLimit }));
vi.mock('@/lib/csrf', () => ({ validateCSRF: vi.fn(() => ({ valid: true })) }));

// The worker module pulls in the whole pipeline at import time; stub those so
// this file exercises the AUTO_COMMIT branch and nothing else.
vi.mock('@/workers/smart-upload-processor', () => ({ processSmartUpload: vi.fn() }));
vi.mock('@/workers/smart-upload-worker', () => ({ processSecondPass: vi.fn() }));
vi.mock('@/lib/services/smart-upload-cleanup', () => ({
  cleanupSmartUploadTempFiles: vi.fn(async () => undefined),
}));
vi.mock('@/lib/smart-upload/runtime-config', () => ({
  loadSmartUploadRuntimeConfig: vi.fn(async () => ({ maxConcurrent: 1 })),
}));
vi.mock('@/lib/smart-upload/metrics', () => ({
  recordMetricSuccess: vi.fn(),
  recordMetricError: vi.fn(),
}));
vi.mock('@/lib/jobs/queue', () => ({ createWorker: mockCreateWorker }));

import { prisma } from '@/lib/db';
import { commitSmartUploadSessionToLibrary } from '../commit';
import { SMART_UPLOAD_JOB_NAMES } from '@/lib/jobs/smart-upload';
import { startSmartUploadProcessorWorker } from '@/workers/smart-upload-processor-worker';
import { POST as approvePost } from '@/app/api/admin/uploads/review/[id]/approve/route';
import { POST as bulkApprovePost } from '@/app/api/admin/uploads/review/bulk-approve/route';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const SESSION_ID = 'coverage-real-pages-session';

function part(
  partName: string,
  pageRange: [number, number],
): Record<string, unknown> {
  return {
    partName,
    instrument: partName,
    section: 'Brass',
    transposition: 'Bb',
    partNumber: 1,
    storageKey: `smart-upload/${SESSION_ID}/parts/${partName}.pdf`,
    fileName: `${partName}.pdf`,
    fileSize: 100,
    pageCount: pageRange[1] - pageRange[0] + 1,
    pageRange,
  };
}

/**
 * A session whose `sourcePageCount` is the authoritative page count of the
 * original PDF. `parsedParts` is serialized because the real column is LongText.
 */
function session(
  sourcePageCount: number | null,
  parsedParts: Record<string, unknown>[],
): Record<string, unknown> {
  return {
    uploadSessionId: SESSION_ID,
    fileName: 'march.pdf',
    fileSize: 4096,
    mimeType: 'application/pdf',
    storageKey: 'smart-upload/original.pdf',
    status: 'REQUIRES_REVIEW',
    commitStatus: 'NOT_STARTED',
    committedPieceId: null,
    committedFileId: null,
    requiresHumanReview: false,
    extractedMetadata: JSON.stringify({
      title: 'Semper Fidelis',
      composer: 'John Philip Sousa',
      confidenceScore: 92,
      fileType: 'FULL_SCORE',
    }),
    parsedParts: JSON.stringify(parsedParts),
    cuttingInstructions: null,
    tempFiles: '[]',
    sourceSha256: 'sha-1',
    routingDecision: null,
    sourcePageCount,
  };
}

function primeHappyPath() {
  vi.mocked(prisma.smartUploadSession.updateMany).mockResolvedValue({ count: 1 });
  vi.mocked(prisma.smartUploadSession.update).mockResolvedValue({ id: 'row' });
  vi.mocked(prisma.musicFile.findFirst).mockResolvedValue(null);
  vi.mocked(prisma.musicPart.count).mockResolvedValue(0);
  mockTx.person.findFirst.mockResolvedValue(null);
  mockTx.person.create.mockImplementation(async ({ data }: never) => ({
    id: 'person-1',
    ...(data as object),
  }));
  mockTx.publisher.findUnique.mockResolvedValue(null);
  mockTx.publisher.create.mockResolvedValue({ id: 'pub-1' });
  mockTx.musicPiece.findFirst.mockResolvedValue(null);
  mockTx.musicPiece.create.mockResolvedValue({ id: 'piece-1', title: 'Semper Fidelis' });
  mockTx.musicPiece.update.mockResolvedValue({ id: 'piece-1', title: 'Semper Fidelis' });
  mockTx.musicFile.create.mockResolvedValue({ id: 'file-1' });
  mockTx.musicFile.update.mockResolvedValue({ id: 'file-1' });
  mockTx.musicFileVersion.count.mockResolvedValue(0);
  mockTx.musicFileVersion.create.mockResolvedValue({ id: 'ver-1' });
  mockTx.musicPart.findFirst.mockResolvedValue(null);
  mockTx.musicPart.create.mockResolvedValue({ id: 'part-1' });
  mockTx.musicPart.update.mockResolvedValue({ id: 'part-1' });
  mockTx.instrument.findFirst.mockResolvedValue(null);
  mockTx.instrument.create.mockResolvedValue({ id: 'instr-1' });
  mockTx.smartUploadSession.update.mockResolvedValue({});
  mockTx.musicAssignment.findMany.mockResolvedValue([]);
  mockTx.musicAssignment.create.mockResolvedValue({ id: 'assign-1' });
  mockTx.musicAssignmentHistory.create.mockResolvedValue({});
  vi.mocked(prisma.$transaction).mockImplementation(
    async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  primeHappyPath();
  mockGetSession.mockResolvedValue({ user: { id: 'admin-user-1' } });
  mockRequirePermission.mockResolvedValue(undefined);
  mockApplyRateLimit.mockResolvedValue(null);
});

// ---------------------------------------------------------------------------
// The defect, pinned directly against the commit service
// ---------------------------------------------------------------------------
describe('commit — coverage proven against the REAL source page count', () => {
  it('BLOCKS a truncated tail: 20-page score, parts claim only 1-8', async () => {
    // The exact scenario the old gate was blind to. It computed
    // totalPages = max(pageRange[1]) = 8, so pages 9-20 never existed as far
    // as the gate was concerned and the commit proceeded with 12 pages of
    // music missing from the library.
    vi.mocked(prisma.smartUploadSession.findUnique).mockResolvedValue(
      session(20, [part('Trumpet 1', [1, 4]), part('Trombone 1', [5, 8])]) as never,
    );

    await expect(commitSmartUploadSessionToLibrary(SESSION_ID)).rejects.toThrow(
      /Cannot commit/,
    );
    // The transaction must never open: nothing reaches the library.
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(mockTx.musicPart.create).not.toHaveBeenCalled();
  });

  it('names the missing tail pages in the failure, so the reviewer can see them', async () => {
    vi.mocked(prisma.smartUploadSession.findUnique).mockResolvedValue(
      session(20, [part('Trumpet 1', [1, 8])]) as never,
    );

    await expect(commitSmartUploadSessionToLibrary(SESSION_ID)).rejects.toThrow(
      /12 page\(s\) in no part: \[9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20\]/,
    );
  });

  it('ALLOWS a split that tiles all 20 real pages exactly once', async () => {
    vi.mocked(prisma.smartUploadSession.findUnique).mockResolvedValue(
      session(20, [part('Trumpet 1', [1, 10]), part('Trombone 1', [11, 20])]) as never,
    );

    const result = await commitSmartUploadSessionToLibrary(SESSION_ID);

    expect(result.wasIdempotent).toBe(false);
    expect(result.partsCommitted).toBe(2);
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it('BLOCKS a 10-page score whose parts stop at 8 (2 pages missing)', async () => {
    vi.mocked(prisma.smartUploadSession.findUnique).mockResolvedValue(
      session(10, [part('Trumpet 1', [1, 4]), part('Trombone 1', [5, 8])]) as never,
    );

    await expect(commitSmartUploadSessionToLibrary(SESSION_ID)).rejects.toThrow(
      /2 page\(s\) in no part: \[9, 10\]/,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('still BLOCKS an interior hole when the real count agrees with the span', async () => {
    // Regression guard: switching to the real count must not lose the property
    // the old gate was actually good at.
    vi.mocked(prisma.smartUploadSession.findUnique).mockResolvedValue(
      session(8, [part('Trumpet 1', [1, 2]), part('Trombone 1', [4, 8])]) as never,
    );

    await expect(commitSmartUploadSessionToLibrary(SESSION_ID)).rejects.toThrow(
      /more than one part|1 page\(s\) in no part/,
    );
  });

  it('still BLOCKS a duplicated page when the real count agrees with the span', async () => {
    vi.mocked(prisma.smartUploadSession.findUnique).mockResolvedValue(
      session(8, [part('Trumpet 1', [1, 5]), part('Trombone 1', [5, 8])]) as never,
    );

    await expect(commitSmartUploadSessionToLibrary(SESSION_ID)).rejects.toThrow(
      /more than one part/,
    );
  });

  it('FAILS CLOSED when sourcePageCount is null — forces human review, never silent trust', async () => {
    // The count was never recorded, so the split cannot be verified. The gate
    // still runs the interior contiguity check (so a hole is still a hole), but
    // it must not present an unverifiable split as verified.
    vi.mocked(prisma.smartUploadSession.findUnique).mockResolvedValue(
      session(null, [part('Trumpet 1', [1, 4]), part('Trombone 1', [5, 8])]) as never,
    );

    await commitSmartUploadSessionToLibrary(SESSION_ID);

    expect(mockTx.smartUploadSession.update).toHaveBeenCalledWith({
      where: { uploadSessionId: SESSION_ID },
      data: expect.objectContaining({ requiresHumanReview: true }),
    });
  });

  it('FAILS CLOSED on null count even when the parts tile their claimed span', async () => {
    // This is precisely the silent-trust case: coverage "passes" against the
    // claimed span, and without the fail-closed flag nothing would record that
    // the pass was unverified.
    vi.mocked(prisma.smartUploadSession.findUnique).mockResolvedValue(
      session(null, [part('Trumpet 1', [1, 4]), part('Trombone 1', [5, 8])]) as never,
    );

    await commitSmartUploadSessionToLibrary(SESSION_ID);

    expect(mockTx.smartUploadSession.update).toHaveBeenCalledWith({
      where: { uploadSessionId: SESSION_ID },
      data: expect.objectContaining({ requiresHumanReview: true }),
    });
  });

  it('does NOT flag human review when the real count is recorded and coverage is complete', async () => {
    vi.mocked(prisma.smartUploadSession.findUnique).mockResolvedValue(
      session(8, [part('Trumpet 1', [1, 4]), part('Trombone 1', [5, 8])]) as never,
    );

    await commitSmartUploadSessionToLibrary(SESSION_ID);

    const update = mockTx.smartUploadSession.update.mock.calls.at(-1)?.[0] as {
      data: Record<string, unknown>;
    };
    expect(update.data.requiresHumanReview).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Entry point 1 — single approve route
// ---------------------------------------------------------------------------
describe('entry point: /api/admin/uploads/review/[id]/approve', () => {
  function approveRequest() {
    return new Request('http://localhost/api/admin/uploads/review/x/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Semper Fidelis' }),
    }) as never;
  }

  it('rejects a manual approve of a truncated split — a human click is not a licence', async () => {
    vi.mocked(prisma.smartUploadSession.findUnique).mockResolvedValue(
      session(20, [part('Trumpet 1', [1, 4]), part('Trombone 1', [5, 8])]) as never,
    );

    const res = await approvePost(approveRequest(), {
      params: Promise.resolve({ id: SESSION_ID }),
    });

    expect(res.status).toBe(500);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('commits a fully covered split through the same route', async () => {
    vi.mocked(prisma.smartUploadSession.findUnique).mockResolvedValue(
      session(20, [part('Trumpet 1', [1, 10]), part('Trombone 1', [11, 20])]) as never,
    );

    const res = await approvePost(approveRequest(), {
      params: Promise.resolve({ id: SESSION_ID }),
    });

    expect(res.status).toBe(200);
    expect(prisma.$transaction).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Entry point 2 — bulk approve route
// ---------------------------------------------------------------------------
describe('entry point: /api/admin/uploads/review/bulk-approve', () => {
  function bulkRequest() {
    return new Request('http://localhost/api/admin/uploads/review/bulk-approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionIds: [SESSION_ID] }),
    }) as never;
  }

  it('skips a truncated split instead of bulk-importing it', async () => {
    vi.mocked(prisma.smartUploadSession.findMany).mockResolvedValue([
      {
        uploadSessionId: SESSION_ID,
        extractedMetadata: JSON.stringify({ title: 'Semper Fidelis' }),
      },
    ] as never);
    vi.mocked(prisma.smartUploadSession.findUnique).mockResolvedValue(
      session(20, [part('Trumpet 1', [1, 4]), part('Trombone 1', [5, 8])]) as never,
    );

    const res = await bulkApprovePost(bulkRequest());
    const body = (await res.json()) as {
      approved: number;
      skippedDetails: Array<{ id: string; reason: string }>;
    };

    expect(body.approved).toBe(0);
    expect(body.skippedDetails[0].id).toBe(SESSION_ID);
    expect(body.skippedDetails[0].reason).toMatch(/Cannot commit/);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('bulk-commits a fully covered split', async () => {
    vi.mocked(prisma.smartUploadSession.findMany).mockResolvedValue([
      {
        uploadSessionId: SESSION_ID,
        extractedMetadata: JSON.stringify({ title: 'Semper Fidelis' }),
      },
    ] as never);
    vi.mocked(prisma.smartUploadSession.findUnique).mockResolvedValue(
      session(20, [part('Trumpet 1', [1, 10]), part('Trombone 1', [11, 20])]) as never,
    );

    const res = await bulkApprovePost(bulkRequest());
    const body = (await res.json()) as { approved: number };

    expect(body.approved).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Entry point 3 — autonomous AUTO_COMMIT job
// ---------------------------------------------------------------------------
describe('entry point: autonomous smartupload_autoCommit job', () => {
  // The worker module memoizes its instance in a module-level variable, so it
  // can only be started once per module registry. Start it once and reuse the
  // captured handler across both tests.
  let processor: ((job: unknown) => Promise<unknown>) | undefined;
  beforeAll(async () => {
    mockCreateWorker.mockImplementation((opts: { processor: (job: unknown) => Promise<unknown> }) => {
      processor = opts.processor;
      return { close: vi.fn(async () => undefined) };
    });
    await startSmartUploadProcessorWorker();
  });

  function autoCommitJob() {
    return {
      name: SMART_UPLOAD_JOB_NAMES.AUTO_COMMIT,
      data: { sessionId: SESSION_ID },
      id: 'job-1',
      attemptsMade: 0,
      opts: { attempts: 1 },
    };
  }

  it('refuses to auto-commit a truncated split', async () => {
    vi.mocked(prisma.smartUploadSession.findUnique).mockResolvedValue(
      session(20, [part('Trumpet 1', [1, 4]), part('Trombone 1', [5, 8])]) as never,
    );
    await expect(processor?.(autoCommitJob())).rejects.toThrow(/Cannot commit/);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('auto-commits a fully covered split', async () => {
    vi.mocked(prisma.smartUploadSession.findUnique).mockResolvedValue(
      session(20, [part('Trumpet 1', [1, 10]), part('Trombone 1', [11, 20])]) as never,
    );
    await expect(processor?.(autoCommitJob())).resolves.toEqual({
      status: 'auto_commit_complete',
      sessionId: SESSION_ID,
    });
  });
});
