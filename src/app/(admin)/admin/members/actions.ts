'use server';

import { MEMBER_CREATE, MEMBER_DELETE, MEMBER_EDIT_ALL, MEMBER_VIEW_ALL } from '@/lib/auth/permission-constants';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db';
import { requirePermission, canAccessMember, getMemberSectionFilter } from '@/lib/auth/guards';
import { auditLog } from '@/lib/services/audit';
import { z } from 'zod';
import { MemberStatus } from '@prisma/client';

const memberSchema = z.object({
  firstName: z.string().min(1, 'First name is required'),
  lastName: z.string().min(1, 'Last name is required'),
  email: z.string().email().optional().or(z.literal('')),
  userId: z.string().optional(),
  sectionId: z.string().optional(),
  primaryInstrumentId: z.string().optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'LEAVE_OF_ABSENCE', 'PENDING', 'ALUMNI', 'AUDITION']),
  joinDate: z.string().optional(),
  phone: z.string().optional(),
  emergencyName: z.string().optional(),
  emergencyPhone: z.string().optional(),
  emergencyEmail: z.string().optional(),
  notes: z.string().optional(),
});

export async function createMember(formData: FormData) {
  const _session = await requirePermission(MEMBER_CREATE);

  try {
    const data = {
      firstName: formData.get('firstName') as string,
      lastName: formData.get('lastName') as string,
      email: formData.get('email') as string || undefined,
      userId: formData.get('userId') as string || undefined,
      sectionId: formData.get('sectionId') as string || undefined,
      primaryInstrumentId: formData.get('primaryInstrumentId') as string || undefined,
      status: formData.get('status') as string || 'PENDING',
      joinDate: formData.get('joinDate') as string || undefined,
      phone: formData.get('phone') as string || undefined,
      emergencyName: formData.get('emergencyName') as string || undefined,
      emergencyPhone: formData.get('emergencyPhone') as string || undefined,
      emergencyEmail: formData.get('emergencyEmail') as string || undefined,
      notes: formData.get('notes') as string || undefined,
    };

    const validated = memberSchema.parse(data);

    // Check if user already has a member profile (if userId provided)
    if (validated.userId) {
      const existingMember = await prisma.member.findUnique({
        where: { userId: validated.userId },
      });

      if (existingMember) {
        return { success: false, error: 'User already has a member profile' };
      }
    }

    const member = await prisma.member.create({
      data: {
        firstName: validated.firstName,
        lastName: validated.lastName,
        email: validated.email || undefined,
        userId: validated.userId || undefined,
        status: validated.status as MemberStatus,
        joinDate: validated.joinDate ? new Date(validated.joinDate) : undefined,
        phone: validated.phone || undefined,
        emergencyName: validated.emergencyName || undefined,
        emergencyPhone: validated.emergencyPhone || undefined,
        emergencyEmail: validated.emergencyEmail || undefined,
        notes: validated.notes || undefined,
      },
    });

    // Create section assignment if sectionId provided
    if (validated.sectionId) {
      await prisma.memberSection.create({
        data: {
          memberId: member.id,
          sectionId: validated.sectionId,
        },
      });
    }

    // Create instrument assignment if primaryInstrumentId provided
    if (validated.primaryInstrumentId) {
      await prisma.memberInstrument.create({
        data: {
          memberId: member.id,
          instrumentId: validated.primaryInstrumentId,
          isPrimary: true,
        },
      });
    }

    await auditLog({
      action: 'member.create',
      entityType: 'Member',
      entityId: member.id,
      newValues: { name: `${member.firstName} ${member.lastName}` },
    });

    revalidatePath('/admin/members');

    return { success: true, memberId: member.id };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, error: error.issues[0].message };
    }
    console.error('Failed to create member:', error);
    return { success: false, error: 'Failed to create member' };
  }
}

