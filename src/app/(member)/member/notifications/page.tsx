import Link from 'next/link';
import { prisma } from '@/lib/db';
import { requireAuth } from '@/lib/auth/guards';
import { formatRelativeTime } from '@/lib/date';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  AlertTriangle,
  Bell,
  Calendar,
  Check,
  Info,
  Megaphone,
  Music,
} from 'lucide-react';
import {
  markAllNotificationsRead,
  markNotificationRead,
} from './actions';
import type { NotificationType } from '@prisma/client';

export const dynamic = 'force-dynamic';

function safeNotificationHref(value: string | null): string | null {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return null;
  return value;
}

const TYPE_META: Record<
  NotificationType,
  { label: string; icon: typeof Bell; badge: 'default' | 'secondary' | 'destructive' | 'outline' }
> = {
  ANNOUNCEMENT: { label: 'Announcement', icon: Megaphone, badge: 'secondary' },
  EVENT_REMINDER: { label: 'Event', icon: Calendar, badge: 'default' },
  MUSIC_ASSIGNMENT: { label: 'Music', icon: Music, badge: 'outline' },
  ATTENDANCE_REMINDER: { label: 'Attendance', icon: AlertTriangle, badge: 'destructive' },
  SYSTEM: { label: 'System', icon: Info, badge: 'secondary' },
};

export default async function MemberNotificationsPage() {
  const session = await requireAuth();

  const [notifications, unreadCount] = await Promise.all([
    prisma.userNotification.findMany({
      where: { userId: session.user.id },
      orderBy: { createdAt: 'desc' },
      take: 100,
    }),
    prisma.userNotification.count({
      where: { userId: session.user.id, isRead: false },
    }),
  ]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold tracking-tight">Notifications</h1>
            {unreadCount > 0 ? <Badge>{unreadCount} unread</Badge> : null}
          </div>
          <p className="text-muted-foreground">
            Your announcements, event reminders, music assignments, and system updates.
          </p>
        </div>

        {unreadCount > 0 ? (
          <form action={markAllNotificationsRead}>
            <Button type="submit" variant="outline" size="sm">
              <Check className="mr-2 h-4 w-4" />
              Mark all read
            </Button>
          </form>
        ) : null}
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Bell className="h-5 w-5" />
            <CardTitle>Notification Center</CardTitle>
          </div>
          <CardDescription>
            Read state is saved to your account and follows you across devices.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {notifications.length === 0 ? (
            <div className="py-12 text-center">
              <Bell className="mx-auto h-12 w-12 text-muted-foreground" />
              <h2 className="mt-4 text-lg font-semibold">No notifications yet</h2>
              <p className="text-muted-foreground">
                New band updates will appear here.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {notifications.map((notification) => {
                const meta = TYPE_META[notification.type];
                const Icon = meta.icon;
                const safeLinkUrl = safeNotificationHref(notification.linkUrl);

                return (
                  <article
                    key={notification.id}
                    className={`rounded-lg border p-4 ${
                      notification.isRead ? 'bg-background' : 'border-primary/40 bg-primary/5'
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <div className="mt-1 shrink-0">
                        <Icon className="h-5 w-5 text-primary" aria-hidden="true" />
                      </div>

                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <h2 className="font-semibold">{notification.title}</h2>
                          <Badge variant={meta.badge}>{meta.label}</Badge>
                          {!notification.isRead ? <Badge variant="outline">Unread</Badge> : null}
                        </div>

                        <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">
                          {notification.message}
                        </p>

                        <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                          <time dateTime={notification.createdAt.toISOString()}>
                            {formatRelativeTime(notification.createdAt)}
                          </time>
                          {notification.readAt ? (
                            <span>Read {formatRelativeTime(notification.readAt)}</span>
                          ) : null}
                        </div>

                        <div className="mt-4 flex flex-wrap gap-2">
                          {safeLinkUrl ? (
                            <Button asChild size="sm" variant="outline">
                              <Link href={safeLinkUrl}>
                                {notification.linkText || 'View details'}
                              </Link>
                            </Button>
                          ) : null}

                          {!notification.isRead ? (
                            <form action={markNotificationRead.bind(null, notification.id)}>
                              <Button type="submit" size="sm" variant="ghost">
                                <Check className="mr-2 h-4 w-4" />
                                Mark read
                              </Button>
                            </form>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
