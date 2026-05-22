'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db';
import { requirePermission } from '@/lib/auth/guards';
import { USER_MANAGE } from '@/lib/auth/permission-constants';
import { auditLog } from '@/lib/services/audit';
import { sendEmail } from '@/lib/email';
import { z } from 'zod';
import { env } from '@/lib/env';
import { randomBytes } from 'crypto';

// =============================================================================
// VALIDATION SCHEMAS
// =============================================================================

const updateUserSchema = z.object({
  name: z.string().optional(),
  email: z.string().email().optional(),
  emailVerified: z.boolean().optional(),
});

const _banUserSchema = z.object({
  userId: z.string().min(1, 'User ID is required'),
  banReason: z.string().optional(),
  banExpires: z.string().optional(),
});

const createUserSchema = z.object({
  email: z.string().email('Valid email is required'),
  name: z.string().optional(),
  sendInvite: z.boolean().default(true),
});

// =============================================================================
// TYPES
// =============================================================================

export interface UserWithDetails {
  id: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
  image: string | null;
  twoFactorEnabled: boolean;
  banned: boolean;
  banReason: string | null;
  banExpires: Date | null;
  createdAt: Date;
  updatedAt: Date;
  roles: Array<{
    id: string;
    roleId: string;
    assignedAt: Date;
    role: {
      id: string;
      name: string;
      displayName: string | null;
      type: string;
    };
  }>;
  member: {
    id: string;
    firstName: string;
    lastName: string;
  } | null;
  sessions: Array<{
    id: string;
    ipAddress: string | null;
    userAgent: string | null;
    createdAt: Date;
    expiresAt: Date;
  }>;
  accounts: Array<{
    id: string;
    providerId: string;
    accountId: string;
    createdAt: Date;
  }>;
  _count: {
    sessions: number;
    auditLogs: number;
  };
}

export interface UserFilters {
  search?: string;
  status?: 'active' | 'banned' | 'unverified';
  hasRole?: string;
  hasMember?: boolean;
}

// =============================================================================
// SERVER ACTIONS
// =============================================================================

/**
 * Get all users with filtering and pagination
 */
