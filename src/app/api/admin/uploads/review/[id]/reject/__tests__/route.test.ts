import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dependencies before importing the route module
vi.mock('@/lib/auth/guards', () => ({
  getSession: vi.fn(),
}));

vi.mock('@/lib/auth/permissions', () => ({
  requirePermission: vi.fn().mockResolvedValue(true),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    smartUploadSession: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    musicFile: {
      findFirst: vi.fn(),
    },
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/lib/services/smart-upload-cleanup', () => ({
  cleanupSmartUploadTempFiles: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/csrf', () => ({
  validateCSRF: vi.fn().mockReturnValue({ valid: true }),
}));

// Mock rate limit — always allow. The route applies the real
// applyRateLimit() (src/lib/rate-limit.ts) to this admin mutation;
// stubbing it here keeps the suite off Redis, matching the pattern
// used by the other rate-limited route tests.
vi.mock('@/lib/rate-limit', () => ({
  applyRateLimit: vi.fn().mockResolvedValue(null),
}));

import { NextRequest } from 'next/server';

// We'll dynamically import the route module inside beforeEach so that
// mocks (especially csrf) have been applied.  Declare placeholders here.
let POST: typeof import('../route').POST;
let OPTIONS: typeof import('../route').OPTIONS;

import { getSession } from '@/lib/auth/guards';
import { requirePermission } from '@/lib/auth/permissions';
import { prisma } from '@/lib/db';

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
    },
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

