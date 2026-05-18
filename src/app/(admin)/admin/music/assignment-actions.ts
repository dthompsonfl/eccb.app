'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db';
import { requirePermission, getSession } from '@/lib/auth/guards';
import { auditLog } from '@/lib/services/audit';
import { AssignmentStatus } from '@prisma/client';
import { MUSIC_ASSIGN } from '@/lib/auth/permission-constants';
import {
  invalidateMusicAssignmentCache,
  invalidateMusicDashboardCache,
} from '@/lib/cache';

/**
 * Bulk assign music to all members of one or more sections
 */
export async function assignMusicToSections(
  pieceId: string,
  sectionIds: string[],
  options?: {
    partName?: string;
    notes?: string;
    dueDate?: Date;
  }
) {
  const session = await requirePermission(MUSIC_ASSIGN);

  try {
    // Get all active members from the specified sections
    const members = await prisma.member.findMany({
      where: {
        status: 'ACTIVE',
        sections: {
          some: {
            sectionId: { in: sectionIds },
          },
        },
      },
      select: { id: true },
    });

    const memberIds = members.map((m) => m.id);

    if (memberIds.length === 0) {
      return { success: false, error: 'No active members found in selected sections' };
    }

    // Create assignments
    const result = await prisma.musicAssignment.createMany({
      data: memberIds.map((memberId) => ({
        pieceId,
        memberId,
        partName: options?.partName,
        notes: options?.notes,
        dueDate: options?.dueDate,
        assignedBy: session.user.id,
        status: AssignmentStatus.ASSIGNED,
      })),
      skipDuplicates: true,
    });

    // Create history entries for each assignment
    const existingAssignments = await prisma.musicAssignment.findMany({
      where: {
        pieceId,
        memberId: { in: memberIds },
      },
      select: { id: true, memberId: true },
    });

    await prisma.musicAssignmentHistory.createMany({
      data: existingAssignments.map((a) => ({
        assignmentId: a.id,
        action: 'ASSIGNED',
        toStatus: AssignmentStatus.ASSIGNED,
        notes: options?.notes || `Assigned via section bulk assignment`,
        performedBy: session.user.id,
      })),
    });

    await auditLog({
      action: 'music.assign.bulk',
      entityType: 'MusicPiece',
      entityId: pieceId,
      newValues: { sectionIds, memberCount: result.count },
    });

    // Invalidate caches
    await invalidateMusicAssignmentCache(pieceId);

    revalidatePath(`/admin/music/${pieceId}`);
    revalidatePath('/member/music');

    return { success: true, count: result.count };
  } catch (error) {
    console.error('Failed to assign music to sections:', error);
    return { success: false, error: 'Failed to assign music to sections' };
  }
}

/**
 * Update assignment status (for tracking part distribution)
 */
export async function updateAssignmentStatus(
  assignmentId: string,
  newStatus: AssignmentStatus,
  notes?: string
) {
  const session = await requirePermission(MUSIC_ASSIGN);

  try {
    const assignment = await prisma.musicAssignment.findUnique({
      where: { id: assignmentId },
      include: { piece: true },
    });

    if (!assignment) {
      return { success: false, error: 'Assignment not found' };
    }

    const oldStatus = assignment.status;
    const now = new Date();

    // Update the assignment with status-specific fields
    const updateData: Record<string, unknown> = {
      status: newStatus,
    };

    if (newStatus === AssignmentStatus.PICKED_UP) {
      updateData.pickedUpAt = now;
      updateData.pickedUpBy = session.user.id;
    } else if (newStatus === AssignmentStatus.RETURNED) {
      updateData.returnedAt = now;
      updateData.returnedTo = session.user.id;
    } else if (newStatus === AssignmentStatus.LOST) {
      updateData.missingSince = now;
      updateData.missingNotes = notes;
    }

    await prisma.musicAssignment.update({
      where: { id: assignmentId },
      data: updateData,
    });

    // Create history entry
    await prisma.musicAssignmentHistory.create({
      data: {
        assignmentId,
        action: `STATUS_CHANGED`,
        fromStatus: oldStatus,
        toStatus: newStatus,
        notes: notes || `Status changed from ${oldStatus} to ${newStatus}`,
        performedBy: session.user.id,
      },
    });

    await auditLog({
      action: 'music.assignment.status',
      entityType: 'MusicAssignment',
      entityId: assignmentId,
      oldValues: { status: oldStatus },
      newValues: { status: newStatus, notes },
    });

    // Invalidate caches
    await invalidateMusicAssignmentCache(assignment.pieceId);
    await invalidateMusicDashboardCache();

    revalidatePath(`/admin/music/${assignment.pieceId}`);
    revalidatePath('/member/music');

    return { success: true };
  } catch (error) {
    console.error('Failed to update assignment status:', error);
    return { success: false, error: 'Failed to update assignment status' };
  }
}

