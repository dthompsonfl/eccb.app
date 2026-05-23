import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// =============================================================================
// Mock Setup - All mocks must be defined before any imports
// =============================================================================

const mockGetSession = vi.hoisted(() => vi.fn());
const mockCheckUserPermission = vi.hoisted(() => vi.fn());
const mockApplyRateLimit = vi.hoisted(() => vi.fn());
const mockValidateCSRF = vi.hoisted(() => vi.fn());

// Mock dependencies
vi.mock('@/lib/auth/guards', () => ({
  getSession: mockGetSession,
}));

vi.mock('@/lib/auth/permissions', () => ({
  checkUserPermission: mockCheckUserPermission,
}));

vi.mock('@/lib/rate-limit', () => ({
  applyRateLimit: mockApplyRateLimit,
}));

vi.mock('@/lib/csrf', () => ({
  validateCSRF: mockValidateCSRF,
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    smartUploadSession: {
      create: vi.fn(),
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
    musicFile: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
    systemSetting: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  },
}));

vi.mock('@/lib/services/storage', () => ({
  uploadFile: vi.fn().mockResolvedValue('smart-upload/test-uuid/original.pdf'),
  validateFileMagicBytes: vi.fn().mockReturnValue(true),
}));

vi.mock('@/lib/smart-upload/duplicate-detection', () => ({
  computeSha256: vi.fn().mockReturnValue('a'.repeat(64)),
}));

vi.mock('@/lib/smart-upload/runtime-config', () => ({
  loadSmartUploadRuntimeConfig: vi.fn().mockResolvedValue({
    provider: 'openai',
    visionModel: 'gpt-4o',
    verificationModel: 'gpt-4o-mini',
    enableFullyAutonomousMode: false,
    maxPagesPerPart: 12,
    autonomousApprovalThreshold: 85,
    localOcrEnabled: true,
    ocrConfidenceThreshold: 60,
    maxFileSizeMb: 50,
    // In the test environment (Node.js Fetch API), File.type may round-trip
    // as '' when parsed back from a NextRequest's multipart body.
    // Include '' here so validation passes and we can test deeper logic.
    allowedMimeTypes: ['application/pdf'],
  }),
  loadSmartUploadSettingsSnapshot: vi.fn().mockResolvedValue({
    source: 'SystemSetting',
    schema: 'smart-upload-runtime-config/v1',
    keys: {},
    hash: 'test-settings-hash',
    capturedAt: '2026-01-01T00:00:00.000Z',
  }),
  buildSmartUploadSettingsSnapshotSummary: vi.fn().mockReturnValue({
    source: 'SystemSetting',
    schema: 'smart-upload-runtime-config/v1',
    hash: 'test-settings-hash',
    capturedAt: '2026-01-01T00:00:00.000Z',
  }),

}));

vi.mock('@/lib/jobs/smart-upload', () => ({
  queueSmartUploadProcess: vi.fn().mockResolvedValue(undefined),
  queueSmartUploadSecondPass: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/lib/services/pdf-renderer', () => ({
  renderPdfToImage: vi.fn().mockResolvedValue('base64-image-data'),
}));

vi.mock('@/lib/services/ocr-fallback', () => ({
  generateOCRFallback: vi.fn().mockReturnValue({
    title: 'test',
    confidence: 10,
    isImageScanned: true,
    needsManualReview: true,
  }),
}));

vi.mock('@/lib/services/pdf-splitter', () => ({
  splitPdfByCuttingInstructions: vi.fn().mockResolvedValue([]),
}));

// Mock pdf-lib dynamically imported in route
vi.mock('pdf-lib', () => ({
  PDFDocument: {
    load: vi.fn().mockResolvedValue({
      getPageCount: () => 1,
    }),
  },
}));

// Mock global fetch for LLM calls
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock crypto.randomUUID
Object.defineProperty(global, 'crypto', {
  value: {
    randomUUID: () => 'test-uuid-1234',
  },
});

