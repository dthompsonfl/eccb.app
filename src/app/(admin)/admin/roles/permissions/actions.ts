'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db';
import { requirePermission } from '@/lib/auth/guards';
import { auditLog } from '@/lib/services/audit';
import { z } from 'zod';
import {
  isValidPermission,
  USER_MANAGE,
} from '@/lib/auth/permission-constants';

// =============================================================================
// TYPES
// =============================================================================

export interface PermissionWithDetails {
  id: string;
  name: string;
  resource: string;
  action: string;
  scope: string | null;
  description: string | null;
}

export interface UserPermissionInfo {
  id: string;
  userId: string;
  permissionId: string;
  grantedAt: Date;
  grantedBy: string | null;
  expiresAt: Date | null;
  permission: PermissionWithDetails;
}

export interface UserWithPermissions {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  emailVerified: boolean;
  createdAt: Date;
  member: {
    id: string;
    firstName: string;
    lastName: string;
  } | null;
  roles: {
    id: string;
    roleId: string;
    role: {
      id: string;
      name: string;
      displayName: string;
      type: string;
      permissions: {
        permission: {
          name: string;
        };
      }[];
    };
  }[];
  customPermissions: UserPermissionInfo[];
}

export interface GroupedPermissions {
  [resource: string]: PermissionWithDetails[];
}

// =============================================================================
// VALIDATION SCHEMAS
// =============================================================================

const grantPermissionSchema = z.object({
  userId: z.string().min(1, 'User ID is required'),
  permission: z.string().min(1, 'Permission is required'),
});

const revokePermissionSchema = z.object({
  userId: z.string().min(1, 'User ID is required'),
  permissionId: z.string().min(1, 'Permission ID is required'),
});

// =============================================================================
// SERVER ACTIONS
// =============================================================================

/**
 * Get all available permissions grouped by resource
 */
export async function getAllPermissions(): Promise<GroupedPermissions> {
  await requirePermission(USER_MANAGE);

  const permissions = await prisma.permission.findMany({
    orderBy: [{ resource: 'asc' }, { action: 'asc' }],
  });

  const grouped: GroupedPermissions = {};

  for (const permission of permissions) {
    if (!grouped[permission.resource]) {
      grouped[permission.resource] = [];
    }
    grouped[permission.resource].push(permission);
  }

  return grouped;
}

/**
 * Get all available permissions as a flat list
 */
export async function getAllPermissionsList(): Promise<PermissionWithDetails[]> {
  await requirePermission(USER_MANAGE);

  return prisma.permission.findMany({
    orderBy: [{ resource: 'asc' }, { action: 'asc' }],
  });
}

/**
 * Get custom permissions for a specific user
 */
export async function getUserCustomPermissions(
  userId: string
): Promise<UserPermissionInfo[]> {
  await requirePermission(USER_MANAGE);

  const userPermissions = await prisma.userPermission.findMany({
    where: { userId },
    include: {
      permission: true,
    },
    orderBy: { grantedAt: 'desc' },
  });

  return userPermissions;
}

/**
 * Get a user with their roles and custom permissions
 */
export async function getUserWithPermissions(
  userId: string
): Promise<UserWithPermissions | null> {
  await requirePermission(USER_MANAGE);

  const user = await prisma.user.findUnique({
    where: {
      id: userId,
      deletedAt: null,
    },
    include: {
      member: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
      roles: {
        include: {
          role: {
            include: {
              permissions: {
                include: {
                  permission: {
                    select: {
                      name: true,
                    },
                  },
                },
              },
            },
          },
        },
        orderBy: { assignedAt: 'desc' },
      },
      customPermissions: {
        include: {
          permission: true,
        },
        orderBy: { grantedAt: 'desc' },
      },
    },
  });

  return user;
}

/**
 * Get all users who have custom permissions
 */
export async function getUsersWithCustomPermissions(): Promise<
  UserWithPermissions[]
