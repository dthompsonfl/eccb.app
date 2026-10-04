'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db';
import { requirePermission, requireAuth } from '@/lib/auth/guards';
import { checkUserPermission } from '@/lib/auth/permissions';
import { auditLog } from '@/lib/services/audit';
import { z } from 'zod';
import { AttendanceStatus } from '@prisma/client';
import { replaceEventAttendance } from '@/lib/attendance/bulk-write';
import {
  canReadMemberAttendance,
  resolveAttendanceFilter,
  resolveAttendanceScope,
} from '@/lib/attendance/access';
import { logger } from '@/lib/logger';
import {
  ATTENDANCE_MARK_ALL,
  ATTENDANCE_MARK_SECTION,
  ATTENDANCE_MARK_OWN,
  ATTENDANCE_VIEW_ALL,
  ATTENDANCE_VIEW_SECTION,
  ATTENDANCE_VIEW_OWN,
} from '@/lib/auth/permission-constants';

// Validation schemas
const markAttendanceSchema = z.object({
  eventId: z.string().min(1, 'Event ID is required'),
  memberId: z.string().min(1, 'Member ID is required'),
  status: z.enum(['PRESENT', 'ABSENT', 'EXCUSED', 'LATE', 'LEFT_EARLY']),
  notes: z.string().optional(),
});

const bulkAttendanceSchema = z.object({
  eventId: z.string().min(1, 'Event ID is required'),
  records: z.array(
    z.object({
      memberId: z.string().min(1, 'Member ID is required'),
      status: z.enum(['PRESENT', 'ABSENT', 'EXCUSED', 'LATE', 'LEFT_EARLY']),
      notes: z.string().optional(),
    })
  ),
});

// Types
export interface AttendanceResult {
  success: boolean;
  attendance?: {
    id: string;
    eventId: string;
    memberId: string;
    status: AttendanceStatus;
    notes: string | null;
    markedAt: Date;
  };
  error?: string;
}

export interface BulkAttendanceResult {
  success: boolean;
  count?: number;
  error?: string;
}

/**
 * Helper function to check if user has a permission
 */
async function checkPermission(userId: string, permission: string): Promise<boolean> {
  try {
    return await checkUserPermission(userId, permission);
  } catch {
    return false;
  }
}

/**
 * Mark attendance for a single member at an event
 * Requires ATTENDANCE_MARK_ALL, ATTENDANCE_MARK_SECTION, or ATTENDANCE_MARK_OWN permission
 */
export async function markAttendance(data: {
  eventId: string;
  memberId: string;
  status: AttendanceStatus;
  notes?: string;
}): Promise<AttendanceResult> {
  try {
    const session = await requireAuth();
    const validated = markAttendanceSchema.parse(data);

    // Check if user has permission to mark attendance
    const hasAllPermission = await checkPermission(session.user.id, ATTENDANCE_MARK_ALL);
    const hasSectionPermission = await checkPermission(session.user.id, ATTENDANCE_MARK_SECTION);
    const hasOwnPermission = await checkPermission(session.user.id, ATTENDANCE_MARK_OWN);

    if (!hasAllPermission && !hasSectionPermission && !hasOwnPermission) {
      return { success: false, error: 'Permission denied' };
    }

    // If only has own permission, verify they're marking their own attendance
    if (!hasAllPermission && !hasSectionPermission && hasOwnPermission) {
      const member = await prisma.member.findFirst({
        where: { userId: session.user.id },
      });
      if (!member || member.id !== validated.memberId) {
        return { success: false, error: 'Can only mark own attendance' };
      }
    }

    // If only has section permission, verify the member is in their section
    if (!hasAllPermission && hasSectionPermission) {
      const member = await prisma.member.findFirst({
        where: { userId: session.user.id },
        include: { sections: true },
      });
      const targetMember = await prisma.member.findUnique({
        where: { id: validated.memberId },
        include: { sections: true },
      });

      if (!member || !targetMember) {
        return { success: false, error: 'Member not found' };
      }

      const memberSectionIds = member.sections.map((s) => s.sectionId);
      const targetSectionIds = targetMember.sections.map((s) => s.sectionId);
      const hasCommonSection = memberSectionIds.some((id) => targetSectionIds.includes(id));

      if (!hasCommonSection) {
        return { success: false, error: 'Can only mark attendance for members in your section' };
      }
    }

    // Verify the event exists and is a rehearsal (attendance only for rehearsals)
    const event = await prisma.event.findUnique({
      where: { id: validated.eventId },
    });

    if (!event) {
      return { success: false, error: 'Event not found' };
    }

    // Upsert attendance record
    const attendance = await prisma.attendance.upsert({
      where: {
        eventId_memberId: {
          eventId: validated.eventId,
          memberId: validated.memberId,
        },
      },
      update: {
        status: validated.status,
        notes: validated.notes,
        markedAt: new Date(),
        markedBy: session.user.id,
      },
      create: {
        eventId: validated.eventId,
        memberId: validated.memberId,
        status: validated.status,
        notes: validated.notes,
        markedBy: session.user.id,
      },
    });

    await auditLog({
      action: 'attendance.mark',
      entityType: 'Attendance',
      entityId: attendance.id,
      newValues: {
        eventId: validated.eventId,
        memberId: validated.memberId,
        status: validated.status,
      },
    });

    revalidatePath(`/admin/events/${validated.eventId}/attendance`);
    revalidatePath('/member/attendance');

    return { success: true, attendance };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, error: error.issues[0].message };
    }
    console.error('Failed to mark attendance:', error);
    return { success: false, error: 'Failed to mark attendance' };
  }
}

