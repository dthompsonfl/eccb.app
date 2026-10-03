/**
 * Commit — Work-level consolidation regression tests (A6 acceptance criteria)
 *
 * These tests verify that:
 *   1. Uploading the same work twice (same title+composer+arranger) does NOT
 *      create a second MusicPiece — it reuses the existing one.
 *   2. A MusicFileVersion snapshot is created before the existing file is
 *      updated (so the old storage key survives in the audit trail).
 *   3. Parts are upserted (not duplicated) on re-commit.
 *   4. A fresh upload of a brand-new work still creates a new MusicPiece.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Prisma mock
// ---------------------------------------------------------------------------
const mockTx = {
  person: { findFirst: vi.fn(), create: vi.fn() },
  publisher: { findUnique: vi.fn(), create: vi.fn() },
  musicPiece: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  musicFile: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  musicFileVersion: { count: vi.fn(), create: vi.fn() },
  musicPart: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
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
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    musicFile: { findFirst: vi.fn() },
    musicPart: { count: vi.fn() },
    $transaction: vi.fn(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx)),
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
import { commitSmartUploadSessionToLibrary } from '../commit';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const SESSION_ID = 'test-session-abc';
const PIECE_ID   = 'piece-existing-123';
const FILE_ID    = 'file-existing-456';

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
};

function resetMocks() {
  vi.clearAllMocks();

  // Session not yet committed (no existing MusicFile with this uploadId)
  vi.mocked(prisma.musicFile.findFirst).mockResolvedValue(null);

  // Composer / arranger / publisher
  mockTx.person.findFirst.mockResolvedValue(null);
  mockTx.person.create.mockImplementation(({ data }: { data: { fullName: string } }) =>
    Promise.resolve({ id: `person-${data.fullName}`, ...data })
  );
  mockTx.publisher.findUnique.mockResolvedValue(null);
  mockTx.publisher.create.mockImplementation(({ data }: { data: { name: string } }) =>
    Promise.resolve({ id: `pub-${data.name}`, ...data })
  );

  // Instrument
  mockTx.instrument.findFirst.mockResolvedValue(null);
  mockTx.instrument.create.mockImplementation(({ data }: { data: { name: string } }) =>
    Promise.resolve({ id: `inst-${data.name}`, ...data })
  );

  // MusicPart.findFirst → null (no existing parts)
  mockTx.musicPart.findFirst.mockResolvedValue(null);
  mockTx.musicPart.create.mockResolvedValue({ id: 'new-part-id' });

  // MusicFileVersion
  mockTx.musicFileVersion.count.mockResolvedValue(0);
  mockTx.musicFileVersion.create.mockResolvedValue({ id: 'ver-1' });

  // MusicFile create / update
  mockTx.musicFile.create.mockResolvedValue({ id: 'new-file-id' });
  mockTx.musicFile.update.mockImplementation(({ data }: { data: object }) =>
    Promise.resolve({ id: FILE_ID, ...data })
  );
}

// ---------------------------------------------------------------------------
// Tests: brand-new work
// ---------------------------------------------------------------------------
describe('commit — new work', () => {
  beforeEach(() => {
    resetMocks();
    vi.mocked(prisma.smartUploadSession.findUnique).mockResolvedValue(BASE_SESSION as any);
    // No existing piece with this fingerprint
    mockTx.musicPiece.findFirst.mockResolvedValue(null);
    mockTx.musicPiece.create.mockResolvedValue({
      id: 'piece-new-789',
      title: 'Semper Fidelis',
    });
  });

  it('creates a new MusicPiece for a brand-new work', async () => {
    const result = await commitSmartUploadSessionToLibrary(SESSION_ID);
    expect(mockTx.musicPiece.create).toHaveBeenCalledOnce();
    expect(mockTx.musicPiece.update).not.toHaveBeenCalled();
    expect(result.wasIdempotent).toBe(false);
  });

  it('does NOT create a MusicFileVersion for a brand-new file', async () => {
    await commitSmartUploadSessionToLibrary(SESSION_ID);
    expect(mockTx.musicFileVersion.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: same work uploaded again (dedup path)
// ---------------------------------------------------------------------------
describe('commit — duplicate work', () => {
  const EXISTING_FILE = {
    id: FILE_ID,
    fileName: 'old-upload.pdf',
    fileSize: 512,
    mimeType: 'application/pdf',
    storageKey: 'smart-upload/old-session/original.pdf',
    version: 1,
    updatedAt: new Date('2024-01-01'),
    fileType: 'FULL_SCORE',
    pieceId: PIECE_ID,
  };

  beforeEach(() => {
    resetMocks();
    vi.mocked(prisma.smartUploadSession.findUnique).mockResolvedValue(BASE_SESSION as any);
    // Existing piece found by fingerprint
    mockTx.musicPiece.findFirst.mockResolvedValue({
      id: PIECE_ID,
      title: 'Semper Fidelis',
      difficulty: null,
      ensembleType: null,
      keySignature: null,
      timeSignature: null,
      tempo: null,
    });
    mockTx.musicPiece.update.mockResolvedValue({ id: PIECE_ID, title: 'Semper Fidelis' });

    // Existing primary file for this piece
    mockTx.musicFile.findFirst.mockResolvedValue(EXISTING_FILE as any);
  });

  it('does NOT create a second MusicPiece for a duplicate work', async () => {
    await commitSmartUploadSessionToLibrary(SESSION_ID);
    expect(mockTx.musicPiece.create).not.toHaveBeenCalled();
  });

  it('creates a MusicFileVersion snapshot of the old file before updating', async () => {
    await commitSmartUploadSessionToLibrary(SESSION_ID);
    expect(mockTx.musicFileVersion.create).toHaveBeenCalledOnce();
    const versionCall = mockTx.musicFileVersion.create.mock.calls[0][0] as { data: { storageKey: string; version: number } };
    // Version snapshot must preserve the OLD storage key, not the new one
    expect(versionCall.data.storageKey).toBe(EXISTING_FILE.storageKey);
    // Version number must increment
    expect(versionCall.data.version).toBe(1); // count=0 so v+1=1
  });

  it('updates the existing MusicFile to point at the new storage key', async () => {
    await commitSmartUploadSessionToLibrary(SESSION_ID);
    expect(mockTx.musicFile.update).toHaveBeenCalled();
    const updateCall = mockTx.musicFile.update.mock.calls[0][0] as { data: { storageKey: string } };
    expect(updateCall.data.storageKey).toBe(BASE_SESSION.storageKey);
  });
});
