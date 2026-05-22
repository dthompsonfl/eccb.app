'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db';
import { requirePermission } from '@/lib/auth/guards';
import { USER_MANAGE } from '@/lib/auth/permission-constants';
import { auditLog } from '@/lib/services/audit';
import { z } from 'zod';
import type { UserWithRoles, RoleWithPermissions } from './types';

// =============================================================================
// VALIDATION SCHEMAS
// =============================================================================

const assignRoleSchema = z.object({
  userId: z.string().min(1, 'User ID is required'),
  roleId: z.string().min(1, 'Role ID is required'),
});

const removeRoleSchema = z.object({
  userId: z.string().min(1, 'User ID is required'),
  roleId: z.string().min(1, 'Role ID is required'),
});

// =============================================================================
// SERVER ACTIONS
// =============================================================================

/**
 * Get all users with their roles
 */
export async function getUserRoles(): Promise<UserWithRoles[]> {
  await requirePermission(USER_MANAGE);

  const users = await prisma.user.findMany({
    where: {
      deletedAt: null,
    },
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
        orderBy: {
          assignedAt: 'desc',
        },
      },
      member: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
    },
    orderBy: {
      createdAt: 'desc',
    },
  });

  return users;
}

/**
 * Get all available roles with their permissions
 */
export async function getAvailableRoles(): Promise<RoleWithPermissions[]> {
  await requirePermission(USER_MANAGE);

  const roles = await prisma.role.findMany({
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
    orderBy: {
      type: 'asc',
    },
  });

  return roles;
}

/**
 * Assign a role to a user
 */
export async function assignRole(
  userId: string,
  roleId: string
): Promise<{ success: boolean; error?: string }> {
  const session = await requirePermission(USER_MANAGE);

  try {
    const validated = assignRoleSchema.parse({ userId, roleId });

    // Check if the role is already assigned
    const existingAssignment = await prisma.userRole.findUnique({
      where: {
        userId_roleId: {
          userId: validated.userId,
          roleId: validated.roleId,
        },
      },
    });

    if (existingAssignment) {
      return { success: false, error: 'Role is already assigned to this user' };
    }

    // Get role and user info for audit log
    const [user, role] = await Promise.all([
      prisma.user.findUnique({
        where: { id: validated.userId },
        select: { name: true, email: true },
      }),
      prisma.role.findUnique({
        where: { id: validated.roleId },
        select: { name: true, displayName: true },
      }),
    ]);

    if (!user || !role) {
      return { success: false, error: 'User or role not found' };
    }

    // Create the role assignment
    await prisma.userRole.create({
      data: {
        userId: validated.userId,
        roleId: validated.roleId,
        assignedBy: session.user.id,
      },
    });

    await auditLog({
      action: 'role.assign',
      entityType: 'User',
      entityId: validated.userId,
      newValues: {
        roleName: role.displayName || role.name,
        userName: user.name || user.email,
      },
    });

    revalidatePath('/admin/roles');

    return { success: true };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, error: error.issues[0].message };
    }
    console.error('Failed to assign role:', error);
    return { success: false, error: 'Failed to assign role' };
  }
}

/**
 * Remove a role from a user
 */
export async function removeRole(
  userId: string,
  roleId: string
): Promise<{ success: boolean; error?: string }> {
  await requirePermission(USER_MANAGE);

  try {
    const validated = removeRoleSchema.parse({ userId, roleId });

    // Get role and user info for audit log
    const [userRole, user, role] = await Promise.all([
      prisma.userRole.findUnique({
        where: {
          userId_roleId: {
            userId: validated.userId,
            roleId: validated.roleId,
          },
        },
      }),
      prisma.user.findUnique({
        where: { id: validated.userId },
        select: { name: true, email: true },
      }),
      prisma.role.findUnique({
        where: { id: validated.roleId },
        select: { name: true, displayName: true },
      }),
    ]);

    if (!userRole) {
      return { success: false, error: 'Role assignment not found' };
    }

    // Delete the role assignment
    await prisma.userRole.delete({
      where: {
        userId_roleId: {
          userId: validated.userId,
          roleId: validated.roleId,
        },
      },
    });

    await auditLog({
      action: 'role.remove',
      entityType: 'User',
      entityId: validated.userId,
      newValues: {
        roleName: role?.displayName || role?.name || 'Unknown',
        userName: user?.name || user?.email || 'Unknown',
      },
    });

    revalidatePath('/admin/roles');

    return { success: true };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, error: error.issues[0].message };
    }
    console.error('Failed to remove role:', error);
    return { success: false, error: 'Failed to remove role' };
  }
}

/**
 * Get users with search and filter
 */
export async function searchUsers(
  query: string,
  page: number = 1,
  limit: number = 20
): Promise<{
  users: UserWithRoles[];
  total: number;
  totalPages: number;
}> {
  await requirePermission(USER_MANAGE);

  const where = query
    ? {
        deletedAt: null,
        OR: [
          { name: { contains: query } },
          { email: { contains: query } },
          {
            member: {
              OR: [
                { firstName: { contains: query } },
                { lastName: { contains: query } },
              ],
            },
          },
        ],
      }
    : { deletedAt: null };

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
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
          orderBy: {
            assignedAt: 'desc',
          },
        },
        member: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.user.count({ where }),
  ]);

  return {
    users,
    total,
    totalPages: Math.ceil(total / limit),
  };
}

/**
 * Get a single user with detailed role information
 */
export async function getUserWithRoles(
  userId: string
): Promise<UserWithRoles | null> {
  await requirePermission(USER_MANAGE);

  const user = await prisma.user.findUnique({
    where: {
      id: userId,
      deletedAt: null,
    },
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
        orderBy: {
          assignedAt: 'desc',
        },
      },
      member: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
    },
  });

  return user;
}
