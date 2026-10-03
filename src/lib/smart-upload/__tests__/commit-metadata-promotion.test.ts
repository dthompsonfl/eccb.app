/**
 * Commit — canonical metadata promotion.
 *
 * ExtractedMetadata is rich (subtitle, notes, copyright year, …) but was mostly
 * being dropped on the floor: only title/composer/arranger/publisher and a few
 * musical attributes reached MusicPiece columns, leaving the rest trapped in the
 * MusicFile.extractedMetadata JSON blob where the library cannot query it.
 *
 * These tests assert the promotion actually happens.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

import { prisma } from '@/lib/db';
import { commitSmartUploadSessionToLibrary } from '../commit';

const SESSION_ID = 'meta-session';

function sessionWith(metadata: Record<string, unknown>) {
  return {
    uploadSessionId: SESSION_ID,
    fileName: 'scan_00482.pdf',
    fileSize: 1024,
    mimeType: 'application/pdf',
    storageKey: `smart-upload/${SESSION_ID}/original.pdf`,
    status: 'PENDING_REVIEW',
    extractedMetadata: {
      title: 'Lincolnshire Posy',
      composer: 'M. William Karlins',
      confidenceScore: 90,
      fileType: 'FULL_SCORE',
      ...metadata,
    },
    parsedParts: [],
    cuttingInstructions: null,
    tempFiles: [],
    sourceSha256: 'sha-1',
    reviewedAt: null,
    committedAt: null,
    commitStatus: 'NOT_STARTED',
    committedPieceId: null,
    committedFileId: null,
    commitError: null,
    commitAttempts: 0,
  };
}

function setupTx() {
  mockTx.person.findFirst.mockResolvedValue(null);
  mockTx.person.create.mockImplementation(({ data }: { data: { fullName: string } }) =>
    Promise.resolve({ id: `person-${data.fullName}`, ...data }),
  );
  mockTx.publisher.findUnique.mockResolvedValue(null);
  mockTx.publisher.create.mockImplementation(({ data }: { data: { name: string } }) =>
    Promise.resolve({ id: `pub-${data.name}`, ...data }),
  );
  mockTx.musicPiece.findFirst.mockResolvedValue(null);
  mockTx.musicPiece.create.mockResolvedValue({ id: 'piece-1' });
  mockTx.musicPiece.update.mockResolvedValue({ id: 'piece-1' });
  mockTx.musicFile.findFirst.mockResolvedValue(null);
  mockTx.musicFile.create.mockResolvedValue({ id: 'file-1' });
  mockTx.musicFile.update.mockResolvedValue({ id: 'file-1' });
  mockTx.musicFileVersion.count.mockResolvedValue(0);
  mockTx.musicFileVersion.create.mockResolvedValue({ id: 'ver-1' });
  mockTx.musicPart.findFirst.mockResolvedValue(null);
  mockTx.musicPart.create.mockResolvedValue({ id: 'part-1' });
  mockTx.musicPart.update.mockResolvedValue({ id: 'part-1' });
  mockTx.musicPart.count.mockResolvedValue(0);
  mockTx.instrument.findFirst.mockResolvedValue(null);
  mockTx.instrument.create.mockImplementation(({ data }: { data: { name: string } }) =>
    Promise.resolve({ id: `inst-${data.name}`, ...data }),
  );
  mockTx.smartUploadSession.update.mockResolvedValue({ id: SESSION_ID });

  // The commit path claims the session with a CAS updateMany; a count of 1 means
  // this process won the claim and may proceed.
  vi.mocked(prisma.smartUploadSession.updateMany).mockResolvedValue({ count: 1 } as never);
  vi.mocked(prisma.musicPart.count).mockResolvedValue(0);
  vi.mocked(prisma.musicPiece.findUnique).mockResolvedValue(null as never);
  vi.mocked(prisma.musicFile.findFirst).mockResolvedValue(null as never);
  vi.mocked(prisma.smartUploadSession.update).mockResolvedValue({} as never);

  vi.mocked(prisma.$transaction).mockImplementation(async (fn) => fn(mockTx));
}

/** The data object passed to musicPiece.create for the given metadata. */
async function committedPieceData(metadata: Record<string, unknown>, overrides = {}) {
  vi.mocked(prisma.smartUploadSession.findUnique).mockResolvedValue(
    sessionWith(metadata) as never,
  );
  await commitSmartUploadSessionToLibrary(SESSION_ID, overrides);
  const call = mockTx.musicPiece.create.mock.calls.at(-1);
  return (call?.[0] as { data: Record<string, unknown> })?.data ?? {};
}