> {
  await requirePermission(USER_MANAGE);

  const users = await prisma.user.findMany({
    where: {
      deletedAt: null,
      customPermissions: { some: {} },
    },
    include: {
      member: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
      roles: {
        include: {
          role: {
            include: {
              permissions: {
                include: {
                  permission: {
                    select: {
                      name: true,
                    },
                  },
                },
              },
            },
          },
        },
        orderBy: { assignedAt: 'desc' },
      },
      customPermissions: {
        include: {
          permission: true,
        },
        orderBy: { grantedAt: 'desc' },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  return users;
}

/**
 * Get all effective permissions for a user (from roles + custom)
 * Returns a map of permission name -> source (role name or 'custom')
 */
export async function getUserEffectivePermissions(
  userId: string
): Promise<Map<string, { source: string; isCustom: boolean }>> {
  await requirePermission(USER_MANAGE);

  const user = await prisma.user.findUnique({
    where: { id: userId, deletedAt: null },
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
      },
      customPermissions: {
        include: {
          permission: true,
        },
      },
    },
  });

  const permissionMap = new Map<string, { source: string; isCustom: boolean }>();

  if (!user) {
    return permissionMap;
  }

  // Add permissions from roles
  for (const userRole of user.roles) {
    for (const rolePerm of userRole.role.permissions) {
      // Only add if not already present (first role wins)
      if (!permissionMap.has(rolePerm.permission.name)) {
        permissionMap.set(rolePerm.permission.name, {
          source: userRole.role.displayName,
          isCustom: false,
        });
      }
    }
  }

  // Add custom permissions (these override role permissions)
  for (const userPerm of user.customPermissions) {
    permissionMap.set(userPerm.permission.name, {
      source: 'Custom Permission',
      isCustom: true,
    });
  }

  return permissionMap;
}

/**
 * Grant a custom permission to a user
 */
export async function grantPermission(
  userId: string,
  permission: string
): Promise<{ success: boolean; error?: string }> {
  const session = await requirePermission(USER_MANAGE);

  try {
    const validated = grantPermissionSchema.parse({ userId, permission });

    // Validate the permission string
    if (!isValidPermission(validated.permission)) {
      return { success: false, error: 'Invalid permission' };
    }

    // Find the permission in the database
    const permissionRecord = await prisma.permission.findUnique({
      where: { name: validated.permission },
    });

    if (!permissionRecord) {
      return {
        success: false,
        error: 'Permission not found in database. Run seed to sync permissions.',
      };
    }

    // Check if already granted
    const existing = await prisma.userPermission.findUnique({
      where: {
        userId_permissionId: {
          userId: validated.userId,
          permissionId: permissionRecord.id,
        },
      },
    });

    if (existing) {
      return { success: false, error: 'Permission already granted to this user' };
    }

    // Get user info for audit log
    const user = await prisma.user.findUnique({
      where: { id: validated.userId },
      select: { name: true, email: true },
    });

    if (!user) {
      return { success: false, error: 'User not found' };
    }

    // Grant the permission
    await prisma.userPermission.create({
      data: {
        userId: validated.userId,
        permissionId: permissionRecord.id,
        grantedBy: session.user.id,
      },
    });

    await auditLog({
      action: 'permission.grant',
      entityType: 'User',
      entityId: validated.userId,
      newValues: {
        permission: validated.permission,
        userName: user.name || user.email,
      },
    });

    revalidatePath('/admin/roles/permissions');

    return { success: true };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, error: error.issues[0].message };
    }
    console.error('Failed to grant permission:', error);
    return { success: false, error: 'Failed to grant permission' };
  }
}

/**
 * Revoke a custom permission from a user
 */
export async function revokePermission(
  userId: string,
  permissionId: string
): Promise<{ success: boolean; error?: string }> {
  await requirePermission(USER_MANAGE);

  try {
    const validated = revokePermissionSchema.parse({ userId, permissionId });

    // Get the permission and user info for audit log
    const [userPermission, user, permission] = await Promise.all([
      prisma.userPermission.findUnique({
        where: {
          userId_permissionId: {
            userId: validated.userId,
            permissionId: validated.permissionId,
          },
        },
      }),
      prisma.user.findUnique({
        where: { id: validated.userId },
        select: { name: true, email: true },
      }),
      prisma.permission.findUnique({
        where: { id: validated.permissionId },
        select: { name: true },
      }),
    ]);

    if (!userPermission) {
      return { success: false, error: 'Permission assignment not found' };
    }

    // Delete the permission
    await prisma.userPermission.delete({
      where: {
        userId_permissionId: {
          userId: validated.userId,
          permissionId: validated.permissionId,
        },
      },
    });

    await auditLog({
      action: 'permission.revoke',
      entityType: 'User',
      entityId: validated.userId,
      newValues: {
        permission: permission?.name || 'Unknown',
        userName: user?.name || user?.email || 'Unknown',
      },
    });

    revalidatePath('/admin/roles/permissions');

    return { success: true };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, error: error.issues[0].message };
    }
    console.error('Failed to revoke permission:', error);
    return { success: false, error: 'Failed to revoke permission' };
  }
}

