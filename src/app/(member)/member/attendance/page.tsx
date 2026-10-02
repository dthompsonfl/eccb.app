import Link from 'next/link';
import { requireAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db';
import { AttendanceStatus } from '@prisma/client';
import { formatDate } from '@/lib/date';
import { attendanceStatusLabel, eventTypeLabel } from '@/lib/accessibility/plain-language';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  ClipboardCheck,
  Calendar,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Clock,
} from 'lucide-react';

export default async function MemberAttendancePage() {
  const session = await requireAuth();

  // Get the member record with attendance data
  const member = await prisma.member.findFirst({
    where: { userId: session.user.id },
    include: {
      attendance: {
        include: {
          event: true,
        },
        orderBy: { markedAt: 'desc' },
        take: 50,
      },
    },
  });

  if (!member) {
    return (
      <div className="space-y-6">
        <h1 className="text-3xl font-bold tracking-tight">Attendance</h1>
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <ClipboardCheck className="h-12 w-12 text-muted-foreground/30 mb-4" />
            <h3 className="text-lg font-medium">We do not have your details yet</h3>
            <p className="text-sm text-muted-foreground mt-1">
              Please fill in your details, then this page will show which rehearsals
              you came to.
            </p>
            <Button asChild className="mt-4">
              <Link href="/member/profile">Fill in my details</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Calculate attendance statistics
  const totalEvents = member.attendance.length;
  const presentCount = member.attendance.filter(a => a.status === 'PRESENT').length;
  const absentCount = member.attendance.filter(a => a.status === 'ABSENT').length;
  const excusedCount = member.attendance.filter(a => a.status === 'EXCUSED').length;
  const attendanceRate = totalEvents > 0 
    ? Math.round((presentCount / totalEvents) * 100) 
    : 0;

  const statusIcons: Record<AttendanceStatus, React.ReactNode> = {
    PRESENT: <CheckCircle2 className="h-4 w-4 text-green-500" />,
    ABSENT: <XCircle className="h-4 w-4 text-red-500" />,
    EXCUSED: <AlertCircle className="h-4 w-4 text-amber-500" />,
    LATE: <Clock className="h-4 w-4 text-blue-500" />,
    LEFT_EARLY: <Clock className="h-4 w-4 text-orange-500" />,
  };

  const _statusColors: Record<AttendanceStatus, string> = {
    PRESENT: 'bg-green-100 text-green-800',
    ABSENT: 'bg-red-100 text-red-800',
    EXCUSED: 'bg-amber-100 text-amber-800',
    LATE: 'bg-blue-100 text-blue-800',
    LEFT_EARLY: 'bg-orange-100 text-orange-800',
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Which Rehearsals I Came To</h1>
        <p className="text-muted-foreground">
          Your record for recent rehearsals and concerts.
        </p>
      </div>

      {/* Statistics Cards */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Came to</CardTitle>
            <ClipboardCheck className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{attendanceRate}%</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Came</CardTitle>
            <CheckCircle2 className="h-4 w-4 text-green-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">{presentCount}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Missed</CardTitle>
            <XCircle className="h-4 w-4 text-red-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-red-600">{absentCount}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Told Us in Advance</CardTitle>
            <AlertCircle className="h-4 w-4 text-amber-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-amber-600">{excusedCount}</div>
          </CardContent>
        </Card>
      </div>

      {/* Attendance History */}
      <Card>
        <CardHeader>
          <CardTitle>Every Rehearsal on Record</CardTitle>
          <CardDescription>Most recent first.</CardDescription>
        </CardHeader>
        <CardContent>
          {member.attendance.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8">
              <Calendar className="h-12 w-12 text-muted-foreground/30 mb-4" />
              <p className="text-muted-foreground">
                Nothing has been recorded yet. Once the band office marks a rehearsal, it
                will show up here.
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>What it was</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Did you come</TableHead>
                  <TableHead>Notes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {member.attendance.map((record) => (
                  <TableRow key={record.id}>
                    <TableCell>
                      <Link
                        href={`/member/events/${record.eventId}`}
                        className="font-medium hover:underline"
                      >
                        {record.event.title}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDate(record.event.startTime, 'MMM d, yyyy')}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{eventTypeLabel(record.event.type)}</Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        {statusIcons[record.status]}
                        <span>{attendanceStatusLabel(record.status)}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground max-w-xs truncate">
                      {record.notes || '-'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