/**
 * Mark attendance for multiple members at an event (bulk operation)
 * Requires ATTENDANCE_MARK_ALL permission
 */
export async function markBulkAttendance(data: {
  eventId: string;
  records: Array<{
    memberId: string;
    status: AttendanceStatus;
    notes?: string;
  }>;
}): Promise<BulkAttendanceResult> {
  try {
    const session = await requirePermission(ATTENDANCE_MARK_ALL);
    const validated = bulkAttendanceSchema.parse(data);

    // Verify the event exists
    const event = await prisma.event.findUnique({
      where: { id: validated.eventId },
    });

    if (!event) {
      return { success: false, error: 'Event not found' };
    }

    // Replace the whole event's attendance atomically. This used to be a bare
    // deleteMany() followed by an un-transacted createMany(): a failure between
    // the two left the event with no attendance at all. See lib/attendance/bulk-write.
    const { count, removed } = await prisma.$transaction(async (tx) =>
      replaceEventAttendance(
        tx,
        validated.eventId,
        validated.records,
        session.user.id,
      ),
    );

    await auditLog({
      action: 'attendance.bulk_mark',
      entityType: 'Event',
      entityId: validated.eventId,
      newValues: { recordCount: count, removedCount: removed },
    });

    revalidatePath(`/admin/events/${validated.eventId}/attendance`);
    revalidatePath('/member/attendance');

    return { success: true, count };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, error: error.issues[0].message };
    }
    console.error('Failed to mark bulk attendance:', error);
    return { success: false, error: 'Failed to mark attendance' };
  }
}

/**
 * Get attendance records for an event
 * Requires ATTENDANCE_VIEW_ALL, ATTENDANCE_VIEW_SECTION, or ATTENDANCE_VIEW_OWN permission
 */
export async function getEventAttendance(eventId: string) {
  try {
    const session = await requireAuth();

    const hasAllPermission = await checkPermission(session.user.id, ATTENDANCE_VIEW_ALL);
    const hasSectionPermission = await checkPermission(session.user.id, ATTENDANCE_VIEW_SECTION);
    const hasOwnPermission = await checkPermission(session.user.id, ATTENDANCE_VIEW_OWN);

    if (!hasAllPermission && !hasSectionPermission && !hasOwnPermission) {
      return { success: false, error: 'Permission denied', attendance: [] };
    }

    const event = await prisma.event.findUnique({
      where: { id: eventId },
      include: {
        attendance: {
          include: {
            member: {
              include: {
                sections: true,
              },
            },
          },
        },
      },
    });

    if (!event) {
      return { success: false, error: 'Event not found', attendance: [] };
    }

    // Filter attendance based on permissions.
    //
    // Same fail-open as the API routes: both branches were wrapped in
    // `if (member)`, so a caller with section/own scope and no Member row fell
    // through with the FULL event roster.
    const decision = await resolveAttendanceScope(session.user.id);
    if (!decision.allowed) {
      logger.warn('Event attendance read denied', {
        userId: session.user.id,
        reason: decision.reason,
      });
      return { success: false, error: 'Permission denied', attendance: [] };
    }

    let attendance = event.attendance;

    if (decision.scope === 'section') {
      const allowed = new Set(decision.sectionIds);
      attendance = attendance.filter((a) =>
        a.member.sections.some((s) => allowed.has(s.sectionId)),
      );
    } else if (decision.scope === 'own') {
      attendance = attendance.filter((a) => a.memberId === decision.memberId);
    }

    return { success: true, attendance };
  } catch (error) {
    console.error('Failed to get event attendance:', error);
    return { success: false, error: 'Failed to get attendance', attendance: [] };
  }
}

