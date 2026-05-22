import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/lib/auth/config';
import { headers } from 'next/headers';
import { z } from 'zod';
import { validateCSRF } from '@/lib/csrf';
import { applyRateLimit } from '@/lib/rate-limit';
import { checkUserPermission } from '@/lib/auth/permissions';
import { auditLog } from '@/lib/services/audit';

import { ATTENDANCE_MARK_ALL } from '@/lib/auth/permission-constants';
const bulkAttendanceSchema = z.object({
  eventId: z.string(),
  records: z.array(
    z.object({
      memberId: z.string(),
      status: z.enum(['PRESENT', 'ABSENT', 'EXCUSED', 'LATE', 'LEFT_EARLY']),
      notes: z.string().optional(),
    })
  ),
});

export async function POST(request: NextRequest) {
  try {
    // Apply rate limiting
    const rateLimitResponse = await applyRateLimit(request, 'api');
    if (rateLimitResponse) {
      return rateLimitResponse as any;
    }

    // Validate CSRF
    const csrfResult = validateCSRF(request);
    if (!csrfResult.valid) {
      return NextResponse.json(
        { error: 'CSRF validation failed', reason: csrfResult.reason },
        { status: 403 }
      );
    }

    const session = await auth.api.getSession({
      headers: await headers(),
    });

    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Check for ATTENDANCE_MARK_ALL permission
    const hasPermission = await checkUserPermission(session.user.id, ATTENDANCE_MARK_ALL);

    if (!hasPermission) {
      return NextResponse.json({ error: 'Permission denied' }, { status: 403 });
    }

    const body = await request.json();
    const { eventId, records } = bulkAttendanceSchema.parse(body);

    // Verify the event exists
    const event = await prisma.event.findUnique({
      where: { id: eventId },
    });

    if (!event) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 });
    }

    // Delete existing attendance records for this event
    await prisma.attendance.deleteMany({
      where: { eventId },
    });

    // Create new attendance records
    await prisma.attendance.createMany({
      data: records.map((record) => ({
        eventId,
        memberId: record.memberId,
        status: record.status,
        notes: record.notes,
        markedBy: session.user.id,
      })),
    });

    await auditLog({
      action: 'attendance.bulk_mark',
      entityType: 'Event',
      entityId: eventId,
      newValues: { recordCount: records.length },
    });

    return NextResponse.json({ success: true, count: records.length });
  } catch (error) {
    console.error('Error marking bulk attendance:', error);
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid request data' }, { status: 400 });
    }
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