/**
 * Mark parts as picked up by member
 */
export async function markPartsPickedUp(
  assignmentIds: string[],
  pickedUpBy?: string
) {
  const session = await requirePermission(MUSIC_ASSIGN);

  try {
    const now = new Date();
    const results: string[] = [];

    // ⚡ Bolt: Batch database operations to prevent N+1 queries
    const assignments = await prisma.musicAssignment.findMany({
      where: {
        id: { in: assignmentIds },
        status: AssignmentStatus.ASSIGNED,
      },
      select: { id: true },
    });

    const validAssignmentIds = assignments.map(a => a.id);
    results.push(...validAssignmentIds);

    const operations = validAssignmentIds.flatMap((assignmentId) => {
      return [
        prisma.musicAssignment.update({
          where: { id: assignmentId },
          data: {
            status: AssignmentStatus.PICKED_UP,
            pickedUpAt: now,
            pickedUpBy: pickedUpBy || session.user.id,
          },
        }),
        prisma.musicAssignmentHistory.create({
          data: {
            assignmentId,
            action: 'PICKED_UP',
            fromStatus: AssignmentStatus.ASSIGNED,
            toStatus: AssignmentStatus.PICKED_UP,
            performedBy: session.user.id,
          },
        }),
      ];
    });

    await prisma.$transaction(operations);

    await auditLog({
      action: 'music.parts.picked_up',
      entityType: 'MusicAssignment',
      newValues: { count: results.length, assignmentIds: results },
    });

    // Invalidate caches
    await invalidateMusicAssignmentCache();
    await invalidateMusicDashboardCache();

    revalidatePath('/admin/music');
    revalidatePath('/member/music');

    return { success: true, count: results.length };
  } catch (error) {
    console.error('Failed to mark parts as picked up:', error);
    return { success: false, error: 'Failed to mark parts as picked up' };
  }
}

/**
 * Process music return workflow
 */
export async function processMusicReturn(
  assignmentId: string,
  data: {
    condition?: string;
    notes?: string;
  }
) {
  const session = await requirePermission(MUSIC_ASSIGN);

  try {
    const assignment = await prisma.musicAssignment.findUnique({
      where: { id: assignmentId },
      include: { piece: true, member: true },
    });

    if (!assignment) {
      return { success: false, error: 'Assignment not found' };
    }

    if (assignment.status !== AssignmentStatus.PICKED_UP &&
        assignment.status !== AssignmentStatus.OVERDUE) {
      return { success: false, error: 'Assignment is not in a returnable state' };
    }

    const now = new Date();
    const oldStatus = assignment.status;

    // Determine new status based on condition
    let newStatus: AssignmentStatus = AssignmentStatus.RETURNED;
    if (data.condition === 'damaged') {
      newStatus = AssignmentStatus.DAMAGED;
    }

    await prisma.musicAssignment.update({
      where: { id: assignmentId },
      data: {
        status: newStatus,
        returnedAt: now,
        returnedTo: session.user.id,
        condition: data.condition,
        notes: data.notes ? `${assignment.notes || ''}\n${data.notes}`.trim() : assignment.notes,
      },
    });

    await prisma.musicAssignmentHistory.create({
      data: {
        assignmentId,
        action: 'RETURNED',
        fromStatus: oldStatus,
        toStatus: newStatus,
        notes: data.condition ? `Condition: ${data.condition}` : undefined,
        performedBy: session.user.id,
      },
    });

    await auditLog({
      action: 'music.returned',
      entityType: 'MusicAssignment',
      entityId: assignmentId,
      newValues: {
        condition: data.condition,
        pieceTitle: assignment.piece.title,
        memberName: `${assignment.member.firstName} ${assignment.member.lastName}`,
      },
    });

    // Invalidate caches
    await invalidateMusicAssignmentCache(assignment.pieceId);
    await invalidateMusicDashboardCache();

    revalidatePath(`/admin/music/${assignment.pieceId}`);
    revalidatePath('/member/music');

    return { success: true };
  } catch (error) {
    console.error('Failed to process music return:', error);
    return { success: false, error: 'Failed to process music return' };
  }
}