/**
 * Batch grant permissions to a user
 */
export async function batchGrantPermissions(
  userId: string,
  permissions: string[]
): Promise<{ success: boolean; error?: string; granted?: number }> {
  const session = await requirePermission(USER_MANAGE);

  try {
    // Validate all permissions first
    const invalidPermissions = permissions.filter((p) => !isValidPermission(p));
    if (invalidPermissions.length > 0) {
      return {
        success: false,
        error: `Invalid permissions: ${invalidPermissions.join(', ')}`,
      };
    }

    // Get permission records
    const permissionRecords = await prisma.permission.findMany({
      where: { name: { in: permissions } },
    });

    if (permissionRecords.length !== permissions.length) {
      const found = new Set(permissionRecords.map((p) => p.name));
      const missing = permissions.filter((p) => !found.has(p));
      return {
        success: false,
        error: `Permissions not found in database: ${missing.join(', ')}. Run seed to sync.`,
      };
    }

    // Get user info
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true },
    });

    if (!user) {
      return { success: false, error: 'User not found' };
    }

    // Get existing permissions
    const existing = await prisma.userPermission.findMany({
      where: {
        userId,
        permissionId: { in: permissionRecords.map((p) => p.id) },
      },
    });

    const existingIds = new Set(existing.map((e) => e.permissionId));
    const toGrant = permissionRecords.filter((p) => !existingIds.has(p.id));

    if (toGrant.length === 0) {
      return { success: true, granted: 0 };
    }

    // Grant permissions
    await prisma.userPermission.createMany({
      data: toGrant.map((p) => ({
        userId,
        permissionId: p.id,
        grantedBy: session.user.id,
      })),
      skipDuplicates: true,
    });

    await auditLog({
      action: 'permission.batch_grant',
      entityType: 'User',
      entityId: userId,
      newValues: {
        permissions: toGrant.map((p) => p.name),
        userName: user.name || user.email,
      },
    });

    revalidatePath('/admin/roles/permissions');

    return { success: true, granted: toGrant.length };
  } catch (error) {
    console.error('Failed to batch grant permissions:', error);
    return { success: false, error: 'Failed to grant permissions' };
  }
}

/**
 * Batch revoke permissions from a user
 */
export async function batchRevokePermissions(
  userId: string,
  permissionIds: string[]
): Promise<{ success: boolean; error?: string; revoked?: number }> {
  await requirePermission(USER_MANAGE);

  try {
    const result = await prisma.userPermission.deleteMany({
      where: {
        userId,
        permissionId: { in: permissionIds },
      },
    });

    await auditLog({
      action: 'permission.batch_revoke',
      entityType: 'User',
      entityId: userId,
      newValues: {
        count: result.count,
        permissionIds,
      },
    });

    revalidatePath('/admin/roles/permissions');

    return { success: true, revoked: result.count };
  } catch (error) {
    console.error('Failed to batch revoke permissions:', error);
    return { success: false, error: 'Failed to revoke permissions' };
  }
}

/**
 * Search users for permission management
 */
export async function searchUsersForPermissions(
  query: string,
  page: number = 1,
  limit: number = 20
): Promise<{
  users: UserWithPermissions[];
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
        member: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
          },
        },
        roles: {
          include: {
            role: {
              include: {
                permissions: {
                  include: {
                    permission: {
                      select: {
                        name: true,
                      },
                    },
                  },
                },
              },
            },
          },
          orderBy: { assignedAt: 'desc' },
        },
        customPermissions: {
          include: {
            permission: true,
          },
          orderBy: { grantedAt: 'desc' },
        },
      },
      orderBy: { createdAt: 'desc' },
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