export async function updateMember(id: string, formData: FormData) {
  // Check if user can access this member (section scoping)
  const access = await canAccessMember(id, { allowOwn: false });
  if (!access.canAccess) {
    return { success: false, error: 'You do not have permission to update this member' };
  }

  const _session = await requirePermission(MEMBER_EDIT_ALL);

  try {
    const data = {
      firstName: formData.get('firstName') as string,
      lastName: formData.get('lastName') as string,
      email: formData.get('email') as string || undefined,
      sectionId: formData.get('sectionId') as string || undefined,
      primaryInstrumentId: formData.get('primaryInstrumentId') as string || undefined,
      status: formData.get('status') as string,
      joinDate: formData.get('joinDate') as string || undefined,
      phone: formData.get('phone') as string || undefined,
      emergencyName: formData.get('emergencyName') as string || undefined,
      emergencyPhone: formData.get('emergencyPhone') as string || undefined,
      emergencyEmail: formData.get('emergencyEmail') as string || undefined,
      notes: formData.get('notes') as string || undefined,
    };

    const member = await prisma.member.update({
      where: { id },
      data: {
        firstName: data.firstName,
        lastName: data.lastName,
        email: data.email || null,
        status: data.status as MemberStatus,
        joinDate: data.joinDate ? new Date(data.joinDate) : undefined,
        phone: data.phone || null,
        emergencyName: data.emergencyName || null,
        emergencyPhone: data.emergencyPhone || null,
        emergencyEmail: data.emergencyEmail || null,
        notes: data.notes || null,
      },
    });

    // Update section assignment if changed
    if (data.sectionId !== undefined) {
      // Remove existing section assignments and create new one
      await prisma.memberSection.deleteMany({
        where: { memberId: id },
      });
      if (data.sectionId) {
        await prisma.memberSection.create({
          data: {
            memberId: id,
            sectionId: data.sectionId,
          },
        });
      }
    }

    // Update primary instrument if changed
    if (data.primaryInstrumentId !== undefined) {
      // Remove existing primary instrument
      await prisma.memberInstrument.deleteMany({
        where: { memberId: id, isPrimary: true },
      });
      if (data.primaryInstrumentId) {
        await prisma.memberInstrument.upsert({
          where: {
            memberId_instrumentId: {
              memberId: id,
              instrumentId: data.primaryInstrumentId,
            },
          },
          update: { isPrimary: true },
          create: {
            memberId: id,
            instrumentId: data.primaryInstrumentId,
            isPrimary: true,
          },
        });
      }
    }

    await auditLog({
      action: 'member.update',
      entityType: 'Member',
      entityId: member.id,
      newValues: { name: `${member.firstName} ${member.lastName}` },
    });

    revalidatePath('/admin/members');
    revalidatePath(`/admin/members/${id}`);

    return { success: true };
  } catch (error) {
    console.error('Failed to update member:', error);
    return { success: false, error: 'Failed to update member' };
  }
}

export async function deleteMember(id: string) {
  // Check if user can access this member (section scoping)
  const access = await canAccessMember(id, { allowOwn: false });
  if (!access.canAccess) {
    return { success: false, error: 'You do not have permission to delete this member' };
  }

  const _session = await requirePermission(MEMBER_DELETE);

  try {
    const member = await prisma.member.delete({
      where: { id },
    });

    await auditLog({
      action: 'member.delete',
      entityType: 'Member',
      entityId: id,
      newValues: { name: `${member.firstName} ${member.lastName}` },
    });

    revalidatePath('/admin/members');

    return { success: true };
  } catch (error) {
    console.error('Failed to delete member:', error);
    return { success: false, error: 'Failed to delete member' };
  }
}

export async function updateMemberStatus(id: string, status: string) {
  const _session = await requirePermission(MEMBER_EDIT_ALL);

  try {
    const member = await prisma.member.update({
      where: { id },
      data: { status: status as MemberStatus },
    });

    await auditLog({
      action: 'member.status_change',
      entityType: 'Member',
      entityId: id,
      newValues: { name: `${member.firstName} ${member.lastName}`, status },
    });

    revalidatePath('/admin/members');
    revalidatePath(`/admin/members/${id}`);

    return { success: true };
  } catch (error) {
    console.error('Failed to update member status:', error);
    return { success: false, error: 'Failed to update status' };
  }
}

export async function assignMemberToSection(memberId: string, sectionId: string | null) {
  const _session = await requirePermission(MEMBER_EDIT_ALL);

  try {
    // Remove existing section assignments
    await prisma.memberSection.deleteMany({
      where: { memberId },
    });

    // Create new assignment if sectionId provided
    if (sectionId) {
      await prisma.memberSection.create({
        data: {
          memberId,
          sectionId,
        },
      });
    }

    const member = await prisma.member.findUnique({
      where: { id: memberId },
      include: {
        sections: {
          include: { section: true },
        },
      },
    });

    await auditLog({
      action: 'member.section_change',
      entityType: 'Member',
      entityId: memberId,
      newValues: {
        name: member ? `${member.firstName} ${member.lastName}` : 'Unknown',
        section: member?.sections[0]?.section.name || 'None',
      },
    });

    revalidatePath('/admin/members');
    revalidatePath(`/admin/members/${memberId}`);

    return { success: true };
  } catch (error) {
    console.error('Failed to assign section:', error);
    return { success: false, error: 'Failed to assign section' };
  }
}

// =============================================================================
// BULK OPERATIONS
// =============================================================================

const bulkOperationSchema = z.object({
  memberIds: z.array(z.string()).min(1, 'At least one member must be selected'),
});