/**
 * Report missing/lost parts
 */
export async function reportMissingParts(
  assignmentId: string,
  data: {
    notes: string;
    reportDate?: Date;
  }
) {
  const session = await requirePermission(MUSIC_ASSIGN);

  try {
    const assignment = await prisma.musicAssignment.findUnique({
      where: { id: assignmentId },
      include: { piece: true, member: true },
    });

    if (!assignment) {
      return { success: false, error: 'Assignment not found' };
    }

    const oldStatus = assignment.status;
    const now = data.reportDate || new Date();

    await prisma.musicAssignment.update({
      where: { id: assignmentId },
      data: {
        status: AssignmentStatus.LOST,
        missingSince: now,
        missingNotes: data.notes,
      },
    });

    await prisma.musicAssignmentHistory.create({
      data: {
        assignmentId,
        action: 'REPORTED_MISSING',
        fromStatus: oldStatus,
        toStatus: AssignmentStatus.LOST,
        notes: data.notes,
        performedBy: session.user.id,
      },
    });

    await auditLog({
      action: 'music.reported_missing',
      entityType: 'MusicAssignment',
      entityId: assignmentId,
      newValues: {
        notes: data.notes,
        pieceTitle: assignment.piece.title,
        memberName: `${assignment.member.firstName} ${assignment.member.lastName}`,
      },
    });

    // Invalidate caches
    await invalidateMusicAssignmentCache(assignment.pieceId);
    await invalidateMusicDashboardCache();

    revalidatePath(`/admin/music/${assignment.pieceId}`);
    revalidatePath('/admin/music');

    return { success: true };
  } catch (error) {
    console.error('Failed to report missing parts:', error);
    return { success: false, error: 'Failed to report missing parts' };
  }
}

/**
 * Get assignment history for a piece or member
 */
export async function getAssignmentHistory(options: {
  pieceId?: string;
  memberId?: string;
  assignmentId?: string;
  limit?: number;
}) {
  await requirePermission('music:read');

  try {
    const where: Record<string, unknown> = {};

    if (options.assignmentId) {
      where.assignmentId = options.assignmentId;
    } else if (options.pieceId) {
      where.assignment = { pieceId: options.pieceId };
    } else if (options.memberId) {
      where.assignment = { memberId: options.memberId };
    }

    const history = await prisma.musicAssignmentHistory.findMany({
      where,
      include: {
        assignment: {
          include: {
            piece: { select: { id: true, title: true } },
            member: { select: { id: true, firstName: true, lastName: true } },
          },
        },
      },
      orderBy: { performedAt: 'desc' },
      take: options.limit || 50,
    });

    return { success: true, history };
  } catch (error) {
    console.error('Failed to get assignment history:', error);
    return { success: false, error: 'Failed to get assignment history' };
  }
}

/**
 * Get librarian dashboard statistics
 */