describe('Reject Upload Session API', () => {
  beforeEach(async () => {
    // reset implementations and call counts to ensure each test is isolated
    vi.resetAllMocks();

    // restore basic mock behavior
    vi.mocked(requirePermission).mockResolvedValue(true);
    const csrfMod = await import('@/lib/csrf');
    vi.mocked(csrfMod.validateCSRF).mockReturnValue({ valid: true });

    // re-import the route after resetting mocks so the imported version
    // picks up our mocked dependencies (csrf, db, etc.).
    const mod = await import('../route');
    POST = mod.POST;
    OPTIONS = mod.OPTIONS;
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  // ===========================================================================
  // Authentication Tests
  // ===========================================================================

  describe('Authentication', () => {
    it('should return 401 when no session exists', async () => {
      vi.mocked(getSession).mockResolvedValue(null);

      const request = new NextRequest('http://localhost/api/admin/uploads/review/session-1/reject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Test rejection' }),
      });

      const params = Promise.resolve({ id: SESSION_ID });
      const response = await POST(request, { params });
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error).toBe('Unauthorized');
    });

    it('should return 401 when session has no user id', async () => {
      vi.mocked(getSession).mockResolvedValue({ user: null } as any);

      const request = new NextRequest('http://localhost/api/admin/uploads/review/session-1/reject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Test rejection' }),
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
    it('should return 500 when user lacks music:edit permission', async () => {
      vi.mocked(getSession).mockResolvedValue(createMockSession());
      vi.mocked(requirePermission).mockRejectedValue(new Error('Permission denied'));

      const request = new NextRequest('http://localhost/api/admin/uploads/review/session-1/reject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Test rejection' }),
      });

      const params = Promise.resolve({ id: SESSION_ID });
      const response = await POST(request, { params });

      expect(response.status).toBe(500);
    });
  });

  // ===========================================================================
  // Session Not Found Tests
  // ===========================================================================

  describe('Session Not Found', () => {
    it('should return 404 when session does not exist', async () => {
      vi.mocked(getSession).mockResolvedValue(createMockSession());
      vi.mocked(prisma.smartUploadSession.findUnique).mockResolvedValue(null);

      const request = new NextRequest('http://localhost/api/admin/uploads/review/session-1/reject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Test rejection' }),
      });

      const params = Promise.resolve({ id: 'non-existent-id' });
      const response = await POST(request, { params });
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error).toBe('Upload session not found');
    });

    it('should return 400 when session is not pending review', async () => {
      vi.mocked(getSession).mockResolvedValue(createMockSession());
      vi.mocked(prisma.smartUploadSession.findUnique).mockResolvedValue(
        createMockSessionData({ status: 'APPROVED' })
      );

      const request = new NextRequest('http://localhost/api/admin/uploads/review/session-1/reject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Test rejection' }),
      });

      const params = Promise.resolve({ id: SESSION_ID });
      const response = await POST(request, { params });
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe('Session is not pending review');
    });
  });

  // ===========================================================================
  // Successful Rejection Tests
  // ===========================================================================

  describe('Successful Rejection', () => {
    it('should successfully reject a pending session with reason', async () => {
      vi.mocked(getSession).mockResolvedValue(createMockSession());
      vi.mocked(prisma.smartUploadSession.findUnique).mockResolvedValue(
        createMockSessionData()
      );
      vi.mocked(prisma.musicFile.findFirst).mockResolvedValue(null);
      vi.mocked(prisma.smartUploadSession.update).mockResolvedValue({
        ...createMockSessionData(),
        status: 'REJECTED',
        reviewedBy: TEST_USER_ID,
        reviewedAt: new Date(),
        routingDecision: 'REJECTED: Poor scan quality',
      });

      const request = new NextRequest('http://localhost/api/admin/uploads/review/session-1/reject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Poor scan quality' }),
      });

      const params = Promise.resolve({ id: SESSION_ID });
      const response = await POST(request, { params });
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.session.status).toBe('REJECTED');
      expect(prisma.smartUploadSession.update).toHaveBeenCalledWith({
        where: { uploadSessionId: SESSION_ID },
        data: {
          status: 'REJECTED',
          reviewedBy: TEST_USER_ID,
          reviewedAt: expect.any(Date),
          routingDecision: 'REJECTED: Poor scan quality',
        },
      });
    });

    it('should successfully reject without reason', async () => {
      vi.mocked(getSession).mockResolvedValue(createMockSession());
      vi.mocked(prisma.smartUploadSession.findUnique).mockResolvedValue(
        createMockSessionData()
      );
      vi.mocked(prisma.musicFile.findFirst).mockResolvedValue(null);
      vi.mocked(prisma.smartUploadSession.update).mockResolvedValue({
        ...createMockSessionData(),
        status: 'REJECTED',
        reviewedBy: TEST_USER_ID,
        reviewedAt: new Date(),
      });

      const request = new NextRequest('http://localhost/api/admin/uploads/review/session-1/reject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      const params = Promise.resolve({ id: SESSION_ID });
      const response = await POST(request, { params });
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
    });
  });

  // ===========================================================================
  // Status Transition Tests
  // ===========================================================================

  describe('Status Transitions', () => {
    it('should reject a PENDING_REVIEW session', async () => {
      vi.mocked(getSession).mockResolvedValue(createMockSession());
      vi.mocked(prisma.smartUploadSession.findUnique).mockResolvedValue(
        createMockSessionData({ status: 'PENDING_REVIEW' })
      );
      vi.mocked(prisma.musicFile.findFirst).mockResolvedValue(null);
      vi.mocked(prisma.smartUploadSession.update).mockResolvedValue({
        ...createMockSessionData(),
        status: 'REJECTED',
        reviewedBy: TEST_USER_ID,
        reviewedAt: new Date(),
      });

      const request = new NextRequest('http://localhost/api/admin/uploads/review/session-1/reject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Test' }),
      });

      const params = Promise.resolve({ id: SESSION_ID });
      const response = await POST(request, { params });
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.session.status).toBe('REJECTED');
    });

    it('should reject already REJECTED session', async () => {
      vi.mocked(getSession).mockResolvedValue(createMockSession());
      vi.mocked(prisma.smartUploadSession.findUnique).mockResolvedValue(
        createMockSessionData({ status: 'REJECTED' })
      );

      const request = new NextRequest('http://localhost/api/admin/uploads/review/session-1/reject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Test' }),
      });

      const params = Promise.resolve({ id: SESSION_ID });
      const response = await POST(request, { params });
      const _data = await response.json();

      expect(response.status).toBe(400);
    });
  });

  // ===========================================================================
  // Database Error Tests
  // ===========================================================================

  describe('Database Errors', () => {
    it('should return 500 when database update fails', async () => {
      vi.mocked(getSession).mockResolvedValue(createMockSession());
      vi.mocked(prisma.smartUploadSession.findUnique).mockResolvedValue(
        createMockSessionData()
      );
      vi.mocked(prisma.musicFile.findFirst).mockResolvedValue(null);
      vi.mocked(prisma.smartUploadSession.update).mockRejectedValue(
        new Error('Database error')
      );

      const request = new NextRequest('http://localhost/api/admin/uploads/review/session-1/reject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Test' }),
      });

      const params = Promise.resolve({ id: SESSION_ID });
      const response = await POST(request, { params });
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.error).toBe('Failed to reject upload session');
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
