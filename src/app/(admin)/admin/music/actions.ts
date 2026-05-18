'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db';
import { requirePermission, getSession } from '@/lib/auth/guards';
import { uploadFile, deleteFile } from '@/lib/services/storage';
import { auditLog } from '@/lib/services/audit';
import { MusicDifficulty, FileType, AssignmentStatus } from '@prisma/client';
import {
  MUSIC_CREATE,
  MUSIC_EDIT,
  MUSIC_DELETE,
  MUSIC_ASSIGN,
} from '@/lib/auth/permission-constants';
import {
  invalidateMusicCache,
  invalidateMusicAssignmentCache,
  invalidateMusicDashboardCache,
} from '@/lib/cache';
import { z } from 'zod';

// Forced change to fix CI
// =============================================================================
// ZOD VALIDATION SCHEMAS
// =============================================================================

const musicPieceSchema = z.object({
  title: z.string().min(1, 'Title is required'),
  subtitle: z.string().optional(),
  composerId: z.string().optional(),
  arrangerId: z.string().optional(),
  publisherId: z.string().optional(),
  difficulty: z.nativeEnum(MusicDifficulty).optional(),
  duration: z.number().positive().optional(),
  genre: z.string().optional(),
  style: z.string().optional(),
  catalogNumber: z.string().optional(),
  notes: z.string().optional(),
});

const _musicFileUploadSchema = z.object({
  file: z.any().refine((f) => f && typeof f.size === 'number' && f.size > 0, 'File is required'),
  partType: z.string().optional(),
  instrumentId: z.string().optional(),
  fileType: z.nativeEnum(FileType).optional(),
  description: z.string().optional(),
  changeNote: z.string().optional(),
  existingFileId: z.string().optional(),
});

const musicFileUpdateSchema = z.object({
  description: z.string().optional(),
  fileType: z.nativeEnum(FileType).optional(),
  isPublic: z.boolean().optional(),
});

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
  const _session = await requirePermission('music:read');
  
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
  const _session = await requirePermission('music:read');
  
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
  const _session = await requirePermission('music:read');
  
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

export async function createMusicPiece(formData: FormData) {
  const _session = await requirePermission(MUSIC_CREATE);
  
  try {
    const title = formData.get('title') as string;
    const subtitle = formData.get('subtitle') as string | null;
    const composerId = formData.get('composerId') as string | null;
    const arrangerId = formData.get('arrangerId') as string | null;
    const publisherId = formData.get('publisherId') as string | null;
    const difficultyValue = formData.get('difficulty') as string | null;
    const difficulty = difficultyValue ? (difficultyValue as MusicDifficulty) : null;
    const duration = formData.get('duration') ? Number(formData.get('duration')) : null;
    const genre = formData.get('genre') as string | null;
    const style = formData.get('style') as string | null;
    const catalogNumber = formData.get('catalogNumber') as string | null;
    const notes = formData.get('notes') as string | null;
    const files = formData.getAll('files') as File[];

    const partialData = {
      title,
      subtitle: subtitle || undefined,
      composerId: composerId || undefined,
      arrangerId: arrangerId || undefined,
      publisherId: publisherId || undefined,
      difficulty,
      duration,
      genre: genre || undefined,
      style: style || undefined,
      catalogNumber: catalogNumber || undefined,
      notes: notes || undefined,
    };
    
    const parsed = musicPieceSchema.partial().safeParse(partialData);
    if (!parsed.success) {
      return { success: false, error: 'Invalid input data', details: parsed.error.issues };
    }

    // Create the music piece
    const piece = await prisma.musicPiece.create({
      data: {
        title: parsed.data.title || '',
        subtitle: parsed.data.subtitle,
        composerId: parsed.data.composerId,
        arrangerId: parsed.data.arrangerId,
        publisherId: parsed.data.publisherId,
        difficulty: parsed.data.difficulty,
        duration: parsed.data.duration,
        genre: parsed.data.genre,
        style: parsed.data.style,
        catalogNumber: parsed.data.catalogNumber,
        notes: parsed.data.notes,
      },
    });

    // Upload files if any
    const uploadedFiles = [];
    for (const file of files) {
      if (file && file.size > 0) {
        const buffer = await file.arrayBuffer();
        const key = `music/${piece.id}/${Date.now()}-${file.name}`;
        await uploadFile(key, Buffer.from(buffer), {
          contentType: file.type,
        });
        
        uploadedFiles.push({
          pieceId: piece.id,
          fileName: file.name,
          storageKey: key,
          mimeType: file.type,
          fileSize: file.size,
          fileType: getFileType(file.type),
        });
      }
    }

    if (uploadedFiles.length > 0) {
      await prisma.musicFile.createMany({
        data: uploadedFiles,
      });
    }

    await auditLog({
      action: 'music.create',
      entityType: 'MusicPiece',
      entityId: piece.id,
      newValues: { title: piece.title, fileCount: uploadedFiles.length },
    });

    // Invalidate caches
    await invalidateMusicCache();

    revalidatePath('/admin/music');
    revalidatePath('/member/music');
    
    return { success: true, pieceId: piece.id };
  } catch (error) {
    console.error('Failed to create music piece:', error);
    return { success: false, error: 'Failed to create music piece' };
  }
}

