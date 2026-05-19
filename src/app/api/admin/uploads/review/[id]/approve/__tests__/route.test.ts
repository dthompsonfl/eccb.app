import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// =============================================================================
// Mock Setup - All mocks must be defined before any imports
// =============================================================================

// Hoisted mock functions that will be shared between mock definition and tests
const mockGetSession = vi.hoisted(() => vi.fn());
const mockRequirePermission = vi.hoisted(() => vi.fn());
const mockFindUnique = vi.hoisted(() => vi.fn());
const mockTransaction = vi.hoisted(() => vi.fn());
const mockCommitSmartUploadSession = vi.hoisted(() => vi.fn());

// Transaction mock functions
const mockTxPersonFindFirst = vi.hoisted(() => vi.fn().mockResolvedValue(null));
const mockTxPersonCreate = vi.hoisted(() => vi.fn().mockResolvedValue({ id: 'composer-1', fullName: 'John Philip Sousa' }));
const mockTxPublisherFindUnique = vi.hoisted(() => vi.fn().mockResolvedValue(null));
const mockTxPublisherCreate = vi.hoisted(() => vi.fn().mockResolvedValue({ id: 'publisher-1', name: 'Test Publisher' }));
const mockTxMusicPieceCreate = vi.hoisted(() => vi.fn().mockResolvedValue({ id: 'piece-1', title: 'Stars and Stripes Forever' }));
const mockTxMusicFileCreate = vi.hoisted(() => vi.fn().mockResolvedValue({ id: 'file-1', fileName: 'test.pdf', storageKey: 'test-key' }));
const mockTxInstrumentFindFirst = vi.hoisted(() => vi.fn().mockResolvedValue(null));
const mockTxInstrumentCreate = vi.hoisted(() => vi.fn().mockResolvedValue({ id: 'instrument-1', name: 'Flute' }));
const mockTxMusicPartCreate = vi.hoisted(() => vi.fn().mockResolvedValue({ id: 'part-1' }));
const mockTxSmartUploadSessionUpdate = vi.hoisted(() => vi.fn());

// Mock transaction object
const mockTx = {
  person: {
    findFirst: mockTxPersonFindFirst,
    create: mockTxPersonCreate,
  },
  publisher: {
    findUnique: mockTxPublisherFindUnique,
    create: mockTxPublisherCreate,
  },
  musicPiece: {
    create: mockTxMusicPieceCreate,
  },
  musicFile: {
    create: mockTxMusicFileCreate,
  },
  instrument: {
    findFirst: mockTxInstrumentFindFirst,
    create: mockTxInstrumentCreate,
  },
  musicPart: {
    create: mockTxMusicPartCreate,
  },
  smartUploadSession: {
    update: mockTxSmartUploadSessionUpdate,
  },
};

// Mock dependencies
vi.mock('@/lib/auth/guards', () => ({
  getSession: mockGetSession,
}));

vi.mock('@/lib/auth/permissions', () => ({
  requirePermission: mockRequirePermission,
}));

vi.mock('@/lib/services/storage', () => ({
  downloadFile: vi.fn(),
  uploadFile: vi.fn(),
  deleteFile: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    smartUploadSession: {
      findUnique: mockFindUnique,
    },
    $transaction: mockTransaction,
  },
}));

vi.mock('@/lib/smart-upload/commit', () => ({
  commitSmartUploadSessionToLibrary: mockCommitSmartUploadSession,
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/lib/csrf', () => ({
  validateCSRF: vi.fn().mockReturnValue({ valid: true }),
}));

// Import after mocks are set up
import { POST, OPTIONS } from '../route';

// =============================================================================
// Types
// =============================================================================

interface ExtractedMetadata {
  title: string;
  composer?: string;
  publisher?: string;
  instrument?: string;
  confidenceScore: number;
}

// =============================================================================
// Test Setup
// =============================================================================

const TEST_USER_ID = 'admin-user-1';
const SESSION_ID = 'upload-session-uuid-1';