export async function getLibrarianDashboardStats() {
  await requirePermission('music:read');

  try {
    const now = new Date();

    // Get counts by status
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const [
      statusCounts,
      overdueCount,
      recentActivity,
      missingCount,
      pendingPickups,
      pendingReturns
    ] = await Promise.all([
      // Get counts by status
      prisma.musicAssignment.groupBy({
        by: ['status'],
        _count: true,
      }),
      // Get overdue assignments
      prisma.musicAssignment.count({
        where: {
          status: { in: [AssignmentStatus.ASSIGNED, AssignmentStatus.PICKED_UP] },
          dueDate: { lt: now },
        },
      }),
      // Get recent activity (last 7 days)
      prisma.musicAssignmentHistory.count({
        where: {
          performedAt: { gte: weekAgo },
        },
      }),
      // Get missing parts count
      prisma.musicAssignment.count({
        where: {
          status: AssignmentStatus.LOST,
        },
      }),
      // Get pending pickups (assigned but not picked up)
      prisma.musicAssignment.count({
        where: {
          status: AssignmentStatus.ASSIGNED,
        },
      }),
      // Get pending returns (picked up but not returned)
      prisma.musicAssignment.count({
        where: {
          status: AssignmentStatus.PICKED_UP,
        },
      }),
    ]);

    // Get recent assignments needing attention
    const needsAttention = await prisma.musicAssignment.findMany({
      where: {
        OR: [
          { status: AssignmentStatus.OVERDUE },
          { status: AssignmentStatus.LOST },
          { status: AssignmentStatus.DAMAGED },
        ],
      },
      include: {
        piece: { select: { id: true, title: true, catalogNumber: true } },
        member: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            user: { select: { email: true } },
            instruments: {
              where: { isPrimary: true },
              select: { instrument: { select: { name: true } } },
            },
          }
        },
      },
      take: 10,
      orderBy: { assignedAt: 'desc' },
    });

    // Format status counts
    const statusMap: Record<string, number> = {
      ASSIGNED: 0,
      PICKED_UP: 0,
      RETURNED: 0,
      OVERDUE: 0,
      LOST: 0,
      DAMAGED: 0,
    };

    for (const item of statusCounts) {
      statusMap[item.status] = item._count;
    }

    return {
      success: true,
      stats: {
        statusCounts: statusMap,
        overdueCount,
        recentActivity,
        missingCount,
        pendingPickups,
        pendingReturns,
        needsAttention,
      },
    };
  } catch (error) {
    console.error('Failed to get librarian dashboard stats:', error);
    return { success: false, error: 'Failed to get dashboard statistics' };
  }
}

/**
 * Get all assignments with filtering for librarian management
 */
export async function getAssignmentsForLibrarian(filters?: {
  status?: AssignmentStatus;
  pieceId?: string;
  memberId?: string;
  overdue?: boolean;
  search?: string;
}) {
  await requirePermission('music:read');

  try {
    const where: Record<string, unknown> = {};

    if (filters?.status) {
      where.status = filters.status;
    }

    if (filters?.pieceId) {
      where.pieceId = filters.pieceId;
    }

    if (filters?.memberId) {
      where.memberId = filters.memberId;
    }

    if (filters?.overdue) {
      where.status = { in: [AssignmentStatus.ASSIGNED, AssignmentStatus.PICKED_UP] };
      where.dueDate = { lt: new Date() };
    }

    if (filters?.search) {
      where.OR = [
        { piece: { title: { contains: filters.search } } },
        {
          member: {
            OR: [
              { firstName: { contains: filters.search } },
              { lastName: { contains: filters.search } },
            ],
          }
        },
        { partName: { contains: filters.search } },
      ];
    }

    const assignments = await prisma.musicAssignment.findMany({
      where,
      include: {
        piece: {
          select: {
            id: true,
            title: true,
            catalogNumber: true,
          }
        },
        member: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            user: { select: { email: true } },
            instruments: {
              where: { isPrimary: true },
              select: { instrument: { select: { name: true } } },
            },
          }
        },
      },
      orderBy: { assignedAt: 'desc' },
      take: 100,
    });

    return { success: true, assignments };
  } catch (error) {
    console.error('Failed to get assignments for librarian:', error);
    return { success: false, error: 'Failed to get assignments' };
  }
}

