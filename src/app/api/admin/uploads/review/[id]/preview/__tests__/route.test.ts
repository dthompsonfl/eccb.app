import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// Mocks
const mockGetSession = vi.hoisted(() => vi.fn());
const mockRequirePermission = vi.hoisted(() => vi.fn());
const mockFindUnique = vi.hoisted(() => vi.fn());
const mockDownloadFile = vi.hoisted(() => vi.fn());
const mockRender = vi.hoisted(() => vi.fn());

vi.mock('@/lib/auth/guards', () => ({
  getSession: mockGetSession,
}));
vi.mock('@/lib/auth/permissions', () => ({
  checkUserPermission: mockRequirePermission,
}));
vi.mock('@/lib/db', () => ({
  prisma: {
    smartUploadSession: {
      findUnique: mockFindUnique,
    },
  },
}));
vi.mock('@/lib/services/storage', () => ({
  downloadFile: mockDownloadFile,
}));
vi.mock('@/lib/services/pdf-renderer', () => ({
  renderPdfPageToImageWithInfo: mockRender,
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Import after mocks
import { GET } from '../route';

const SESSION_ID = 'session-1';
const TEST_USER = { user: { id: 'admin' } };

function makeRequest(query: string) {
  return new NextRequest(`http://localhost/api/admin/uploads/review/${SESSION_ID}/preview${query}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSession.mockResolvedValue(TEST_USER);
  mockRequirePermission.mockResolvedValue(true);
  mockFindUnique.mockResolvedValue({
    uploadSessionId: SESSION_ID,
    storageKey: 'smart-upload/foo/original.pdf',
  });
  mockDownloadFile.mockResolvedValue('http://download/url');

  // stub fetch for downloading PDFs
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    arrayBuffer: async () => new ArrayBuffer(0),
  }));
});

describe('Preview route', () => {
  it('returns 400 when page index is out of range (caught in catch)', async () => {
    mockRender.mockRejectedValue(new Error('Page index 5 out of range')); // simulate pdfjs error

    const response = await GET(makeRequest('?page=5'), { params: Promise.resolve({ id: SESSION_ID }) });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Preview generation failed');
  });

  it('returns image data when render succeeds', async () => {
    mockRender.mockResolvedValue({
      imageBase64: 'data',
      totalPages: 3,
      mimeType: 'image/png',
    });

    const response = await GET(makeRequest('?page=1'), { params: Promise.resolve({ id: SESSION_ID }) });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.imageBase64).toBe('data');
    expect(body.totalPages).toBe(3);
  });
});
