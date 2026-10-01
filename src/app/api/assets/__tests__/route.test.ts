// Server Route Handler test: run in the Node environment.
//
// Under the global jsdom environment, `File` is jsdom's implementation while
// NextRequest.formData() is undici's, so undici's multipart parser asserts
// `webidl.is.File(value)` and throws for any multipart body. request.formData()
// then rejects and the handler returns 500 instead of the expected 400.
// @vitest-environment node

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

// =============================================================================
// Mock Setup - All mocks must be hoisted before imports
// =============================================================================

const mockMediaAssetFindMany = vi.hoisted(() => vi.fn());
const mockMediaAssetFindUnique = vi.hoisted(() => vi.fn());
const mockMediaAssetCreate = vi.hoisted(() => vi.fn());
const mockMediaAssetUpdate = vi.hoisted(() => vi.fn());
const mockMediaAssetDelete = vi.hoisted(() => vi.fn());
const mockMediaAssetGroupBy = vi.hoisted(() => vi.fn());
const mockMediaAssetCount = vi.hoisted(() => vi.fn());

const mockGetSession = vi.hoisted(() => vi.fn());
const mockCheckUserPermission = vi.hoisted(() => vi.fn());
const mockUploadFile = vi.hoisted(() => vi.fn());
const mockDownloadFile = vi.hoisted(() => vi.fn());
const mockDeleteFile = vi.hoisted(() => vi.fn());
const mockValidateCSRF = vi.hoisted(() => vi.fn());
const mockApplyRateLimit = vi.hoisted(() => vi.fn());

vi.mock('@/lib/db', () => ({
  prisma: {
    mediaAsset: {
      findMany: mockMediaAssetFindMany,
      findUnique: mockMediaAssetFindUnique,
      create: mockMediaAssetCreate,
      update: mockMediaAssetUpdate,
      delete: mockMediaAssetDelete,
      groupBy: mockMediaAssetGroupBy,
      count: mockMediaAssetCount,
    },
  },
}));

vi.mock('@/lib/auth/guards', () => ({
  getSession: mockGetSession,
}));

vi.mock('@/lib/auth/permissions', () => ({
  checkUserPermission: mockCheckUserPermission,
}));

vi.mock('@/lib/services/storage', () => ({
  uploadFile: mockUploadFile,
  downloadFile: mockDownloadFile,
  deleteFile: mockDeleteFile,
  fileExists: vi.fn(),
  validateFileMagicBytes: vi.fn().mockReturnValue(true),
}));

vi.mock('@/lib/rate-limit', () => ({
  applyRateLimit: mockApplyRateLimit,
}));