export async function bulkUpdateMemberStatus(memberIds: string[], status: MemberStatus) {
  const _session = await requirePermission(MEMBER_EDIT_ALL);

  try {
    const validated = bulkOperationSchema.parse({ memberIds });

    const result = await prisma.member.updateMany({
      where: { id: { in: validated.memberIds } },
      data: { status },
    });

    await auditLog({
      action: 'member.bulk_status_change',
      entityType: 'Member',
      newValues: { count: result.count, status, memberIds: validated.memberIds },
    });

    revalidatePath('/admin/members');

    return { success: true, count: result.count };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, error: error.issues[0].message };
    }
    console.error('Failed to bulk update status:', error);
    return { success: false, error: 'Failed to update member status' };
  }
}

export async function bulkAssignSection(memberIds: string[], sectionId: string | null) {
  const _session = await requirePermission(MEMBER_EDIT_ALL);

  try {
    const validated = bulkOperationSchema.parse({ memberIds });

    // Use a transaction to ensure atomicity
    await prisma.$transaction(async (tx) => {
      // Remove existing section assignments for all selected members
      await tx.memberSection.deleteMany({
        where: { memberId: { in: validated.memberIds } },
      });

      // Create new assignments if sectionId provided
      if (sectionId) {
        await tx.memberSection.createMany({
          data: validated.memberIds.map((memberId) => ({
            memberId,
            sectionId,
          })),
        });
      }
    });

    await auditLog({
      action: 'member.bulk_section_assign',
      entityType: 'Member',
      newValues: { count: validated.memberIds.length, sectionId, memberIds: validated.memberIds },
    });

    revalidatePath('/admin/members');

    return { success: true, count: validated.memberIds.length };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, error: error.issues[0].message };
    }
    console.error('Failed to bulk assign section:', error);
    return { success: false, error: 'Failed to assign section' };
  }
}

export async function bulkAssignRole(memberIds: string[], roleId: string) {
  const session = await requirePermission(MEMBER_EDIT_ALL);

  try {
    const validated = bulkOperationSchema.parse({ memberIds });

    // Get user IDs linked to the selected members
    const members = await prisma.member.findMany({
      where: { id: { in: validated.memberIds } },
      select: { id: true, userId: true, firstName: true, lastName: true },
    });

    const usersWithIds = members.filter((m) => m.userId);

    if (usersWithIds.length === 0) {
      return { success: false, error: 'No members with linked user accounts found' };
    }

    // Assign role to users
    // ⚡ Bolt: Prevent N+1 queries by using createMany with skipDuplicates instead of iterative upserts
    const roleAssignments = usersWithIds
      .filter((m) => m.userId)
      .map((m) => ({
        userId: m.userId as string,
        roleId,
        assignedBy: session.user.id,
      }));

    if (roleAssignments.length > 0) {
      await prisma.userRole.createMany({
        data: roleAssignments,
        skipDuplicates: true,
      });
    }

    await auditLog({
      action: 'member.bulk_role_assign',
      entityType: 'Member',
      newValues: { count: usersWithIds.length, roleId, memberIds: validated.memberIds },
    });

    revalidatePath('/admin/members');

    return { success: true, count: usersWithIds.length };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, error: error.issues[0].message };
    }
    console.error('Failed to bulk assign role:', error);
    return { success: false, error: 'Failed to assign role' };
  }
}

export async function bulkDeleteMembers(memberIds: string[]) {
  const _session = await requirePermission(MEMBER_DELETE);

  try {
    const validated = bulkOperationSchema.parse({ memberIds });

    const result = await prisma.member.deleteMany({
      where: { id: { in: validated.memberIds } },
    });

    await auditLog({
      action: 'member.bulk_delete',
      entityType: 'Member',
      newValues: { count: result.count, memberIds: validated.memberIds },
    });

    revalidatePath('/admin/members');

    return { success: true, count: result.count };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, error: error.issues[0].message };
    }
    console.error('Failed to bulk delete members:', error);
    return { success: false, error: 'Failed to delete members' };
  }
}

export async function linkMemberToUser(memberId: string, userId: string) {
  const _session = await requirePermission(MEMBER_EDIT_ALL);

  try {
    // Check if user already has a member profile
    const existingMember = await prisma.member.findUnique({
      where: { userId },
    });

    if (existingMember && existingMember.id !== memberId) {
      return { success: false, error: 'User already has a different member profile' };
    }

    const member = await prisma.member.update({
      where: { id: memberId },
      data: { userId },
    });

    await auditLog({
      action: 'member.link_user',
      entityType: 'Member',
      entityId: memberId,
      newValues: { name: `${member.firstName} ${member.lastName}`, userId },
    });

    revalidatePath('/admin/members');
    revalidatePath(`/admin/members/${memberId}`);

    return { success: true };
  } catch (error) {
    console.error('Failed to link member to user:', error);
    return { success: false, error: 'Failed to link member to user' };
  }
}