// =============================================================================
// Helper Functions
// =============================================================================

function createMockSession(userId: string = TEST_USER_ID): any {
  return {
    user: {
      id: userId,
      email: 'admin@example.com',
      name: 'Admin User',
    },
  };
}

function createMockSessionData(overrides: Partial<any> = {}): any {
  return {
    id: 'db-session-id-1',
    uploadSessionId: SESSION_ID,
    fileName: 'test.pdf',
    fileSize: 1024,
    mimeType: 'application/pdf',
    storageKey: 'smart-upload/test-uuid/original.pdf',
    extractedMetadata: {
      title: 'Stars and Stripes Forever',
      composer: 'John Philip Sousa',
      confidenceScore: 95,
    } as ExtractedMetadata,
    confidenceScore: 95,
    status: 'PENDING_REVIEW',
    uploadedBy: 'user-1',
    reviewedBy: null,
    reviewedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// =============================================================================
// Test Suite
// =============================================================================

describe('Approve Upload Session API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset transaction mock to default behavior
    mockTransaction.mockImplementation(async (callback: (tx: typeof mockTx) => Promise<unknown>) => callback(mockTx));
    mockRequirePermission.mockResolvedValue(true);
    // Default commit mock returns a successful result
    mockCommitSmartUploadSession.mockResolvedValue({
      musicPieceId: 'piece-1',
      musicPieceTitle: 'Stars and Stripes Forever',
      musicFileId: 'file-1',
      partsCommitted: 1,
    });
  });

  // ===========================================================================
  // Authentication Tests
  // ===========================================================================

  describe('Authentication', () => {
    it('should return 401 when no session exists', async () => {
      mockGetSession.mockResolvedValue(null);

      const request = new NextRequest('http://localhost/api/admin/uploads/review/session-1/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Test Piece' }),
      });

      const params = Promise.resolve({ id: SESSION_ID });
      const response = await POST(request, { params });
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error).toBe('Unauthorized');
    });

    it('should return 401 when session has no user id', async () => {
      mockGetSession.mockResolvedValue({ user: null });

      const request = new NextRequest('http://localhost/api/admin/uploads/review/session-1/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Test Piece' }),
      });

      const params = Promise.resolve({ id: SESSION_ID });
      const response = await POST(request, { params });
      const _data = await response.json();

      expect(response.status).toBe(401);
    });
  });

  // ===========================================================================
  // Permission Tests
  // ===========================================================================

  describe('Permissions', () => {
    it('should return 500 when user lacks music:create permission', async () => {
      mockGetSession.mockResolvedValue(createMockSession());
      mockRequirePermission.mockRejectedValue(new Error('Permission denied'));

      const request = new NextRequest('http://localhost/api/admin/uploads/review/session-1/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Test Piece' }),
      });

      const params = Promise.resolve({ id: SESSION_ID });
      const response = await POST(request, { params });

      expect(response.status).toBe(500);
    });
  });

  // ===========================================================================
  // Validation Tests
  // ===========================================================================

  describe('Validation', () => {
    it('should return 400 when title is missing', async () => {
      mockGetSession.mockResolvedValue(createMockSession());
      mockFindUnique.mockResolvedValue(createMockSessionData());

      const request = new NextRequest('http://localhost/api/admin/uploads/review/session-1/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}), // Missing title
      });

      const params = Promise.resolve({ id: SESSION_ID });
      const response = await POST(request, { params });
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe('Validation error');
    });

    it('should return 400 when title is empty', async () => {
      mockGetSession.mockResolvedValue(createMockSession());
      mockFindUnique.mockResolvedValue(createMockSessionData());

      const request = new NextRequest('http://localhost/api/admin/uploads/review/session-1/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '' }),
      });

      const params = Promise.resolve({ id: SESSION_ID });
      const response = await POST(request, { params });
      const _data = await response.json();

      expect(response.status).toBe(400);
    });
  });

  // ===========================================================================
  // Session Not Found Tests
  // ===========================================================================

  describe('Session Not Found', () => {
    it('should return 404 when session does not exist', async () => {
      mockGetSession.mockResolvedValue(createMockSession());
      mockFindUnique.mockResolvedValue(null);

      const request = new NextRequest('http://localhost/api/admin/uploads/review/session-1/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Test Piece' }),
      });

      const params = Promise.resolve({ id: 'non-existent-id' });
      const response = await POST(request, { params });
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error).toBe('Upload session not found');
    });

    it('should return 400 when session is not pending review', async () => {
      mockGetSession.mockResolvedValue(createMockSession());
      mockFindUnique.mockResolvedValue(createMockSessionData({ status: 'APPROVED' }));

      const request = new NextRequest('http://localhost/api/admin/uploads/review/session-1/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Test Piece' }),
      });

      const params = Promise.resolve({ id: SESSION_ID });
      const response = await POST(request, { params });
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe('Session is not awaiting review');
    });
  });

  // ===========================================================================
  // Successful Approval Tests
  // ===========================================================================

  describe('Successful Approval', () => {
    it('should successfully approve a pending session', async () => {
      mockGetSession.mockResolvedValue(createMockSession());
      // First call: status check (must be PENDING_REVIEW)
      mockFindUnique.mockResolvedValueOnce(createMockSessionData());
      // Second call: post-commit fetch for response
      mockFindUnique.mockResolvedValueOnce({
        status: 'APPROVED',
        reviewedAt: new Date(),
      });

      const request = new NextRequest('http://localhost/api/admin/uploads/review/session-1/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Stars and Stripes Forever',
          composer: 'John Philip Sousa',
        }),
      });

      const params = Promise.resolve({ id: SESSION_ID });
      const response = await POST(request, { params });
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.session.status).toBe('APPROVED');
      expect(mockCommitSmartUploadSession).toHaveBeenCalledWith(
        SESSION_ID,
        expect.objectContaining({ title: 'Stars and Stripes Forever', composer: 'John Philip Sousa' }),
        TEST_USER_ID,
      );
    });

    it('should approve session with all optional fields', async () => {
      mockGetSession.mockResolvedValue(createMockSession());
      // First call: status check (must be PENDING_REVIEW)
      mockFindUnique.mockResolvedValueOnce(createMockSessionData());
      // Second call: post-commit fetch for response
      mockFindUnique.mockResolvedValueOnce({
        status: 'APPROVED',
        reviewedAt: new Date(),
      });

      const request = new NextRequest('http://localhost/api/admin/uploads/review/session-1/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Test Piece',
          composer: 'Test Composer',
          publisher: 'Test Publisher',
          instrument: 'Concert Band',
          partNumber: 'Full Score',
          difficulty: 'Grade 4',
        }),
      });

      const params = Promise.resolve({ id: SESSION_ID });
      const response = await POST(request, { params });
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
    });
  });

  // ===========================================================================
  // Database Error Tests
  // ===========================================================================

  describe('Database Errors', () => {
    it('should return 500 when database update fails', async () => {
      mockGetSession.mockResolvedValue(createMockSession());
      mockFindUnique.mockResolvedValue(createMockSessionData());
      mockCommitSmartUploadSession.mockRejectedValue(new Error('Database error'));

      const request = new NextRequest('http://localhost/api/admin/uploads/review/session-1/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Test Piece' }),
      });

      const params = Promise.resolve({ id: SESSION_ID });
      const response = await POST(request, { params });
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.error).toBe('Failed to approve upload session');
    });
  });

  // ===========================================================================
  // OPTIONS Handler Tests
  // ===========================================================================

  describe('OPTIONS Handler', () => {
    it('should return 204 with correct CORS headers', async () => {
      const response = await OPTIONS();

      expect(response.status).toBe(204);
      expect(response.headers.get('Access-Control-Allow-Methods')).toBe('POST, OPTIONS');
    });
  });
});
