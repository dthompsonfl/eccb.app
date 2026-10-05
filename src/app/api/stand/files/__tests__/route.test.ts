// @vitest-environment node
/**
 * Stand file proxy authorization tests.
 *
 * /api/stand/files/[...key] used to run its own inline "does this file belong to
 * this piece/event" query and never consulted the shared access policy. That made
 * it a parallel path: any ACTIVE member who knew a pieceId could stream any PDF
 * in the library, bypassing assignment and part scoping entirely.
 *
 * These tests assert the proxy now defers to @/lib/music/access, and that
 * unauthorized reads return a non-enumerating 404.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { Readable } from 'stream';
import { OFFLINE_CACHE_HEADER, OFFLINE_USER_HEADER } from '@/lib/stand/offline';

vi.mock('@/lib/rate-limit', () => ({
  applyRateLimit: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    userRole: { findFirst: vi.fn() },
    member: { findFirst: vi.fn() },
    musicAssignment: { findMany: vi.fn() },
    musicPiece: { findFirst: vi.fn() },
    musicPart: { findFirst: vi.fn() },
    musicFile: { findFirst: vi.fn() },
    audioLink: { findFirst: vi.fn() },
    event: { findFirst: vi.fn() },
    attendance: { findFirst: vi.fn() },
  },
}));

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock('@/lib/auth/permissions', () => ({
  getUserRoles: vi.fn().mockResolvedValue(['MUSICIAN']),
}));

vi.mock('@/lib/stand/settings', () => ({
  getStandSettings: vi.fn().mockResolvedValue({ accessPolicy: 'any_member', offlineEnabled: true }),
}));

vi.mock('@/lib/services/storage', () => ({
  downloadFile: vi.fn(),
}));

vi.mock('@/lib/stand/telemetry', () => ({
  recordTelemetry: vi.fn(),
}));

// Watermarking is covered for real in ./watermark.test.ts. Here it would reject
// the synthetic PDF bytes these tests use, and the header is the subject.
vi.mock('@/lib/music/watermark-delivery', () => ({
  applyDeliveryWatermarkStream: vi.fn(async ({ stream }: { stream: NodeJS.ReadableStream }) => ({
    bytes: new Uint8Array(Buffer.from('%PDF-1.7 body')),
    size: 15,
    stream,
  })),
  needsWatermark: () => false,
  WatermarkError: class WatermarkError extends Error {},
}));

import { GET } from '@/app/api/stand/files/[...key]/route';
import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db';

const mockAuth = auth as unknown as { api: { getSession: ReturnType<typeof vi.fn> } };

/** Wire a signed-in plain member with the given assignments. */
function asMember(
  assignments: Array<{ partId: string | null }>,
  roles: string[] = ['MUSICIAN']
) {
  mockAuth.api.getSession.mockResolvedValue({ user: { id: 'user-1' } });
  // StandAccessContext reads roles via getUserRoles, the global-role probe via
  // prisma.userRole.findFirst. Keep both consistent.
  vi.mocked(prisma.userRole.findFirst).mockResolvedValue(null);
  vi.mocked(prisma.member.findFirst).mockResolvedValue({
    id: 'member-1',
    sections: [],
  } as never);
  vi.mocked(prisma.musicAssignment.findMany).mockResolvedValue(
    assignments.map((a) => ({ partId: a.partId })) as never
  );
  return roles;
}

function request(query: string): NextRequest {
  return new NextRequest(`http://localhost:3000/api/stand/files/music/trumpet-1.pdf${query}`);
}

const params = Promise.resolve({ key: ['music', 'trumpet-1.pdf'] });

describe('Stand file proxy authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.musicPiece.findFirst).mockResolvedValue({
      isArchived: false,
      deletedAt: null,
    } as never);
    vi.mocked(prisma.event.findFirst).mockResolvedValue({ id: 'event-1' } as never);
  });

  it('returns 404 with no scope at all', async () => {
    asMember([]);
    const res = await GET(request(''), { params });
    expect(res.status).toBe(404);
  });

  it('returns 401 with no session', async () => {
    mockAuth.api.getSession.mockResolvedValue(null);
    const res = await GET(request('?pieceId=piece-1'), { params });
    expect(res.status).toBe(401);
  });

  it('rejects path traversal', async () => {
    asMember([]);
    const res = await GET(request('?pieceId=piece-1'), {
      params: Promise.resolve({ key: ['..', '..', 'etc', 'passwd'] }),
    });
    expect(res.status).toBe(400);
  });

  it('DENIES an active member with no assignment in library mode', async () => {
    asMember([]);
    // The file genuinely belongs to the piece — that is not the question.
    vi.mocked(prisma.musicFile.findFirst).mockResolvedValue({
      id: 'file-1',
      pieceId: 'piece-1',
    } as never);
    // It resolves to part-1, which this member is not assigned.
    vi.mocked(prisma.musicPart.findFirst)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'part-1' } as never);

    const res = await GET(request('?pieceId=piece-1'), { params });
    expect(res.status).toBe(404);
  });

  it('DENIES a sibling part to a member assigned a different part', async () => {
    asMember([{ partId: 'part-trumpet-2' }]);
    vi.mocked(prisma.musicFile.findFirst).mockResolvedValue({
      id: 'file-1',
      pieceId: 'piece-1',
    } as never);
    // storageKey is not itself a MusicPart key; the file links to part-1.
    vi.mocked(prisma.musicPart.findFirst)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'part-1' } as never);

    const res = await GET(request('?pieceId=piece-1'), { params });
    expect(res.status).toBe(404);
  });

  it('DENIES archived music to a plain member', async () => {
    asMember([{ partId: null }]);
    vi.mocked(prisma.musicPiece.findFirst).mockResolvedValue({
      isArchived: true,
      deletedAt: null,
    } as never);
    vi.mocked(prisma.musicFile.findFirst).mockResolvedValue({
      id: 'file-1',
      pieceId: 'piece-1',
    } as never);

    const res = await GET(request('?pieceId=piece-1'), { params });
    expect(res.status).toBe(404);
  });

  it('does not stream the file when access is denied', async () => {
    const { downloadFile } = await import('@/lib/services/storage');
    asMember([]);
    vi.mocked(prisma.musicFile.findFirst).mockResolvedValue({
      id: 'file-1',
      pieceId: 'piece-1',
    } as never);
    vi.mocked(prisma.musicPart.findFirst).mockResolvedValue({
      id: 'part-1',
      pieceId: 'piece-1',
    } as never);

    const res = await GET(request('?pieceId=piece-1'), { params });
    expect(res.status).toBe(404);
    expect(downloadFile).not.toHaveBeenCalled();
  });
});