/**
 * Get attendance records for a member
 * Requires ATTENDANCE_VIEW_ALL, ATTENDANCE_VIEW_SECTION, or ATTENDANCE_VIEW_OWN permission
 */
export async function getMemberAttendance(memberId: string) {
  try {
    const session = await requireAuth();

    const hasAllPermission = await checkPermission(session.user.id, ATTENDANCE_VIEW_ALL);
    const hasSectionPermission = await checkPermission(session.user.id, ATTENDANCE_VIEW_SECTION);
    const hasOwnPermission = await checkPermission(session.user.id, ATTENDANCE_VIEW_OWN);

    if (!hasAllPermission && !hasSectionPermission && !hasOwnPermission) {
      return { success: false, error: 'Permission denied', attendance: [] };
    }

    // Check access based on permissions.
    //
    // Replaces `if (member && targetMember)`, which skipped the section check
    // entirely when either lookup was null and fell through to an unscoped read
    // of the requested member's attendance.
    const access = await canReadMemberAttendance(session.user.id, memberId);
    if (!access.allowed) {
      logger.warn('Member attendance read denied', {
        userId: session.user.id,
        memberId,
        reason: access.reason,
      });
      return { success: false, error: 'Permission denied', attendance: [] };
    }

    const attendance = await prisma.attendance.findMany({
      where: { memberId },
      include: {
        event: true,
      },
      orderBy: { markedAt: 'desc' },
    });

    return { success: true, attendance };
  } catch (error) {
    console.error('Failed to get member attendance:', error);
    return { success: false, error: 'Failed to get attendance', attendance: [] };
  }
}

/**
 * Get attendance statistics for a member
 */
export async function getMemberAttendanceStats(memberId: string) {
  try {
    const session = await requireAuth();

    // Check access
    const hasAllPermission = await checkPermission(session.user.id, ATTENDANCE_VIEW_ALL);
    const hasOwnPermission = await checkPermission(session.user.id, ATTENDANCE_VIEW_OWN);

    if (!hasAllPermission && hasOwnPermission) {
      const member = await prisma.member.findFirst({
        where: { userId: session.user.id },
      });
      if (!member || member.id !== memberId) {
        return { success: false, error: 'Permission denied' };
      }
    }

    const attendance = await prisma.attendance.findMany({
      where: { memberId },
    });

    const total = attendance.length;
    const present = attendance.filter((a) => a.status === 'PRESENT').length;
    const absent = attendance.filter((a) => a.status === 'ABSENT').length;
    const excused = attendance.filter((a) => a.status === 'EXCUSED').length;
    const late = attendance.filter((a) => a.status === 'LATE').length;
    const leftEarly = attendance.filter((a) => a.status === 'LEFT_EARLY').length;

    const attendanceRate = total > 0 ? Math.round((present / total) * 100) : 0;
    const punctualityRate = total > 0 ? Math.round(((present + late) / total) * 100) : 0;

    return {
      success: true,
      stats: {
        total,
        present,
        absent,
        excused,
        late,
        leftEarly,
        attendanceRate,
        punctualityRate,
      },
    };
  } catch (error) {
    console.error('Failed to get member attendance stats:', error);
    return { success: false, error: 'Failed to get attendance statistics' };
  }
}

/**
 * Get attendance statistics for an event
 */
