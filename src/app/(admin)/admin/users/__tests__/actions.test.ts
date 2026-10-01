import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getUsers,
  getUserDetails,
  updateUser,
  banUser,
  unbanUser,
  createUser,
  deleteUser,
  revokeAllSessions,
  impersonateUser,
  getUserStats,
} from '../actions';

// Mock Next.js cache
vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

// Mock dependencies
vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
      count: vi.fn(),
    },
    session: {
      deleteMany: vi.fn(),
      delete: vi.fn(),
    },
    verification: {
      create: vi.fn(),
    },
    role: {
      findMany: vi.fn(),
    },
    userRole: {
      groupBy: vi.fn(),
    },
  },
}));

vi.mock('@/lib/auth/guards', () => ({
  requirePermission: vi.fn().mockResolvedValue({
    user: { id: 'admin-id', email: 'admin@test.com' },
  }),
  getSession: vi.fn().mockResolvedValue({
    user: { id: 'admin-id', email: 'admin@test.com' },
  }),
}));

vi.mock('@/lib/services/audit', () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/email', () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/env', () => ({
  env: {
    BETTER_AUTH_URL: 'http://localhost:3000',
    NODE_ENV: 'development',
  },
}));

import { prisma } from '@/lib/db';

const mockPrisma = prisma as unknown as {
  user: {
    findMany: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
  };
  session: {
    deleteMany: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  verification: {
    create: ReturnType<typeof vi.fn>;
  };
  role: {
    findMany: ReturnType<typeof vi.fn>;
  };
  userRole: {
    groupBy: ReturnType<typeof vi.fn>;
  };
};

describe('User Management Actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getUsers', () => {
    it('should return users with pagination', async () => {
      const mockUsers = [
        {
          id: 'user-1',
          email: 'user1@test.com',
          name: 'User One',
          emailVerified: true,
          twoFactorEnabled: false,
          banned: false,
          banReason: null,
          banExpires: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          roles: [],
          member: null,
          sessions: [],
          accounts: [],
          _count: { sessions: 0, auditLogs: 0 },
        },
      ];

      mockPrisma.user.findMany.mockResolvedValue(mockUsers);
      mockPrisma.user.count.mockResolvedValue(1);

      const result = await getUsers({}, 1, 20);

      expect(result.users).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.totalPages).toBe(1);
    });

    it('should filter users by search term', async () => {
      mockPrisma.user.findMany.mockResolvedValue([]);
      mockPrisma.user.count.mockResolvedValue(0);

      await getUsers({ search: 'test' }, 1, 20);

      expect(mockPrisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: expect.arrayContaining([
              { name: { contains: 'test' } },
              { email: { contains: 'test' } },
            ]),
          }),
        })
      );
    });

    it('should filter users by banned status', async () => {
      mockPrisma.user.findMany.mockResolvedValue([]);
      mockPrisma.user.count.mockResolvedValue(0);

      await getUsers({ status: 'banned' }, 1, 20);

      expect(mockPrisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            banned: true,
          }),
        })
      );
    });
  });

  describe('getUserDetails', () => {
    it('should return user details', async () => {
      const mockUser = {
        id: 'user-1',
        email: 'user1@test.com',
        name: 'User One',
        emailVerified: true,
        twoFactorEnabled: false,
        banned: false,
        banReason: null,
        banExpires: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        roles: [],
        member: null,
        sessions: [],
        accounts: [],
        _count: { sessions: 0, auditLogs: 0 },
      };

      mockPrisma.user.findUnique.mockResolvedValue(mockUser);

      const result = await getUserDetails('user-1');

      expect(result).not.toBeNull();
      expect(result?.email).toBe('user1@test.com');
    });

    it('should return null for non-existent user', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);

      const result = await getUserDetails('non-existent');

      expect(result).toBeNull();
    });
  });

  describe('updateUser', () => {
    it('should update user name', async () => {
      mockPrisma.user.update.mockResolvedValue({
        id: 'user-1',
        name: 'Updated Name',
        email: 'user1@test.com',
      });

      const result = await updateUser('user-1', { name: 'Updated Name' });

      expect(result.success).toBe(true);
      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { name: 'Updated Name' },
      });
    });
  });

  describe('banUser', () => {
    it('should ban a user', async () => {
      mockPrisma.user.update.mockResolvedValue({
        id: 'user-1',
        email: 'user1@test.com',
        name: 'User One',
        banned: true,
        banReason: 'Violation',
        banExpires: null,
      });
      mockPrisma.session.deleteMany.mockResolvedValue({ count: 2 });

      const result = await banUser('user-1', 'Violation');

      expect(result.success).toBe(true);
      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: {
          banned: true,
          banReason: 'Violation',
          banExpires: undefined,
        },
      });
      expect(mockPrisma.session.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
      });
    });

    it('should not allow banning yourself', async () => {
      const result = await banUser('admin-id', 'Test');

      expect(result.success).toBe(false);
      expect(result.error).toBe('You cannot ban your own account');
    });
  });

  describe('unbanUser', () => {
    it('should unban a user', async () => {
      mockPrisma.user.update.mockResolvedValue({
        id: 'user-1',
        email: 'user1@test.com',
        name: 'User One',
        banned: false,
        banReason: null,
        banExpires: null,
      });

      const result = await unbanUser('user-1');

      expect(result.success).toBe(true);
      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: {
          banned: false,
          banReason: null,
          banExpires: null,
        },
      });
    });
  });

  describe('createUser', () => {
    it('should create a new user', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      mockPrisma.user.create.mockResolvedValue({
        id: 'new-user-id',
        email: 'newuser@test.com',
        name: 'New User',
        emailVerified: false,
      });
      mockPrisma.verification.create.mockResolvedValue({});

      const result = await createUser('newuser@test.com', 'New User', true);

      expect(result.success).toBe(true);
      expect(result.userId).toBe('new-user-id');
    });

    it('should fail if user already exists', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'existing-user',
        email: 'existing@test.com',
      });

      const result = await createUser('existing@test.com', 'Test', false);

      expect(result.success).toBe(false);
      expect(result.error).toBe('User with this email already exists');
    });
  });

  describe('deleteUser', () => {
    it('should soft delete a user', async () => {
      mockPrisma.user.update.mockResolvedValue({
        id: 'user-1',
        email: 'user1@test.com',
        name: 'User One',
        deletedAt: new Date(),
      });
      mockPrisma.session.deleteMany.mockResolvedValue({ count: 1 });

      const result = await deleteUser('user-1');

      expect(result.success).toBe(true);
      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { deletedAt: expect.any(Date) },
      });
    });

    it('should not allow deleting yourself', async () => {
      const result = await deleteUser('admin-id');

      expect(result.success).toBe(false);
      expect(result.error).toBe('You cannot delete your own account');
    });
  });

  describe('revokeAllSessions', () => {
    it('should revoke all sessions for a user', async () => {
      mockPrisma.session.deleteMany.mockResolvedValue({ count: 3 });
      mockPrisma.user.findUnique.mockResolvedValue({
        name: 'User One',
        email: 'user1@test.com',
      });

      const result = await revokeAllSessions('user-1');

      expect(result.success).toBe(true);
      expect(result.count).toBe(3);
    });
  });

  describe('impersonateUser', () => {
    // The old implementation of this action minted a token nobody consumed and
    // reported success. It no longer performs any authorization of its own, so
    // these tests pin the redirect away from the dead code path. The real
    // behaviour (permission checks, privilege-escalation guards, session
    // creation, cookie forwarding) is covered in
    // src/lib/auth/__tests__/impersonation.test.ts.
    it('is no longer an entry point and points callers at the route', async () => {
      const result = await impersonateUser();

      expect(result.success).toBe(false);
      expect(result.error).toContain('/api/admin/users/impersonate');
    });
  });

  describe('getUserStats', () => {
    it('should return user statistics', async () => {
      mockPrisma.user.count
        .mockResolvedValueOnce(100) // total
        .mockResolvedValueOnce(80) // active
        .mockResolvedValueOnce(5) // banned
        .mockResolvedValueOnce(15) // unverified
        .mockResolvedValueOnce(70) // withMember
        .mockResolvedValueOnce(30); // withoutMember

      const stats = await getUserStats();

      expect(stats).toEqual({
        total: 100,
        active: 80,
        banned: 5,
        unverified: 15,
        withMember: 70,
        withoutMember: 30,
      });
    });
  });
});