/**
 * Mark overdue assignments
 * This should be run periodically (e.g., via cron job)
 */
export async function markOverdueAssignments() {
  const session = await getSession();
  if (!session) {
    return { success: false, error: 'Unauthorized' };
  }

  try {
    const now = new Date();

    // Find assignments that are past due and not yet returned
    const overdueAssignments = await prisma.musicAssignment.findMany({
      where: {
        status: { in: [AssignmentStatus.ASSIGNED, AssignmentStatus.PICKED_UP] },
        dueDate: { lt: now },
      },
    });

    let markedCount = 0;

    // ⚡ Bolt: Batch database operations in loops to prevent N+1 queries
    const updateOperations: any[] = [];
    const createHistoryOperations: any[] = [];

    for (const assignment of overdueAssignments) {
      if (assignment.status !== AssignmentStatus.OVERDUE) {
        updateOperations.push(
          prisma.musicAssignment.update({
            where: { id: assignment.id },
            data: { status: AssignmentStatus.OVERDUE },
          })
        );

        createHistoryOperations.push(
          prisma.musicAssignmentHistory.create({
            data: {
              assignmentId: assignment.id,
              action: 'MARKED_OVERDUE',
              fromStatus: assignment.status,
              toStatus: AssignmentStatus.OVERDUE,
              notes: `Automatically marked overdue (due date: ${assignment.dueDate?.toISOString()})`,
              performedBy: session.user.id,
            },
          })
        );

        markedCount++;
      }
    }

    if (updateOperations.length > 0) {
      await prisma.$transaction([...updateOperations, ...createHistoryOperations]);
    }

    await auditLog({
      action: 'music.overdue.marked',
      entityType: 'MusicAssignment',
      newValues: { count: markedCount },
    });

    // Invalidate caches
    await invalidateMusicAssignmentCache();
    await invalidateMusicDashboardCache();

    return { success: true, markedCount };
  } catch (error) {
    console.error('Failed to mark overdue assignments:', error);
    return { success: false, error: 'Failed to mark overdue assignments' };
  }
}

export async function assignMusicToMembers(
  pieceId: string,
  memberIds: string[],
  notes?: string
) {
  const session = await requirePermission(MUSIC_ASSIGN);

  try {
    // Create assignments
    await prisma.musicAssignment.createMany({
      data: memberIds.map((memberId) => ({
        pieceId,
        memberId,
        assignedBy: session.user.id,
        notes,
      })),
      skipDuplicates: true,
    });

    await auditLog({
      action: 'music.assign',
      entityType: 'MusicPiece',
      entityId: pieceId,
      newValues: { memberCount: memberIds.length },
    });

    // Invalidate caches
    await invalidateMusicAssignmentCache(pieceId);

    revalidatePath(`/admin/music/${pieceId}`);
    revalidatePath('/member/music');

    return { success: true };
  } catch (error) {
    console.error('Failed to assign music:', error);
    return { success: false, error: 'Failed to assign music' };
  }
}

export async function unassignMusicFromMember(
  pieceId: string,
  memberId: string
) {
  await requirePermission(MUSIC_ASSIGN);

  try {
    await prisma.musicAssignment.deleteMany({
      where: {
        pieceId,
        memberId,
      },
    });

    await auditLog({
      action: 'music.unassign',
      entityType: 'MusicPiece',
      entityId: pieceId,
      newValues: { memberId },
    });

    // Invalidate caches
    await invalidateMusicAssignmentCache(pieceId, memberId);

    revalidatePath(`/admin/music/${pieceId}`);
    revalidatePath('/member/music');

    return { success: true };
  } catch (error) {
    console.error('Failed to unassign music:', error);
    return { success: false, error: 'Failed to unassign music' };
  }
}