export async function getEventAttendanceStats(eventId: string) {
  try {
    await requireAuth();

    const attendance = await prisma.attendance.findMany({
      where: { eventId },
    });

    const total = attendance.length;
    const present = attendance.filter((a) => a.status === 'PRESENT').length;
    const absent = attendance.filter((a) => a.status === 'ABSENT').length;
    const excused = attendance.filter((a) => a.status === 'EXCUSED').length;
    const late = attendance.filter((a) => a.status === 'LATE').length;
    const leftEarly = attendance.filter((a) => a.status === 'LEFT_EARLY').length;

    const attendanceRate = total > 0 ? Math.round((present / total) * 100) : 0;

    return {
      success: true,
      stats: {
        total,
        present,
        absent,
        excused,
        late,
        leftEarly,
        attendanceRate,
      },
    };
  } catch (error) {
    console.error('Failed to get event attendance stats:', error);
    return { success: false, error: 'Failed to get attendance statistics' };
  }
}

/**
 * Initialize attendance records for an event (create pending records for all active members)
 * Useful for rehearsals to pre-populate attendance
 */
export async function initializeEventAttendance(eventId: string): Promise<BulkAttendanceResult> {
  try {
    const session = await requirePermission(ATTENDANCE_MARK_ALL);

    // Verify the event exists and is a rehearsal
    const event = await prisma.event.findUnique({
      where: { id: eventId },
    });

    if (!event) {
      return { success: false, error: 'Event not found' };
    }

    // Get all active members
    const activeMembers = await prisma.member.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true },
    });

    // Create pending attendance records (status will be ABSENT by default, to be updated)
    const existingRecords = await prisma.attendance.findMany({
      where: { eventId },
      select: { memberId: true },
    });

    const existingMemberIds = new Set(existingRecords.map((r) => r.memberId));
    const newMembers = activeMembers.filter((m) => !existingMemberIds.has(m.id));

    if (newMembers.length === 0) {
      return { success: true, count: 0 };
    }

    await prisma.attendance.createMany({
      data: newMembers.map((member) => ({
        eventId,
        memberId: member.id,
        status: 'ABSENT' as AttendanceStatus,
        markedBy: session.user.id,
      })),
    });

    await auditLog({
      action: 'attendance.initialize',
      entityType: 'Event',
      entityId: eventId,
      newValues: { memberCount: newMembers.length },
    });

    revalidatePath(`/admin/events/${eventId}/attendance`);

    return { success: true, count: newMembers.length };
  } catch (error) {
    console.error('Failed to initialize event attendance:', error);
    return { success: false, error: 'Failed to initialize attendance' };
  }
}

// =============================================================================
// EXPORT FUNCTIONS
// =============================================================================

export interface AttendanceExportFilters {
  startDate?: string;
  endDate?: string;
  memberId?: string;
  sectionId?: string;
  eventId?: string;
  eventType?: string;
  status?: AttendanceStatus;
}

export interface AttendanceExportResult {
  success: boolean;
  data?: string;
  filename?: string;
  count?: number;
  error?: string;
}

/**
 * Export attendance records to CSV
 * Requires ATTENDANCE_VIEW_ALL permission
 */
