import Link from 'next/link';
import { prisma } from '@/lib/db';
import { EventType } from '@prisma/client';
import { requirePermission } from '@/lib/auth/guards';
import { formatDate, formatTime } from '@/lib/date';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Calendar,
  Search,
  Users,
  MapPin,
  ClipboardCheck,
  CheckCircle2,
} from 'lucide-react';

import { ATTENDANCE_MARK_ALL } from '@/lib/auth/permission-constants';
interface SearchParams {
  search?: string;
  type?: string;
  page?: string;
}

export default async function AdminAttendancePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await requirePermission(ATTENDANCE_MARK_ALL);
  const params = await searchParams;

  const search = params.search || '';
  const type = params.type || '';
  const page = parseInt(params.page || '1');
  const limit = 20;

  const now = new Date();
  
  // Build where clause for events (past and recent, for attendance taking)
   
  const where: any = {};

  // Show events from the past 30 days and future
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  where.startTime = { gte: thirtyDaysAgo };

  if (type) {
    where.type = type as EventType;
  }

  if (search) {
    where.OR = [
      { title: { contains: search } },
      { venue: { name: { contains: search } } },
    ];
  }

  const [events, total] = await Promise.all([
    prisma.event.findMany({
      where,
      include: {
        venue: {
          select: { id: true, name: true },
        },
        _count: {
          select: {
            attendance: true,
          },
        },
        attendance: {
          select: {
            status: true,
          },
        },
      },
      orderBy: { startTime: 'asc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.event.count({ where }),
  ]);

  const totalPages = Math.ceil(total / limit);

  const typeColors: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
    REHEARSAL: 'secondary',
    CONCERT: 'default',
    SECTIONAL: 'outline',
    BOARD_MEETING: 'outline',
    SOCIAL: 'outline',
    OTHER: 'secondary',
  };

  // Calculate attendance stats for each event
  const eventStats = events.map((event) => {
    const present = event.attendance.filter((a) => a.status === 'PRESENT').length;
    const total = event.attendance.length;
    const rate = total > 0 ? Math.round((present / total) * 100) : 0;
    return { present, total, rate };
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Attendance</h1>
          <p className="text-muted-foreground">
            Take and manage attendance for rehearsals and events
          </p>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Events with Attendance</CardTitle>
            <Calendar className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{events.filter((e) => e._count.attendance > 0).length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Total Records</CardTitle>
            <ClipboardCheck className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {events.reduce((sum, e) => sum + e._count.attendance, 0)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Avg Attendance Rate</CardTitle>
            <CheckCircle2 className="h-4 w-4 text-green-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {eventStats.length > 0
                ? Math.round(eventStats.reduce((sum, s) => sum + s.rate, 0) / eventStats.length)
                : 0}%
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Event List */}
      <Card>
        <CardHeader>
          <CardTitle>Events</CardTitle>
          <CardDescription>
            Select an event to take or view attendance
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col sm:flex-row gap-4 mb-6">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                name="search"
                placeholder="Search events..."
                defaultValue={search}
                className="pl-9"
              />
            </div>
            <Select name="type" defaultValue={type}>
              <SelectTrigger id="type" name="type" className="w-[150px]">
                <SelectValue placeholder="All Types" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Types</SelectItem>
                <SelectItem value="REHEARSAL">Rehearsal</SelectItem>
                <SelectItem value="CONCERT">Concert</SelectItem>
                <SelectItem value="SECTIONAL">Sectional</SelectItem>
                <SelectItem value="BOARD_MEETING">Board Meeting</SelectItem>
                <SelectItem value="SOCIAL">Social</SelectItem>
                <SelectItem value="OTHER">Other</SelectItem>
              </SelectContent>
            </Select>
            <Button type="submit">Filter</Button>
          </form>

          {events.length === 0 ? (
            <div className="text-center py-12">
              <Calendar className="mx-auto h-12 w-12 text-muted-foreground" />
              <h3 className="mt-4 text-lg font-semibold">No events found</h3>
              <p className="text-muted-foreground">
                {search || type
                  ? 'Try adjusting your search or filters'
                  : 'No upcoming events in the next 30 days'}
              </p>
            </div>
          ) : (
            <>
              <div className="border rounded-lg overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Event</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Date & Time</TableHead>
                      <TableHead>Venue</TableHead>
                      <TableHead>Attendance</TableHead>
                      <TableHead>Rate</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {events.map((event, index) => {
                      const stats = eventStats[index];
                      return (
                        <TableRow key={event.id}>
                          <TableCell>
                            <p className="font-medium">{event.title}</p>
                          </TableCell>
                          <TableCell>
                            <Badge variant={typeColors[event.type] || 'secondary'}>
                              {event.type}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <div>
                              <p>{formatDate(event.startTime)}</p>
                              <p className="text-sm text-muted-foreground">
                                {formatTime(event.startTime)}
                              </p>
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1">
                              <MapPin className="h-3 w-3 text-muted-foreground" />
                              <span>{event.venue?.name || 'TBD'}</span>
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1">
                              <Users className="h-3 w-3 text-muted-foreground" />
                              <span>{event._count.attendance}</span>
                            </div>
                          </TableCell>
                          <TableCell>
                            {stats.total > 0 ? (
                              <div className="flex items-center gap-2">
                                <div className="w-16 h-2 bg-muted rounded-full overflow-hidden">
                                  <div
                                    className="h-full bg-green-500"
                                    style={{ width: `${stats.rate}%` }}
                                  />
                                </div>
                                <span className="text-sm text-muted-foreground">
                                  {stats.rate}%
                                </span>
                              </div>
                            ) : (
                              <span className="text-sm text-muted-foreground">-</span>
                            )}
                          </TableCell>
                          <TableCell className="text-right">
                            <Link href={`/admin/events/${event.id}/attendance`}>
                              <Button variant="outline" size="sm">
                                <ClipboardCheck className="mr-2 h-4 w-4" />
                                Take Attendance
                              </Button>
                            </Link>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="flex items-center justify-between mt-4">
                  <p className="text-sm text-muted-foreground">
                    Showing {(page - 1) * limit + 1} to{' '}
                    {Math.min(page * limit, total)} of {total} events
                  </p>
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/admin/attendance?page=${page - 1}&search=${search}&type=${type}`}
                    >
                      <Button variant="outline" size="sm" disabled={page <= 1}>
                        Previous
                      </Button>
                    </Link>
                    <span className="text-sm">
                      Page {page} of {totalPages}
                    </span>
                    <Link
                      href={`/admin/attendance?page=${page + 1}&search=${search}&type=${type}`}
                    >
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={page >= totalPages}
                      >
                        Next
                      </Button>
                    </Link>
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
