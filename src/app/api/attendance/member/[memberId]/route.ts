import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/lib/auth/config';
import { headers } from 'next/headers';
import { canReadMemberAttendance } from '@/lib/attendance/access';
import { logger } from '@/lib/logger';

interface RouteParams {
  params: Promise<{ memberId: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const session = await auth.api.getSession({
      headers: await headers(),
    });

    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { memberId } = await params;

    // Single fail-closed decision, replacing the previous
    // `if (member && targetMember)` guard that skipped its check entirely when
    // either lookup was null and fell through to an unscoped read.
    const access = await canReadMemberAttendance(session.user.id, memberId);
    if (!access.allowed) {
      logger.warn('Attendance read denied', {
        userId: session.user.id,
        memberId,
        reason: access.reason,
      });
      // 403, not 404: the caller is authenticated and the id is theirs to ask
      // about, so this is an authorization decision rather than a probe.
      return NextResponse.json({ error: 'Permission denied' }, { status: 403 });
    }

    // Get attendance records for the member
    const attendance = await prisma.attendance.findMany({
      where: { memberId },
      include: {
        event: true,
      },
      orderBy: { markedAt: 'desc' },
    });

    return NextResponse.json({ success: true, attendance });
  } catch (error) {
    console.error('Error fetching member attendance:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
