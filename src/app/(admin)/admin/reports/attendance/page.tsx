import { prisma } from '@/lib/db';
import { requirePermission } from '@/lib/auth/guards';
import { formatDate } from '@/lib/date';
import { EventType } from '@prisma/client';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

import {
  Download,
  FileText,
  Users,
  Calendar,
  TrendingUp,
} from 'lucide-react';
import { AttendanceReportClient } from './attendance-report-client';
import { getSectionAttendanceStats } from '@/lib/services/attendance-report.service';

import { ATTENDANCE_VIEW_ALL } from '@/lib/auth/permission-constants';
export const metadata = {
  title: 'Attendance Reports | Admin',
  description: 'View and export attendance reports',
};

export default async function AttendanceReportsPage({
  searchParams,
}: {
  searchParams: Promise<{
    startDate?: string;
    endDate?: string;
    sectionId?: string;
    eventType?: string;
  }>;
}) {
  await requirePermission(ATTENDANCE_VIEW_ALL);

  const params = await searchParams;
  const now = new Date();
  const defaultStartDate = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

  const startDate = params.startDate || defaultStartDate.toISOString().split('T')[0];
  const endDate = params.endDate || now.toISOString().split('T')[0];
  const sectionId = params.sectionId || '';
  const eventType = params.eventType || '';

  // Build where clause for attendance stats
  const attendanceWhere: Record<string, unknown> = {
    event: {
      startTime: {
        gte: new Date(startDate),
        lte: new Date(endDate),
      },
      isCancelled: false,
    },
  };

  if (eventType) {
    (attendanceWhere.event as Record<string, unknown>).type = eventType;
  }

  if (sectionId) {
    attendanceWhere.member = {
      sections: { some: { sectionId } },
    };
  }

  // Fetch sections for filter dropdown and all other data concurrently
  const [
    sections,
    attendanceStats,
    sectionAttendanceData,
    attendanceByEventType,
    topMembers,
    recentEvents,
  ] = await Promise.all([
    prisma.section.findMany({
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    prisma.attendance.groupBy({
      by: ['status'],
      where: attendanceWhere,
      _count: true,
    }),
    getSectionAttendanceStats(
      new Date(startDate),
      new Date(endDate),
      eventType
    ),
    prisma.event.findMany({
      where: {
        startTime: { gte: new Date(startDate), lte: new Date(endDate) },
        isCancelled: false,
      },
      select: {
        type: true,
        attendance: {
          select: { status: true },
        },
      },
    }),
    prisma.member.findMany({
      select: {
        id: true,
        firstName: true,
        lastName: true,
        sections: { select: { section: { select: { name: true } } } },
        _count: {
          select: {
            attendance: {
              where: {
                ...attendanceWhere,
                status: 'PRESENT',
              },
            },
          },
        },
      },
      orderBy: {
        attendance: { _count: 'desc' },
      },
      take: 10,
    }),
    prisma.event.findMany({
      where: {
        startTime: { gte: new Date(startDate), lte: new Date(endDate) },
        isCancelled: false,
        ...(eventType ? { type: eventType as EventType } : {}),
      },
      select: {
        id: true,
        title: true,
        type: true,
        startTime: true,
        location: true,
        attendance: {
          select: { status: true },
        },
      },
      orderBy: { startTime: 'desc' },
      take: 15,
    })
  ]);

  const totals = {
    present: attendanceStats.find((a) => a.status === 'PRESENT')?._count || 0,
    absent: attendanceStats.find((a) => a.status === 'ABSENT')?._count || 0,
    excused: attendanceStats.find((a) => a.status === 'EXCUSED')?._count || 0,
    late: attendanceStats.find((a) => a.status === 'LATE')?._count || 0,
    leftEarly: attendanceStats.find((a) => a.status === 'LEFT_EARLY')?._count || 0,
  };
  const totalRecords = Object.values(totals).reduce((a, b) => a + b, 0);
  const attendanceRate = totalRecords > 0
    ? Math.round((totals.present / totalRecords) * 100)
    : 0;

  // Group by event type and calculate stats
  const eventTypeMap = new Map<string, { present: number; total: number }>();
  for (const event of attendanceByEventType) {
    const existing = eventTypeMap.get(event.type) || { present: 0, total: 0 };
    const present = event.attendance.filter((a) => a.status === 'PRESENT').length;
    eventTypeMap.set(event.type, {
      present: existing.present + present,
      total: existing.total + event.attendance.length,
    });
  }

  const eventTypeStats = Array.from(eventTypeMap.entries()).map(([type, stats]) => ({
    type,
    eventCount: stats.total,
    present: stats.present,
    total: stats.total,
    rate: stats.total > 0 ? Math.round((stats.present / stats.total) * 100) : 0,
  }));

  const eventAttendanceData = recentEvents.map((event) => {
    const present = event.attendance.filter(
      (a) => a.status === 'PRESENT' || a.status === 'LATE'
    ).length;
    const total = event.attendance.length;
    const rate = total > 0 ? Math.round((present / total) * 100) : 0;

    return {
      id: event.id,
      title: event.title,
      type: event.type,
      date: event.startTime,
      location: event.location,
      present,
      total,
      rate,
    };
  });

  // Build export URL with filters
  const exportParams = new URLSearchParams({
    startDate,
    endDate,
    ...(sectionId && { sectionId }),
    ...(eventType && { eventType }),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Attendance Reports</h1>
          <p className="text-muted-foreground">
            View attendance statistics and export reports
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" asChild>
            <a href={`/api/admin/attendance/export?${exportParams.toString()}`}>
              <Download className="mr-2 h-4 w-4" />
              Export CSV
            </a>
          </Button>
          <Button variant="outline" asChild>
            <a href={`/api/admin/attendance/export?${exportParams.toString()}&type=member-summary`}>
              <Users className="mr-2 h-4 w-4" />
              Member Summary
            </a>
          </Button>
          <Button variant="outline" asChild>
            <a href={`/api/admin/attendance/export?${exportParams.toString()}&type=event-summary`}>
              <Calendar className="mr-2 h-4 w-4" />
              Event Summary
            </a>
          </Button>
        </div>
      </div>

      {/* Filters */}
      <Card>
        <CardHeader>
          <CardTitle>Filters</CardTitle>
          <CardDescription>Filter attendance data by date range, section, and event type</CardDescription>
        </CardHeader>
        <CardContent>
          <AttendanceReportClient
            sections={sections}
            startDate={startDate}
            endDate={endDate}
            sectionId={sectionId}
            eventType={eventType}
          />
        </CardContent>
      </Card>

      {/* Overview Stats */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Records</CardTitle>
            <FileText className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totalRecords}</div>
            <p className="text-xs text-muted-foreground">
              {formatDate(new Date(startDate), 'MMM d')} - {formatDate(new Date(endDate), 'MMM d, yyyy')}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Attendance Rate</CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{attendanceRate}%</div>
            <p className="text-xs text-muted-foreground">
              Present: {totals.present} of {totalRecords}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Late / Left Early</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totals.late + totals.leftEarly}</div>
            <p className="text-xs text-muted-foreground">
              Late: {totals.late} • Left Early: {totals.leftEarly}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Absences</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totals.absent}</div>
            <p className="text-xs text-muted-foreground">
              Excused: {totals.excused}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Attendance Breakdown */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Attendance Breakdown</CardTitle>
            <CardDescription>Distribution of attendance statuses</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Present</span>
                <div className="flex items-center gap-2">
                  <div className="w-32 bg-muted rounded-full h-2">
                    <div
                      className="bg-green-500 h-2 rounded-full"
                      style={{
                        width: `${totalRecords > 0 ? (totals.present / totalRecords) * 100 : 0}%`,
                      }}
                    />
                  </div>
                  <span className="text-sm text-muted-foreground w-12">
                    {totals.present}
                  </span>
                </div>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Late</span>
                <div className="flex items-center gap-2">
                  <div className="w-32 bg-muted rounded-full h-2">
                    <div
                      className="bg-amber-500 h-2 rounded-full"
                      style={{
                        width: `${totalRecords > 0 ? (totals.late / totalRecords) * 100 : 0}%`,
                      }}
                    />
                  </div>
                  <span className="text-sm text-muted-foreground w-12">
                    {totals.late}
                  </span>
                </div>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Excused</span>
                <div className="flex items-center gap-2">
                  <div className="w-32 bg-muted rounded-full h-2">
                    <div
                      className="bg-blue-500 h-2 rounded-full"
                      style={{
                        width: `${totalRecords > 0 ? (totals.excused / totalRecords) * 100 : 0}%`,
                      }}
                    />
                  </div>
                  <span className="text-sm text-muted-foreground w-12">
                    {totals.excused}
                  </span>
                </div>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Absent</span>
                <div className="flex items-center gap-2">
                  <div className="w-32 bg-muted rounded-full h-2">
                    <div
                      className="bg-red-500 h-2 rounded-full"
                      style={{
                        width: `${totalRecords > 0 ? (totals.absent / totalRecords) * 100 : 0}%`,
                      }}
                    />
                  </div>
                  <span className="text-sm text-muted-foreground w-12">
                    {totals.absent}
                  </span>
                </div>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Left Early</span>
                <div className="flex items-center gap-2">
                  <div className="w-32 bg-muted rounded-full h-2">
                    <div
                      className="bg-purple-500 h-2 rounded-full"
                      style={{
                        width: `${totalRecords > 0 ? (totals.leftEarly / totalRecords) * 100 : 0}%`,
                      }}
                    />
                  </div>
                  <span className="text-sm text-muted-foreground w-12">
                    {totals.leftEarly}
                  </span>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Attendance by Section */}
        <Card>
          <CardHeader>
            <CardTitle>Attendance by Section</CardTitle>
            <CardDescription>Attendance rates by instrument section</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Section</TableHead>
                  <TableHead className="text-right">Members</TableHead>
                  <TableHead className="text-right">Records</TableHead>
                  <TableHead className="text-right">Rate</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sectionAttendanceData.map((section) => (
                  <TableRow key={section.id}>
                    <TableCell className="font-medium">{section.name}</TableCell>
                    <TableCell className="text-right">{section.memberCount}</TableCell>
                    <TableCell className="text-right">{section.total}</TableCell>
                    <TableCell className="text-right">
                      <Badge variant={section.rate >= 80 ? 'default' : section.rate >= 60 ? 'secondary' : 'destructive'}>
                        {section.rate}%
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      {/* Attendance by Event Type */}
      <Card>
        <CardHeader>
          <CardTitle>Attendance by Event Type</CardTitle>
          <CardDescription>Attendance rates broken down by event type</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Event Type</TableHead>
                <TableHead className="text-right">Present</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="text-right">Rate</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {eventTypeStats.map((stat) => (
                <TableRow key={stat.type}>
                  <TableCell className="font-medium">{stat.type}</TableCell>
                  <TableCell className="text-right">{stat.present}</TableCell>
                  <TableCell className="text-right">{stat.total}</TableCell>
                  <TableCell className="text-right">
                    <Badge variant={stat.rate >= 80 ? 'default' : stat.rate >= 60 ? 'secondary' : 'destructive'}>
                      {stat.rate}%
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Top Attenders */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Top Attenders</CardTitle>
            <CardDescription>Members with the most present attendance</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Member</TableHead>
                  <TableHead>Section</TableHead>
                  <TableHead className="text-right">Present</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {topMembers.map((member) => (
                  <TableRow key={member.id}>
                    <TableCell className="font-medium">
                      {member.firstName} {member.lastName}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {member.sections[0]?.section.name || '-'}
                    </TableCell>
                    <TableCell className="text-right">
                      {member._count.attendance}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {/* Recent Event Attendance */}
        <Card>
          <CardHeader>
            <CardTitle>Recent Event Attendance</CardTitle>
            <CardDescription>Attendance for recent events</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Event</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead className="text-right">Rate</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {eventAttendanceData.map((event) => (
                  <TableRow key={event.id}>
                    <TableCell className="font-medium">{event.title}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDate(event.date, 'MMM d, yyyy')}
                    </TableCell>
                    <TableCell className="text-right">
                      <Badge variant={event.rate >= 80 ? 'default' : event.rate >= 60 ? 'secondary' : 'destructive'}>
                        {event.rate}%
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// Clock icon component
function Clock({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}
