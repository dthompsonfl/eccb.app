import { prisma } from '@/lib/db';
import { requireAuth } from '@/lib/auth/guards';
import { formatDate, formatRelativeTime } from '@/lib/date';
import {
  announcementTypeLabel,
  eventTypeLabel,
} from '@/lib/accessibility/plain-language';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import Link from 'next/link';
import {
  Bell,
  Megaphone,
  Calendar,
  AlertTriangle,
  Info,
} from 'lucide-react';

export default async function MemberNotificationsPage() {
  const _session = await requireAuth();
  
  const now = new Date();

  // Get active announcements
  const announcements = await prisma.announcement.findMany({
    where: {
      publishAt: { lte: now },
      OR: [
        { expiresAt: null },
        { expiresAt: { gt: now } },
      ],
      audience: { in: ['ALL', 'MEMBERS'] },
      status: 'PUBLISHED',
    },
    include: {
      author: {
        select: { name: true },
      },
    },
    orderBy: [
      { isPinned: 'desc' },
      { isUrgent: 'desc' },
      { publishAt: 'desc' },
    ],
    take: 20,
  });

  // Get upcoming events in next 7 days
  const upcomingEvents = await prisma.event.findMany({
    where: {
      startTime: {
        gte: now,
        lte: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
      },
      isCancelled: false,
      isPublished: true,
    },
    include: {
      venue: {
        select: { name: true },
      },
    },
    orderBy: { startTime: 'asc' },
  });

  const typeIcons: Record<string, React.ReactNode> = {
    INFO: <Info className="h-5 w-5 text-blue-500" />,
    WARNING: <AlertTriangle className="h-5 w-5 text-amber-500" />,
    URGENT: <AlertTriangle className="h-5 w-5 text-red-500" />,
    EVENT: <Calendar className="h-5 w-5 text-green-500" />,
  };

  const typeColors: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
    INFO: 'secondary',
    WARNING: 'outline',
    URGENT: 'destructive',
    EVENT: 'default',
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Notifications</h1>
        <p className="text-muted-foreground">
          Announcements and updates from the band
        </p>
      </div>

      {/* Upcoming Events Alert */}
      {upcomingEvents.length > 0 && (
        <Card className="border-primary">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Calendar className="h-5 w-5 text-primary" />
              <CardTitle className="text-lg">Coming Up This Week</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {upcomingEvents.map((event) => (
                <Link
                  key={event.id}
                  href={`/member/events/${event.id}`}
                  className="flex items-center justify-between p-3 rounded-lg hover:bg-muted transition-colors"
                >
                  <div>
                    <p className="font-medium">{event.title}</p>
                    <p className="text-sm text-muted-foreground">
                      {formatDate(event.startTime)} • {event.venue?.name || 'TBD'}
                    </p>
                  </div>
                  <Badge variant={event.type === 'CONCERT' ? 'default' : 'secondary'}>
                    {eventTypeLabel(event.type)}
                  </Badge>
                </Link>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Announcements */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Megaphone className="h-5 w-5" />
            <CardTitle>Announcements</CardTitle>
          </div>
          <CardDescription>
            Important updates and news from the band
          </CardDescription>
        </CardHeader>
        <CardContent>
          {announcements.length === 0 ? (
            <div className="text-center py-12">
              <Bell className="mx-auto h-12 w-12 text-muted-foreground" />
              <h3 className="mt-4 text-lg font-semibold">All caught up!</h3>
              <p className="text-muted-foreground">
                No new announcements at this time
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {announcements.map((announcement) => (
                <div
                  key={announcement.id}
                  className={`p-4 rounded-lg border ${
                    announcement.type === 'URGENT'
                      ? 'border-red-500 bg-red-500/5'
                      : announcement.type === 'WARNING'
                      ? 'border-amber-500 bg-amber-500/5'
                      : 'bg-muted/30'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <div className="flex-shrink-0 mt-1">
                      {typeIcons[announcement.type]}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="font-semibold">{announcement.title}</h3>
                        <Badge variant={typeColors[announcement.type]}>
                          {announcementTypeLabel(announcement.type)}
                        </Badge>
                        {announcement.isPinned && (
                          <Badge variant="outline">Pinned</Badge>
                        )}
                      </div>
                      <p className="mt-2 text-sm text-muted-foreground whitespace-pre-wrap">
                        {announcement.content}
                      </p>
                      <div className="mt-3 flex items-center gap-4 text-xs text-muted-foreground">
                        <span>By {announcement.author?.name || 'Admin'}</span>
                        {announcement.publishAt && (
                          <span>{formatRelativeTime(announcement.publishAt)}</span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
