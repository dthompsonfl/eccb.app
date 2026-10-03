/**
 * Commit — Automatic part-to-player routing and the commit-time coverage gate.
 *
 * These are the end-to-end assertions for the product requirement "upload a score
 * and everything just happens". `part-routing.test.ts` proves the routing logic;
 * this proves the commit path actually calls it, that the resulting assignments
 * reach the player, that a re-commit does not duplicate them, and that a
 * half-cut part set cannot reach the library.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRoster } = vi.hoisted(() => ({ mockRoster: vi.fn() }));

const mockTx = {
  person: { findFirst: vi.fn(), create: vi.fn() },
  publisher: { findUnique: vi.fn(), create: vi.fn() },
  musicPiece: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  musicFile: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  musicFileVersion: { count: vi.fn(), create: vi.fn() },
  musicPart: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), count: vi.fn() },
  instrument: { findFirst: vi.fn(), create: vi.fn() },
  smartUploadSession: { update: vi.fn() },
  musicAssignment: { findMany: vi.fn(), create: vi.fn() },
  musicAssignmentHistory: { create: vi.fn() },
};



vi.mock('@/lib/db', () => ({
  prisma: {
    smartUploadSession: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      // Must resolve: the commit error path appends .catch() to the update it
      // makes while persisting a failure.
      update: vi.fn(async () => ({})),
    },
    musicFile: { findFirst: vi.fn() },
    musicPiece: { findUnique: vi.fn() },
    musicPart: { count: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock('@/lib/smart-upload/part-routing', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/smart-upload/part-routing')>();
  return { ...actual, loadRoutingRoster: mockRoster };
});

vi.mock('@/lib/services/storage', () => ({
  deleteFile: vi.fn(async () => undefined),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { prisma } from '@/lib/db';
import { commitSmartUploadSessionToLibrary } from '../commit';

const SESSION_ID = 'route-session';

const PART = (
  partName: string,
  instrument: string,
  pageRange: [number, number],
): Record<string, unknown> => ({
  partName,
  instrument,
  section: 'Brass',
  transposition: 'Bb',
  partNumber: 1,
  storageKey: `smart-upload/${SESSION_ID}/parts/${partName}.pdf`,
  fileName: `${partName}.pdf`,
  fileSize: 100,
  pageCount: pageRange[1] - pageRange[0] + 1,
  pageRange,
});

function session(overrides: Record<string, unknown> = {}) {
  return {
    uploadSessionId: SESSION_ID,
    fileName: 'march.pdf',
    fileSize: 999,
    mimeType: 'application/pdf',
    storageKey: 'smart-upload/original.pdf',
    status: 'AUTO_COMMITTING',
    commitStatus: 'NOT_STARTED',
    extractedMetadata: {
      title: 'Semper Fidelis',
      composer: 'John Philip Sousa',
      confidenceScore: 92,
      isMultiPart: true,
    },
    parsedParts: [PART('Trumpet', 'Trumpet', [1, 4]), PART('Trombone', 'Trombone', [5, 8])],
    cuttingInstructions: null,
    tempFiles: [],
    sourceSha256: 'sha-1',
    routingDecision: null,
    ...overrides,
  };
}

/** Wire the mocks for a clean first-time commit. */
function primeHappyPath(overrides: Record<string, unknown> = {}) {
  vi.mocked(prisma.smartUploadSession.findUnique).mockResolvedValue(
    session(overrides) as never,
  );
  vi.mocked(prisma.smartUploadSession.updateMany).mockResolvedValue({ count: 1 });
  vi.mocked(prisma.musicFile.findFirst).mockResolvedValue(null as never);
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
  mockTx.musicFile.create.mockResolvedValue({ id: 'file-1' });
  mockTx.musicPart.findFirst.mockResolvedValue(null);
  mockTx.musicPart.create.mockResolvedValue({ id: 'part-default' });
  mockTx.instrument.findFirst.mockResolvedValue(null);
  mockTx.instrument.create.mockResolvedValue({ id: 'instr-1' });
  mockTx.musicAssignment.findMany.mockResolvedValue([]);
  mockRoster.mockResolvedValue([]);
  // Every delegate must resolve to something with the fields commit reads off
  // it; an undefined return here surfaces as an opaque "reading 'id'" from deep
  // inside the transaction.
  mockTx.musicFileVersion.count.mockResolvedValue(0);
  mockTx.musicFileVersion.create.mockResolvedValue({ id: 'ver-1' });
  mockTx.musicPiece.update.mockResolvedValue({ id: 'piece-1', title: 'Semper Fidelis' });
  mockTx.musicFile.update.mockResolvedValue({ id: 'file-1' });
  mockTx.musicPart.update.mockResolvedValue({ id: 'part-default' });
  mockTx.smartUploadSession.update.mockResolvedValue({});
  mockTx.musicAssignmentHistory.create.mockResolvedValue({});
  mockTx.musicAssignment.create.mockResolvedValue({ id: 'assign-1' });
  vi.mocked(prisma.$transaction).mockImplementation(
    async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('commit — automatic routing to players', () => {
  it('creates a MusicAssignment for each part and each matching player', async () => {
    primeHappyPath();
    mockRoster.mockResolvedValue([
      {
        memberId: 'm-trumpet',
        firstName: 'Ana',
        lastName: 'Diaz',
        instrumentNames: ['Trumpet'],
        sectionNames: ['Brass'],
      },
      {
        memberId: 'm-trombone',
        firstName: 'Bob',
        lastName: 'Egan',
        instrumentNames: ['Trombone'],
        sectionNames: ['Brass'],
      },
    ]);
    mockTx.musicPart.create
      .mockResolvedValueOnce({ id: 'part-trumpet' })
      .mockResolvedValueOnce({ id: 'part-trombone' });

    const result = await commitSmartUploadSessionToLibrary(SESSION_ID);

    expect(result.assignmentsCreated).toBe(2);
    expect(result.unroutedParts).toEqual([]);

    const created = mockTx.musicAssignment.create.mock.calls.map(
      ([arg]) => (arg as { data: Record<string, unknown> }).data,
    );
    expect(created).toHaveLength(2);
    // partId is what makes the assignment part-scoped, which is what the Stand's
    // getPieceAssignmentGrant requires for a member to see their own part.
    expect(created).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ partId: 'part-trumpet', memberId: 'm-trumpet' }),
        expect.objectContaining({ partId: 'part-trombone', memberId: 'm-trombone' }),
      ]),
    );
  });

  it('writes an assignment history row, matching the manual assignment path', async () => {
    primeHappyPath();
    mockRoster.mockResolvedValue([
      {
        memberId: 'm-trumpet',
        firstName: 'Ana',
        lastName: 'Diaz',
        instrumentNames: ['Trumpet'],
        sectionNames: ['Brass'],
      },
    ]);
    mockTx.musicPart.create.mockResolvedValueOnce({ id: 'part-trumpet' }).mockResolvedValueOnce({ id: 'part-tb' });

    await commitSmartUploadSessionToLibrary(SESSION_ID);

    expect(mockTx.musicAssignmentHistory.create).toHaveBeenCalledTimes(1);
  });

  it('SURFACES a part no member plays instead of dropping it silently', async () => {
    primeHappyPath();
    mockRoster.mockResolvedValue([
      {
        memberId: 'm-trumpet',
        firstName: 'Ana',
        lastName: 'Diaz',
        instrumentNames: ['Trumpet'],
        sectionNames: ['Brass'],
      },
    ]);
    mockTx.musicPart.create.mockResolvedValueOnce({ id: 'part-trumpet' }).mockResolvedValueOnce({ id: 'part-tb' });

    const result = await commitSmartUploadSessionToLibrary(SESSION_ID);

    // Only the trumpet part is assigned.
    expect(result.assignmentsCreated).toBe(1);
    expect(result.unroutedParts).toHaveLength(1);
    expect(result.unroutedParts[0]).toMatchObject({
      partId: 'part-tb',
      reason: 'NO_MEMBER_FOR_INSTRUMENT',
      canonicalInstrument: 'Trombone',
    });

    // And it is recorded on the session so an admin can act on it.
    const sessionUpdate = mockTx.smartUploadSession.update.mock.calls.at(-1)?.[0] as {
      data: { routingDecision?: string };
    };
    expect(sessionUpdate.data.routingDecision).toContain('need manual assignment');
    expect(sessionUpdate.data.routingDecision).toContain('Trombone');
  });

  it('is idempotent: a re-commit does not duplicate assignments', async () => {
    primeHappyPath();
    mockRoster.mockResolvedValue([
      {
        memberId: 'm-trumpet',
        firstName: 'Ana',
        lastName: 'Diaz',
        instrumentNames: ['Trumpet'],
        sectionNames: ['Brass'],
      },
    ]);
    // The roster lookup happens outside the tx, but this test asserts on create.
    mockTx.musicPart.create.mockResolvedValue({ id: 'part-trumpet' });
    // Pretend both assignments already exist for this piece.
    mockTx.musicAssignment.findMany.mockResolvedValue([
      { id: 'a1', memberId: 'm-trumpet', partId: 'part-trumpet' },
    ]);

    const result = await commitSmartUploadSessionToLibrary(SESSION_ID);

    expect(mockTx.musicAssignment.create).not.toHaveBeenCalled();
    expect(result.assignmentsCreated).toBe(0);
  });

  it('routes using canonical names, so Bb and B-flat spellings both reach the player', async () => {
    primeHappyPath();
    // The roster holds the unicode seed spelling; the part holds the normalized
    // one. Exact string equality would route nothing.
    mockRoster.mockResolvedValue([
      {
        memberId: 'm-clarinet',
        firstName: 'Kim',
        lastName: 'Osei',
        instrumentNames: ['B\u266d Clarinet'],
        sectionNames: ['Woodwinds'],
      },
    ]);
    vi.mocked(prisma.smartUploadSession.findUnique).mockResolvedValue(
      session({
        parsedParts: [PART('Bb Clarinet', 'Bb Clarinet', [1, 6])],
      }) as never,
    );
    mockTx.musicPart.create.mockResolvedValue({ id: 'part-clarinet' });

    const result = await commitSmartUploadSessionToLibrary(SESSION_ID);

    expect(result.assignmentsCreated).toBe(1);
    expect(mockTx.musicAssignment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ memberId: 'm-clarinet' }),
      }),
    );
  });
});