export async function exportAttendanceToCSV(
  filters: AttendanceExportFilters = {}
): Promise<AttendanceExportResult> {
  try {
    const session = await requireAuth();

    const hasAllPermission = await checkPermission(session.user.id, ATTENDANCE_VIEW_ALL);
    const hasSectionPermission = await checkPermission(session.user.id, ATTENDANCE_VIEW_SECTION);

    if (!hasAllPermission && !hasSectionPermission) {
      return { success: false, error: 'Permission denied' };
    }

    // Build where clause
    const where: Record<string, unknown> = {};

    // Date range filter
    if (filters.startDate || filters.endDate) {
      where.event = {
        ...((where.event as object) || {}),
        startTime: {
          ...(filters.startDate ? { gte: new Date(filters.startDate) } : {}),
          ...(filters.endDate ? { lte: new Date(filters.endDate) } : {}),
        },
      };
    }

    // Event filter
    if (filters.eventId) {
      where.eventId = filters.eventId;
    }

    // Event type filter
    if (filters.eventType) {
      where.event = {
        ...((where.event as object) || {}),
        type: filters.eventType,
      };
    }

    // Member filter
    if (filters.memberId) {
      where.memberId = filters.memberId;
    }

    // Status filter
    if (filters.status) {
      where.status = filters.status;
    }

    // Section scoping
    //
    // Previously `if (member) { where.member = … }`. With no Member row the
    // filter was never applied and `where` stayed unscoped, so a caller holding
    // only ATTENDANCE_VIEW_SECTION exported the ENTIRE band — and these queries
    // select `member.email`, so one request leaked every member's name, section
    // and email address.
    //
    // `resolveAttendanceFilter` returns an always-present filter rather than no
    // filter, and denies outright when the caller has no profile at all.
    const scopeFilter = await resolveAttendanceFilter(session.user.id);
    if (scopeFilter.kind === 'denied') {
      logger.warn('Attendance bulk read denied', {
        userId: session.user.id,
        reason: scopeFilter.reason,
      });
      return { success: false, error: 'Permission denied' };
    }
    if (scopeFilter.kind === 'scoped') {
      where.member = {
        ...((where.member as object) || {}),
        ...scopeFilter.filter,
      };
    }

    // Section filter (for admins)
    if (filters.sectionId && hasAllPermission) {
      where.member = {
        ...((where.member as object) || {}),
        sections: { some: { sectionId: filters.sectionId } },
      };
    }

    const attendance = await prisma.attendance.findMany({
      where,
      include: {
        event: {
          select: {
            id: true,
            title: true,
            type: true,
            startTime: true,
            location: true,
          },
        },
        member: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            sections: {
              select: {
                section: { select: { name: true } },
              },
            },
          },
        },
      },
      orderBy: [
        { event: { startTime: 'desc' } },
        { member: { lastName: 'asc' } },
      ],
    });

    // Generate CSV
    const headers = [
      'Event',
      'Event Type',
      'Event Date',
      'Event Location',
      'Member First Name',
      'Member Last Name',
      'Member Email',
      'Section',
      'Status',
      'Notes',
      'Marked At',
    ];

    const rows = attendance.map((record) => {
      const section = record.member.sections[0]?.section.name || '';
      return [
        record.event.title,
        record.event.type,
        record.event.startTime.toISOString().split('T')[0],
        record.event.location || '',
        record.member.firstName,
        record.member.lastName,
        record.member.email || '',
        section,
        record.status,
        record.notes || '',
        record.markedAt.toISOString(),
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
      action: 'attendance.export',
      entityType: 'Attendance',
      newValues: { count: attendance.length, filters },
    });

    return {
      success: true,
      data: csvContent,
      filename: `attendance-export-${new Date().toISOString().split('T')[0]}.csv`,
      count: attendance.length,
    };
  } catch (error) {
    console.error('Failed to export attendance:', error);
    return { success: false, error: 'Failed to export attendance' };
  }
}

/**
 * Export member attendance summary to CSV
 * Shows attendance statistics per member for a date range
 */