/**
 * Offline opt-in header.
 *
 * `shouldCacheScoreResponse` in @/lib/stand/offline only stores a score the
 * server explicitly marked. Until now no route set that header, so the entire
 * offline-score path was dead code. Marking a response is therefore only safe
 * under strict conditions: a DENIED response must never carry it, or the next
 * requester could be served a cached 404 page (or, worse, a cached login page
 * from a redirect) as if it were a score.
 */
describe('offline cache opt-in header', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.musicPiece.findFirst).mockResolvedValue({
      isArchived: false,
      deletedAt: null,
    } as never);
    vi.mocked(prisma.event.findFirst).mockResolvedValue({ id: 'event-1' } as never);
  });

  it('never marks a DENIED response cacheable', async () => {
    asMember([]);
    vi.mocked(prisma.musicFile.findFirst).mockResolvedValue({
      id: 'file-1',
      pieceId: 'piece-1',
    } as never);
    vi.mocked(prisma.musicPart.findFirst)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'part-1' } as never);

    const res = await GET(request('?pieceId=piece-1'), { params });
    expect(res.status).toBe(404);
    expect(res.headers.get(OFFLINE_CACHE_HEADER)).toBeNull();
    expect(res.headers.get(OFFLINE_USER_HEADER)).toBeNull();
  });

  it('never marks an unauthenticated response cacheable', async () => {
    mockAuth.api.getSession.mockResolvedValue(null);
    const res = await GET(request('?pieceId=piece-1'), { params });
    expect(res.status).toBe(401);
    expect(res.headers.get(OFFLINE_CACHE_HEADER)).toBeNull();
  });

  it('never marks a redirect-to-login cacheable', async () => {
    asMember([{ partId: null }]);
    const { downloadFile } = await import('@/lib/services/storage');
    vi.mocked(prisma.musicFile.findFirst).mockResolvedValue({
      id: 'file-1',
      pieceId: 'piece-1',
    } as never);
    // S3 driver: the local-stream branch is skipped entirely, so the route
    // answers with a 307 to a presigned URL instead of PDF bytes.
    vi.mocked(downloadFile).mockResolvedValue('https://s3.example.org/presigned.pdf');

    const res = await GET(request('?pieceId=piece-1'), { params });
    expect(res.status).toBe(307);
    expect(res.headers.get(OFFLINE_CACHE_HEADER)).toBeNull();
  });

  it('marks an authorized 200 PDF cacheable and names its owner', async () => {
    asMember([{ partId: null }]);
    const { downloadFile } = await import('@/lib/services/storage');
    vi.mocked(prisma.musicFile.findFirst).mockResolvedValue({
      id: 'file-1',
      pieceId: 'piece-1',
    } as never);
    vi.mocked(downloadFile).mockResolvedValue({
      stream: Readable.from(Buffer.from('%PDF-1.7 body')),
      metadata: { contentType: 'application/pdf', size: 15 },
    } as never);

    const res = await GET(request('?pieceId=piece-1'), { params });
    expect(res.status).toBe(200);
    expect(res.headers.get(OFFLINE_CACHE_HEADER)).toBe('true');
    expect(res.headers.get(OFFLINE_USER_HEADER)).toBe('user-1');
  });

  it('does not mark a non-PDF response cacheable', async () => {
    asMember([{ partId: null }]);
    const { downloadFile } = await import('@/lib/services/storage');
    vi.mocked(prisma.musicFile.findFirst).mockResolvedValue({
      id: 'file-1',
      pieceId: 'piece-1',
    } as never);
    vi.mocked(downloadFile).mockResolvedValue({
      stream: Readable.from(Buffer.from('{}')),
      metadata: { contentType: 'application/json', size: 2 },
    } as never);

    const res = await GET(request('?pieceId=piece-1'), { params });
    expect(res.status).toBe(200);
    expect(res.headers.get(OFFLINE_CACHE_HEADER)).toBeNull();
  });

  it('does not mark cacheable when the admin setting disables offline', async () => {
    const { getStandSettings } = await import('@/lib/stand/settings');
    vi.mocked(getStandSettings).mockResolvedValue({
      accessPolicy: 'any_member',
      offlineEnabled: false,
    } as never);

    asMember([{ partId: null }]);
    const { downloadFile } = await import('@/lib/services/storage');
    vi.mocked(prisma.musicFile.findFirst).mockResolvedValue({
      id: 'file-1',
      pieceId: 'piece-1',
    } as never);
    vi.mocked(downloadFile).mockResolvedValue({
      stream: Readable.from(Buffer.from('%PDF-1.7 body')),
      metadata: { contentType: 'application/pdf', size: 15 },
    } as never);

    const res = await GET(request('?pieceId=piece-1'), { params });
    expect(res.status).toBe(200);
    expect(res.headers.get(OFFLINE_CACHE_HEADER)).toBeNull();
  });
});