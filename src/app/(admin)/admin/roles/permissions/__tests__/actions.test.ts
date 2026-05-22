import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getAllPermissions,
  getAllPermissionsList,
  getUserCustomPermissions,
  getUserWithPermissions,
  getUsersWithCustomPermissions,
  getUserEffectivePermissions,
  grantPermission,
  revokePermission,
  batchGrantPermissions,
  batchRevokePermissions,
  searchUsersForPermissions,
} from '../actions';
import { prisma } from '@/lib/db';
import { requirePermission } from '@/lib/auth/guards';
import { auditLog } from '@/lib/services/audit';

import { isValidPermission } from '@/lib/auth/permission-constants';
// Mock dependencies
vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
    },
    permission: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
    userPermission: {
      create: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      createMany: vi.fn(),
    },
  },
}));

vi.mock('@/lib/auth/guards', () => ({
  requirePermission: vi.fn(),
}));

vi.mock('@/lib/services/audit', () => ({
  auditLog: vi.fn(),
}));

vi.mock('@/lib/auth/permission-constants', () => ({
  isValidPermission: vi.fn(),
  ALL_PERMISSIONS: [],
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

describe('Permission Actions', () => {
  const mockSession = {
    user: { id: 'admin-user-id', email: 'admin@test.com' },
    session: { id: 'session-id' },
  };

  const mockUser = {
    id: 'user-1',
    email: 'test@example.com',
    name: 'Test User',
    image: null,
    emailVerified: true,
    createdAt: new Date(),
    member: null,
    roles: [],
    customPermissions: [],
  };

  const mockPermission = {
    id: 'perm-1',
    name: 'music.view',
    resource: 'music',
    action: 'view',
    scope: null,
    description: 'View music library',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockSession as any);
  });

  describe('getAllPermissions', () => {
    it('should require admin.users.manage permission', async () => {
      vi.mocked(prisma.permission.findMany).mockResolvedValue([]);

      await getAllPermissions();

      expect(requirePermission).toHaveBeenCalledWith('admin.users.manage');
    });

    it('should return permissions grouped by resource', async () => {
      const permissions = [
        { ...mockPermission, resource: 'music', name: 'music.view' },
        { ...mockPermission, id: 'perm-2', resource: 'music', name: 'music.edit' },
        { ...mockPermission, id: 'perm-3', resource: 'member', name: 'member.view' },
      ];
      vi.mocked(prisma.permission.findMany).mockResolvedValue(permissions as any);

      const result = await getAllPermissions();

      expect(result).toEqual({
        music: [
          { ...mockPermission, resource: 'music', name: 'music.view' },
          { ...mockPermission, id: 'perm-2', resource: 'music', name: 'music.edit' },
        ],
        member: [
          { ...mockPermission, id: 'perm-3', resource: 'member', name: 'member.view' },
        ],
      });
    });
  });

  describe('getAllPermissionsList', () => {
    it('should require admin.users.manage permission', async () => {
      vi.mocked(prisma.permission.findMany).mockResolvedValue([]);

      await getAllPermissionsList();

      expect(requirePermission).toHaveBeenCalledWith('admin.users.manage');
    });

    it('should return flat list of permissions', async () => {
      const permissions = [mockPermission];
      vi.mocked(prisma.permission.findMany).mockResolvedValue(permissions as any);

      const result = await getAllPermissionsList();

      expect(result).toEqual(permissions);
      expect(prisma.permission.findMany).toHaveBeenCalledWith({
        orderBy: [{ resource: 'asc' }, { action: 'asc' }],
      });
    });
  });

  describe('getUserCustomPermissions', () => {
    it('should require admin.users.manage permission', async () => {
      vi.mocked(prisma.userPermission.findMany).mockResolvedValue([]);

      await getUserCustomPermissions('user-1');

      expect(requirePermission).toHaveBeenCalledWith('admin.users.manage');
    });

    it('should return user custom permissions', async () => {
      const userPermissions = [
        {
          id: 'up-1',
          userId: 'user-1',
          permissionId: 'perm-1',
          grantedAt: new Date(),
          grantedBy: 'admin-id',
          expiresAt: null,
          permission: mockPermission,
        },
      ];
      vi.mocked(prisma.userPermission.findMany).mockResolvedValue(userPermissions as any);

      const result = await getUserCustomPermissions('user-1');

      expect(result).toEqual(userPermissions);
      expect(prisma.userPermission.findMany).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
        include: { permission: true },
        orderBy: { grantedAt: 'desc' },
      });
    });
  });

  describe('getUserWithPermissions', () => {
    it('should require admin.users.manage permission', async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any);

      await getUserWithPermissions('user-1');

      expect(requirePermission).toHaveBeenCalledWith('admin.users.manage');
    });

    it('should return user with roles and custom permissions', async () => {
      const userWithPerms = {
        ...mockUser,
        roles: [],
        customPermissions: [],
      };
      vi.mocked(prisma.user.findUnique).mockResolvedValue(userWithPerms as any);

      const result = await getUserWithPermissions('user-1');

      expect(result).toEqual(userWithPerms);
    });

    it('should return null if user not found', async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

      const result = await getUserWithPermissions('non-existent');

      expect(result).toBeNull();
    });
  });

  describe('getUsersWithCustomPermissions', () => {
    it('should require admin.users.manage permission', async () => {
      vi.mocked(prisma.user.findMany).mockResolvedValue([]);

      await getUsersWithCustomPermissions();

      expect(requirePermission).toHaveBeenCalledWith('admin.users.manage');
    });

    it('should return only users with custom permissions', async () => {
      vi.mocked(prisma.user.findMany).mockResolvedValue([mockUser] as any);

      await getUsersWithCustomPermissions();

      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            deletedAt: null,
            customPermissions: { some: {} },
          },
        })
      );
    });
  });

  describe('getUserEffectivePermissions', () => {
    it('should require admin.users.manage permission', async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue({
        ...mockUser,
        roles: [],
        customPermissions: [],
      } as any);

      await getUserEffectivePermissions('user-1');

      expect(requirePermission).toHaveBeenCalledWith('admin.users.manage');
    });

    it('should return empty map if user not found', async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

      const result = await getUserEffectivePermissions('non-existent');

      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(0);
    });

    it('should combine role and custom permissions', async () => {
      const userWithPerms = {
        ...mockUser,
        roles: [
          {
            id: 'ur-1',
            roleId: 'role-1',
            assignedAt: new Date(),
            expiresAt: null,
            role: {
              id: 'role-1',
              name: 'MUSICIAN',
              displayName: 'Musician',
              type: 'MUSICIAN',
              permissions: [
                {
                  id: 'rp-1',
                  permission: { name: 'music.view' },
                },
              ],
            },
          },
        ],
        customPermissions: [
          {
            id: 'up-1',
            permissionId: 'perm-1',
            grantedAt: new Date(),
            grantedBy: null,
            expiresAt: null,
            permission: { name: 'music.edit' },
          },
        ],
      };
      vi.mocked(prisma.user.findUnique).mockResolvedValue(userWithPerms as any);

      const result = await getUserEffectivePermissions('user-1');

      expect(result.size).toBe(2);
      expect(result.get('music.view')).toEqual({
        source: 'Musician',
        isCustom: false,
      });
      expect(result.get('music.edit')).toEqual({
        source: 'Custom Permission',
        isCustom: true,
      });
    });

    it('should let custom permissions override role permissions', async () => {
      const userWithPerms = {
        ...mockUser,
        roles: [
          {
            id: 'ur-1',
            roleId: 'role-1',
            assignedAt: new Date(),
            expiresAt: null,
            role: {
              id: 'role-1',
              name: 'MUSICIAN',
              displayName: 'Musician',
              type: 'MUSICIAN',
              permissions: [
                {
                  id: 'rp-1',
                  permission: { name: 'music.view' },
                },
              ],
            },
          },
        ],
        customPermissions: [
          {
            id: 'up-1',
            permissionId: 'perm-1',
            grantedAt: new Date(),
            grantedBy: null,
            expiresAt: null,
            permission: { name: 'music.view' },
          },
        ],
      };
      vi.mocked(prisma.user.findUnique).mockResolvedValue(userWithPerms as any);

      const result = await getUserEffectivePermissions('user-1');

      expect(result.size).toBe(1);
      expect(result.get('music.view')).toEqual({
        source: 'Custom Permission',
        isCustom: true,
      });
    });
  });

  describe('grantPermission', () => {
    it('should require admin.users.manage permission', async () => {
      vi.mocked(isValidPermission).mockReturnValue(true);
      vi.mocked(prisma.permission.findUnique).mockResolvedValue(mockPermission as any);
      vi.mocked(prisma.userPermission.findUnique).mockResolvedValue(null);
      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any);
      vi.mocked(prisma.userPermission.create).mockResolvedValue({} as any);

      await grantPermission('user-1', 'music.view');

      expect(requirePermission).toHaveBeenCalledWith('admin.users.manage');
    });

    it('should return error for invalid permission', async () => {
      vi.mocked(isValidPermission).mockReturnValue(false);

      const result = await grantPermission('user-1', 'invalid.permission');

      expect(result).toEqual({
        success: false,
        error: 'Invalid permission',
      });
    });

    it('should return error if permission not in database', async () => {
      vi.mocked(isValidPermission).mockReturnValue(true);
      vi.mocked(prisma.permission.findUnique).mockResolvedValue(null);

      const result = await grantPermission('user-1', 'music.view');

      expect(result).toEqual({
        success: false,
        error: 'Permission not found in database. Run seed to sync permissions.',
      });
    });

    it('should return error if already granted', async () => {
      vi.mocked(isValidPermission).mockReturnValue(true);
      vi.mocked(prisma.permission.findUnique).mockResolvedValue(mockPermission as any);
      vi.mocked(prisma.userPermission.findUnique).mockResolvedValue({
        id: 'up-1',
        userId: 'user-1',
        permissionId: 'perm-1',
        grantedAt: new Date(),
        grantedBy: null,
        expiresAt: null,
      } as any);

      const result = await grantPermission('user-1', 'music.view');

      expect(result).toEqual({
        success: false,
        error: 'Permission already granted to this user',
      });
    });

    it('should return error if user not found', async () => {
      vi.mocked(isValidPermission).mockReturnValue(true);
      vi.mocked(prisma.permission.findUnique).mockResolvedValue(mockPermission as any);
      vi.mocked(prisma.userPermission.findUnique).mockResolvedValue(null);
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

      const result = await grantPermission('user-1', 'music.view');

      expect(result).toEqual({
        success: false,
        error: 'User not found',
      });
    });

    it('should grant permission and create audit log', async () => {
      vi.mocked(isValidPermission).mockReturnValue(true);
      vi.mocked(prisma.permission.findUnique).mockResolvedValue(mockPermission as any);
      vi.mocked(prisma.userPermission.findUnique).mockResolvedValue(null);
      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any);
      vi.mocked(prisma.userPermission.create).mockResolvedValue({
        id: 'up-1',
        userId: 'user-1',
        permissionId: 'perm-1',
        grantedAt: new Date(),
        grantedBy: 'admin-user-id',
        expiresAt: null,
      } as any);

      const result = await grantPermission('user-1', 'music.view');

      expect(result).toEqual({ success: true });
      expect(auditLog).toHaveBeenCalledWith({
        action: 'permission.grant',
        entityType: 'User',
        entityId: 'user-1',
        newValues: {
          permission: 'music.view',
          userName: 'Test User',
        },
      });
    });
  });

  describe('revokePermission', () => {
    it('should require admin.users.manage permission', async () => {
      vi.mocked(prisma.userPermission.findUnique).mockResolvedValue({
        id: 'up-1',
        userId: 'user-1',
        permissionId: 'perm-1',
        grantedAt: new Date(),
        grantedBy: null,
        expiresAt: null,
      } as any);
      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any);
      vi.mocked(prisma.permission.findUnique).mockResolvedValue(mockPermission as any);
      vi.mocked(prisma.userPermission.delete).mockResolvedValue({} as any);

      await revokePermission('user-1', 'perm-1');

      expect(requirePermission).toHaveBeenCalledWith('admin.users.manage');
    });

    it('should return error if permission assignment not found', async () => {
      vi.mocked(prisma.userPermission.findUnique).mockResolvedValue(null);

      const result = await revokePermission('user-1', 'perm-1');

      expect(result).toEqual({
        success: false,
        error: 'Permission assignment not found',
      });
    });

    it('should revoke permission and create audit log', async () => {
      vi.mocked(prisma.userPermission.findUnique).mockResolvedValue({
        id: 'up-1',
        userId: 'user-1',
        permissionId: 'perm-1',
        grantedAt: new Date(),
        grantedBy: null,
        expiresAt: null,
      } as any);
      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any);
      vi.mocked(prisma.permission.findUnique).mockResolvedValue(mockPermission as any);
      vi.mocked(prisma.userPermission.delete).mockResolvedValue({} as any);

      const result = await revokePermission('user-1', 'perm-1');

      expect(result).toEqual({ success: true });
      expect(auditLog).toHaveBeenCalledWith({
        action: 'permission.revoke',
        entityType: 'User',
        entityId: 'user-1',
        newValues: {
          permission: 'music.view',
          userName: 'Test User',
        },
      });
    });
  });

  describe('batchGrantPermissions', () => {
    it('should require admin.users.manage permission', async () => {
      vi.mocked(isValidPermission).mockReturnValue(true);
      vi.mocked(prisma.permission.findMany).mockResolvedValue([mockPermission] as any);
      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any);
      vi.mocked(prisma.userPermission.findMany).mockResolvedValue([]);
      vi.mocked(prisma.userPermission.createMany).mockResolvedValue({ count: 1 });

      await batchGrantPermissions('user-1', ['music.view']);

      expect(requirePermission).toHaveBeenCalledWith('admin.users.manage');
    });

    it('should return error for invalid permissions', async () => {
      vi.mocked(isValidPermission).mockReturnValue(false);

      const result = await batchGrantPermissions('user-1', ['invalid.permission']);

      expect(result).toEqual({
        success: false,
        error: 'Invalid permissions: invalid.permission',
      });
    });

    it('should return error if user not found', async () => {
      vi.mocked(isValidPermission).mockReturnValue(true);
      vi.mocked(prisma.permission.findMany).mockResolvedValue([mockPermission] as any);
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

      const result = await batchGrantPermissions('user-1', ['music.view']);

      expect(result).toEqual({
        success: false,
        error: 'User not found',
      });
    });

    it('should grant multiple permissions', async () => {
      vi.mocked(isValidPermission).mockReturnValue(true);
      vi.mocked(prisma.permission.findMany).mockResolvedValue([mockPermission] as any);
      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any);
      vi.mocked(prisma.userPermission.findMany).mockResolvedValue([]);
      vi.mocked(prisma.userPermission.createMany).mockResolvedValue({ count: 1 } as any);

      const result = await batchGrantPermissions('user-1', ['music.view']);

      expect(result).toEqual({ success: true, granted: 1 });
    });

    it('should skip already granted permissions', async () => {
      vi.mocked(isValidPermission).mockReturnValue(true);
      vi.mocked(prisma.permission.findMany).mockResolvedValue([mockPermission] as any);
      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any);
      vi.mocked(prisma.userPermission.findMany).mockResolvedValue([
        {
          id: 'up-1',
          userId: 'user-1',
          permissionId: 'perm-1',
          grantedAt: new Date(),
          grantedBy: null,
          expiresAt: null,
        },
      ] as any);

      const result = await batchGrantPermissions('user-1', ['music.view']);

      expect(result).toEqual({ success: true, granted: 0 });
    });
  });

  describe('batchRevokePermissions', () => {
    it('should require admin.users.manage permission', async () => {
      vi.mocked(prisma.userPermission.deleteMany).mockResolvedValue({ count: 2 });

      await batchRevokePermissions('user-1', ['perm-1', 'perm-2']);

      expect(requirePermission).toHaveBeenCalledWith('admin.users.manage');
    });

    it('should revoke multiple permissions', async () => {
      vi.mocked(prisma.userPermission.deleteMany).mockResolvedValue({ count: 2 });

      const result = await batchRevokePermissions('user-1', ['perm-1', 'perm-2']);

      expect(result).toEqual({ success: true, revoked: 2 });
      expect(prisma.userPermission.deleteMany).toHaveBeenCalledWith({
        where: {
          userId: 'user-1',
          permissionId: { in: ['perm-1', 'perm-2'] },
        },
      });
    });
  });

  describe('searchUsersForPermissions', () => {
    it('should require admin.users.manage permission', async () => {
      vi.mocked(prisma.user.findMany).mockResolvedValue([]);
      vi.mocked(prisma.user.count).mockResolvedValue(0);

      await searchUsersForPermissions('test');

      expect(requirePermission).toHaveBeenCalledWith('admin.users.manage');
    });

    it('should search users with query', async () => {
      vi.mocked(prisma.user.findMany).mockResolvedValue([mockUser] as any);
      vi.mocked(prisma.user.count).mockResolvedValue(1);

      const result = await searchUsersForPermissions('test', 1, 20);

      expect(result).toEqual({
        users: [mockUser],
        total: 1,
        totalPages: 1,
      });
    });

    it('should return paginated results', async () => {
      vi.mocked(prisma.user.findMany).mockResolvedValue([mockUser] as any);
      vi.mocked(prisma.user.count).mockResolvedValue(50);

      const result = await searchUsersForPermissions('', 2, 20);

      expect(result).toEqual({
        users: [mockUser],
        total: 50,
        totalPages: 3,
      });
      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 20,
          take: 20,
        })
      );
    });
  });
});
