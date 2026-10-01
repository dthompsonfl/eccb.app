import { USER_MANAGE } from '@/lib/auth/permission-constants';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  assignRole,
  removeRole,
  getUserRoles,
  getAvailableRoles,
  searchUsers,
  getUserWithRoles,
} from '../actions';
import { prisma } from '@/lib/db';
import { requirePermission } from '@/lib/auth/guards';
import { auditLog } from '@/lib/services/audit';

// Mock dependencies
vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
    },
    role: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
    userRole: {
      create: vi.fn(),
      delete: vi.fn(),
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('@/lib/auth/guards', () => ({
  requirePermission: vi.fn(),
}));

vi.mock('@/lib/services/audit', () => ({
  auditLog: vi.fn(),
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

describe('Role Actions', () => {
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
    roles: [],
    member: null,
  };

  const mockRole = {
    id: 'role-1',
    name: 'MUSICIAN',
    displayName: 'Musician',
    description: 'Basic musician role',
    type: 'MUSICIAN',
    permissions: [],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockSession as any);
  });

  describe('getUserRoles', () => {
    it('should require admin.users.manage permission', async () => {
      vi.mocked(prisma.user.findMany).mockResolvedValue([]);

      await getUserRoles();

      expect(requirePermission).toHaveBeenCalledWith(USER_MANAGE);
    });

    it('should return users with their roles', async () => {
      const usersWithRoles = [
        {
          ...mockUser,
          roles: [
            {
              id: 'ur-1',
              roleId: 'role-1',
              assignedAt: new Date(),
              role: mockRole,
            },
          ],
        },
      ];
      vi.mocked(prisma.user.findMany).mockResolvedValue(usersWithRoles as any);

      const result = await getUserRoles();

      expect(result).toEqual(usersWithRoles);
      expect(prisma.user.findMany).toHaveBeenCalledWith({
        where: { deletedAt: null },
        include: {
          roles: {
            include: {
              role: {
                include: {
                  permissions: {
                    include: {
                      permission: true,
                    },
                  },
                },
              },
            },
            orderBy: { assignedAt: 'desc' },
          },
          member: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      });
    });
  });

  describe('getAvailableRoles', () => {
    it('should require admin.users.manage permission', async () => {
      vi.mocked(prisma.role.findMany).mockResolvedValue([]);

      await getAvailableRoles();

      expect(requirePermission).toHaveBeenCalledWith(USER_MANAGE);
    });

    it('should return all roles with permissions and user count', async () => {
      const roles = [
        {
          ...mockRole,
          permissions: [],
          _count: { users: 5 },
        },
      ];
      vi.mocked(prisma.role.findMany).mockResolvedValue(roles as any);

      const result = await getAvailableRoles();

      expect(result).toEqual(roles);
      expect(prisma.role.findMany).toHaveBeenCalledWith({
        include: {
          permissions: {
            include: {
              permission: true,
            },
          },
          _count: {
            select: {
              users: true,
            },
          },
        },
        orderBy: { type: 'asc' },
      });
    });
  });

  describe('assignRole', () => {
    it('should require admin.users.manage permission', async () => {
      vi.mocked(prisma.userRole.findUnique).mockResolvedValue(null);
      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any);
      vi.mocked(prisma.role.findUnique).mockResolvedValue(mockRole as any);
      vi.mocked(prisma.userRole.create).mockResolvedValue({} as any);

      await assignRole('user-1', 'role-1');

      expect(requirePermission).toHaveBeenCalledWith(USER_MANAGE);
    });

    it('should return error if role already assigned', async () => {
      vi.mocked(prisma.userRole.findUnique).mockResolvedValue({
        id: 'ur-1',
        userId: 'user-1',
        roleId: 'role-1',
        assignedAt: new Date(),
        assignedBy: null,
        expiresAt: null,
      } as any);

      const result = await assignRole('user-1', 'role-1');

      expect(result).toEqual({
        success: false,
        error: 'Role is already assigned to this user',
      });
    });

    it('should return error if user not found', async () => {
      vi.mocked(prisma.userRole.findUnique).mockResolvedValue(null);
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
      vi.mocked(prisma.role.findUnique).mockResolvedValue(mockRole as any);

      const result = await assignRole('user-1', 'role-1');

      expect(result).toEqual({
        success: false,
        error: 'User or role not found',
      });
    });

    it('should return error if role not found', async () => {
      vi.mocked(prisma.userRole.findUnique).mockResolvedValue(null);
      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any);
      vi.mocked(prisma.role.findUnique).mockResolvedValue(null);

      const result = await assignRole('user-1', 'role-1');

      expect(result).toEqual({
        success: false,
        error: 'User or role not found',
      });
    });

    it('should assign role and create audit log', async () => {
      vi.mocked(prisma.userRole.findUnique).mockResolvedValue(null);
      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any);
      vi.mocked(prisma.role.findUnique).mockResolvedValue(mockRole as any);
      vi.mocked(prisma.userRole.create).mockResolvedValue({
        id: 'ur-1',
        userId: 'user-1',
        roleId: 'role-1',
        assignedAt: new Date(),
        assignedBy: 'admin-user-id',
        expiresAt: null,
      } as any);

      const result = await assignRole('user-1', 'role-1');

      expect(result).toEqual({ success: true });
      expect(prisma.userRole.create).toHaveBeenCalledWith({
        data: {
          userId: 'user-1',
          roleId: 'role-1',
          assignedBy: 'admin-user-id',
        },
      });
      expect(auditLog).toHaveBeenCalledWith({
        action: 'role.assign',
        entityType: 'User',
        entityId: 'user-1',
        newValues: {
          roleName: 'Musician',
          userName: 'Test User',
        },
      });
    });
  });

  describe('removeRole', () => {
    it('should require admin.users.manage permission', async () => {
      vi.mocked(prisma.userRole.findUnique).mockResolvedValue({
        id: 'ur-1',
        userId: 'user-1',
        roleId: 'role-1',
        assignedAt: new Date(),
        assignedBy: null,
        expiresAt: null,
      } as any);
      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any);
      vi.mocked(prisma.role.findUnique).mockResolvedValue(mockRole as any);
      vi.mocked(prisma.userRole.delete).mockResolvedValue({} as any);

      await removeRole('user-1', 'role-1');

      expect(requirePermission).toHaveBeenCalledWith(USER_MANAGE);
    });

    it('should return error if role assignment not found', async () => {
      vi.mocked(prisma.userRole.findUnique).mockResolvedValue(null);

      const result = await removeRole('user-1', 'role-1');

      expect(result).toEqual({
        success: false,
        error: 'Role assignment not found',
      });
    });

    it('should remove role and create audit log', async () => {
      const userRole = {
        id: 'ur-1',
        userId: 'user-1',
        roleId: 'role-1',
        assignedAt: new Date(),
        assignedBy: null,
        expiresAt: null,
      };
      vi.mocked(prisma.userRole.findUnique).mockResolvedValue(userRole as any);
      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any);
      vi.mocked(prisma.role.findUnique).mockResolvedValue(mockRole as any);
      vi.mocked(prisma.userRole.delete).mockResolvedValue(userRole as any);

      const result = await removeRole('user-1', 'role-1');

      expect(result).toEqual({ success: true });
      expect(prisma.userRole.delete).toHaveBeenCalledWith({
        where: {
          userId_roleId: {
            userId: 'user-1',
            roleId: 'role-1',
          },
        },
      });
      expect(auditLog).toHaveBeenCalledWith({
        action: 'role.remove',
        entityType: 'User',
        entityId: 'user-1',
        newValues: {
          roleName: 'Musician',
          userName: 'Test User',
        },
      });
    });
  });

  describe('searchUsers', () => {
    it('should require admin.users.manage permission', async () => {
      vi.mocked(prisma.user.findMany).mockResolvedValue([]);
      vi.mocked(prisma.user.count).mockResolvedValue(0);

      await searchUsers('test');

      expect(requirePermission).toHaveBeenCalledWith(USER_MANAGE);
    });

    it('should search users with query', async () => {
      vi.mocked(prisma.user.findMany).mockResolvedValue([mockUser] as any);
      vi.mocked(prisma.user.count).mockResolvedValue(1);

      const result = await searchUsers('test', 1, 20);

      expect(result).toEqual({
        users: [mockUser],
        total: 1,
        totalPages: 1,
      });
      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            deletedAt: null,
            OR: [
              { name: { contains: 'test' } },
              { email: { contains: 'test' } },
              {
                member: {
                  OR: [
                    { firstName: { contains: 'test' } },
                    { lastName: { contains: 'test' } },
                  ],
                },
              },
            ],
          },
        })
      );
    });

    it('should return paginated results', async () => {
      vi.mocked(prisma.user.findMany).mockResolvedValue([mockUser] as any);
      vi.mocked(prisma.user.count).mockResolvedValue(50);

      const result = await searchUsers('', 2, 20);

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

  describe('getUserWithRoles', () => {
    it('should require admin.users.manage permission', async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any);

      await getUserWithRoles('user-1');

      expect(requirePermission).toHaveBeenCalledWith(USER_MANAGE);
    });

    it('should return user with roles', async () => {
      const userWithRoles = {
        ...mockUser,
        roles: [
          {
            id: 'ur-1',
            roleId: 'role-1',
            assignedAt: new Date(),
            role: mockRole,
          },
        ],
      };
      vi.mocked(prisma.user.findUnique).mockResolvedValue(userWithRoles as any);

      const result = await getUserWithRoles('user-1');

      expect(result).toEqual(userWithRoles);
    });

    it('should return null if user not found', async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

      const result = await getUserWithRoles('non-existent');

      expect(result).toBeNull();
    });
  });
});
