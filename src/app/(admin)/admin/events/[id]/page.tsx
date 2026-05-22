import { notFound } from 'next/navigation';
import Link from 'next/link';
import { prisma } from '@/lib/db';
import { requirePermission } from '@/lib/auth/guards';
import { formatDate, formatTime } from '@/lib/date';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  ArrowLeft,
  Edit,
  Calendar,
  MapPin,
  Clock,
  Users,
  Music,
  Shirt,
  AlertCircle,
} from 'lucide-react';

import { EVENT_VIEW_ALL } from '@/lib/auth/permission-constants';
interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function EventDetailPage({ params }: PageProps) {
  await requirePermission(EVENT_VIEW_ALL);
  const { id } = await params;

  const event = await prisma.event.findUnique({
    where: { id },
    include: {
      venue: true,
      music: {
        include: {
          piece: {
            include: {
              composer: true,
            },
          },
        },
        orderBy: { sortOrder: 'asc' },
      },
      attendance: {
        include: {
          member: {
            include: {
              user: true,
              instruments: {
                where: { isPrimary: true },
                include: { instrument: true },
              },
            },
          },
        },
      },
    },
  });

  if (!event) {
    notFound();
  }

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

  const attendanceStats = {
    present: event.attendance.filter((r) => r.status === 'PRESENT').length,
    absent: event.attendance.filter((r) => r.status === 'ABSENT').length,
    excused: event.attendance.filter((r) => r.status === 'EXCUSED').length,
    late: event.attendance.filter((r) => r.status === 'LATE').length,
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href="/admin/events">
            <Button variant="outline" size="icon">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-3xl font-bold tracking-tight">{event.title}</h1>
              <Badge variant={typeColors[event.type]}>{event.type}</Badge>
              <Badge variant={statusColors[event.isCancelled ? "CANCELLED" : "SCHEDULED"]}>{event.isCancelled ? "CANCELLED" : "SCHEDULED"}</Badge>
            </div>
            {event.description && (
              <p className="text-muted-foreground">{event.description}</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Link href={`/admin/events/${id}/edit`}>
            <Button>
              <Edit className="mr-2 h-4 w-4" />
              Edit
            </Button>
          </Link>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-3">
        {/* Event Details */}
        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle>Event Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex items-center gap-3">
                <Calendar className="h-5 w-5 text-muted-foreground" />
                <div>
                  <p className="text-sm text-muted-foreground">Date</p>
                  <p className="font-medium">{formatDate(event.startTime)}</p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <Clock className="h-5 w-5 text-muted-foreground" />
                <div>
                  <p className="text-sm text-muted-foreground">Time</p>
                  <p className="font-medium">
                    {formatTime(event.startTime)}
                    {event.endTime && ` - ${formatTime(event.endTime)}`}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <MapPin className="h-5 w-5 text-muted-foreground" />
                <div>
                  <p className="text-sm text-muted-foreground">Venue</p>
                  <p className="font-medium">{event.venue?.name || 'TBD'}</p>
                  {event.venue?.address && (
                    <p className="text-sm text-muted-foreground">{event.venue.address}</p>
                  )}
                </div>
              </div>
              {event.dressCode && (
                <div className="flex items-center gap-3">
                  <Shirt className="h-5 w-5 text-muted-foreground" />
                  <div>
                    <p className="text-sm text-muted-foreground">Dress Code</p>
                    <p className="font-medium">{event.dressCode}</p>
                  </div>
                </div>
              )}
              {event.callTime && (
                <div className="flex items-center gap-3">
                  <AlertCircle className="h-5 w-5 text-muted-foreground" />
                  <div>
                    <p className="text-sm text-muted-foreground">Call Time</p>
                    <p className="font-medium">{formatTime(event.callTime)}</p>
                  </div>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Quick Stats */}
        <div className="space-y-6">
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-4">
                <div className="p-2 bg-primary/10 rounded-lg">
                  <Music className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{event.music.length}</p>
                  <p className="text-sm text-muted-foreground">Music Pieces</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-4">
                <div className="p-2 bg-green-500/10 rounded-lg">
                  <Users className="h-5 w-5 text-green-500" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{attendanceStats.present}</p>
                  <p className="text-sm text-muted-foreground">Present</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="text-sm space-y-2">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Absent</span>
                  <span className="font-medium">{attendanceStats.absent}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Excused</span>
                  <span className="font-medium">{attendanceStats.excused}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Late</span>
                  <span className="font-medium">{attendanceStats.late}</span>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="music" className="space-y-4">
        <TabsList>
          <TabsTrigger value="music">
            <Music className="mr-2 h-4 w-4" />
            Program ({event.music.length})
          </TabsTrigger>
          <TabsTrigger value="attendance">
            <Users className="mr-2 h-4 w-4" />
            Attendance ({event.attendance.length})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="music">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>Music Program</CardTitle>
                  <CardDescription>
                    Pieces scheduled for this event
                  </CardDescription>
                </div>
                <Link href={`/admin/events/${id}/music`}>
                  <Button variant="outline">
                    <Music className="mr-2 h-4 w-4" />
                    Manage Program
                  </Button>
                </Link>
              </div>
            </CardHeader>
            <CardContent>
              {event.music.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">
                  No music has been scheduled for this event.
                </p>
              ) : (
                <div className="space-y-4">
                  {event.music.map((ep, index) => (
                    <div
                      key={ep.id}
                      className="flex items-center gap-4 border-b pb-4 last:border-0"
                    >
                      <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center text-sm font-medium">
                        {index + 1}
                      </div>
                      <div className="flex-1">
                        <Link
                          href={`/admin/music/${ep.piece.id}`}
                          className="font-medium hover:underline"
                        >
                          {ep.piece.title}
                        </Link>
                        {ep.piece.composer && (
                          <p className="text-sm text-muted-foreground">
                            {ep.piece.composer.firstName}{' '}
                            {ep.piece.composer.lastName}
                          </p>
                        )}
                      </div>
                      {ep.piece.duration && (
                        <Badge variant="outline">
                          {ep.piece.duration} min
                        </Badge>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="attendance">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>Attendance</CardTitle>
                  <CardDescription>
                    Member attendance for this event
                  </CardDescription>
                </div>
                <Link href={`/admin/events/${id}/attendance`}>
                  <Button variant="outline">
                    <Users className="mr-2 h-4 w-4" />
                    Take Attendance
                  </Button>
                </Link>
              </div>
            </CardHeader>
            <CardContent>
              {event.attendance.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">
                  No attendance has been recorded for this event.
                </p>
              ) : (
                <div className="space-y-2">
                  {event.attendance.map((record) => (
                    <div
                      key={record.id}
                      className="flex items-center justify-between py-2 border-b last:border-0"
                    >
                      <div className="flex items-center gap-3">
                        <span className="font-medium">
                          {record.member.user?.name || `${record.member.firstName} ${record.member.lastName}`}
                        </span>
                        {record.member.instruments?.[0]?.instrument && (
                          <Badge variant="outline">
                            {record.member.instruments[0].instrument.name}
                          </Badge>
                        )}
                      </div>
                      <Badge
                        variant={
                          record.status === 'PRESENT'
                            ? 'default'
                            : record.status === 'ABSENT'
                            ? 'destructive'
                            : 'secondary'
                        }
                      >
                        {record.status}
                      </Badge>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