export async function getUsers(
  filters: UserFilters = {},
  page: number = 1,
  limit: number = 20
): Promise<{ users: UserWithDetails[]; total: number; totalPages: number }> {
  await requirePermission(USER_MANAGE);

  const where: {
    deletedAt: null;
    OR?: Array<{
      name?: { contains: string };
      email?: { contains: string };
      member?: {
        OR: Array<
          { firstName: { contains: string } } | { lastName: { contains: string } }
        >;
      };
    }>;
    banned?: boolean;
    emailVerified?: boolean;
    roles?: { some: { roleId: string } };
    member?: { is: null } | { isNot: null };
  } = { deletedAt: null };

  if (filters.search) {
    where.OR = [
      { name: { contains: filters.search } },
      { email: { contains: filters.search } },
      {
        member: {
          OR: [
            { firstName: { contains: filters.search } },
            { lastName: { contains: filters.search } },
          ],
        },
      },
    ];
  }

  if (filters.status === 'banned') {
    where.banned = true;
  } else if (filters.status === 'active') {
    where.banned = false;
    where.emailVerified = true;
  } else if (filters.status === 'unverified') {
    where.emailVerified = false;
  }

  if (filters.hasRole) {
    where.roles = { some: { roleId: filters.hasRole } };
  }

  if (filters.hasMember === true) {
    where.member = { isNot: null };
  } else if (filters.hasMember === false) {
    where.member = { is: null };
  }

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      include: {
        roles: {
          include: {
            role: {
              select: {
                id: true,
                name: true,
                displayName: true,
                type: true,
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
        sessions: {
          select: {
            id: true,
            ipAddress: true,
            userAgent: true,
            createdAt: true,
            expiresAt: true,
          },
          orderBy: { createdAt: 'desc' },
          take: 5,
        },
        accounts: {
          select: {
            id: true,
            providerId: true,
            accountId: true,
            createdAt: true,
          },
        },
        _count: {
          select: {
            sessions: true,
            auditLogs: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.user.count({ where }),
  ]);

  return {
    users: users as UserWithDetails[],
    total,
    totalPages: Math.ceil(total / limit),
  };
}

/**
 * Get a single user with full details
 */
export async function getUserDetails(userId: string): Promise<UserWithDetails | null> {
  await requirePermission(USER_MANAGE);

  const user = await prisma.user.findUnique({
    where: { id: userId, deletedAt: null },
    include: {
      roles: {
        include: {
          role: {
            select: {
              id: true,
              name: true,
              displayName: true,
              type: true,
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
      sessions: {
        select: {
          id: true,
          ipAddress: true,
          userAgent: true,
          createdAt: true,
          expiresAt: true,
        },
        orderBy: { createdAt: 'desc' },
      },
      accounts: {
        select: {
          id: true,
          providerId: true,
          accountId: true,
          createdAt: true,
        },
      },
      _count: {
        select: {
          sessions: true,
          auditLogs: true,
        },
      },
    },
  });

  return user as UserWithDetails | null;
}

/**
 * Update user basic information
 */
export async function updateUser(
  userId: string,
  data: { name?: string; email?: string; emailVerified?: boolean }
): Promise<{ success: boolean; error?: string }> {
  const _session = await requirePermission(USER_MANAGE);

  try {
    const validated = updateUserSchema.parse(data);

    const user = await prisma.user.update({
      where: { id: userId },
      data: validated,
    });

    await auditLog({
      action: 'user.update',
      entityType: 'User',
      entityId: userId,
      newValues: { ...validated, userName: user.name || user.email },
    });

    revalidatePath('/admin/users');
    revalidatePath(`/admin/users/${userId}`);

    return { success: true };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, error: error.issues[0].message };
    }
    console.error('Failed to update user:', error);
    return { success: false, error: 'Failed to update user' };
  }
}

/**
 * Ban/Deactivate a user
 */
export async function banUser(
  userId: string,
  banReason?: string,
  banExpires?: Date
): Promise<{ success: boolean; error?: string }> {
  const session = await requirePermission(USER_MANAGE);

  try {
    // Prevent banning yourself
    if (userId === session.user.id) {
      return { success: false, error: 'You cannot ban your own account' };
    }

    const user = await prisma.user.update({
      where: { id: userId },
      data: {
        banned: true,
        banReason,
        banExpires,
      },
    });

    // Revoke all sessions for banned user
    await prisma.session.deleteMany({
      where: { userId },
    });

    await auditLog({
      action: 'user.ban',
      entityType: 'User',
      entityId: userId,
      newValues: {
        userName: user.name || user.email,
        banReason,
        banExpires,
      },
    });

    revalidatePath('/admin/users');
    revalidatePath(`/admin/users/${userId}`);

    return { success: true };
  } catch (error) {
    console.error('Failed to ban user:', error);
    return { success: false, error: 'Failed to ban user' };
  }
}

/**
 * Unban/Activate a user
 */
export async function unbanUser(userId: string): Promise<{ success: boolean; error?: string }> {
  await requirePermission(USER_MANAGE);

  try {
    const user = await prisma.user.update({
      where: { id: userId },
      data: {
        banned: false,
        banReason: null,
        banExpires: null,
      },
    });

    await auditLog({
      action: 'user.unban',
      entityType: 'User',
      entityId: userId,
      newValues: { userName: user.name || user.email },
    });

    revalidatePath('/admin/users');
    revalidatePath(`/admin/users/${userId}`);

    return { success: true };
  } catch (error) {
    console.error('Failed to unban user:', error);
    return { success: false, error: 'Failed to unban user' };
  }
}

/**
 * Send password reset email to user
 */
export async function sendPasswordReset(
  userId: string
): Promise<{ success: boolean; error?: string }> {
  await requirePermission(USER_MANAGE);

  try {
    const user = await prisma.user.findUnique({
      where: { id: userId, deletedAt: null },
    });

    if (!user) {
      return { success: false, error: 'User not found' };
    }

    // Generate a password reset token
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

    // Store the verification token
    await prisma.verification.create({
      data: {
        identifier: `password-reset:${user.id}`,
        value: token,
        expiresAt,
      },
    });

    // Generate reset URL
    const resetUrl = `${env.BETTER_AUTH_URL}/reset-password?token=${token}`;

    // Send email
    await sendEmail({
      to: user.email,
      subject: 'Password Reset - ECCB Platform',
      html: `
        <h2>Password Reset Request</h2>
        <p>Hi ${user.name || 'there'},</p>
        <p>An administrator has requested a password reset for your account. Click the link below to create a new password:</p>
        <p><a href="${resetUrl}" style="padding: 12px 24px; background: #0f766e; color: white; text-decoration: none; border-radius: 6px;">Reset Password</a></p>
        <p>Or copy this link: ${resetUrl}</p>
        <p><strong>This link will expire in 15 minutes.</strong></p>
        <p>If you didn't expect this email, you can safely ignore it.</p>
      `,
      text: `Reset your password by visiting: ${resetUrl}\n\nThis link expires in 15 minutes.`,
    });

    await auditLog({
      action: 'user.password_reset_sent',
      entityType: 'User',
      entityId: userId,
      newValues: { userName: user.name || user.email },
    });

    return { success: true };
  } catch (error) {
    console.error('Failed to send password reset:', error);
    return { success: false, error: 'Failed to send password reset email' };
  }
}

/**
 * Create a new user (optionally send invite)
 */
export async function createUser(
  email: string,
  name?: string,
  sendInvite: boolean = true
): Promise<{ success: boolean; error?: string; userId?: string }> {
  await requirePermission(USER_MANAGE);

  try {
    const validated = createUserSchema.parse({ email, name, sendInvite });

    // Check if user already exists
    const existingUser = await prisma.user.findUnique({
      where: { email: validated.email },
    });

    if (existingUser) {
      return { success: false, error: 'User with this email already exists' };
    }

    // Create user
    const user = await prisma.user.create({
      data: {
        email: validated.email,
        name: validated.name,
        emailVerified: false,
      },
    });

    if (validated.sendInvite) {
      // Generate invite token
      const token = randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

      await prisma.verification.create({
        data: {
          identifier: `invite:${user.id}`,
          value: token,
          expiresAt,
        },
      });

      const inviteUrl = `${env.BETTER_AUTH_URL}/signup?invite=${token}`;

      await sendEmail({
        to: user.email,
        subject: 'Welcome to ECCB Platform - Set Up Your Account',
        html: `
          <h2>Welcome to ECCB Platform!</h2>
          <p>Hi ${user.name || 'there'},</p>
          <p>An account has been created for you on the Emerald Coast Community Band platform. Click the link below to set up your account:</p>
          <p><a href="${inviteUrl}" style="padding: 12px 24px; background: #0f766e; color: white; text-decoration: none; border-radius: 6px;">Set Up Account</a></p>
          <p>Or copy this link: ${inviteUrl}</p>
          <p><strong>This invite will expire in 7 days.</strong></p>
        `,
        text: `Set up your account by visiting: ${inviteUrl}\n\nThis invite expires in 7 days.`,
      });
    }

    await auditLog({
      action: 'user.create',
      entityType: 'User',
      entityId: user.id,
      newValues: { email: user.email, name: user.name, sendInvite: validated.sendInvite },
    });

    revalidatePath('/admin/users');

    return { success: true, userId: user.id };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, error: error.issues[0].message };
    }
    console.error('Failed to create user:', error);
    return { success: false, error: 'Failed to create user' };
  }
}

/**
 * Delete a user (soft delete)
 */
export async function deleteUser(userId: string): Promise<{ success: boolean; error?: string }> {
  const session = await requirePermission(USER_MANAGE);

  try {
    // Prevent deleting yourself
    if (userId === session.user.id) {
      return { success: false, error: 'You cannot delete your own account' };
    }

    const user = await prisma.user.update({
      where: { id: userId },
      data: { deletedAt: new Date() },
    });

    // Revoke all sessions
    await prisma.session.deleteMany({
      where: { userId },
    });

    await auditLog({
      action: 'user.delete',
      entityType: 'User',
      entityId: userId,
      newValues: { userName: user.name || user.email },
    });

    revalidatePath('/admin/users');

    return { success: true };
  } catch (error) {
    console.error('Failed to delete user:', error);
    return { success: false, error: 'Failed to delete user' };
  }
}

/**
 * Revoke a specific session
 */
export async function revokeSession(
  sessionId: string
): Promise<{ success: boolean; error?: string }> {
  await requirePermission(USER_MANAGE);

  try {
    const session = await prisma.session.delete({
      where: { id: sessionId },
      include: { user: { select: { id: true, name: true, email: true } } },
    });

    await auditLog({
      action: 'session.revoke',
      entityType: 'Session',
      entityId: sessionId,
      newValues: { userId: session.user.id, userName: session.user.name || session.user.email },
    });

    revalidatePath(`/admin/users/${session.user.id}`);

    return { success: true };
  } catch (error) {
    console.error('Failed to revoke session:', error);
    return { success: false, error: 'Failed to revoke session' };
  }
}

/**
 * Revoke all sessions for a user
 */
export async function revokeAllSessions(
  userId: string
): Promise<{ success: boolean; error?: string; count?: number }> {
  await requirePermission(USER_MANAGE);

  try {
    const result = await prisma.session.deleteMany({
      where: { userId },
    });

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true },
    });

    await auditLog({
      action: 'session.revoke_all',
      entityType: 'User',
      entityId: userId,
      newValues: { userName: user?.name || user?.email, count: result.count },
    });

    revalidatePath(`/admin/users/${userId}`);

    return { success: true, count: result.count };
  } catch (error) {
    console.error('Failed to revoke all sessions:', error);
    return { success: false, error: 'Failed to revoke sessions' };
  }
}

/**
 * Impersonate a user (create a temporary session)
 * This is for admin support purposes
 */
export async function impersonateUser(
  userId: string
): Promise<{ success: boolean; error?: string; impersonationToken?: string }> {
  const session = await requirePermission(USER_MANAGE);

  try {
    // Prevent impersonating yourself
    if (userId === session.user.id) {
      return { success: false, error: 'You cannot impersonate your own account' };
    }

    const targetUser = await prisma.user.findUnique({
      where: { id: userId, deletedAt: null },
      select: { id: true, email: true, name: true, banned: true },
    });

    if (!targetUser) {
      return { success: false, error: 'User not found' };
    }

    if (targetUser.banned) {
      return { success: false, error: 'Cannot impersonate a banned user' };
    }

    // Generate an impersonation token
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    // Store the impersonation token
    await prisma.verification.create({
      data: {
        identifier: `impersonate:${session.user.id}:${targetUser.id}`,
        value: token,
        expiresAt,
      },
    });

    await auditLog({
      action: 'user.impersonate_start',
      entityType: 'User',
      entityId: userId,
      newValues: {
        adminId: session.user.id,
        adminEmail: session.user.email,
        targetEmail: targetUser.email,
      },
    });

    return { success: true, impersonationToken: token };
  } catch (error) {
    console.error('Failed to impersonate user:', error);
    return { success: false, error: 'Failed to impersonate user' };
  }
}

/**
 * Get user statistics for dashboard
 */
export async function getUserStats(): Promise<{
  total: number;
  active: number;
  banned: number;
  unverified: number;
  withMember: number;
  withoutMember: number;
}> {
  await requirePermission(USER_MANAGE);

  const [total, active, banned, unverified, withMember, withoutMember] = await Promise.all([
    prisma.user.count({ where: { deletedAt: null } }),
    prisma.user.count({ where: { deletedAt: null, banned: false, emailVerified: true } }),
    prisma.user.count({ where: { deletedAt: null, banned: true } }),
    prisma.user.count({ where: { deletedAt: null, emailVerified: false } }),
    prisma.user.count({ where: { deletedAt: null, member: { isNot: null } } }),
    prisma.user.count({ where: { deletedAt: null, member: { is: null } } }),
  ]);

  return { total, active, banned, unverified, withMember, withoutMember };
}