vi.mock('@/lib/csrf', () => ({
  validateCSRF: mockValidateCSRF,
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Import after mocks
import { GET } from '../route';
import { POST as UPLOAD_POST } from '../upload/route';
import { GET as ASSET_GET, DELETE as ASSET_DELETE, PATCH as ASSET_PATCH } from '../[id]/route';

describe('Assets API', () => {
  const mockUser = {
    id: 'user-123',
    email: 'admin@test.com',
  };

  const mockSession = {
    user: mockUser,
    session: { id: 'session-123' },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(mockSession);
    mockCheckUserPermission.mockResolvedValue(true);
    mockValidateCSRF.mockReturnValue({ valid: true });
    mockApplyRateLimit.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('GET /api/assets', () => {
    it('should return 401 if not authenticated', async () => {
      mockGetSession.mockResolvedValue(null);

      const request = new NextRequest('http://localhost/api/assets');
      const response = await GET(request);

      expect(response.status).toBe(401);
    });

    it('should return 403 if user lacks permission', async () => {
      mockCheckUserPermission.mockResolvedValue(false);

      const request = new NextRequest('http://localhost/api/assets');
      const response = await GET(request);

      expect(response.status).toBe(403);
    });

    it('should return paginated assets', async () => {
      const mockAssets = [
        {
          id: 'asset-1',
          fileName: 'image.jpg',
          fileSize: 1024,
          mimeType: 'image/jpeg',
          storageKey: 'assets/asset-1.jpg',
          title: 'Test Image',
          altText: 'Alt text',
          caption: 'Caption',
          tags: ['tag1'],
          width: 800,
          height: 600,
          uploadedAt: new Date(),
          uploadedBy: 'user-123',
        },
      ];

      mockMediaAssetFindMany.mockResolvedValue(mockAssets);
      mockMediaAssetCount.mockResolvedValue(1);

      const request = new NextRequest('http://localhost/api/assets');
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.assets).toHaveLength(1);
      expect(data.assets[0].fileName).toBe('image.jpg');
      expect(data.pagination.total).toBe(1);
    });

    it('should filter by mime type', async () => {
      mockMediaAssetFindMany.mockResolvedValue([]);
      mockMediaAssetCount.mockResolvedValue(0);

      const request = new NextRequest('http://localhost/api/assets?mimeType=image');
      const response = await GET(request);

      expect(response.status).toBe(200);
      expect(mockMediaAssetFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            mimeType: { startsWith: 'image/' },
          }),
        })
      );
    });

    it('should search by filename and title', async () => {
      mockMediaAssetFindMany.mockResolvedValue([]);
      mockMediaAssetCount.mockResolvedValue(0);

      const request = new NextRequest('http://localhost/api/assets?search=test');
      const response = await GET(request);

      expect(response.status).toBe(200);
      expect(mockMediaAssetFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: expect.arrayContaining([
              { fileName: { contains: 'test' } },
              { title: { contains: 'test' } },
            ]),
          }),
        })
      );
    });
  });

  describe('POST /api/assets/upload', () => {
    it('should return 401 if not authenticated', async () => {
      mockGetSession.mockResolvedValue(null);

      const request = new NextRequest('http://localhost/api/assets/upload', {
        method: 'POST',
      });
      const response = await UPLOAD_POST(request);

      expect(response.status).toBe(401);
    });

    it('should return 403 if user lacks CMS_EDIT permission', async () => {
      mockCheckUserPermission.mockResolvedValue(false);

      const request = new NextRequest('http://localhost/api/assets/upload', {
        method: 'POST',
      });
      const response = await UPLOAD_POST(request);

      expect(response.status).toBe(403);
    });

    it('should return 400 if no file provided', async () => {
      const formData = new FormData();
      const request = new NextRequest('http://localhost/api/assets/upload', {
        method: 'POST',
        body: formData,
      });
      const response = await UPLOAD_POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe('No file provided');
    });

    it('should return 400 for invalid file type', async () => {
      const file = new File(['content'], 'test.exe', { type: 'application/octet-stream' });
      const formData = new FormData();
      formData.append('file', file);

      const request = new NextRequest('http://localhost/api/assets/upload', {
        method: 'POST',
        body: formData,
      });
      const response = await UPLOAD_POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toContain('Invalid file type');
    });
  });

  describe('GET /api/assets/[id]', () => {
    it('should return 404 if asset not found', async () => {
      mockMediaAssetFindUnique.mockResolvedValue(null);

      const request = new NextRequest('http://localhost/api/assets/asset-123');
      const response = await ASSET_GET(request, {
        params: Promise.resolve({ id: 'asset-123' }),
      });

      expect(response.status).toBe(404);
    });

    it('should return asset file', async () => {
      const mockAsset = {
        id: 'asset-123',
        fileName: 'test.jpg',
        fileSize: 1024,
        mimeType: 'image/jpeg',
        storageKey: 'assets/asset-123.jpg',
      };

      mockMediaAssetFindUnique.mockResolvedValue(mockAsset);
      // Return a string (S3 presigned URL) to test the redirect path
      mockDownloadFile.mockResolvedValue('https://s3.example.com/presigned-url');

      const request = new NextRequest('http://localhost/api/assets/asset-123');
      const response = await ASSET_GET(request, {
        params: Promise.resolve({ id: 'asset-123' }),
      });

      // Should redirect to S3 URL (307 Temporary Redirect)
      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toBe('https://s3.example.com/presigned-url');
    });
  });

  describe('DELETE /api/assets/[id]', () => {
    it('should return 401 if not authenticated', async () => {
      mockGetSession.mockResolvedValue(null);

      const request = new NextRequest('http://localhost/api/assets/asset-123', {
        method: 'DELETE',
      });
      const response = await ASSET_DELETE(request, {
        params: Promise.resolve({ id: 'asset-123' }),
      });

      expect(response.status).toBe(401);
    });

    it('should return 404 if asset not found', async () => {
      mockMediaAssetFindUnique.mockResolvedValue(null);

      const request = new NextRequest('http://localhost/api/assets/asset-123', {
        method: 'DELETE',
      });
      const response = await ASSET_DELETE(request, {
        params: Promise.resolve({ id: 'asset-123' }),
      });

      expect(response.status).toBe(404);
    });

    it('should delete asset successfully', async () => {
      const mockAsset = {
        id: 'asset-123',
        fileName: 'test.jpg',
        storageKey: 'assets/asset-123.jpg',
      };

      mockMediaAssetFindUnique.mockResolvedValue(mockAsset);
      mockDeleteFile.mockResolvedValue(undefined);
      mockMediaAssetDelete.mockResolvedValue(mockAsset);

      const request = new NextRequest('http://localhost/api/assets/asset-123', {
        method: 'DELETE',
      });
      const response = await ASSET_DELETE(request, {
        params: Promise.resolve({ id: 'asset-123' }),
      });
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(mockDeleteFile).toHaveBeenCalledWith('assets/asset-123.jpg');
      expect(mockMediaAssetDelete).toHaveBeenCalledWith({
        where: { id: 'asset-123' },
      });
    });
  });

  describe('PATCH /api/assets/[id]', () => {
    it('should update asset metadata', async () => {
      const mockAsset = {
        id: 'asset-123',
        fileName: 'test.jpg',
        title: 'Old Title',
        altText: 'Old Alt',
        caption: 'Old Caption',
        tags: [],
      };

      mockMediaAssetFindUnique.mockResolvedValue(mockAsset);
      mockMediaAssetUpdate.mockResolvedValue({
        ...mockAsset,
        title: 'New Title',
        altText: 'New Alt',
        caption: 'New Caption',
      });

      const request = new NextRequest('http://localhost/api/assets/asset-123', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'New Title',
          altText: 'New Alt',
          caption: 'New Caption',
        }),
      });
      const response = await ASSET_PATCH(request, {
        params: Promise.resolve({ id: 'asset-123' }),
      });
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.asset.title).toBe('New Title');
    });
  });
});
