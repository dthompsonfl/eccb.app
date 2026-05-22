import { prisma } from '@/lib/db';
import { requirePermission } from '@/lib/auth/guards';
import { formatDate } from '@/lib/date';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import {
  BarChart3,
  Download,
  Users,
  Calendar,
  Music,
  TrendingUp,
} from 'lucide-react';

import { REPORT_VIEW } from '@/lib/auth/permission-constants';
export default async function AdminReportsPage() {
  await requirePermission(REPORT_VIEW);

  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

  // Execute all database queries concurrently
  const [
    totalMembers,
    activeMembers,
    newMembers,
    membersBySection,
    totalEvents,
    upcomingEvents,
    completedEvents,
    attendanceStats,
    totalPieces,
    recentPieces,
    topAttenders,
    recentEvents,
  ] = await Promise.all([
    // Member stats
    prisma.member.count(),
    prisma.member.count({ where: { status: 'ACTIVE' } }),
    prisma.member.count({
      where: { joinDate: { gte: thirtyDaysAgo } },
    }),

    // Get members by section
    prisma.section.findMany({
      select: {
        name: true,
        _count: {
          select: { members: true },
        },
      },
      orderBy: {
        members: { _count: 'desc' },
      },
    }),

    // Event stats
    prisma.event.count(),
    prisma.event.count({
      where: { startTime: { gte: now }, isCancelled: false },
    }),
    prisma.event.count({
      where: { endTime: { lt: now }, isCancelled: false },
    }),

    // Attendance stats for last 90 days
    prisma.attendance.groupBy({
      by: ['status'],
      where: {
        event: {
          startTime: { gte: ninetyDaysAgo, lte: now },
        },
      },
      _count: true,
    }),

    // Music library stats
    prisma.musicPiece.count(),
    prisma.musicPiece.count({
      where: { createdAt: { gte: thirtyDaysAgo } },
    }),

    // Top members by attendance (last 90 days)
    prisma.member.findMany({
      select: {
        id: true,
        firstName: true,
        lastName: true,
        sections: {
          select: {
            section: { select: { name: true } },
          },
        },
        _count: {
          select: {
            attendance: {
              where: {
                status: 'PRESENT',
                event: { startTime: { gte: ninetyDaysAgo } },
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

    // Recent events with attendance
    prisma.event.findMany({
      where: {
        endTime: { lt: now },
        isCancelled: false,
      },
      select: {
        id: true,
        title: true,
        type: true,
        startTime: true,
        _count: {
          select: { attendance: true },
        },
        attendance: {
          select: { status: true },
        },
      },
      orderBy: { startTime: 'desc' },
      take: 10,
    }),
  ]);

  const attendanceTotals = {
    present: attendanceStats.find((a) => a.status === 'PRESENT')?._count || 0,
    absent: attendanceStats.find((a) => a.status === 'ABSENT')?._count || 0,
    excused: attendanceStats.find((a) => a.status === 'EXCUSED')?._count || 0,
    late: attendanceStats.find((a) => a.status === 'LATE')?._count || 0,
  };
  const totalAttendanceRecords = Object.values(attendanceTotals).reduce((a, b) => a + b, 0);
  const attendanceRate = totalAttendanceRecords > 0
    ? Math.round(((attendanceTotals.present + attendanceTotals.late) / totalAttendanceRecords) * 100)
    : 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Reports</h1>
          <p className="text-muted-foreground">
            View band statistics and generate reports
          </p>
        </div>
        <Button variant="outline">
          <Download className="mr-2 h-4 w-4" />
          Export All Data
        </Button>
      </div>

      {/* Overview Stats */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Members</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totalMembers}</div>
            <p className="text-xs text-muted-foreground">
              {activeMembers} active • {newMembers} new this month
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Events</CardTitle>
            <Calendar className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totalEvents}</div>
            <p className="text-xs text-muted-foreground">
              {upcomingEvents} upcoming • {completedEvents} completed
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
              Last 90 days
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Music Library</CardTitle>
            <Music className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totalPieces}</div>
            <p className="text-xs text-muted-foreground">
              {recentPieces} added this month
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Detailed Reports */}
      <Tabs defaultValue="attendance" className="space-y-4">
        <TabsList>
          <TabsTrigger value="attendance">Attendance</TabsTrigger>
          <TabsTrigger value="membership">Membership</TabsTrigger>
          <TabsTrigger value="events">Events</TabsTrigger>
        </TabsList>

        <TabsContent value="attendance" className="space-y-4">
          <div className="flex justify-end">
            <Button asChild>
              <a href="/admin/reports/attendance">
                <BarChart3 className="mr-2 h-4 w-4" />
                Full Attendance Reports
              </a>
            </Button>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            {/* Attendance Breakdown */}
            <Card>
              <CardHeader>
                <CardTitle>Attendance Summary</CardTitle>
                <CardDescription>Last 90 days</CardDescription>
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
                            width: `${totalAttendanceRecords > 0 ? (attendanceTotals.present / totalAttendanceRecords) * 100 : 0}%`,
                          }}
                        />
                      </div>
                      <span className="text-sm text-muted-foreground w-12">
                        {attendanceTotals.present}
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
                            width: `${totalAttendanceRecords > 0 ? (attendanceTotals.late / totalAttendanceRecords) * 100 : 0}%`,
                          }}
                        />
                      </div>
                      <span className="text-sm text-muted-foreground w-12">
                        {attendanceTotals.late}
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
                            width: `${totalAttendanceRecords > 0 ? (attendanceTotals.excused / totalAttendanceRecords) * 100 : 0}%`,
                          }}
                        />
                      </div>
                      <span className="text-sm text-muted-foreground w-12">
                        {attendanceTotals.excused}
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
                            width: `${totalAttendanceRecords > 0 ? (attendanceTotals.absent / totalAttendanceRecords) * 100 : 0}%`,
                          }}
                        />
                      </div>
                      <span className="text-sm text-muted-foreground w-12">
                        {attendanceTotals.absent}
                      </span>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Top Attenders */}
            <Card>
              <CardHeader>
                <CardTitle>Top Attenders</CardTitle>
                <CardDescription>Most consistent members (90 days)</CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Member</TableHead>
                      <TableHead>Section</TableHead>
                      <TableHead className="text-right">Events</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {topAttenders.map((member) => (
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
          </div>

          {/* Recent Events Attendance */}
          <Card>
            <CardHeader>
              <CardTitle>Recent Event Attendance</CardTitle>
              <CardDescription>Attendance for the last 10 events</CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Event</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>Total</TableHead>
                    <TableHead>Present</TableHead>
                    <TableHead>Rate</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recentEvents.map((event) => {
                    const present = event.attendance.filter(
                      (a) => a.status === 'PRESENT' || a.status === 'LATE'
                    ).length;
                    const total = event.attendance.length;
                    const rate = total > 0 ? Math.round((present / total) * 100) : 0;

                    return (
                      <TableRow key={event.id}>
                        <TableCell className="font-medium">{event.title}</TableCell>
                        <TableCell>
                          <Badge variant="outline">{event.type}</Badge>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {formatDate(event.startTime, 'MMM d, yyyy')}
                        </TableCell>
                        <TableCell>{total}</TableCell>
                        <TableCell>{present}</TableCell>
                        <TableCell>
                          <Badge variant={rate >= 80 ? 'default' : rate >= 60 ? 'secondary' : 'destructive'}>
                            {rate}%
                          </Badge>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="membership" className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            {/* Members by Section */}
            <Card>
              <CardHeader>
                <CardTitle>Members by Section</CardTitle>
                <CardDescription>Distribution across instrument sections</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {membersBySection.map((section) => (
                    <div key={section.name} className="flex items-center justify-between">
                      <span className="text-sm font-medium">{section.name}</span>
                      <div className="flex items-center gap-2">
                        <div className="w-32 bg-muted rounded-full h-2">
                          <div
                            className="bg-primary h-2 rounded-full"
                            style={{
                              width: `${totalMembers > 0 ? (section._count.members / totalMembers) * 100 : 0}%`,
                            }}
                          />
                        </div>
                        <span className="text-sm text-muted-foreground w-8">
                          {section._count.members}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            {/* Member Status */}
            <Card>
              <CardHeader>
                <CardTitle>Member Status</CardTitle>
                <CardDescription>Current membership status breakdown</CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-full bg-green-500" />
                    <span>Active Members</span>
                  </div>
                  <span className="font-bold">{activeMembers}</span>
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-full bg-gray-500" />
                    <span>Inactive / Other</span>
                  </div>
                  <span className="font-bold">{totalMembers - activeMembers}</span>
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-full bg-blue-500" />
                    <span>New This Month</span>
                  </div>
                  <span className="font-bold">{newMembers}</span>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="events" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Event Statistics</CardTitle>
              <CardDescription>Overview of events by type</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-muted-foreground">
                Event analytics and statistics will be displayed here.
              </p>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
