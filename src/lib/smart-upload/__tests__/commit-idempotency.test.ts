/**
 * Commit — Idempotency and CAS Locking Tests
 *
 * These tests verify that:
 *   1. Concurrent commits are prevented by CAS-style optimistic locking
 *   2. Duplicate commit attempts return idempotent results without DB mutation
 *   3. Transaction failures properly set FAILED status and persist errors
 *   4. State transitions follow the valid commit lifecycle
 *   5. Race conditions are handled gracefully (P2002 unique constraint errors)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Prisma mock setup (before imports)
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
  // Commit now routes parts to members; these are the collaborators that
  // make the assignment rows land.
  musicAssignment: { findMany: vi.fn(async () => []), create: vi.fn(async () => ({ id: 'assign-1' })) },
  musicAssignmentHistory: { create: vi.fn(async () => ({})) },
};

vi.mock('@/lib/db', () => ({
  prisma: {
    smartUploadSession: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      update: vi.fn(),
    },
    musicFile: { findFirst: vi.fn() },
    musicPiece: { findUnique: vi.fn() },
    musicPart: { count: vi.fn() },
    $transaction: vi.fn(),
  },
}));

// Routing reads the active roster. Default to an empty band so the existing
// commit assertions are unaffected; routing itself is covered in
// __tests__/part-routing.test.ts and commit-routing.test.ts.
vi.mock('@/lib/smart-upload/part-routing', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('@/lib/smart-upload/part-routing')
  >();
  return {
    ...actual,
    loadRoutingRoster: async () => [],
  };
});

vi.mock('@/lib/services/storage', () => ({
  deleteFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';
import { commitSmartUploadSessionToLibrary } from '../commit';

// ---------------------------------------------------------------------------
// Test Constants
// ---------------------------------------------------------------------------
const SESSION_ID = 'test-session-abc';
const PIECE_ID = 'piece-existing-123';
const FILE_ID = 'file-existing-456';

const BASE_SESSION = {
  uploadSessionId: SESSION_ID,
  fileName: 'test.pdf',
  fileSize: 1024,
  mimeType: 'application/pdf',
  storageKey: 'smart-upload/test-session-abc/original.pdf',
  status: 'PENDING_REVIEW',
  extractedMetadata: {
    title: 'Semper Fidelis',
    composer: 'John Philip Sousa',
    arranger: 'Frank Erickson',
    confidenceScore: 75,
    fileType: 'FULL_SCORE',
  },
  parsedParts: [],
  cuttingInstructions: null,
  tempFiles: [],
  sourceSha256: 'abc123def456',
  reviewedAt: null,
  committedAt: null,
  commitStatus: 'NOT_STARTED',
  committedPieceId: null,
  committedFileId: null,
  commitError: null,
  commitAttempts: 0,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function createSession(overrides = {}) {
  return { ...BASE_SESSION, ...overrides };
}

function setupTransactionSuccess() {
  mockTx.person.findFirst.mockResolvedValue(null);
  mockTx.person.create.mockImplementation(({ data }: { data: { fullName: string } }) =>
    Promise.resolve({ id: `person-${data.fullName}`, ...data })
  );
  mockTx.publisher.findUnique.mockResolvedValue(null);
  mockTx.publisher.create.mockImplementation(({ data }: { data: { name: string } }) =>
    Promise.resolve({ id: `pub-${data.name}`, ...data })
  );
  mockTx.musicPiece.findFirst.mockResolvedValue(null);
  mockTx.musicPiece.create.mockResolvedValue({ id: 'new-piece-789', title: 'Semper Fidelis' });
  mockTx.musicPiece.update.mockResolvedValue({ id: PIECE_ID, title: 'Semper Fidelis' });
  mockTx.musicFile.findFirst.mockResolvedValue(null);
  mockTx.musicFile.create.mockResolvedValue({ id: 'new-file-id' });
  mockTx.musicFile.update.mockResolvedValue({ id: FILE_ID });
  mockTx.musicFileVersion.count.mockResolvedValue(0);
  mockTx.musicFileVersion.create.mockResolvedValue({ id: 'ver-1' });
  mockTx.musicPart.findFirst.mockResolvedValue(null);
  mockTx.musicPart.create.mockResolvedValue({ id: 'new-part-id' });
  mockTx.musicPart.update.mockResolvedValue({ id: 'updated-part-id' });
  mockTx.musicPart.count.mockResolvedValue(0);
  mockTx.instrument.findFirst.mockResolvedValue(null);
  mockTx.instrument.create.mockImplementation(({ data }: { data: { name: string } }) =>
    Promise.resolve({ id: `inst-${data.name}`, ...data })
  );
  mockTx.smartUploadSession.update.mockResolvedValue({ id: SESSION_ID });

  // Set up transaction to execute the callback with mockTx
  vi.mocked(prisma.$transaction).mockImplementation(async (fn) => fn(mockTx));
}

// ---------------------------------------------------------------------------
// Setup and Teardown
// ---------------------------------------------------------------------------
beforeEach(() => {
  vi.resetAllMocks();
  setupTransactionSuccess();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// CAS Locking Tests
// ---------------------------------------------------------------------------
describe('CAS Locking — Concurrent Commit Prevention', () => {
  it('acquires lock by transitioning from NOT_STARTED to IN_PROGRESS', async () => {
    vi.mocked(prisma.smartUploadSession.findUnique).mockResolvedValue(createSession() as any);
    vi.mocked(prisma.smartUploadSession.updateMany).mockResolvedValue({ count: 1 } as any);

    await commitSmartUploadSessionToLibrary(SESSION_ID);

    expect(prisma.smartUploadSession.updateMany).toHaveBeenCalledWith({
      where: {
        uploadSessionId: SESSION_ID,
        OR: [
          { commitStatus: { in: ['NOT_STARTED', 'FAILED'] } },
          { commitStatus: null },
        ],
      },
      data: {
        commitStatus: 'IN_PROGRESS',
        commitAttempts: { increment: 1 },
        commitError: null,
      },
    });
  });

  it('returns existing commit result when another process completed during wait', async () => {
    // CAS fails first
    vi.mocked(prisma.smartUploadSession.updateMany).mockResolvedValueOnce({ count: 0 } as any);
    
    // Then findUnique returns COMPLETE session
    vi.mocked(prisma.smartUploadSession.findUnique)
      .mockResolvedValueOnce(createSession({
        commitStatus: 'COMPLETE',
        committedPieceId: PIECE_ID,
        committedFileId: FILE_ID,
      }) as any)
      .mockResolvedValueOnce({ id: PIECE_ID, title: 'Existing Piece' } as any);
    
    vi.mocked(prisma.musicPiece.findUnique).mockResolvedValue({ id: PIECE_ID, title: 'Existing Piece' } as any);
    vi.mocked(prisma.musicPart.count).mockResolvedValue(5);

    const result = await commitSmartUploadSessionToLibrary(SESSION_ID);

    expect(result.wasIdempotent).toBe(true);
    expect(result.musicPieceId).toBe(PIECE_ID);
    expect(result.musicPieceTitle).toBe('Existing Piece');
    expect(mockTx.musicPiece.create).not.toHaveBeenCalled();
  });

  it('waits and retries when CAS fails but commit completes during wait', async () => {
    // CAS fails
    vi.mocked(prisma.smartUploadSession.updateMany).mockResolvedValueOnce({ count: 0 } as any);
    
    // First findUnique shows IN_PROGRESS, second shows COMPLETE after wait
    vi.mocked(prisma.smartUploadSession.findUnique)
      .mockResolvedValueOnce(createSession({ commitStatus: 'IN_PROGRESS' }) as any)
      .mockResolvedValueOnce(createSession({ 
        commitStatus: 'COMPLETE',
        committedPieceId: PIECE_ID,
        committedFileId: FILE_ID,
      }) as any);
    
    vi.mocked(prisma.musicPiece.findUnique).mockResolvedValue({ 
      id: PIECE_ID, 
      title: 'Race-Resolved Piece' 
    } as any);
    vi.mocked(prisma.musicPart.count).mockResolvedValue(3);

    const result = await commitSmartUploadSessionToLibrary(SESSION_ID);

    expect(result.wasIdempotent).toBe(true);
    expect(result.musicPieceTitle).toBe('Race-Resolved Piece');
  });

  it('reports a stranded IN_PROGRESS lock as wedged, not as a concurrent commit', async () => {
    // CAS fails
    vi.mocked(prisma.smartUploadSession.updateMany).mockResolvedValueOnce({ count: 0 } as any);

    // Both checks show IN_PROGRESS
    vi.mocked(prisma.smartUploadSession.findUnique)
      .mockResolvedValue(createSession({ commitStatus: 'IN_PROGRESS' }) as any);

    // The message distinguishes a lock stranded by a dead worker from a genuine
    // concurrent commit. The old wording said only "already being committed by
    // another process", which sent operators hunting for a concurrency bug that
    // did not exist — the real cause is a SIGKILL mid-commit, now released
    // automatically by reapWedgedSmartUploadCommits.
    await expect(commitSmartUploadSessionToLibrary(SESSION_ID)).rejects.toThrow(
      /stranded in IN_PROGRESS/,
    );
    await expect(commitSmartUploadSessionToLibrary(SESSION_ID)).rejects.not.toThrow(
      /already being committed by another process/,
    );
  });

  it('reports a genuine concurrent commit with the concurrent wording', async () => {
    // A CAS miss where the row is NOT IN_PROGRESS is a real race, and must keep
    // the original message so the two cases stay distinguishable in logs.
    vi.mocked(prisma.smartUploadSession.updateMany).mockResolvedValueOnce({ count: 0 } as any);
    vi.mocked(prisma.smartUploadSession.findUnique)
      .mockResolvedValue(createSession({ commitStatus: 'NOT_STARTED' }) as any);

    await expect(commitSmartUploadSessionToLibrary(SESSION_ID)).rejects.toThrow(
      /already being committed by another process/,
    );
  });

  it('allows retry from FAILED state', async () => {
    vi.mocked(prisma.smartUploadSession.findUnique).mockResolvedValue(
      createSession({ commitStatus: 'FAILED', commitError: 'Previous error' }) as any
    );
    vi.mocked(prisma.smartUploadSession.updateMany).mockResolvedValue({ count: 1 } as any);

    await commitSmartUploadSessionToLibrary(SESSION_ID);

    expect(prisma.smartUploadSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            { commitStatus: { in: ['NOT_STARTED', 'FAILED'] } },
          ]),
        }),
      })
    );
  });

  it('allows retry from null commitStatus', async () => {
    vi.mocked(prisma.smartUploadSession.findUnique).mockResolvedValue(
      createSession({ commitStatus: null }) as any
    );
    vi.mocked(prisma.smartUploadSession.updateMany).mockResolvedValue({ count: 1 } as any);

    await commitSmartUploadSessionToLibrary(SESSION_ID);

    expect(prisma.smartUploadSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            { commitStatus: null },
          ]),
        }),
      })
    );
  });
});

// ---------------------------------------------------------------------------
// Idempotency Tests
// ---------------------------------------------------------------------------
describe('Idempotency — Duplicate Commit Handling', () => {
  it('returns idempotent result when session already marked COMPLETE', async () => {
    vi.mocked(prisma.smartUploadSession.findUnique).mockResolvedValue(
      createSession({
        commitStatus: 'COMPLETE',
        committedPieceId: PIECE_ID,
        committedFileId: FILE_ID,
      }) as any
    );
    vi.mocked(prisma.musicPiece.findUnique).mockResolvedValue({
      id: PIECE_ID,
      title: 'Already Committed Piece',
    } as any);
    vi.mocked(prisma.musicPart.count).mockResolvedValue(10);

    const result = await commitSmartUploadSessionToLibrary(SESSION_ID);

    expect(result.wasIdempotent).toBe(true);
    expect(result.musicPieceId).toBe(PIECE_ID);
    expect(result.musicPieceTitle).toBe('Already Committed Piece');
    expect(result.partsCommitted).toBe(10);
    expect(mockTx.musicPiece.create).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      'Commit idempotency: session already marked committed',
      { sessionId: SESSION_ID }
    );
  });

  it('returns idempotent result via existing file lookup', async () => {
    vi.mocked(prisma.smartUploadSession.findUnique).mockResolvedValue(
      createSession({ commitStatus: 'NOT_STARTED' }) as any
    );
    vi.mocked(prisma.musicFile.findFirst).mockResolvedValue({
      id: FILE_ID,
      pieceId: PIECE_ID,
      piece: { id: PIECE_ID, title: 'File-Lookup Piece' },
    } as any);
    vi.mocked(prisma.musicPart.count).mockResolvedValue(7);
    vi.mocked(prisma.smartUploadSession.update).mockResolvedValue({ id: SESSION_ID } as any);

    const result = await commitSmartUploadSessionToLibrary(SESSION_ID);

    expect(result.wasIdempotent).toBe(true);
    expect(result.musicPieceTitle).toBe('File-Lookup Piece');
    // The code also flags the session for human review on commit failure,
    // so assert the fields that matter rather than an exact object.
    expect(prisma.smartUploadSession.update).toHaveBeenCalledWith({
      where: { uploadSessionId: SESSION_ID },
      data: expect.objectContaining({
        status: 'AUTO_COMMITTED',
        commitStatus: 'COMPLETE',
        committedPieceId: PIECE_ID,
        committedFileId: FILE_ID,
      }),
    });
  });

  it('returns non-idempotent result for fresh commit', async () => {
    vi.mocked(prisma.smartUploadSession.findUnique).mockResolvedValue(createSession() as any);
    vi.mocked(prisma.smartUploadSession.updateMany).mockResolvedValue({ count: 1 } as any);

    const result = await commitSmartUploadSessionToLibrary(SESSION_ID);

    expect(result.wasIdempotent).toBe(false);
    expect(result.musicPieceId).toBe('new-piece-789');
  });

  it('populates all commit fields on successful retry', async () => {
    vi.mocked(prisma.smartUploadSession.findUnique).mockResolvedValue(
      createSession({
        commitStatus: 'COMPLETE',
        committedPieceId: PIECE_ID,
        committedFileId: FILE_ID,
        committedAt: new Date('2024-01-15'),
        reviewedAt: new Date('2024-01-15'),
        reviewedBy: 'test-user',
      }) as any
    );
    vi.mocked(prisma.musicPiece.findUnique).mockResolvedValue({
      id: PIECE_ID,
      title: 'Complete Piece',
    } as any);
    vi.mocked(prisma.musicPart.count).mockResolvedValue(12);

    const result = await commitSmartUploadSessionToLibrary(SESSION_ID);

    expect(result.musicPieceId).toBe(PIECE_ID);
    expect(result.musicPieceTitle).toBe('Complete Piece');
    expect(result.musicFileId).toBe(FILE_ID);
    expect(result.sessionId).toBe(SESSION_ID);
    expect(result.partsCommitted).toBe(12);
    expect(result.wasIdempotent).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Race Condition Recovery Tests
// ---------------------------------------------------------------------------
describe('Race Condition — P2002 Unique Constraint Recovery', () => {
  it('recovers from P2002 error when another process completed commit', async () => {
    vi.mocked(prisma.smartUploadSession.findUnique)
      .mockResolvedValueOnce(createSession() as any)
      .mockResolvedValueOnce(createSession({
        commitStatus: 'COMPLETE',
        committedPieceId: PIECE_ID,
        committedFileId: FILE_ID,
      }) as any);
    vi.mocked(prisma.smartUploadSession.updateMany).mockResolvedValue({ count: 1 } as any);
    
    const p2002Error = new Error('Unique constraint failed');
    (p2002Error as any).code = 'P2002';
    vi.mocked(prisma.$transaction).mockRejectedValueOnce(p2002Error);
    
    vi.mocked(prisma.musicPiece.findUnique).mockResolvedValue({
      id: PIECE_ID,
      title: 'Race-Recovered Piece',
    } as any);
    vi.mocked(prisma.musicPart.count).mockResolvedValue(8);

    const result = await commitSmartUploadSessionToLibrary(SESSION_ID);

    expect(result.wasIdempotent).toBe(true);
    expect(result.musicPieceTitle).toBe('Race-Recovered Piece');
    expect(logger.info).toHaveBeenCalledWith(
      'Commit idempotency: race condition resolved, commit already complete',
      { sessionId: SESSION_ID }
    );
  });

  it('propagates P2002 error when commit is not complete', async () => {
    vi.mocked(prisma.smartUploadSession.findUnique).mockResolvedValue(createSession() as any);
    vi.mocked(prisma.smartUploadSession.updateMany).mockResolvedValue({ count: 1 } as any);
    
    const p2002Error = new Error('Unique constraint failed');
    (p2002Error as any).code = 'P2002';
    vi.mocked(prisma.$transaction).mockRejectedValueOnce(p2002Error);
    
    // After P2002, still shows IN_PROGRESS
    vi.mocked(prisma.smartUploadSession.findUnique).mockResolvedValueOnce(
      createSession({ commitStatus: 'IN_PROGRESS' }) as any
    );
    vi.mocked(prisma.smartUploadSession.update).mockResolvedValue({ id: SESSION_ID } as any);

    await expect(commitSmartUploadSessionToLibrary(SESSION_ID)).rejects.toThrow('Commit failed');

    // On a P2002 unique-constraint failure the session is marked FAILED *and*
    // flagged for human review so it is never left looking auto-committable.
    // The previous assertion used an exact object with only two fields, so it
    // broke when that safe-fail behaviour was added.
    // The code also flags the session for human review on commit failure,
    // so assert the fields that matter rather than an exact object.
    expect(prisma.smartUploadSession.update).toHaveBeenCalledWith({
      where: { uploadSessionId: SESSION_ID },
      data: expect.objectContaining({
        commitStatus: 'FAILED',
        commitError: expect.stringContaining('Unique constraint failed'),
        requiresHumanReview: true,
        status: 'FAILED',
      }),
    });
  });
});

// ---------------------------------------------------------------------------
// Transaction Failure Tests
// ---------------------------------------------------------------------------
describe('Transaction Failure — Error Handling', () => {
  it('sets FAILED status on transaction error', async () => {
    const transactionError = new Error('Database connection lost');
    vi.mocked(prisma.smartUploadSession.findUnique).mockResolvedValue(createSession() as any);
    vi.mocked(prisma.smartUploadSession.updateMany).mockResolvedValue({ count: 1 } as any);
    vi.mocked(prisma.$transaction).mockRejectedValueOnce(transactionError);
    vi.mocked(prisma.smartUploadSession.update).mockResolvedValue({ id: SESSION_ID } as any);

    await expect(commitSmartUploadSessionToLibrary(SESSION_ID)).rejects.toThrow('Commit failed');

    // The code also flags the session for human review on commit failure,
    // so assert the fields that matter rather than an exact object.
    expect(prisma.smartUploadSession.update).toHaveBeenCalledWith({
      where: { uploadSessionId: SESSION_ID },
      data: expect.objectContaining({
        commitStatus: 'FAILED',
        commitError: 'Database connection lost',
        requiresHumanReview: true,
        status: 'FAILED',
      }),
    });
  });

  it('sanitizes error messages to 500 characters', async () => {
    const longError = 'A'.repeat(1000);
    vi.mocked(prisma.smartUploadSession.findUnique).mockResolvedValue(createSession() as any);
    vi.mocked(prisma.smartUploadSession.updateMany).mockResolvedValue({ count: 1 } as any);
    vi.mocked(prisma.$transaction).mockRejectedValueOnce(new Error(longError));
    vi.mocked(prisma.smartUploadSession.update).mockResolvedValue({ id: SESSION_ID } as any);

    await expect(commitSmartUploadSessionToLibrary(SESSION_ID)).rejects.toThrow();

    const updateCall = vi.mocked(prisma.smartUploadSession.update).mock.calls[0][0] as {
      data: { commitError: string };
    };
    expect(updateCall.data.commitError.length).toBeLessThanOrEqual(500);
  });

  it('logs error with context on transaction failure', async () => {
    const error = new Error('Constraint violation');
    (error as any).code = 'P2025';
    vi.mocked(prisma.smartUploadSession.findUnique).mockResolvedValue(createSession() as any);
    vi.mocked(prisma.smartUploadSession.updateMany).mockResolvedValue({ count: 1 } as any);
    vi.mocked(prisma.$transaction).mockRejectedValueOnce(error);
    vi.mocked(prisma.smartUploadSession.update).mockResolvedValue({ id: SESSION_ID } as any);

    await expect(commitSmartUploadSessionToLibrary(SESSION_ID)).rejects.toThrow();

    expect(logger.error).toHaveBeenCalledWith(
      'Commit transaction failed',
      expect.objectContaining({
        sessionId: SESSION_ID,
        error: 'Constraint violation',
        errorCode: 'P2025',
      })
    );
  });

  it('handles error persistence failure gracefully', async () => {
    vi.mocked(prisma.smartUploadSession.findUnique).mockResolvedValue(createSession() as any);
    vi.mocked(prisma.smartUploadSession.updateMany).mockResolvedValue({ count: 1 } as any);
    vi.mocked(prisma.$transaction).mockRejectedValueOnce(new Error('Transaction failed'));
    
    const updateError = new Error('Cannot update session');
    vi.mocked(prisma.smartUploadSession.update).mockRejectedValueOnce(updateError);

    await expect(commitSmartUploadSessionToLibrary(SESSION_ID)).rejects.toThrow('Commit failed');

    expect(logger.error).toHaveBeenCalledWith(
      'Failed to persist commit error',
      expect.objectContaining({
        sessionId: SESSION_ID,
        updateError: 'Cannot update session',
      })
    );
  });

  it('handles database connection errors', async () => {
    const connectionError = new Error('connect ECONNREFUSED 127.0.0.1:3306');
    (connectionError as any).code = 'ECONNREFUSED';
    vi.mocked(prisma.smartUploadSession.findUnique).mockResolvedValue(createSession() as any);
    vi.mocked(prisma.smartUploadSession.updateMany).mockResolvedValue({ count: 1 } as any);
    vi.mocked(prisma.$transaction).mockRejectedValueOnce(connectionError);
    vi.mocked(prisma.smartUploadSession.update).mockResolvedValue({ id: SESSION_ID } as any);

    await expect(commitSmartUploadSessionToLibrary(SESSION_ID)).rejects.toThrow('Commit failed');

    // The code also flags the session for human review on commit failure,
    // so assert the fields that matter rather than an exact object.
    expect(prisma.smartUploadSession.update).toHaveBeenCalledWith({
      where: { uploadSessionId: SESSION_ID },
      data: expect.objectContaining({
        commitStatus: 'FAILED',
        commitError: 'connect ECONNREFUSED 127.0.0.1:3306',
        requiresHumanReview: true,
        status: 'FAILED',
      }),
    });
  });
});

// ---------------------------------------------------------------------------
// State Transition Tests
// ---------------------------------------------------------------------------
describe('State Transitions — Commit Status Lifecycle', () => {
  it('transitions NOT_STARTED → IN_PROGRESS → COMPLETE on success', async () => {
    vi.mocked(prisma.smartUploadSession.findUnique).mockResolvedValue(
      createSession({ commitStatus: 'NOT_STARTED' }) as any
    );
    vi.mocked(prisma.smartUploadSession.updateMany).mockResolvedValue({ count: 1 } as any);

    await commitSmartUploadSessionToLibrary(SESSION_ID);

    expect(mockTx.smartUploadSession.update).toHaveBeenCalledWith({
      where: { uploadSessionId: SESSION_ID },
      data: expect.objectContaining({
        commitStatus: 'COMPLETE',
        committedPieceId: 'new-piece-789',
        committedFileId: 'new-file-id',
      }),
    });
  });

  it('transitions FAILED → IN_PROGRESS on retry', async () => {
    vi.mocked(prisma.smartUploadSession.findUnique).mockResolvedValue(
      createSession({ commitStatus: 'FAILED', commitError: 'Previous failure', commitAttempts: 1 }) as any
    );
    vi.mocked(prisma.smartUploadSession.updateMany).mockResolvedValue({ count: 1 } as any);

    await commitSmartUploadSessionToLibrary(SESSION_ID);

    expect(prisma.smartUploadSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ uploadSessionId: SESSION_ID }),
        data: expect.objectContaining({
          commitStatus: 'IN_PROGRESS',
          commitError: null,
          commitAttempts: { increment: 1 },
        }),
      })
    );
  });

  it('rejects commit when status is COMPLETE', async () => {
    vi.mocked(prisma.smartUploadSession.findUnique).mockResolvedValue(
      createSession({
        status: 'APPROVED',
        commitStatus: 'COMPLETE',
        committedPieceId: PIECE_ID,
        committedFileId: FILE_ID,
      }) as any
    );
    vi.mocked(prisma.musicPiece.findUnique).mockResolvedValue({ id: PIECE_ID, title: 'Complete Piece' } as any);
    vi.mocked(prisma.musicPart.count).mockResolvedValue(0);

    const result = await commitSmartUploadSessionToLibrary(SESSION_ID);

    expect(result.wasIdempotent).toBe(true);
    expect(prisma.smartUploadSession.updateMany).not.toHaveBeenCalled();
  });

  it('clears commitError when transitioning to IN_PROGRESS', async () => {
    vi.mocked(prisma.smartUploadSession.findUnique).mockResolvedValue(
      createSession({ commitStatus: 'FAILED', commitError: 'Old error message' }) as any
    );
    vi.mocked(prisma.smartUploadSession.updateMany).mockResolvedValue({ count: 1 } as any);

    await commitSmartUploadSessionToLibrary(SESSION_ID);

    expect(prisma.smartUploadSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ commitError: null }),
      })
    );
  });

  it('increments commitAttempts on each commit attempt', async () => {
    vi.mocked(prisma.smartUploadSession.findUnique).mockResolvedValue(
      createSession({ commitAttempts: 2 }) as any
    );
    vi.mocked(prisma.smartUploadSession.updateMany).mockResolvedValue({ count: 1 } as any);

    await commitSmartUploadSessionToLibrary(SESSION_ID);

    expect(prisma.smartUploadSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ commitAttempts: { increment: 1 } }),
      })
    );
  });
});

// ---------------------------------------------------------------------------
// Edge Cases and Cleanup Tests
// ---------------------------------------------------------------------------
describe('Edge Cases — Boundary Conditions', () => {
  it('handles missing session gracefully', async () => {
    vi.mocked(prisma.smartUploadSession.findUnique).mockResolvedValue(null);

    await expect(commitSmartUploadSessionToLibrary(SESSION_ID)).rejects.toThrow(
      `SmartUploadSession not found: ${SESSION_ID}`
    );
  });

  it('handles non-commit-eligible status', async () => {
    vi.mocked(prisma.smartUploadSession.findUnique).mockResolvedValue(
      createSession({ status: 'REJECTED' }) as any
    );

    await expect(commitSmartUploadSessionToLibrary(SESSION_ID)).rejects.toThrow(
      `Session ${SESSION_ID} is not commit-eligible`
    );
  });

  it('allows auto-commit for PENDING_REVIEW status', async () => {
    vi.mocked(prisma.smartUploadSession.findUnique).mockResolvedValue(
      createSession({ status: 'PENDING_REVIEW' }) as any
    );
    vi.mocked(prisma.smartUploadSession.updateMany).mockResolvedValue({ count: 1 } as any);

    await commitSmartUploadSessionToLibrary(SESSION_ID, {}, 'system:auto-commit');

    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it('rejects manual commit for non-PENDING_REVIEW status', async () => {
    vi.mocked(prisma.smartUploadSession.findUnique).mockResolvedValue(
      createSession({ status: 'APPROVED' }) as any
    );

    await expect(commitSmartUploadSessionToLibrary(SESSION_ID, {}, 'user-123')).rejects.toThrow(
      `Session ${SESSION_ID} is not commit-eligible`
    );
  });

  it('cleans up temp files on successful commit', async () => {
    const { deleteFile } = await import('@/lib/services/storage');
    vi.mocked(prisma.smartUploadSession.findUnique).mockResolvedValue(
      createSession({ tempFiles: ['temp/file1.pdf', 'temp/file2.pdf'] }) as any
    );
    vi.mocked(prisma.smartUploadSession.updateMany).mockResolvedValue({ count: 1 } as any);

    await commitSmartUploadSessionToLibrary(SESSION_ID);

    expect(deleteFile).toHaveBeenCalledWith('temp/file1.pdf');
    expect(deleteFile).toHaveBeenCalledWith('temp/file2.pdf');
  });

  it('preserves final music files during cleanup', async () => {
    const { deleteFile } = await import('@/lib/services/storage');
    const storageKey = 'smart-upload/test-session-abc/original.pdf';
    vi.mocked(prisma.smartUploadSession.findUnique).mockResolvedValue(
      createSession({ storageKey, tempFiles: [storageKey, 'temp/to-delete.pdf'] }) as any
    );
    vi.mocked(prisma.smartUploadSession.updateMany).mockResolvedValue({ count: 1 } as any);

    await commitSmartUploadSessionToLibrary(SESSION_ID);

    expect(deleteFile).not.toHaveBeenCalledWith(storageKey);
    expect(deleteFile).toHaveBeenCalledWith('temp/to-delete.pdf');
  });

  it('continues cleanup even when individual file deletion fails', async () => {
    const { deleteFile } = await import('@/lib/services/storage');
    vi.mocked(deleteFile)
      .mockRejectedValueOnce(new Error('Access denied'))
      .mockResolvedValueOnce(undefined);

    vi.mocked(prisma.smartUploadSession.findUnique).mockResolvedValue(
      createSession({ tempFiles: ['temp/file1.pdf', 'temp/file2.pdf'] }) as any
    );
    vi.mocked(prisma.smartUploadSession.updateMany).mockResolvedValue({ count: 1 } as any);

    await commitSmartUploadSessionToLibrary(SESSION_ID);

    expect(logger.warn).toHaveBeenCalledWith(
      'Auto-commit: failed to delete temp file',
      expect.objectContaining({ sessionId: SESSION_ID, key: 'temp/file1.pdf' })
    );
    expect(deleteFile).toHaveBeenCalledWith('temp/file2.pdf');
  });
});

// ---------------------------------------------------------------------------
// Audit and Logging Tests
// ---------------------------------------------------------------------------
describe('Audit Logging', () => {
  it('logs successful commit with context', async () => {
    vi.mocked(prisma.smartUploadSession.findUnique).mockResolvedValue(createSession() as any);
    vi.mocked(prisma.smartUploadSession.updateMany).mockResolvedValue({ count: 1 } as any);

    await commitSmartUploadSessionToLibrary(SESSION_ID, {}, 'user-admin-123');

    expect(logger.info).toHaveBeenCalledWith(
      'Smart upload committed to library',
      expect.objectContaining({
        sessionId: SESSION_ID,
        approvedBy: 'user-admin-123',
        title: expect.any(String),
        pieceId: expect.any(String),
        partsCommitted: expect.any(Number),
      })
    );
  });

  it('logs idempotent commit detection', async () => {
    vi.mocked(prisma.smartUploadSession.findUnique).mockResolvedValue(
      createSession({
        commitStatus: 'COMPLETE',
        committedPieceId: PIECE_ID,
        committedFileId: FILE_ID,
      }) as any
    );
    vi.mocked(prisma.musicPiece.findUnique).mockResolvedValue({ id: PIECE_ID, title: 'Test Piece' } as any);
    vi.mocked(prisma.musicPart.count).mockResolvedValue(5);

    await commitSmartUploadSessionToLibrary(SESSION_ID);

    expect(logger.info).toHaveBeenCalledWith(
      'Commit idempotency: session already marked committed',
      { sessionId: SESSION_ID }
    );
  });

  it('logs CAS lock contention', async () => {
    vi.mocked(prisma.smartUploadSession.updateMany).mockResolvedValueOnce({ count: 0 } as any);
    vi.mocked(prisma.smartUploadSession.findUnique)
      .mockResolvedValueOnce(createSession({
        commitStatus: 'COMPLETE',
        committedPieceId: PIECE_ID,
        committedFileId: FILE_ID,
      }) as any)
      .mockResolvedValueOnce({ id: PIECE_ID, title: 'Resolved Piece' } as any);
    vi.mocked(prisma.musicPiece.findUnique).mockResolvedValue({ id: PIECE_ID, title: 'Resolved Piece' } as any);
    vi.mocked(prisma.musicPart.count).mockResolvedValue(3);

    await commitSmartUploadSessionToLibrary(SESSION_ID);

    // Either message is acceptable - both indicate idempotency was detected
    expect(logger.info).toHaveBeenCalled();
    const calls = vi.mocked(logger.info).mock.calls;
    const hasIdempotencyLog = calls.some(call => 
      call[0]?.includes('idempotency') || call[0]?.includes('already')
    );
    expect(hasIdempotencyLog).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration-style Tests
// ---------------------------------------------------------------------------
describe('Integration — Full Commit Flow', () => {
  it('completes full successful commit flow', async () => {
    vi.mocked(prisma.smartUploadSession.findUnique).mockResolvedValue(createSession() as any);
    vi.mocked(prisma.smartUploadSession.updateMany).mockResolvedValue({ count: 1 } as any);

    const result = await commitSmartUploadSessionToLibrary(SESSION_ID, { title: 'Custom Title' }, 'test-user');

    expect(prisma.smartUploadSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ commitStatus: 'IN_PROGRESS' }) })
    );
    expect(prisma.$transaction).toHaveBeenCalled();
    expect(result.wasIdempotent).toBe(false);
    expect(result.sessionId).toBe(SESSION_ID);
    expect(result.musicPieceId).toBeDefined();
    expect(result.musicFileId).toBeDefined();
    expect(logger.info).toHaveBeenCalled();
  });

  it('handles concurrent commits with idempotent results', async () => {
    // First process would succeed, second sees CAS failure and existing commit
    vi.mocked(prisma.smartUploadSession.updateMany).mockResolvedValueOnce({ count: 0 } as any);
    vi.mocked(prisma.smartUploadSession.findUnique)
      .mockResolvedValueOnce(createSession({
        commitStatus: 'COMPLETE',
        committedPieceId: PIECE_ID,
        committedFileId: FILE_ID,
      }) as any)
      .mockResolvedValueOnce({ id: PIECE_ID, title: 'Concurrent Piece' } as any);
    vi.mocked(prisma.musicPiece.findUnique).mockResolvedValue({ id: PIECE_ID, title: 'Concurrent Piece' } as any);
    vi.mocked(prisma.musicPart.count).mockResolvedValue(4);

    const result = await commitSmartUploadSessionToLibrary(SESSION_ID);

    expect(result.wasIdempotent).toBe(true);
    expect(result.musicPieceId).toBe(PIECE_ID);
  });

  it('recovers from transient failure on retry', async () => {
    vi.mocked(prisma.smartUploadSession.findUnique).mockResolvedValue(
      createSession({ commitStatus: 'FAILED', commitError: 'Previous DB error', commitAttempts: 1 }) as any
    );
    vi.mocked(prisma.smartUploadSession.updateMany).mockResolvedValue({ count: 1 } as any);

    const result = await commitSmartUploadSessionToLibrary(SESSION_ID);

    expect(result.wasIdempotent).toBe(false);
    expect(result.musicPieceId).toBe('new-piece-789');
    expect(prisma.smartUploadSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ commitError: null }) })
    );
  });
});