beforeEach(() => {
  vi.resetAllMocks();
  setupTx();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('commit promotes extracted metadata into canonical columns', () => {
  it('promotes the copyright year', async () => {
    const data = await committedPieceData({ copyrightYear: 1977 });
    expect(data.copyrightYear).toBe(1977);
  });

  it('coerces a decorated copyright year string', async () => {
    const data = await committedPieceData({ copyrightYear: 'c. 1977' });
    expect(data.copyrightYear).toBe(1977);
  });

  it('stores null rather than a bogus copyright year', async () => {
    const data = await committedPieceData({ copyrightYear: '19th century' });
    expect(data.copyrightYear).toBeNull();
  });

  it('leaves copyrightYear null when nothing was extracted', async () => {
    const data = await committedPieceData({});
    expect(data.copyrightYear).toBeNull();
  });

  it('promotes the subtitle', async () => {
    const data = await committedPieceData({ subtitle: 'A Musical Fable' });
    expect(data.subtitle).toBe('A Musical Fable');
  });

  it('promotes notes without losing the import provenance stamp', async () => {
    const data = await committedPieceData({ notes: 'Slower in the trio.' });
    expect(data.notes).toContain('Slower in the trio.');
    expect(data.notes).toContain('Imported via Smart Upload');
  });

  it('promotes the musical attributes that already had homes', async () => {
    const data = await committedPieceData({
      ensembleType: 'Concert Band',
      keySignature: 'Bb Major',
      timeSignature: '4/4',
      tempo: 'Andante',
    });
    expect(data.ensembleType).toBe('Concert Band');
    expect(data.keySignature).toBe('Bb Major');
    expect(data.timeSignature).toBe('4/4');
    expect(data.tempo).toBe('Andante');
  });

  it('a manual subtitle override wins over the extracted one', async () => {
    const data = await committedPieceData(
      { subtitle: 'Extracted Subtitle' },
      { subtitle: 'Director Override' },
    );
    expect(data.subtitle).toBe('Director Override');
  });

  it('a manual notes override wins over the extracted one', async () => {
    const data = await committedPieceData(
      { notes: 'Extracted note' },
      { notes: 'Director note' },
    );
    // The override must win over the extracted value, and neither may be
    // clobbered by the provenance stamp.
    expect(data.notes).toContain('Director note');
    expect(data.notes).not.toContain('Extracted note');
  });

  it('re-commit fills only null columns, so a curated value is not clobbered', async () => {
    // Existing piece with a hand-curated subtitle must not be overwritten by a
    // later re-commit that extracted a different one.
    mockTx.musicPiece.findFirst.mockResolvedValue({
      id: 'piece-existing',
      title: 'Lincolnshire Posy',
      subtitle: 'Curated Subtitle',
      notes: null,
    } as never);

    vi.mocked(prisma.smartUploadSession.findUnique).mockResolvedValue(
      sessionWith({ subtitle: 'Machine Subtitle', notes: 'Machine note' }) as never,
    );
    await commitSmartUploadSessionToLibrary(SESSION_ID);

    const updateCall = mockTx.musicPiece.update.mock.calls.at(-1) as
      | [{ where: { id: string }; data: Record<string, unknown> }]
      | undefined;
    const updated = updateCall?.[0].data ?? {};

    expect(updated.subtitle).toBeUndefined();
    expect(updated.notes).toContain('Machine note');
  });
});