export async function updateMusicPiece(id: string, formData: FormData) {
  const _session = await requirePermission(MUSIC_EDIT);
  
  try {
    const title = formData.get('title') as string;
    const subtitle = formData.get('subtitle') as string | null;
    const composerId = formData.get('composerId') as string | null;
    const arrangerId = formData.get('arrangerId') as string | null;
    const publisherId = formData.get('publisherId') as string | null;
    const difficultyValue = formData.get('difficulty') as string | null;
    const difficulty = difficultyValue ? (difficultyValue as MusicDifficulty) : null;
    const duration = formData.get('duration') ? Number(formData.get('duration')) : null;
    const genre = formData.get('genre') as string | null;
    const style = formData.get('style') as string | null;
    const catalogNumber = formData.get('catalogNumber') as string | null;
    const notes = formData.get('notes') as string | null;

    const piece = await prisma.musicPiece.update({
      where: { id },
      data: {
        title,
        subtitle,
        composerId: composerId || null,
        arrangerId: arrangerId || null,
        publisherId: publisherId || null,
        difficulty,
        duration,
        genre,
        style,
        catalogNumber,
        notes,
      },
    });

    await auditLog({
      action: 'music.update',
      entityType: 'MusicPiece',
      entityId: piece.id,
      newValues: { title },
    });

    // Invalidate caches
    await invalidateMusicCache(id);

    revalidatePath('/admin/music');
    revalidatePath(`/admin/music/${id}`);
    revalidatePath('/member/music');
    
    return { success: true };
  } catch (error) {
    console.error('Failed to update music piece:', error);
    return { success: false, error: 'Failed to update music piece' };
  }
}

export async function deleteMusicPiece(id: string) {
  const _session = await requirePermission(MUSIC_DELETE);
  
  try {
    // Get all files for this piece
    const files = await prisma.musicFile.findMany({
      where: { pieceId: id },
    });

    // Delete files from storage
    for (const file of files) {
      await deleteFile(file.storageKey);
    }

    // Delete from database (cascading will handle related records)
    const piece = await prisma.musicPiece.delete({
      where: { id },
    });

    await auditLog({
      action: 'music.delete',
      entityType: 'MusicPiece',
      entityId: id,
      newValues: { title: piece.title },
    });

    // Invalidate caches
    await invalidateMusicCache(id);

    revalidatePath('/admin/music');
    revalidatePath('/member/music');
    
    return { success: true };
  } catch (error) {
    console.error('Failed to delete music piece:', error);
    return { success: false, error: 'Failed to delete music piece' };
  }
}

