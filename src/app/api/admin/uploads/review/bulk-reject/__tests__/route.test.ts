import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

let POST: typeof import('../route').POST;
let OPTIONS: typeof import('../route').OPTIONS;

// Mock dependencies
vi.mock('@/lib/auth/guards', () => ({
  getSession: vi.fn(),
  requirePermission: vi.fn().mockResolvedValue(true),
}));

vi.mock('@/lib/csrf', () => ({
  validateCSRF: vi.fn().mockReturnValue({ valid: true }),
}));

vi.mock('@/lib/auth/permissions', () => ({
  requirePermission: vi.fn().mockResolvedValue(true),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    smartUploadSession: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
    musicFile: {
      findMany: vi.fn(),
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

// Mock rate limit — always allow. The route applies the real
// applyRateLimit() (src/lib/rate-limit.ts) to this admin mutation;
// stubbing it here keeps the suite off Redis, matching the pattern
// used by the other rate-limited route tests.
vi.mock('@/lib/rate-limit', () => ({
  applyRateLimit: vi.fn().mockResolvedValue(null),
}));

import { getSession } from '@/lib/auth/guards';
import { prisma } from '@/lib/db';
import { cleanupSmartUploadTempFiles } from '@/lib/services/smart-upload-cleanup';

// =============================================================================
// Test Setup
// =============================================================================

const TEST_USER_ID = 'admin-user-1';

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

// =============================================================================
// Test Suite
// =============================================================================

describe('Bulk Reject Upload Sessions API', () => {
  beforeEach(async () => {
    vi.resetAllMocks();

    // restore mocks that resetAllMocks cleared
    const csrfMod = await import('@/lib/csrf');
    vi.mocked(csrfMod.validateCSRF).mockReturnValue({ valid: true });

    // restore permission mock to always succeed
    const guards = await import('@/lib/auth/guards');
    if (guards.requirePermission) {
      vi.mocked(guards.requirePermission).mockResolvedValue(true);
    }

    const mod = await import('../route');
    POST = mod.POST;
    OPTIONS = mod.OPTIONS;
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('Authentication & Authorization', () => {
    it('should return 401 when no session exists', async () => {
      vi.mocked(getSession).mockResolvedValue(null);

      const request = new NextRequest('http://localhost/api/admin/uploads/review/bulk-reject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionIds: ['s1'], reason: 'Test' }),
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error).toBe('Unauthorized');
    });
  });

  describe('Validation', () => {
    it('should return 400 for empty sessionIds array', async () => {
      vi.mocked(getSession).mockResolvedValue(createMockSession());

      const request = new NextRequest('http://localhost/api/admin/uploads/review/bulk-reject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionIds: [], reason: 'Test' }),
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe('Validation error');
    });

    it('should return 400 if no pending sessions are found', async () => {
      vi.mocked(getSession).mockResolvedValue(createMockSession());
      vi.mocked(prisma.smartUploadSession.findMany).mockResolvedValue([]);

      const request = new NextRequest('http://localhost/api/admin/uploads/review/bulk-reject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionIds: ['non-existent'], reason: 'Test' }),
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe('No pending sessions found for the provided IDs');
    });
  });

  describe('Bulk Rejection Logic', () => {
    it('should successfully reject multiple sessions using bulk operations', async () => {
      vi.mocked(getSession).mockResolvedValue(createMockSession());

      const sessions = [
        { uploadSessionId: 's1', status: 'PENDING_REVIEW' },
        { uploadSessionId: 's2', status: 'PENDING_REVIEW' },
      ];
      vi.mocked(prisma.smartUploadSession.findMany).mockResolvedValue(sessions as any);
      vi.mocked(prisma.musicFile.findMany).mockResolvedValue([]);
      vi.mocked(prisma.smartUploadSession.updateMany).mockResolvedValue({ count: 2 } as any);

      const request = new NextRequest('http://localhost/api/admin/uploads/review/bulk-reject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionIds: ['s1', 's2'], reason: 'Bad quality' }),
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.rejected).toBe(2);

      // Verify batch operations
      expect(prisma.musicFile.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.smartUploadSession.updateMany).toHaveBeenCalledTimes(1);

      // Verify cleanup was called for each successfully rejected session in parallel
      expect(cleanupSmartUploadTempFiles).toHaveBeenCalledTimes(2);
      expect(cleanupSmartUploadTempFiles).toHaveBeenCalledWith('s1');
      expect(cleanupSmartUploadTempFiles).toHaveBeenCalledWith('s2');
    });

    it('should skip sessions that are already committed using bulk check', async () => {
      vi.mocked(getSession).mockResolvedValue(createMockSession());

      const sessions = [
        { uploadSessionId: 's1', status: 'PENDING_REVIEW' },
        { uploadSessionId: 's2', status: 'PENDING_REVIEW' },
      ];
      vi.mocked(prisma.smartUploadSession.findMany).mockResolvedValue(sessions as any);

      // Mock findMany to show s1 is committed
      vi.mocked(prisma.musicFile.findMany).mockResolvedValue([
        { originalUploadId: 's1' }
      ] as any);

      vi.mocked(prisma.smartUploadSession.updateMany).mockResolvedValue({ count: 1 } as any);

      const request = new NextRequest('http://localhost/api/admin/uploads/review/bulk-reject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionIds: ['s1', 's2'], reason: 'Bulk skip test' }),
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.rejected).toBe(1);
      expect(data.skipped).toBe(1);
      expect(data.rejectedIds).toEqual(['s2']);
      expect(data.skippedDetails[0].id).toBe('s1');

      // updateMany should only target s2
      expect(prisma.smartUploadSession.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { uploadSessionId: { in: ['s2'] } }
      }));

      // Cleanup should only be called for s2
      expect(cleanupSmartUploadTempFiles).toHaveBeenCalledTimes(1);
      expect(cleanupSmartUploadTempFiles).toHaveBeenCalledWith('s2');
    });
  });

  describe('OPTIONS Handler', () => {
    it('should return 204 with correct CORS headers', async () => {
      const response = await OPTIONS();

      expect(response.status).toBe(204);
      expect(response.headers.get('Access-Control-Allow-Methods')).toBe('POST, OPTIONS');
    });
  });
});
