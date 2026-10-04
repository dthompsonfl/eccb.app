import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/lib/auth/config';
import { headers } from 'next/headers';
import { canReadMemberAttendance } from '@/lib/attendance/access';
import { logger } from '@/lib/logger';

interface RouteParams {
  params: Promise<{ eventId: string; memberId: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const session = await auth.api.getSession({
      headers: await headers(),
    });

    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { eventId, memberId } = await params;

    // Check access based on permissions.
    //
    // Replaces the `if (member && targetMember)` guard, which skipped the
    // section check entirely when either lookup was null and fell through to an
    // unscoped read of this member's record for this event.
    const access = await canReadMemberAttendance(session.user.id, memberId);
    if (!access.allowed) {
      logger.warn('Event member attendance read denied', {
        userId: session.user.id,
        eventId,
        memberId,
        reason: access.reason,
      });
      return NextResponse.json({ error: 'Permission denied' }, { status: 403 });
    }

    // Get the specific attendance record
    const attendance = await prisma.attendance.findUnique({
      where: {
        eventId_memberId: {
          eventId,
          memberId,
        },
      },
    });

    if (!attendance) {
      return NextResponse.json({ error: 'Attendance record not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true, attendance });
  } catch (error) {
    console.error('Error fetching attendance record:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