export async function exportMemberAttendanceSummary(
  filters: {
    startDate?: string;
    endDate?: string;
    sectionId?: string;
  } = {}
): Promise<AttendanceExportResult> {
  try {
    const session = await requireAuth();

    const hasAllPermission = await checkPermission(session.user.id, ATTENDANCE_VIEW_ALL);
    const hasSectionPermission = await checkPermission(session.user.id, ATTENDANCE_VIEW_SECTION);

    if (!hasAllPermission && !hasSectionPermission) {
      return { success: false, error: 'Permission denied' };
    }

    // Build member where clause
    const memberWhere: Record<string, unknown> = {};

    // Section scoping
    //
    // Previously `if (member) { memberWhere.sections = … }` — with no Member row
    // the clause was never set and the member list came back UNSCOPED, exposing
    // every member in the band.
    const memberScope = await resolveAttendanceFilter(session.user.id);
    if (memberScope.kind === 'denied') {
      logger.warn('Attendance member summary denied', {
        userId: session.user.id,
        reason: memberScope.reason,
      });
      return { success: false, error: 'Permission denied' };
    }
    if (memberScope.kind === 'scoped') {
      if ('member' in memberScope.filter) {
        const sections = (memberScope.filter.member as { sections?: unknown }).sections;
        if (sections) memberWhere.sections = sections;
      } else if ('memberId' in memberScope.filter) {
        memberWhere.id = memberScope.filter.memberId;
      }
    }

    // Section filter (for admins)
    if (filters.sectionId && hasAllPermission) {
      memberWhere.sections = { some: { sectionId: filters.sectionId } };
    }

    // Get members with their attendance
    const members = await prisma.member.findMany({
      where: memberWhere,
      include: {
        sections: {
          select: { section: { select: { name: true } } },
        },
        attendance: {
          where: {
            event: {
              startTime: {
                ...(filters.startDate ? { gte: new Date(filters.startDate) } : {}),
                ...(filters.endDate ? { lte: new Date(filters.endDate) } : {}),
              },
            },
          },
          select: { status: true },
        },
      },
      orderBy: { lastName: 'asc' },
    });

    // Generate CSV
    const headers = [
      'First Name',
      'Last Name',
      'Section',
      'Total Events',
      'Present',
      'Absent',
      'Excused',
      'Late',
      'Left Early',
      'Attendance Rate (%)',
    ];

    const rows = members.map((member) => {
      const total = member.attendance.length;
      const present = member.attendance.filter((a) => a.status === 'PRESENT').length;
      const absent = member.attendance.filter((a) => a.status === 'ABSENT').length;
      const excused = member.attendance.filter((a) => a.status === 'EXCUSED').length;
      const late = member.attendance.filter((a) => a.status === 'LATE').length;
      const leftEarly = member.attendance.filter((a) => a.status === 'LEFT_EARLY').length;
      const attendanceRate = total > 0 ? Math.round((present / total) * 100) : 0;

      return [
        member.firstName,
        member.lastName,
        member.sections[0]?.section.name || '',
        total.toString(),
        present.toString(),
        absent.toString(),
        excused.toString(),
        late.toString(),
        leftEarly.toString(),
        attendanceRate.toString(),
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
      action: 'attendance.export_member_summary',
      entityType: 'Attendance',
      newValues: { count: members.length, filters },
    });

    return {
      success: true,
      data: csvContent,
      filename: `member-attendance-summary-${new Date().toISOString().split('T')[0]}.csv`,
      count: members.length,
    };
  } catch (error) {
    console.error('Failed to export member attendance summary:', error);
    return { success: false, error: 'Failed to export member attendance summary' };
  }
}

/**
 * Export event attendance summary to CSV
 * Shows attendance statistics per event for a date range
 */
export async function exportEventAttendanceSummary(
  filters: {
    startDate?: string;
    endDate?: string;
    eventType?: string;
  } = {}
): Promise<AttendanceExportResult> {
  try {
    await requirePermission(ATTENDANCE_VIEW_ALL);

    // Build event where clause
    const eventWhere: Record<string, unknown> = {
      isCancelled: false,
    };

    if (filters.startDate || filters.endDate) {
      eventWhere.startTime = {
        ...(filters.startDate ? { gte: new Date(filters.startDate) } : {}),
        ...(filters.endDate ? { lte: new Date(filters.endDate) } : {}),
      };
    }

    if (filters.eventType) {
      eventWhere.type = filters.eventType;
    }

    // Get events with their attendance
    const events = await prisma.event.findMany({
      where: eventWhere,
      include: {
        attendance: {
          select: { status: true },
        },
      },
      orderBy: { startTime: 'desc' },
    });

    // Generate CSV
    const headers = [
      'Event',
      'Event Type',
      'Event Date',
      'Location',
      'Total Records',
      'Present',
      'Absent',
      'Excused',
      'Late',
      'Left Early',
      'Attendance Rate (%)',
    ];

    const rows = events.map((event) => {
      const total = event.attendance.length;
      const present = event.attendance.filter((a) => a.status === 'PRESENT').length;
      const absent = event.attendance.filter((a) => a.status === 'ABSENT').length;
      const excused = event.attendance.filter((a) => a.status === 'EXCUSED').length;
      const late = event.attendance.filter((a) => a.status === 'LATE').length;
      const leftEarly = event.attendance.filter((a) => a.status === 'LEFT_EARLY').length;
      const attendanceRate = total > 0 ? Math.round((present / total) * 100) : 0;

      return [
        event.title,
        event.type,
        event.startTime.toISOString().split('T')[0],
        event.location || '',
        total.toString(),
        present.toString(),
        absent.toString(),
        excused.toString(),
        late.toString(),
        leftEarly.toString(),
        attendanceRate.toString(),
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
      action: 'attendance.export_event_summary',
      entityType: 'Attendance',
      newValues: { count: events.length, filters },
    });

    return {
      success: true,
      data: csvContent,
      filename: `event-attendance-summary-${new Date().toISOString().split('T')[0]}.csv`,
      count: events.length,
    };
  } catch (error) {
    console.error('Failed to export event attendance summary:', error);
    return { success: false, error: 'Failed to export event attendance summary' };
  }
}

/**
 * Get attendance data for reports with filtering
 */
export async function getAttendanceReportData(filters: AttendanceExportFilters = {}) {
  try {
    const session = await requireAuth();

    const hasAllPermission = await checkPermission(session.user.id, ATTENDANCE_VIEW_ALL);
    const hasSectionPermission = await checkPermission(session.user.id, ATTENDANCE_VIEW_SECTION);

    if (!hasAllPermission && !hasSectionPermission) {
      return { success: false, error: 'Permission denied' };
    }

    // Build where clause
    const where: Record<string, unknown> = {};

    // Date range filter
    if (filters.startDate || filters.endDate) {
      where.event = {
        ...((where.event as object) || {}),
        startTime: {
          ...(filters.startDate ? { gte: new Date(filters.startDate) } : {}),
          ...(filters.endDate ? { lte: new Date(filters.endDate) } : {}),
        },
      };
    }

    // Event filter
    if (filters.eventId) {
      where.eventId = filters.eventId;
    }

    // Event type filter
    if (filters.eventType) {
      where.event = {
        ...((where.event as object) || {}),
        type: filters.eventType,
      };
    }

    // Member filter
    if (filters.memberId) {
      where.memberId = filters.memberId;
    }

    // Status filter
    if (filters.status) {
      where.status = filters.status;
    }

    // Section scoping
    //
    // Previously `if (member) { where.member = … }`. With no Member row the
    // filter was never applied and `where` stayed unscoped, so a caller holding
    // only ATTENDANCE_VIEW_SECTION exported the ENTIRE band — and these queries
    // select `member.email`, so one request leaked every member's name, section
    // and email address.
    //
    // `resolveAttendanceFilter` returns an always-present filter rather than no
    // filter, and denies outright when the caller has no profile at all.
    const scopeFilter = await resolveAttendanceFilter(session.user.id);
    if (scopeFilter.kind === 'denied') {
      logger.warn('Attendance bulk read denied', {
        userId: session.user.id,
        reason: scopeFilter.reason,
      });
      return { success: false, error: 'Permission denied' };
    }
    if (scopeFilter.kind === 'scoped') {
      where.member = {
        ...((where.member as object) || {}),
        ...scopeFilter.filter,
      };
    }

    // Section filter (for admins)
    if (filters.sectionId && hasAllPermission) {
      where.member = {
        ...((where.member as object) || {}),
        sections: { some: { sectionId: filters.sectionId } },
      };
    }

    const attendance = await prisma.attendance.findMany({
      where,
      include: {
        event: {
          select: {
            id: true,
            title: true,
            type: true,
            startTime: true,
            location: true,
          },
        },
        member: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            sections: {
              select: {
                section: { select: { name: true } },
              },
            },
          },
        },
      },
      orderBy: [
        { event: { startTime: 'desc' } },
        { member: { lastName: 'asc' } },
      ],
    });

    // Calculate summary stats
    const total = attendance.length;
    const present = attendance.filter((a) => a.status === 'PRESENT').length;
    const absent = attendance.filter((a) => a.status === 'ABSENT').length;
    const excused = attendance.filter((a) => a.status === 'EXCUSED').length;
    const late = attendance.filter((a) => a.status === 'LATE').length;
    const leftEarly = attendance.filter((a) => a.status === 'LEFT_EARLY').length;
    const attendanceRate = total > 0 ? Math.round((present / total) * 100) : 0;

    return {
      success: true,
      attendance,
      stats: {
        total,
        present,
        absent,
        excused,
        late,
        leftEarly,
        attendanceRate,
      },
    };
  } catch (error) {
    console.error('Failed to get attendance report data:', error);
    return { success: false, error: 'Failed to get attendance report data' };
  }
}
