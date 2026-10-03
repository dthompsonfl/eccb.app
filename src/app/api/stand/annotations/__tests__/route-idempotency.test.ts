import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Prisma } from '@prisma/client';

/**
 * Idempotent replay for the offline annotation queue.
 *
 * The queue's documented promise is that a retry cannot duplicate a stroke. Two
 * mechanisms enforce it here, and both are covered:
 *
 *  1. A read-before-write short-circuit, which handles the common replay.
 *  2. The (userId, clientId) unique index, which handles two replays racing
 *     each other. The loser gets P2002 from Prisma, which must be reported to
 *     the client as SUCCESS with the winning row. Returning 500 instead would
 *     leave the stroke queued forever, retrying the same conflict on every
 *     reconnect — the queue could never drain.
 */

const mockRequireStandAccess = vi.fn();
const mockCanAccessPiece = vi.fn();
const mockAssertCanWriteLayer = vi.fn();
const mockApplyRateLimit = vi.fn();
const mockGetStandSettings = vi.fn();

const annotation = {
  id: 'ann-1',
  musicId: 'piece-1',
  page: 3,
  layer: 'PERSONAL',
  userId: 'user-1',
  sectionId: null,
  strokeData: '{"points":[[0,0]]}',
  createdAt: '2026-10-04T00:00:00.000Z',
  updatedAt: '2026-10-04T00:00:00.000Z',
};

const mockFindUnique = vi.fn();
const mockCreate = vi.fn();
const mockCount = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    annotation: {
      findUnique: mockFindUnique,
      create: mockCreate,
      count: mockCount,
    },
  },
}));

vi.mock('@/lib/stand/access', () => ({
  requireStandAccess: mockRequireStandAccess,
  canAccessPiece: mockCanAccessPiece,
  assertCanWriteLayer: mockAssertCanWriteLayer,
  annotationVisibilityFilter: () => ({}),
}));

vi.mock('@/lib/rate-limit', () => ({
  applyRateLimit: mockApplyRateLimit,
}));

vi.mock('@/lib/stand/settings', () => ({
  getStandSettings: mockGetStandSettings,
}));

function makeRequest(body: unknown) {
  return {
    json: async () => body,
  } as never;
}

const VALID_BODY = {
  musicId: 'piece-1',
  page: 3,
  layer: 'PERSONAL',
  strokeData: { points: [[0, 0]] },
  clientId: 'client-generated-id-0001',
};

async function callPost(body: unknown) {
  const { POST } = await import('@/app/api/stand/annotations/route');
  return POST(makeRequest(body));
}

describe('POST /api/stand/annotations idempotent replay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApplyRateLimit.mockResolvedValue(null);
    mockRequireStandAccess.mockResolvedValue({
      userId: 'user-1',
      userSectionIds: [],
      roles: [],
    });
    mockCanAccessPiece.mockResolvedValue(true);
    mockAssertCanWriteLayer.mockReturnValue(null);
    mockCount.mockResolvedValue(0);
    mockGetStandSettings.mockResolvedValue({
      maxStrokeDataBytes: 100_000,
      maxAnnotationsPerPage: 50,
    });
    mockCreate.mockResolvedValue(annotation);
    mockFindUnique.mockResolvedValue(null);
  });

  it('persists the clientId so a replay can be recognised', async () => {
    await callPost(VALID_BODY);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0][0].data.clientId).toBe(VALID_BODY.clientId);
  });

  it('returns the existing row and does not insert when the clientId replays', async () => {
    mockFindUnique.mockResolvedValue(annotation);

    const res = await callPost(VALID_BODY);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.annotation.id).toBe('ann-1');
    // This is the whole point: one physical stroke, one row.
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('checks the replay BEFORE the per-page annotation limit', async () => {
    // Otherwise a legitimate replay of an already-saved stroke is rejected as
    // "limit reached", the stroke stays queued, and it can never drain.
    mockFindUnique.mockResolvedValue(annotation);
    mockCount.mockResolvedValue(999);

    const res = await callPost(VALID_BODY);

    expect(res.status).toBe(200);
    expect(mockCount).not.toHaveBeenCalled();
  });

  it('reports a P2002 race as success with the winning row, not a 500', async () => {
    mockFindUnique
      .mockResolvedValueOnce(null) // first read misses
      .mockResolvedValueOnce(annotation); // the winner, read after the conflict
    mockCreate.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );

    const res = await callPost(VALID_BODY);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.annotation.id).toBe('ann-1');
  });

  it('still 500s on an unrelated Prisma failure', async () => {
    mockCreate.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Table not found', {
        code: 'P2021',
        clientVersion: 'test',
      }),
    );

    const res = await callPost(VALID_BODY);
    expect(res.status).toBe(500);
  });

  it('accepts a payload with no clientId (the online path)', async () => {
    const { clientId: _omit, ...withoutClientId } = VALID_BODY;
    await callPost(withoutClientId);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0][0].data.clientId).toBeNull();
  });

  it('rejects an over-long clientId rather than silently truncating it', async () => {
    const res = await callPost({ ...VALID_BODY, clientId: 'x'.repeat(65) });
    expect(res.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});