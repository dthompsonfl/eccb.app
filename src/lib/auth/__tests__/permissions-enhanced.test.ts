import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { checkUserPermission, getUserPermissions, getUserRoles, requirePermission, requireRole } from '../permissions';
import { prisma } from '@/lib/db';
import { redis } from '@/lib/redis';

// Mock dependencies
vi.mock('@/lib/db', () => ({
  prisma: {
    userRole: {
      findMany: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('@/lib/redis', () => ({
  redis: {
    get: vi.fn(),
    setex: vi.fn(),
  },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock('@/lib/auth/config', () => ({
  auth: {
    api: {
      getSession: vi.fn(),
    },
  },
}));

describe('Permission System - Enhanced Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  // ===========================================================================
  // checkUserPermission Tests
  // ===========================================================================

  describe('checkUserPermission', () => {
    it('should return true when user has the exact permission', async () => {
      vi.mocked(redis.get).mockResolvedValue(JSON.stringify(['music.view.all', 'music.create', 'member.view.own']));

      const result = await checkUserPermission('user-123', 'music.view.all');

      expect(result).toBe(true);
    });

    it('should return false when user does not have the permission', async () => {
      vi.mocked(redis.get).mockResolvedValue(JSON.stringify(['music.view.assigned', 'member.view.own']));

      const result = await checkUserPermission('user-123', 'music.view.all');

      expect(result).toBe(false);
    });

    it('should return false when user has no permissions', async () => {
      vi.mocked(redis.get).mockResolvedValue(JSON.stringify([]));

      const result = await checkUserPermission('user-123', 'music.view.all');

      expect(result).toBe(false);
    });

    it('should return false for invalid permission strings', async () => {
      vi.mocked(redis.get).mockResolvedValue(JSON.stringify(['music.view.all']));

      // Test with malformed permission strings
      expect(await checkUserPermission('user-123', '')).toBe(false);
      expect(await checkUserPermission('user-123', 'invalid')).toBe(false);
      // Legacy aliases normalize to canonical permissions during migration.
      expect(await checkUserPermission('user-123', 'music:read')).toBe(true);
    });

    it('should handle permission check with wildcard-like patterns', async () => {
      // Note: The system doesn't support wildcards, but we test the behavior
      vi.mocked(redis.get).mockResolvedValue(JSON.stringify(['music.view.all']));

      // Should not match partial strings
      expect(await checkUserPermission('user-123', 'music.view')).toBe(false);
      expect(await checkUserPermission('user-123', 'music.view.all.extra')).toBe(false);
    });
  });

  // ===========================================================================
  // getUserPermissions Tests
  // ===========================================================================

  describe('getUserPermissions', () => {
    it('should return cached permissions when available', async () => {
      const cachedPermissions = ['music.view.all', 'music.create'];
      vi.mocked(redis.get).mockResolvedValue(JSON.stringify(cachedPermissions));

      const result = await getUserPermissions('user-123');

      expect(result).toEqual(cachedPermissions);
      expect(prisma.userRole.findMany).not.toHaveBeenCalled();
    });

    it('should fetch from database when cache is empty', async () => {
      vi.mocked(redis.get).mockResolvedValue(null);
      vi.mocked(prisma.userRole.findMany).mockResolvedValue([
        {
          role: {
            permissions: [
              { permission: { name: 'music.view.all' } },
              { permission: { name: 'music.create' } },
            ],
          },
        },
      ] as any);

      const result = await getUserPermissions('user-123');

      expect(result).toContain('music.view.all');
      expect(result).toContain('music.create');
      expect(redis.setex).toHaveBeenCalled();
    });

    it('should deduplicate permissions from multiple roles', async () => {
      vi.mocked(redis.get).mockResolvedValue(null);
      vi.mocked(prisma.userRole.findMany).mockResolvedValue([
        {
          role: {
            permissions: [
              { permission: { name: 'music.view.all' } },
              { permission: { name: 'music.create' } },
            ],
          },
        },
        {
          role: {
            permissions: [
              { permission: { name: 'music.view.all' } }, // Duplicate
              { permission: { name: 'member.view.own' } },
            ],
          },
        },
      ] as any);

      const result = await getUserPermissions('user-123');

      expect(result.filter((p) => p === 'music.view.all')).toHaveLength(1);
      expect(result).toHaveLength(3);
      expect(result).toContain('music.view.all');
      expect(result).toContain('music.create');
      expect(result).toContain('member.view.own');
    });

    it('should handle redis errors gracefully', async () => {
      vi.mocked(redis.get).mockRejectedValue(new Error('Redis connection error'));
      vi.mocked(prisma.userRole.findMany).mockResolvedValue([
        {
          role: {
            permissions: [{ permission: { name: 'music.view.all' } }],
          },
        },
      ] as any);

      const result = await getUserPermissions('user-123');

      expect(result).toContain('music.view.all');
    });

    it('should handle redis setex errors gracefully', async () => {
      vi.mocked(redis.get).mockResolvedValue(null);
      vi.mocked(redis.setex).mockRejectedValue(new Error('Redis write error'));
      vi.mocked(prisma.userRole.findMany).mockResolvedValue([
        {
          role: {
            permissions: [{ permission: { name: 'music.view.all' } }],
          },
        },
      ] as any);

      // Should not throw
      const result = await getUserPermissions('user-123');
      expect(result).toContain('music.view.all');
    });

    it('should return empty array for user with no roles', async () => {
      vi.mocked(redis.get).mockResolvedValue(null);
      vi.mocked(prisma.userRole.findMany).mockResolvedValue([]);

      const result = await getUserPermissions('user-123');

      expect(result).toEqual([]);
    });

    it('should return empty array for user with roles but no permissions', async () => {
      vi.mocked(redis.get).mockResolvedValue(null);
      vi.mocked(prisma.userRole.findMany).mockResolvedValue([
        {
          role: {
            permissions: [],
          },
        },
      ] as any);

      const result = await getUserPermissions('user-123');

      expect(result).toEqual([]);
    });

    it('should filter out expired role assignments', async () => {
      vi.mocked(redis.get).mockResolvedValue(null);
      (prisma.userRole.findMany as any).mockImplementation(async (args: any) => {
        // The actual implementation filters by expiresAt
        // This tests that the query is correct
        expect(args.where.OR).toContainEqual({ expiresAt: null });
        expect(args.where.OR).toContainEqual({ expiresAt: { gt: expect.any(Date) } });
        return [];
      });

      await getUserPermissions('user-123');
    });

    it('should cache permissions with correct TTL (5 minutes = 300 seconds)', async () => {
      vi.mocked(redis.get).mockResolvedValue(null);
      vi.mocked(prisma.userRole.findMany).mockResolvedValue([
        {
          role: {
            permissions: [{ permission: { name: 'music.view.all' } }],
          },
        },
      ] as any);

      await getUserPermissions('user-123');

      expect(redis.setex).toHaveBeenCalledWith(
        'permissions:user-123',
        300,
        expect.any(String)
      );
    });
  });

  // ===========================================================================
  // getUserRoles Tests
  // ===========================================================================

  describe('getUserRoles', () => {
    it('should return cached roles when available', async () => {
      const cachedRoles = ['ADMIN', 'LIBRARIAN'];
      vi.mocked(redis.get).mockResolvedValue(JSON.stringify(cachedRoles));

      const result = await getUserRoles('user-123');

      expect(result).toEqual(cachedRoles);
      expect(prisma.userRole.findMany).not.toHaveBeenCalled();
    });

    it('should fetch roles from database when cache is empty', async () => {
      vi.mocked(redis.get).mockResolvedValue(null);
      vi.mocked(prisma.userRole.findMany).mockResolvedValue([
        { role: { name: 'ADMIN' } },
        { role: { name: 'LIBRARIAN' } },
      ] as any);

      const result = await getUserRoles('user-123');

      expect(result).toContain('ADMIN');
      expect(result).toContain('LIBRARIAN');
      expect(redis.setex).toHaveBeenCalled();
    });

    it('should return empty array for user with no roles', async () => {
      vi.mocked(redis.get).mockResolvedValue(null);
      vi.mocked(prisma.userRole.findMany).mockResolvedValue([]);

      const result = await getUserRoles('user-123');

      expect(result).toEqual([]);
    });

    it('should handle multiple roles with same name (deduplication)', async () => {
      vi.mocked(redis.get).mockResolvedValue(null);
      vi.mocked(prisma.userRole.findMany).mockResolvedValue([
        { role: { name: 'MEMBER' } },
        { role: { name: 'MEMBER' } }, // Duplicate
      ] as any);

      const result = await getUserRoles('user-123');

      // Note: Current implementation doesn't deduplicate roles
      // This test documents the current behavior
      expect(result).toEqual(['MEMBER', 'MEMBER']);
    });
  });

  // ===========================================================================
  // requirePermission Tests
  // ===========================================================================

  describe('requirePermission', () => {
    it('should throw error when user is not authenticated', async () => {
      const { auth } = await import('@/lib/auth/config');
      vi.mocked(auth.api.getSession).mockResolvedValue(null);

      await expect(requirePermission('music.view.all')).rejects.toThrow('Unauthorized');
    });

    it('should throw error when user lacks required permission', async () => {
      const { auth } = await import('@/lib/auth/config');
      vi.mocked(auth.api.getSession).mockResolvedValue({
        user: { id: 'user-123' },
        session: { id: 'session-123' },
      } as any);
      vi.mocked(redis.get).mockResolvedValue(JSON.stringify(['music.view.assigned']));

      await expect(requirePermission('music.view.all')).rejects.toThrow('Forbidden');
    });

    it('should not throw when user has required permission', async () => {
      const { auth } = await import('@/lib/auth/config');
      vi.mocked(auth.api.getSession).mockResolvedValue({
        user: { id: 'user-123' },
        session: { id: 'session-123' },
      } as any);
      vi.mocked(redis.get).mockResolvedValue(JSON.stringify(['music.view.all']));

      // Should not throw
      await expect(requirePermission('music.view.all')).resolves.toBeUndefined();
    });
  });

  // ===========================================================================
  // requireRole Tests
  // ===========================================================================

  describe('requireRole', () => {
    it('should throw error when user is not authenticated', async () => {
      const { auth } = await import('@/lib/auth/config');
      vi.mocked(auth.api.getSession).mockResolvedValue(null);

      await expect(requireRole('ADMIN')).rejects.toThrow('Unauthorized');
    });

    it('should throw error when user lacks required role', async () => {
      const { auth } = await import('@/lib/auth/config');
      vi.mocked(auth.api.getSession).mockResolvedValue({
        user: { id: 'user-123' },
        session: { id: 'session-123' },
      } as any);
      vi.mocked(redis.get).mockResolvedValue(JSON.stringify(['MEMBER']));

      await expect(requireRole('ADMIN')).rejects.toThrow('Forbidden');
    });

    it('should not throw when user has required role', async () => {
      const { auth } = await import('@/lib/auth/config');
      vi.mocked(auth.api.getSession).mockResolvedValue({
        user: { id: 'user-123' },
        session: { id: 'session-123' },
      } as any);
      vi.mocked(redis.get).mockResolvedValue(JSON.stringify(['ADMIN', 'MEMBER']));

      // Should not throw
      await expect(requireRole('ADMIN')).resolves.toBeUndefined();
    });
  });

  // ===========================================================================
  // Edge Cases and Security Tests
  // ===========================================================================

  describe('Edge Cases and Security', () => {
    it('should handle very long user IDs', async () => {
      const longUserId = 'a'.repeat(1000);
      vi.mocked(redis.get).mockResolvedValue(null);
      vi.mocked(prisma.userRole.findMany).mockResolvedValue([]);

      const result = await getUserPermissions(longUserId);

      expect(result).toEqual([]);
      expect(redis.get).toHaveBeenCalledWith(`permissions:${longUserId}`);
    });

    it('should handle special characters in user IDs', async () => {
      const specialUserId = 'user-123:with-special.chars';
      vi.mocked(redis.get).mockResolvedValue(null);
      vi.mocked(prisma.userRole.findMany).mockResolvedValue([]);

      const result = await getUserPermissions(specialUserId);

      expect(result).toEqual([]);
    });

    it('should handle concurrent permission checks for same user', async () => {
      vi.mocked(redis.get).mockResolvedValue(null);
      vi.mocked(prisma.userRole.findMany).mockResolvedValue([
        {
          role: {
            permissions: [{ permission: { name: 'music.view.all' } }],
          },
        },
      ] as any);

      // Simulate concurrent requests
      const results = await Promise.all([
        getUserPermissions('user-123'),
        getUserPermissions('user-123'),
        getUserPermissions('user-123'),
      ]);

      // All should return the same result
      expect(results[0]).toEqual(results[1]);
      expect(results[1]).toEqual(results[2]);
    });

    it('should handle malformed cached data', async () => {
      vi.mocked(redis.get).mockResolvedValue('not valid json');
      vi.mocked(prisma.userRole.findMany).mockResolvedValue([
        {
          role: {
            permissions: [{ permission: { name: 'music.view.all' } }],
          },
        },
      ] as any);

      // Should fall back to database
      const result = await getUserPermissions('user-123');
      expect(result).toContain('music.view.all');
    });
  });
});

// =============================================================================
// Permission Constants Tests
// =============================================================================

describe('Permission Constants', () => {
  it('should have consistent permission naming format', async () => {
    const { ALL_PERMISSIONS, isValidPermission } = await import('../permission-constants');

    // All permissions should follow the pattern: resource.action.scope or resource.action
    for (const permission of ALL_PERMISSIONS) {
      const parts = permission.split('.');
      expect(parts.length).toBeGreaterThanOrEqual(2);
      expect(parts.length).toBeLessThanOrEqual(3);

      // Each part should be lowercase
      for (const part of parts) {
        expect(part).toBe(part.toLowerCase());
      }

      // isValidPermission should return true for all permissions in ALL_PERMISSIONS
      expect(isValidPermission(permission)).toBe(true);
    }
  });

  it('should correctly identify invalid permissions', async () => {
    const { isValidPermission } = await import('../permission-constants');

    expect(isValidPermission('invalid.permission')).toBe(false);
    expect(isValidPermission('music:read')).toBe(false); // Legacy aliases are not canonical permissions
    expect(isValidPermission('')).toBe(false);
    expect(isValidPermission('music')).toBe(false); // Missing action
    expect(isValidPermission('MUSIC.VIEW.ALL')).toBe(false); // Uppercase
  });

  it('should normalize legacy permission aliases without adding them to canonical permissions', async () => {
    const { normalizePermission } = await import('../permission-constants');

    expect(normalizePermission('music:read')).toBe('music.view.all');
    expect(normalizePermission('members:update')).toBe('member.edit.all');
    expect(normalizePermission('unknown:legacy')).toBe('unknown:legacy');
  });

  it('should have all expected permission groups', async () => {
    const {
      MUSIC_PERMISSIONS,
      MEMBER_PERMISSIONS,
      EVENT_PERMISSIONS,
      ATTENDANCE_PERMISSIONS,
      CMS_PERMISSIONS,
      COMMUNICATION_PERMISSIONS,
      ADMIN_PERMISSIONS,
    } = await import('../permission-constants');

    expect(MUSIC_PERMISSIONS.length).toBeGreaterThan(0);
    expect(MEMBER_PERMISSIONS.length).toBeGreaterThan(0);
    expect(EVENT_PERMISSIONS.length).toBeGreaterThan(0);
    expect(ATTENDANCE_PERMISSIONS.length).toBeGreaterThan(0);
    expect(CMS_PERMISSIONS.length).toBeGreaterThan(0);
    expect(COMMUNICATION_PERMISSIONS.length).toBeGreaterThan(0);
    expect(ADMIN_PERMISSIONS.length).toBeGreaterThan(0);
  });

  it('should have unique permissions across all groups', async () => {
    const { ALL_PERMISSIONS } = await import('../permission-constants');

    const uniquePermissions = new Set(ALL_PERMISSIONS);
    expect(uniquePermissions.size).toBe(ALL_PERMISSIONS.length);
  });

  it('should have download permissions with correct hierarchy', async () => {
    const { MUSIC_DOWNLOAD_ALL, MUSIC_DOWNLOAD_ASSIGNED } = await import('../permission-constants');

    // These should be distinct permissions
    expect(MUSIC_DOWNLOAD_ALL).toBe('music.download.all');
    expect(MUSIC_DOWNLOAD_ASSIGNED).toBe('music.download.assigned');
    expect(MUSIC_DOWNLOAD_ALL).not.toBe(MUSIC_DOWNLOAD_ASSIGNED);
  });
});
