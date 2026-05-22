import Link from 'next/link';
import { prisma } from '@/lib/db';
import { requirePermission } from '@/lib/auth/guards';
import { formatDate, formatTime } from '@/lib/date';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Calendar,
  CalendarPlus,
  Search,
  MoreHorizontal,
  Eye,
  Edit,
  Users,
  Music,
  MapPin,
} from 'lucide-react';

import { EVENT_VIEW_ALL } from '@/lib/auth/permission-constants';
interface SearchParams {
  search?: string;
  type?: string;
  status?: string;
  page?: string;
  view?: string;
}

export default async function AdminEventsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await requirePermission(EVENT_VIEW_ALL);
  const params = await searchParams;

  const search = params.search || '';
  const type = params.type || '';
  const status = params.status || '';
  const page = parseInt(params.page || '1');
  const view = params.view || 'upcoming';
  const limit = 20;

  const now = new Date();
  const where: any = {};

  if (view === 'upcoming') {
    where.startTime = { gte: now };
  } else if (view === 'past') {
    where.startTime = { lt: now };
  }

  if (type) {
    where.eventType = type;
  }

  if (status) {
    where.status = status;
  }

  if (search) {
    where.OR = [
      { title: { contains: search } },
      { venue: { name: { contains: search } } },
    ];
  }

  const [events, total, stats] = await Promise.all([
    prisma.event.findMany({
      where,
      include: {
        venue: {
          select: { id: true, name: true },
        },
        _count: {
          select: {
            attendance: true,
            music: true,
          },
        },
      },
      orderBy: { startTime: view === 'past' ? 'desc' : 'asc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.event.count({ where }),
    Promise.all([
      prisma.event.count({ where: { startTime: { gte: now }, isCancelled: false } }),
      prisma.event.count({ where: { type: 'REHEARSAL', startTime: { gte: now } } }),
      prisma.event.count({ where: { type: 'CONCERT', startTime: { gte: now } } }),
      prisma.event.count({ where: { startTime: { gte: now, lte: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000) } } }),
    ]),
  ]);

  const [upcomingCount, rehearsalCount, concertCount, thisMonthCount] = stats;
  const totalPages = Math.ceil(total / limit);

  const typeColors: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
    REHEARSAL: 'secondary',
    CONCERT: 'default',
    MEETING: 'outline',
    SOCIAL: 'outline',
    OTHER: 'secondary',
  };

  const statusColors: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
    SCHEDULED: 'default',
    CANCELLED: 'destructive',
    COMPLETED: 'secondary',
    POSTPONED: 'outline',
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Events</h1>
          <p className="text-muted-foreground">
            Manage rehearsals, concerts, and other events
          </p>
        </div>
        <Link href="/admin/events/new">
          <Button>
            <CalendarPlus className="mr-2 h-4 w-4" />
            Add Event
          </Button>
        </Link>
      </div>

      {/* Stats */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Upcoming Events</CardTitle>
            <Calendar className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{upcomingCount}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Rehearsals</CardTitle>
            <Badge variant="secondary">Scheduled</Badge>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{rehearsalCount}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Concerts</CardTitle>
            <Badge variant="default">Coming Up</Badge>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{concertCount}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">This Month</CardTitle>
            <Badge variant="outline">Next 30 Days</Badge>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{thisMonthCount}</div>
          </CardContent>
        </Card>
      </div>

      {/* Event List */}
      <Card>
        <CardHeader>
          <Tabs defaultValue={view} className="w-full">
            <div className="flex items-center justify-between">
              <TabsList>
                <TabsTrigger value="upcoming" asChild>
                  <Link href="/admin/events?view=upcoming">Upcoming</Link>
                </TabsTrigger>
                <TabsTrigger value="past" asChild>
                  <Link href="/admin/events?view=past">Past</Link>
                </TabsTrigger>
                <TabsTrigger value="all" asChild>
                  <Link href="/admin/events?view=all">All</Link>
                </TabsTrigger>
              </TabsList>
            </div>
          </Tabs>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col sm:flex-row gap-4 mb-6">
            <input type="hidden" name="view" value={view} />
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
                <SelectItem value="MEETING">Meeting</SelectItem>
                <SelectItem value="SOCIAL">Social</SelectItem>
                <SelectItem value="OTHER">Other</SelectItem>
              </SelectContent>
            </Select>
            <Select name="status" defaultValue={status}>
              <SelectTrigger id="status" name="status" className="w-[150px]">
                <SelectValue placeholder="All Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Status</SelectItem>
                <SelectItem value="SCHEDULED">Scheduled</SelectItem>
                <SelectItem value="CANCELLED">Cancelled</SelectItem>
                <SelectItem value="COMPLETED">Completed</SelectItem>
                <SelectItem value="POSTPONED">Postponed</SelectItem>
              </SelectContent>
            </Select>
            <Button type="submit">Filter</Button>
          </form>

          {events.length === 0 ? (
            <div className="text-center py-12">
              <Calendar className="mx-auto h-12 w-12 text-muted-foreground" />
              <h3 className="mt-4 text-lg font-semibold">No events found</h3>
              <p className="text-muted-foreground">
                {search || type || status
                  ? 'Try adjusting your search or filters'
                  : 'Create your first event to get started'}
              </p>
            </div>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Event</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Date & Time</TableHead>
                    <TableHead>Venue</TableHead>
                    <TableHead>Attendance</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {events.map((event) => (
                    <TableRow key={event.id}>
                      <TableCell>
                        <div>
                          <p className="font-medium">{event.title}</p>
                          {event.description && (
                            <p className="text-sm text-muted-foreground line-clamp-1">
                              {event.description}
                            </p>
                          )}
                        </div>
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
                            {event.endTime && ` - ${formatTime(event.endTime)}`}
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
                        <div className="flex items-center gap-4">
                          <div className="flex items-center gap-1">
                            <Users className="h-3 w-3 text-muted-foreground" />
                            <span className="text-sm">{event._count.attendance}</span>
                          </div>
                          <div className="flex items-center gap-1">
                            <Music className="h-3 w-3 text-muted-foreground" />
                            <span className="text-sm">{event._count.music}</span>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant={statusColors[event.isCancelled ? "CANCELLED" : "SCHEDULED"] || 'secondary'}>
                          {event.isCancelled ? "CANCELLED" : "SCHEDULED"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon">
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuLabel>Actions</DropdownMenuLabel>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem asChild>
                              <Link href={`/admin/events/${event.id}`}>
                                <Eye className="mr-2 h-4 w-4" />
                                View Details
                              </Link>
                            </DropdownMenuItem>
                            <DropdownMenuItem asChild>
                              <Link href={`/admin/events/${event.id}/edit`}>
                                <Edit className="mr-2 h-4 w-4" />
                                Edit Event
                              </Link>
                            </DropdownMenuItem>
                            <DropdownMenuItem asChild>
                              <Link href={`/admin/events/${event.id}/attendance`}>
                                <Users className="mr-2 h-4 w-4" />
                                Attendance
                              </Link>
                            </DropdownMenuItem>
                            <DropdownMenuItem asChild>
                              <Link href={`/admin/events/${event.id}/music`}>
                                <Music className="mr-2 h-4 w-4" />
                                Music Program
                              </Link>
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="flex items-center justify-between mt-4">
                  <p className="text-sm text-muted-foreground">
                    Showing {(page - 1) * limit + 1} to{' '}
                    {Math.min(page * limit, total)} of {total} events
                  </p>
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/admin/events?page=${page - 1}&view=${view}&search=${search}&type=${type}&status=${status}`}
                    >
                      <Button variant="outline" size="sm" disabled={page <= 1}>
                        Previous
                      </Button>
                    </Link>
                    <span className="text-sm">
                      Page {page} of {totalPages}
                    </span>
                    <Link
                      href={`/admin/events?page=${page + 1}&view=${view}&search=${search}&type=${type}&status=${status}`}
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