export async function unlinkMemberFromUser(memberId: string) {
  const _session = await requirePermission(MEMBER_EDIT_ALL);

  try {
    const member = await prisma.member.update({
      where: { id: memberId },
      data: { userId: null },
    });

    await auditLog({
      action: 'member.unlink_user',
      entityType: 'Member',
      entityId: member.id,
      newValues: { name: `${member.firstName} ${member.lastName}` },
    });

    revalidatePath('/admin/members');
    revalidatePath(`/admin/members/${member.id}`);

    return { success: true };
  } catch (error) {
    console.error('Failed to unlink member from user:', error);
    return { success: false, error: 'Failed to unlink member from user' };
  }
}

// =============================================================================
// EXPORT FUNCTIONALITY
// =============================================================================

export interface MemberExportFilters {
  search?: string;
  status?: string;
  sectionId?: string;
  instrumentId?: string;
  roleId?: string;
}

export async function exportMembersToCSV(filters: MemberExportFilters = {}) {
  await requirePermission(MEMBER_VIEW_ALL);

  const sectionFilter = await getMemberSectionFilter();

  try {
    // Build where clause (same logic as page)
    const where: Record<string, unknown> = {};

    if (sectionFilter) {
      where.sections = {
        some: { sectionId: sectionFilter },
      };
    } else if (filters.sectionId) {
      where.sections = {
        some: { sectionId: filters.sectionId },
      };
    }

    if (filters.status) {
      where.status = filters.status;
    }

    if (filters.instrumentId) {
      where.instruments = {
        some: { instrumentId: filters.instrumentId },
      };
    }

    if (filters.roleId) {
      where.user = {
        roles: {
          some: { roleId: filters.roleId },
        },
      };
    }

    if (filters.search) {
      const searchConditions = [
        { firstName: { contains: filters.search, mode: 'insensitive' } },
        { lastName: { contains: filters.search, mode: 'insensitive' } },
        { email: { contains: filters.search, mode: 'insensitive' } },
      ];
      
      if (filters.roleId) {
        where.user = {
          ...where.user as object,
          AND: [
            where.user as object,
            {
              OR: [
                { name: { contains: filters.search, mode: 'insensitive' } },
                { email: { contains: filters.search, mode: 'insensitive' } },
              ],
            },
          ],
        };
      } else {
        (where as Record<string, unknown>).OR = [
          ...searchConditions,
          { user: { name: { contains: filters.search, mode: 'insensitive' } } },
          { user: { email: { contains: filters.search, mode: 'insensitive' } } },
        ];
      }
    }

    const members = await prisma.member.findMany({
      where,
      include: {
        user: {
          include: {
            roles: {
              include: { role: true },
            },
          },
        },
        instruments: {
          where: { isPrimary: true },
          include: { instrument: true },
        },
        sections: {
          include: { section: true },
        },
      },
      orderBy: { lastName: 'asc' },
    });

    // Generate CSV
    const headers = [
      'First Name',
      'Last Name',
      'Email',
      'Phone',
      'Status',
      'Section',
      'Instrument',
      'Role',
      'Join Date',
      'Emergency Contact',
      'Emergency Phone',
      'Emergency Email',
    ];

    const rows = members.map((member) => {
      const primarySection = member.sections[0]?.section;
      const primaryInstrument = member.instruments[0]?.instrument;
      const primaryRole = member.user?.roles[0]?.role;

      return [
        member.firstName,
        member.lastName,
        member.email || member.user?.email || '',
        member.phone || '',
        member.status,
        primarySection?.name || '',
        primaryInstrument?.name || '',
        primaryRole ? (primaryRole.displayName || primaryRole.name) : '',
        member.joinDate ? member.joinDate.toISOString().split('T')[0] : '',
        member.emergencyName || '',
        member.emergencyPhone || '',
        member.emergencyEmail || '',
      ];
    });

    // Escape CSV fields
    const escapeCSV = (field: string) => {
      if (field.includes(',') || field.includes('"') || field.includes('\n')) {
        return `"${field.replace(/"/g, '""')}"`;
      }
      return field;
    };

    const csvContent = [
      headers.map(escapeCSV).join(','),
      ...rows.map((row) => row.map(escapeCSV).join(',')),
    ].join('\n');

    await auditLog({
      action: 'member.export',
      entityType: 'Member',
      newValues: { count: members.length, filters },
    });

    return {
      success: true,
      data: csvContent,
      filename: `members-export-${new Date().toISOString().split('T')[0]}.csv`,
      count: members.length,
    };
  } catch (error) {
    console.error('Failed to export members:', error);
    return { success: false, error: 'Failed to export members' };
  }
}