export async function uploadMusicFile(musicPieceId: string, formData: FormData) {
  const session = await requirePermission(MUSIC_EDIT);

  try {
    const file = formData.get('file') as File;
    const partType = formData.get('partType') as string | null;
    const instrumentId = formData.get('instrumentId') as string | null;
    const fileType = formData.get('fileType') as string | null;
    const description = formData.get('description') as string | null;
    const changeNote = formData.get('changeNote') as string | null;
    const existingFileId = formData.get('existingFileId') as string | null;

    if (!file || file.size === 0) {
      return { success: false, error: 'No file provided' };
    }

    const buffer = await file.arrayBuffer();
    const key = `music/${musicPieceId}/${Date.now()}-${file.name}`;
    await uploadFile(key, Buffer.from(buffer), {
      contentType: file.type,
    });

    // If updating an existing file (new version)
    if (existingFileId) {
      const existingFile = await prisma.musicFile.findUnique({
        where: { id: existingFileId },
        include: { versions: true },
      });

      if (!existingFile) {
        return { success: false, error: 'Existing file not found' };
      }

      // Create version record for the old version
      await prisma.musicFileVersion.create({
        data: {
          fileId: existingFile.id,
          version: existingFile.version,
          fileName: existingFile.fileName,
          storageKey: existingFile.storageKey,
          fileSize: existingFile.fileSize,
          mimeType: existingFile.mimeType,
          changeNote: changeNote || undefined,
          uploadedBy: session.user.id,
        },
      });

      // Update the main file record
      const updatedFile = await prisma.musicFile.update({
        where: { id: existingFileId },
        data: {
          fileName: file.name,
          storageKey: key,
          fileSize: file.size,
          mimeType: file.type,
          fileType: (fileType as FileType) || existingFile.fileType,
          description: description || existingFile.description,
          version: { increment: 1 },
        },
      });

      await auditLog({
        action: 'music.file.version',
        entityType: 'MusicFile',
        entityId: updatedFile.id,
        newValues: { fileName: file.name, version: updatedFile.version, pieceId: musicPieceId },
      });

      // Invalidate caches
      await invalidateMusicCache(musicPieceId);

      revalidatePath(`/admin/music/${musicPieceId}`);
      
      return { success: true, fileId: updatedFile.id, version: updatedFile.version };
    }

    // Create new file
    const musicFile = await prisma.musicFile.create({
      data: {
        pieceId: musicPieceId,
        fileName: file.name,
        storageKey: key,
        mimeType: file.type,
        fileSize: file.size,
        fileType: getFileType(file.type),
        description: description || undefined,
        uploadedBy: session.user.id,
      },
    });

    // Link to part if specified
    if (instrumentId && partType) {
      await prisma.musicPart.create({
        data: {
          pieceId: musicPieceId,
          instrumentId,
          partName: partType,
          fileId: musicFile.id,
        },
      });
    }

    await auditLog({
      action: 'music.file.upload',
      entityType: 'MusicFile',
      entityId: musicFile.id,
      newValues: { fileName: file.name, pieceId: musicPieceId },
    });

    // Invalidate caches
    await invalidateMusicCache(musicPieceId);

    revalidatePath(`/admin/music/${musicPieceId}`);
    
    return { success: true, fileId: musicFile.id };
  } catch (error) {
    console.error('Failed to upload music file:', error);
    return { success: false, error: 'Failed to upload file' };
  }
}

export async function updateMusicFile(fileId: string, data: {
  description?: string;
  fileType?: FileType;
  isPublic?: boolean;
}) {
  const _session = await requirePermission(MUSIC_EDIT);
  
  try {
    const file = await prisma.musicFile.findUnique({
      where: { id: fileId },
    });

    if (!file) {
      return { success: false, error: 'File not found' };
    }

    const parsed = musicFileUpdateSchema.partial().safeParse(data);
    if (!parsed.success) {
      return { success: false, error: 'Invalid file update data', details: parsed.error.issues };
    }
    const _updatedFile = await prisma.musicFile.update({
      where: { id: fileId },
      data: parsed.data,
    });

    await auditLog({
      action: 'music.file.update',
      entityType: 'MusicFile',
      entityId: fileId,
      oldValues: {
        description: file.description,
        fileType: file.fileType,
        isPublic: file.isPublic
      },
      newValues: data,
    });

    // Invalidate caches
    await invalidateMusicCache(file.pieceId);

    revalidatePath(`/admin/music/${file.pieceId}`);

    return { success: true };
  } catch (error) {
    console.error('Failed to update music file:', error);
    return { success: false, error: 'Failed to update file' };
  }
}

export async function getFileVersionHistory(fileId: string) {
  const _session = await requirePermission('music:read');

  try {
    const versions = await prisma.musicFileVersion.findMany({
      where: { fileId },
      orderBy: { version: 'desc' },
    });

    return { success: true, versions };
  } catch (error) {
    console.error('Failed to get file version history:', error);
    return { success: false, error: 'Failed to get version history' };
  }
}

export async function archiveMusicFile(fileId: string) {
  const _session = await requirePermission(MUSIC_EDIT);
  
  try {
    const file = await prisma.musicFile.findUnique({
      where: { id: fileId },
    });

    if (!file) {
      return { success: false, error: 'File not found' };
    }

    // Soft delete by marking as archived (preserves version history)
    await prisma.musicFile.update({
      where: { id: fileId },
      data: { isArchived: true },
    });

    await auditLog({
      action: 'music.file.archive',
      entityType: 'MusicFile',
      entityId: fileId,
      newValues: { fileName: file.fileName, pieceId: file.pieceId },
    });

    // Invalidate caches
    await invalidateMusicCache(file.pieceId);

    revalidatePath(`/admin/music/${file.pieceId}`);

    return { success: true };
  } catch (error) {
    console.error('Failed to archive music file:', error);
    return { success: false, error: 'Failed to archive file' };
  }
}

