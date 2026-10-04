import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/lib/auth/config';
import { headers } from 'next/headers';
import { resolveAttendanceScope } from '@/lib/attendance/access';
import { logger } from '@/lib/logger';

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const session = await auth.api.getSession({
      headers: await headers(),
    });

    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { eventId } = await params;

    // Get event with attendance
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
      return NextResponse.json({ error: 'Event not found' }, { status: 404 });
    }

    // Filter attendance based on permissions.
    //
    // This previously left `attendance` as the FULL event roster when the
    // caller held section/own scope but had no `Member` row, because both
    // branches were wrapped in `if (member)`. A caller with
    // `attendance.view.section` and no profile therefore received every
    // member's attendance for the event plus their section memberships.
    //
    // `resolveAttendanceScope` denies instead of returning an empty scope, so
    // there is no path that reaches the unfiltered roster.
    const decision = await resolveAttendanceScope(session.user.id);
    if (!decision.allowed) {
      logger.warn('Event attendance read denied', {
        userId: session.user.id,
        eventId,
        reason: decision.reason,
      });
      return NextResponse.json({ error: 'Permission denied' }, { status: 403 });
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

    return NextResponse.json({ success: true, attendance });
  } catch (error) {
    console.error('Error fetching event attendance:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