// Import after mocks
import { OPTIONS, POST } from '../route';
import { prisma } from '@/lib/db';
import { computeSha256 } from '@/lib/smart-upload/duplicate-detection';
import { validateFileMagicBytes } from '@/lib/services/storage';

// =============================================================================
// Test Setup
// =============================================================================

const _TEST_USER_ID = 'test-user-1';

/** Build a minimal multipart POST request with a fake PDF file.
 * We use a raw multipart binary body (not a FormData object) to ensure
 * the file.type = 'application/pdf' is preserved correctly across the
 * Node.js Fetch API boundary in the test environment.
 */
function buildUploadRequest(filename = 'Test Score.pdf'): NextRequest {
  const boundary = '----FormBoundaryECCBTest12345';
  // Minimal valid %PDF magic bytes
  const pdfBytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: application/pdf\r\n\r\n`
    ),
    pdfBytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return new NextRequest('http://localhost:3000/api/files/smart-upload', {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
  });
}

// =============================================================================
// Test Suite
// =============================================================================

describe('Smart Upload API Route', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default mock implementations
    mockValidateCSRF.mockReturnValue({ valid: true });
    mockApplyRateLimit.mockResolvedValue(null);
    mockCheckUserPermission.mockResolvedValue(true);
    mockGetSession.mockResolvedValue({ user: { id: _TEST_USER_ID, role: 'ADMIN' } });

    // No duplicate sessions/files by default
    vi.mocked(prisma.smartUploadSession.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.smartUploadSession.findMany).mockResolvedValue([]);
    vi.mocked(prisma.musicFile.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.smartUploadSession.create).mockResolvedValue({
      uploadSessionId: 'test-uuid-1234',
      fileName: 'Test Score.pdf',
    } as any);

    // Re-apply implementations reset by previous test cycles
    vi.mocked(validateFileMagicBytes).mockReturnValue(true);

    // Default LLM response
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        message: {
          content: JSON.stringify({
            title: 'Test Piece',
            composer: 'Test Composer',
            confidenceScore: 95,
            fileType: 'FULL_SCORE',
            isMultiPart: false,
          }),
        },
      }),
    });
  });

  // Note: beforeEach calls vi.clearAllMocks() which resets call history.
  // We do NOT call vi.resetAllMocks() here because that would wipe mock implementations
  // (e.g. validateFileMagicBytes.mockReturnValue(true)) set in the vi.mock() factories.

  // ===========================================================================
  // OPTIONS Handler Tests
  // ===========================================================================

  describe('OPTIONS Handler', () => {
    it('should return 204 with correct CORS headers', async () => {
      const response = await OPTIONS();

      expect(response.status).toBe(204);
      expect(response.headers.get('Access-Control-Allow-Methods')).toBe(
        'POST, OPTIONS'
      );
      expect(response.headers.get('Access-Control-Allow-Headers')).toBe(
        'Content-Type, Authorization'
      );
    });
  });

  // ===========================================================================
  // Authentication & Authorization Tests
  // ===========================================================================

  describe('Authentication Guards', () => {
    it('returns 401 when session is absent', async () => {
      mockGetSession.mockResolvedValue(null);
      const response = await POST(buildUploadRequest());
      expect(response.status).toBe(401);
    });

    it('returns 403 when user lacks MUSIC_UPLOAD permission', async () => {
      mockCheckUserPermission.mockResolvedValue(false);
      const response = await POST(buildUploadRequest());
      expect(response.status).toBe(403);
    });
  });

  // ===========================================================================
  // Duplicate Detection Tests (409)
  // ===========================================================================

  describe('Duplicate Detection', () => {
    it('returns 409 when an existing committed MusicFile matches the SHA-256', async () => {
      vi.mocked(prisma.smartUploadSession.findMany).mockResolvedValue([
        { uploadSessionId: 'old-session-id' } as any,
      ]);
      vi.mocked(prisma.musicFile.findFirst).mockResolvedValue({
        id: 'mf-1',
        pieceId: 'piece-1',
        piece: { title: 'Amparito Roca' },
      } as any);

      const response = await POST(buildUploadRequest('Amparito Roca.pdf'));
      const body = await response.json();

      expect(response.status).toBe(409);
      expect(body.duplicate).toBe(true);
      expect(body.reason).toBe('exact_duplicate');
      expect(body.existingPiece?.title).toBe('Amparito Roca');
    });

    it('returns 409 when a pending (non-REJECTED) session with same SHA-256 exists', async () => {
      vi.mocked(prisma.musicFile.findFirst).mockResolvedValue(null);
      vi.mocked(prisma.smartUploadSession.findFirst).mockResolvedValue({
        uploadSessionId: 'existing-session',
        status: 'PENDING_REVIEW',
        fileName: 'Festive Overture.pdf',
        createdAt: new Date('2026-02-01T00:00:00Z'),
      } as any);

      const response = await POST(buildUploadRequest('Festive Overture.pdf'));
      const body = await response.json();

      expect(response.status).toBe(409);
      expect(body.duplicate).toBe(true);
      expect(body.reason).toBe('pending_session');
      expect(body.existingSession?.status).toBe('PENDING_REVIEW');
    });

    it('returns 409 with approved_session reason for APPROVED sessions', async () => {
      vi.mocked(prisma.musicFile.findFirst).mockResolvedValue(null);
      vi.mocked(prisma.smartUploadSession.findFirst).mockResolvedValue({
        uploadSessionId: 'existing-session',
        status: 'APPROVED',
        fileName: 'March USA250.pdf',
        createdAt: new Date('2026-02-10T00:00:00Z'),
      } as any);

      const response = await POST(buildUploadRequest('March USA250.pdf'));
      const body = await response.json();

      expect(response.status).toBe(409);
      expect(body.duplicate).toBe(true);
      expect(body.reason).toBe('approved_session');
      expect(body.existingSession?.reviewUrl).toContain('/admin/uploads/review');
    });

    it('allows re-upload when existing session is REJECTED', async () => {
      vi.mocked(prisma.musicFile.findFirst).mockResolvedValue(null);
      // findFirst returns REJECTED session → should be allowed through
      vi.mocked(prisma.smartUploadSession.findFirst).mockResolvedValue({
        uploadSessionId: 'rejected-session',
        status: 'REJECTED',
        fileName: 'Test Score.pdf',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      } as any);

      const response = await POST(buildUploadRequest());

      // Should not be a 409 — rejected files may be re-uploaded
      expect(response.status).not.toBe(409);
    });

    it('stores sourceSha256 in the session create call', async () => {
      // SHA-256 returns deterministic string from mock
      const fakeSha = 'a'.repeat(64);
      vi.mocked(computeSha256).mockReturnValue(fakeSha);

      await POST(buildUploadRequest());

      const createCall = vi.mocked(prisma.smartUploadSession.create).mock.calls[0]?.[0];
      expect(createCall?.data?.sourceSha256).toBe(fakeSha);
    });

    it('sets llmCallCount to 0 on new session', async () => {
      await POST(buildUploadRequest());

      const createCall = vi.mocked(prisma.smartUploadSession.create).mock.calls[0]?.[0];
      expect(createCall?.data?.llmCallCount).toBe(0);
    });
  });

  // ===========================================================================
  // CSRF / Rate Limit Tests
  // ===========================================================================

  describe('CSRF Validation', () => {
    it('returns 403 when CSRF validation fails', async () => {
      mockValidateCSRF.mockReturnValue({ valid: false, reason: 'token_mismatch' });
      const response = await POST(buildUploadRequest());
      expect(response.status).toBe(403);
    });
  });

  describe('Rate Limiting', () => {
    it('returns rate-limit response when limit is hit', async () => {
      mockApplyRateLimit.mockResolvedValue(
        new Response('Too Many Requests', { status: 429 })
      );
      const response = await POST(buildUploadRequest());
      expect(response.status).toBe(429);
    });
  });
});