export async function deleteMusicFile(fileId: string) {
  const _session = await requirePermission(MUSIC_EDIT);
  
  try {
    const file = await prisma.musicFile.findUnique({
      where: { id: fileId },
    });

    if (!file) {
      return { success: false, error: 'File not found' };
    }

    await deleteFile(file.storageKey);
    await prisma.musicFile.delete({ where: { id: file.id } });

    await auditLog({
      action: 'music.file.delete',
      entityType: 'MusicFile',
      entityId: fileId,
      newValues: { fileName: file.fileName, pieceId: file.pieceId },
    });

    // Invalidate caches
    await invalidateMusicCache(file.pieceId);

    revalidatePath(`/admin/music/${file.pieceId}`);

    return { success: true };
  } catch (error) {
    console.error('Failed to delete music file:', error);
    return { success: false, error: 'Failed to delete file' };
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
  const _session = await requirePermission(MUSIC_ASSIGN);

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

function getFileType(mimeType: string): FileType {
  if (mimeType.includes('pdf')) return FileType.FULL_SCORE;
  if (mimeType.includes('audio')) return FileType.AUDIO;
  return FileType.OTHER;
}

// =============================================================================
// EXPORT FUNCTIONALITY
// =============================================================================

export interface MusicExportFilters {
  search?: string;
  genre?: string;
  difficulty?: string;
  status?: string;
}

export async function exportMusicToCSV(filters: MusicExportFilters = {}) {
  await requirePermission('music:read');

  try {
    // Build where clause
    const where: Record<string, unknown> = {
      deletedAt: null,
    };

    // Filter by archived status
    if (filters.status === 'archived') {
      where.isArchived = true;
    } else if (filters.status === 'active' || !filters.status) {
      where.isArchived = false;
    }

    if (filters.genre) {
      where.genre = filters.genre;
    }

    if (filters.difficulty) {
      where.difficulty = filters.difficulty;
    }

    if (filters.search) {
      where.OR = [
        { title: { contains: filters.search } },
        { subtitle: { contains: filters.search } },
        { composer: { fullName: { contains: filters.search } } },
        { arranger: { fullName: { contains: filters.search } } },
        { catalogNumber: { contains: filters.search } },
      ];
    }

    const pieces = await prisma.musicPiece.findMany({
      where,
      include: {
        composer: true,
        arranger: true,
        publisher: true,
        files: {
          where: { isArchived: false },
        },
        _count: {
          select: {
            assignments: true,
            eventMusic: true,
          },
        },
      },
      orderBy: { title: 'asc' },
    });

    // Generate CSV
    const headers = [
      'Title',
      'Subtitle',
      'Composer',
      'Arranger',
      'Publisher',
      'Genre',
      'Style',
      'Difficulty',
      'Duration (seconds)',
      'Catalog Number',
      'Notes',
      'File Count',
      'Assignment Count',
      'Archived',
      'Created At',
    ];

    const difficultyLabels: Record<string, string> = {
      GRADE_1: 'Grade 1',
      GRADE_2: 'Grade 2',
      GRADE_3: 'Grade 3',
      GRADE_4: 'Grade 4',
      GRADE_5: 'Grade 5',
      GRADE_6: 'Grade 6',
    };

    const rows = pieces.map((piece) => [
      piece.title,
      piece.subtitle || '',
      piece.composer?.fullName || '',
      piece.arranger?.fullName || '',
      piece.publisher?.name || '',
      piece.genre || '',
      piece.style || '',
      piece.difficulty ? difficultyLabels[piece.difficulty] || piece.difficulty : '',
      piece.duration?.toString() || '',
      piece.catalogNumber || '',
      piece.notes || '',
      piece.files.length.toString(),
      piece._count.assignments.toString(),
      piece.isArchived ? 'Yes' : 'No',
      piece.createdAt.toISOString().split('T')[0],
    ]);

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
      action: 'music.export',
      entityType: 'MusicPiece',
      newValues: { count: pieces.length, filters },
    });

    return {
      success: true,
      data: csvContent,
      filename: `music-export-${new Date().toISOString().split('T')[0]}.csv`,
      count: pieces.length,
    };
  } catch (error) {
    console.error('Failed to export music:', error);
    return { success: false, error: 'Failed to export music' };
  }
}
