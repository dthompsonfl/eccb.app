/**
 * @vitest-environment node
 *
 * Route tests for the OMR endpoint's authorization and full-score behaviour.
 *
 * The defect being locked down: the route used to self-fetch
 * `/api/files/<storageKey>` without the caller's session, which 401s for exactly
 * the private scores OMR is most often run against, and the GET path exposed
 * extracted metadata to any signed-in user who knew a file id.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetSession = vi.hoisted(() => vi.fn());
const mockGetUserRoles = vi.hoisted(() => vi.fn());
const mockApplyRateLimit = vi.hoisted(() => vi.fn());
const mockCanAccessFile = vi.hoisted(() => vi.fn());
const mockDownloadFile = vi.hoisted(() => vi.fn());
const mockFindUnique = vi.hoisted(() => vi.fn());
const mockMusicFileUpdate = vi.hoisted(() => vi.fn());
const mockMusicPieceUpdate = vi.hoisted(() => vi.fn());

vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers()) }));

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: mockGetSession } },
}));

vi.mock('@/lib/auth/permissions', () => ({
  getUserRoles: mockGetUserRoles,
}));

vi.mock('@/lib/rate-limit', () => ({ applyRateLimit: mockApplyRateLimit }));
vi.mock('@/lib/stand/access', () => ({ canAccessFile: mockCanAccessFile }));
vi.mock('@/lib/services/storage', () => ({ downloadFile: mockDownloadFile }));

vi.mock('@/lib/smart-upload/runtime-config', () => ({
  loadSmartUploadRuntimeConfig: vi.fn(async () => ({
    provider: 'openai',
    openaiApiKey: 'sk-test',
    visionModel: 'gpt-4o',
    endpointUrl: 'https://api.openai.com/v1',
  })),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    musicFile: { findUnique: mockFindUnique, update: mockMusicFileUpdate },
    musicPiece: { update: mockMusicPieceUpdate },
  },
}));

import { GET, POST } from '@/app/api/stand/omr/route';

const FILE = {
  id: 'file-1',
  storageKey: 'music/abc/secret-part.pdf',
  pieceId: 'piece-1',
  extractedMetadata: JSON.stringify({ tempo: 120, keySignature: 'C major' }),
};

function getRequest(query = '?musicFileId=file-1') {
  return new Request(`http://localhost/api/stand/omr${query}`) as never;
}

function postRequest(body: unknown) {
  return new Request('http://localhost/api/stand/omr', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  }) as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSession.mockResolvedValue({ user: { id: 'user-1' } });
  mockGetUserRoles.mockResolvedValue(['DIRECTOR']);
  mockApplyRateLimit.mockResolvedValue(null);
  mockFindUnique.mockResolvedValue(FILE);
  mockCanAccessFile.mockResolvedValue(true);
  mockMusicFileUpdate.mockResolvedValue({});
  mockMusicPieceUpdate.mockResolvedValue({});
});

describe('GET /api/stand/omr — object-level authorization', () => {
  it('returns metadata for an authorized user', async () => {
    const res = await GET(getRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.processed).toBe(true);
    expect(body.metadata.tempo).toBe(120);
  });

  it('refuses an unauthorized user', async () => {
    mockCanAccessFile.mockResolvedValue(false);
    const res = await GET(getRequest());
    expect(res.status).toBe(404);
  });

  it('does not leak metadata to an unauthorized user', async () => {
    mockCanAccessFile.mockResolvedValue(false);
    const res = await GET(getRequest());
    const text = await res.text();
    expect(text).not.toContain('keySignature');
    expect(text).not.toContain('C major');
  });

  it('returns 404 rather than 403 so ids cannot be probed', async () => {
    mockCanAccessFile.mockResolvedValue(false);
    const res = await GET(getRequest());
    const body = await res.json();
    expect(body.error).toBe('Music file not found');
  });

  it('still requires authentication', async () => {
    mockGetSession.mockResolvedValue(null);
    const res = await GET(getRequest());
    expect(res.status).toBe(401);
  });

  it('checks authorization BEFORE returning cached metadata', async () => {
    // The cached branch must not be a way around the access check.
    mockCanAccessFile.mockResolvedValue(false);
    const res = await GET(getRequest());
    expect(res.status).toBe(404);
  });
});

describe('POST /api/stand/omr — authorization and storage access', () => {
  it('reads the score through the storage layer, not a self-fetch', async () => {
    mockFindUnique.mockResolvedValue({ ...FILE, extractedMetadata: null });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    // The provider call is stubbed to fail fast; we only assert HOW the bytes
    // were obtained, which is the defect being fixed.
    await POST(postRequest({ musicFileId: 'file-1' }));

    expect(mockDownloadFile).toHaveBeenCalledWith('music/abc/secret-part.pdf');
    // No internal HTTP round-trip to /api/files/<key>.
    const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('/api/files/'))).toBe(false);
    vi.unstubAllGlobals();
  });

  it('refuses to process a file the user cannot access', async () => {
    mockFindUnique.mockResolvedValue({ ...FILE, extractedMetadata: null });
    mockCanAccessFile.mockResolvedValue(false);

    const res = await POST(postRequest({ musicFileId: 'file-1' }));

    expect(res.status).toBe(404);
    // The bytes were never read.
    expect(mockDownloadFile).not.toHaveBeenCalled();
  });

  it('does not expose cached metadata to an unauthorized user', async () => {
    mockCanAccessFile.mockResolvedValue(false);
    const res = await POST(postRequest({ musicFileId: 'file-1' }));
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).not.toContain('C major');
  });

  it('authorizes before serving the cached response', async () => {
    mockCanAccessFile.mockResolvedValue(true);
    const res = await POST(postRequest({ musicFileId: 'file-1' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cached).toBe(true);
  });

  it('reports a storage read failure without leaking internals', async () => {
    mockFindUnique.mockResolvedValue({ ...FILE, extractedMetadata: null });
    mockDownloadFile.mockRejectedValue(new Error('S3 down: bucket music-private'));

    const res = await POST(postRequest({ musicFileId: 'file-1' }));

    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).not.toContain('S3 down');
  });
});