describe('commit — page coverage hard gate', () => {
  it('BLOCKS commit when a page belongs to no part', async () => {
    // Trumpet takes pages 1-2, trombone 4-8: page 3 is in nobody's part.
    vi.mocked(prisma.smartUploadSession.findUnique).mockResolvedValue(
      session({
        parsedParts: [
          PART('Trumpet', 'Trumpet', [1, 2]),
          PART('Trombone', 'Trombone', [4, 8]),
        ],
      }) as never,
    );

    await expect(commitSmartUploadSessionToLibrary(SESSION_ID)).rejects.toThrow(
      /Cannot commit/,
    );

    // Crucially, the transaction never opened, so nothing was written.
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(mockTx.musicPart.create).not.toHaveBeenCalled();
    expect(mockTx.musicAssignment.create).not.toHaveBeenCalled();
  });

  it('BLOCKS commit when a page is duplicated across two parts', async () => {
    vi.mocked(prisma.smartUploadSession.findUnique).mockResolvedValue(
      session({
        parsedParts: [
          PART('Trumpet', 'Trumpet', [1, 5]),
          PART('Trombone', 'Trombone', [5, 8]),
        ],
      }) as never,
    );

    await expect(commitSmartUploadSessionToLibrary(SESSION_ID)).rejects.toThrow(
      /more than one part/,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('BLOCKS commit for a manual approve too, not just the autonomous worker', async () => {
    // A human clicking Approve is not a licence to ship a half-cut set: the
    // coverage invariant is the pipeline's core safety property.
    vi.mocked(prisma.smartUploadSession.findUnique).mockResolvedValue(
      session({
        status: 'REQUIRES_REVIEW',
        parsedParts: [
          PART('Trumpet', 'Trumpet', [1, 2]),
          PART('Trombone', 'Trombone', [4, 8]),
        ],
      }) as never,
    );

    await expect(
      commitSmartUploadSessionToLibrary(SESSION_ID, {}, 'admin-user-1'),
    ).rejects.toThrow(/Cannot commit/);
  });

  it('ALLOWS commit when the parts tile their span exactly', async () => {
    primeHappyPath();
    const result = await commitSmartUploadSessionToLibrary(SESSION_ID);

    expect(result.wasIdempotent).toBe(false);
    expect(result.partsCommitted).toBe(2);
  });

  it('ALLOWS a single-part upload, which has no span to check', async () => {
    primeHappyPath();
    vi.mocked(prisma.smartUploadSession.findUnique).mockResolvedValue(
      session({
        parsedParts: [PART('Trumpet', 'Trumpet', [1, 8])],
      }) as never,
    );

    const result = await commitSmartUploadSessionToLibrary(SESSION_ID);
    expect(result.partsCommitted).toBe(1);
  });
});