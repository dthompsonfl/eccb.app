import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { checkUserPermission, getUserPermissions, getUserRoles } from '../permissions';
import { prisma } from '@/lib/db';
import { redis } from '@/lib/redis';

// Mock dependencies
vi.mock('@/lib/db', () => ({
  prisma: {
    userRole: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock('@/lib/redis', () => ({
  redis: {
    get: vi.fn(),
    setex: vi.fn(),
  },
}));

describe('Permission System', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('checkUserPermission', () => {
    it('should return true when user has the permission', async () => {
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
  });

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

    it('should deduplicate permissions', async () => {
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
              { permission: { name: 'music.view.all' } },
              { permission: { name: 'member.view.own' } },
            ],
          },
        },
      ] as any);

      const result = await getUserPermissions('user-123');

      expect(result.filter((p) => p === 'music.view.all')).toHaveLength(1);
      expect(result).toHaveLength(3);
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
  });

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
  });
});

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
    expect(isValidPermission('music:read')).toBe(false); // Legacy alias, not canonical
    expect(isValidPermission('')).toBe(false);
    expect(isValidPermission('music')).toBe(false); // Missing action
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
});
