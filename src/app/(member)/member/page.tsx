import { Metadata } from 'next';
import Link from 'next/link';
import { requireAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db';
import { formatDate, formatRelativeTime } from '@/lib/date';
import { eventTypeLabel } from '@/lib/accessibility/plain-language';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Music,
  Calendar,
  ClipboardCheck,
  Bell,
  ArrowRight,
  FileText,
  Clock,
  MapPin,
} from 'lucide-react';

export const metadata: Metadata = {
  title: 'Home',
};

async function getDashboardData(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      member: {
        include: {
          musicAssignments: {
            include: {
              piece: true,
            },
            orderBy: { assignedAt: 'desc' },
            take: 5,
          },
          attendance: {
            include: {
              event: true,
            },
            orderBy: { event: { startTime: 'desc' } },
            take: 5,
          },
        },
      },
      notifications: {
        where: { isRead: false },
        orderBy: { createdAt: 'desc' },
        take: 5,
      },
    },
  });

  // Upcoming events
  const upcomingEvents = await prisma.event.findMany({
    where: {
      isPublished: true,
      isCancelled: false,
      startTime: { gte: new Date() },
      deletedAt: null,
    },
    orderBy: { startTime: 'asc' },
    take: 3,
    include: {
      venue: true,
    },
  });

  // Recent announcements
  const announcements = await prisma.announcement.findMany({
    where: {
      status: 'PUBLISHED',
      publishedAt: { lte: new Date() },
      OR: [
        { expiresAt: null },
        { expiresAt: { gt: new Date() } },
      ],
    },
    orderBy: { publishedAt: 'desc' },
    take: 3,
  });

  return { user, upcomingEvents, announcements };
}

export default async function MemberDashboardPage() {
  const session = await requireAuth();
  const { user, upcomingEvents, announcements } = await getDashboardData(session.user.id);

  const memberName = user?.member
    ? `${user.member.firstName}`
    : user?.name || 'Member';

  const assignedMusic = user?.member?.musicAssignments || [];
  const unreadNotifications = user?.notifications.length || 0;

  return (
    <div className="space-y-8">
      {/* Welcome Banner */}
      <div className="bg-gradient-to-r from-primary/10 via-primary/5 to-transparent rounded-2xl p-6 md:p-8">
        <h1 className="text-2xl md:text-3xl font-bold">
          Welcome back, {memberName}!
        </h1>
        <p className="mt-2 text-muted-foreground">
          Here is what is coming up. Everything you need is in the menu on the left.
        </p>
      </div>

      {/* Quick Stats */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Your Music</CardTitle>
            <Music className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{assignedMusic.length}</div>
            <p className="text-xs text-muted-foreground">pieces given to you</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Coming Up</CardTitle>
            <Calendar className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{upcomingEvents.length}</div>
            <p className="text-xs text-muted-foreground">in the next 30 days</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Rehearsals</CardTitle>
            <ClipboardCheck className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {user?.member?.attendance.filter(a => a.status === 'PRESENT').length || 0}
            </div>
            <p className="text-xs text-muted-foreground">you came to</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Messages</CardTitle>
            <Bell className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{unreadNotifications}</div>
            <p className="text-xs text-muted-foreground">you have not read</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Upcoming Events */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>What&apos;s Coming Up</CardTitle>
              <Button variant="ghost" size="sm" asChild>
                <Link href="/member/calendar">
                  See all dates
                  <ArrowRight className="ml-1 h-4 w-4" />
                </Link>
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {upcomingEvents.length === 0 ? (
              <p className="text-muted-foreground text-center py-8">
                Nothing is scheduled right now. Check back soon.
              </p>
            ) : (
              <div className="space-y-4">
                {upcomingEvents.map((event) => (
                  <div
                    key={event.id}
                    className="flex items-start gap-4 p-3 rounded-lg hover:bg-muted/50 transition-colors"
                  >
                    <div className="flex-shrink-0 w-12 h-12 bg-primary/10 rounded-lg flex flex-col items-center justify-center">
                      <span className="text-xs font-medium text-primary">
                        {formatDate(event.startTime, 'MMM')}
                      </span>
                      <span className="text-lg font-bold text-primary">
                        {formatDate(event.startTime, 'd')}
                      </span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <h4 className="font-medium truncate">{event.title}</h4>
                      <div className="flex items-center gap-3 text-sm text-muted-foreground mt-1">
                        <span className="flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          {formatDate(event.startTime, 'h:mm a')}
                        </span>
                        {event.venue && (
                          <span className="flex items-center gap-1 truncate">
                            <MapPin className="h-3 w-3" />
                            {event.venue.name}
                          </span>
                        )}
                      </div>
                    </div>
                    <Badge variant={event.type === 'CONCERT' ? 'default' : 'secondary'}>
                      {eventTypeLabel(event.type)}
                    </Badge>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* My Music */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Your Music</CardTitle>
              <Button variant="ghost" size="sm" asChild>
                <Link href="/member/music">
                  See all
                  <ArrowRight className="ml-1 h-4 w-4" />
                </Link>
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {assignedMusic.length === 0 ? (
              <p className="text-muted-foreground text-center py-8">
                You have not been given any music yet. Your librarian will add it here.
              </p>
            ) : (
              <div className="space-y-3">
                {assignedMusic.map((assignment) => (
                  <Link
                    key={assignment.id}
                    href={`/member/music/${assignment.pieceId}`}
                    className="flex items-center gap-3 p-3 rounded-lg hover:bg-muted/50 transition-colors"
                  >
                    <div className="flex-shrink-0 w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center">
                      <FileText className="h-5 w-5 text-primary" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <h4 className="font-medium truncate">{assignment.piece.title}</h4>
                      {assignment.partName && (
                        <p className="text-sm text-muted-foreground">
                          Part: {assignment.partName}
                        </p>
                      )}
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Announcements */}
      {announcements.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Latest Announcements</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {announcements.map((announcement) => (
                <div
                  key={announcement.id}
                  className="border-l-4 border-primary pl-4 py-2"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <h4 className="font-medium">{announcement.title}</h4>
                      <p className="text-sm text-muted-foreground mt-1 line-clamp-2">
                        {announcement.content}
                      </p>
                    </div>
                    {announcement.isUrgent && (
                      <Badge variant="destructive">Urgent</Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-2">
                    {announcement.publishedAt && formatRelativeTime(announcement.publishedAt)}
                  </p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
