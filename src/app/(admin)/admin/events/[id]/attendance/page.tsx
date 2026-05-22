import { notFound } from 'next/navigation';
import Link from 'next/link';
import { prisma } from '@/lib/db';
import { requirePermission } from '@/lib/auth/guards';
import { formatDate, formatTime } from '@/lib/date';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { AttendanceRoster } from '@/components/admin/attendance/attendance-roster';
import {
  ArrowLeft,
  Calendar,
  Clock,
  MapPin,
  Users,
} from 'lucide-react';

import { ATTENDANCE_MARK_ALL } from '@/lib/auth/permission-constants';
interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function EventAttendancePage({ params }: PageProps) {
  await requirePermission(ATTENDANCE_MARK_ALL);
  const { id } = await params;

  // Fetch event with venue info
  const event = await prisma.event.findUnique({
    where: { id },
    include: {
      venue: true,
    },
  });

  if (!event) {
    notFound();
  }

  // Fetch all active members with their instruments and sections
  const members = await prisma.member.findMany({
    where: {
      status: 'ACTIVE',
    },
    include: {
      instruments: {
        where: { isPrimary: true },
        include: { instrument: true },
      },
      sections: {
        include: { section: true },
      },
    },
    orderBy: [
      { lastName: 'asc' },
      { firstName: 'asc' },
    ],
  });

  // Fetch existing attendance records for this event
  const existingAttendance = await prisma.attendance.findMany({
    where: { eventId: id },
    select: {
      id: true,
      memberId: true,
      status: true,
      notes: true,
      markedAt: true,
    },
  });

  // Format members for the roster component
  const formattedMembers = members.map((member) => ({
    id: member.id,
    firstName: member.firstName,
    lastName: member.lastName,
    email: member.email,
    status: member.status,
    instruments: member.instruments.map((i) => ({
      isPrimary: i.isPrimary,
      instrument: {
        id: i.instrument.id,
        name: i.instrument.name,
      },
    })),
    sections: member.sections.map((s) => ({
      section: {
        id: s.section.id,
        name: s.section.name,
      },
    })),
  }));

  // Format existing attendance
  const formattedAttendance = existingAttendance.map((a) => ({
    id: a.id,
    memberId: a.memberId,
    status: a.status,
    notes: a.notes,
    markedAt: a.markedAt,
  }));

  const typeColors: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
    REHEARSAL: 'secondary',
    CONCERT: 'default',
    SECTIONAL: 'outline',
    BOARD_MEETING: 'outline',
    SOCIAL: 'outline',
    OTHER: 'secondary',
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href={`/admin/events/${id}`}>
            <Button variant="outline" size="icon">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-3xl font-bold tracking-tight">Take Attendance</h1>
              <Badge variant={typeColors[event.type]}>{event.type}</Badge>
            </div>
            <p className="text-muted-foreground">{event.title}</p>
          </div>
        </div>
      </div>

      {/* Event Info Card */}
      <Card>
        <CardContent className="py-4">
          <div className="flex flex-wrap gap-6">
            <div className="flex items-center gap-2">
              <Calendar className="h-4 w-4 text-muted-foreground" />
              <span>{formatDate(event.startTime)}</span>
            </div>
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-muted-foreground" />
              <span>
                {formatTime(event.startTime)}
                {event.endTime && ` - ${formatTime(event.endTime)}`}
              </span>
            </div>
            {event.venue && (
              <div className="flex items-center gap-2">
                <MapPin className="h-4 w-4 text-muted-foreground" />
                <span>{event.venue.name}</span>
              </div>
            )}
            <div className="flex items-center gap-2">
              <Users className="h-4 w-4 text-muted-foreground" />
              <span>{members.length} active members</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Attendance Roster */}
      <AttendanceRoster
        eventId={id}
        eventTitle={event.title}
        eventType={event.type}
        members={formattedMembers}
        existingAttendance={formattedAttendance}
      />
    </div>
  );
}
