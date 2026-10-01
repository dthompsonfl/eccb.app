'use client';

/**
 * AdminNotificationsClient
 *
 * Read lifecycle for the administrator's own notification inbox
 * (UserNotification rows scoped to the signed-in admin).
 *
 * Previously the admin header's notification bell linked to
 * /admin/notifications, which did not exist. Worse, nothing anywhere read
 * UserNotification, so the read/unread state the backend persisted was never
 * surfaced or changed.
 *
 * This component provides mark-one-read and mark-all-read, and reflects the
 * server's unread count.
 */

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { CheckCheck, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Bell, Megaphone, Calendar, Music, AlertTriangle, Info, Check } from 'lucide-react';
import type { NotificationType } from '@prisma/client';
import { formatRelativeTime } from '@/lib/date';
import { markNotificationRead, markAllNotificationsRead } from './actions';

interface NotificationItem {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  linkUrl: string | null;
  linkText: string | null;
  isRead: boolean;
  createdAt: Date;
}

const TYPE_META: Record<NotificationType, { icon: typeof Bell; label: string }> = {
  ANNOUNCEMENT: { icon: Megaphone, label: 'Announcement' },
  EVENT_REMINDER: { icon: Calendar, label: 'Event' },
  MUSIC_ASSIGNMENT: { icon: Music, label: 'Music' },
  ATTENDANCE_REMINDER: { icon: AlertTriangle, label: 'Attendance' },
  SYSTEM: { icon: Info, label: 'System' },
};

export function AdminNotificationsClient({
  notifications,
  unreadCount,
}: {
  notifications: NotificationItem[];
  unreadCount: number;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);

  const markRead = (id: string) => {
    setBusyId(id);
    startTransition(async () => {
      const result = await markNotificationRead(id);
      setBusyId(null);
      if (!result.success) {
        toast.error(result.error ?? 'Could not mark notification as read');
        return;
      }
      router.refresh();
    });
  };

  const markAll = () => {
    startTransition(async () => {
      const result = await markAllNotificationsRead();
      if (!result.success) {
        toast.error(result.error ?? 'Could not mark all notifications as read');
        return;
      }
      toast.success('All notifications marked as read');
      router.refresh();
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {unreadCount > 0
            ? `${unreadCount} unread notification${unreadCount === 1 ? '' : 's'}`
            : 'You are all caught up.'}
        </p>
        {unreadCount > 0 && (
          <Button
            variant="outline"
            onClick={markAll}
            disabled={isPending}
            aria-busy={isPending}
          >
            {isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <CheckCheck className="mr-2 h-4 w-4" aria-hidden="true" />
            )}
            Mark all as read
          </Button>
        )}
      </div>

      {notifications.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center py-12 text-center">
            <Bell className="mb-4 h-12 w-12 text-muted-foreground" aria-hidden="true" />
            <h2 className="text-lg font-semibold">No notifications</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Announcements and event reminders for administrators appear here.
            </p>
          </CardContent>
        </Card>
      ) : (
        <ul className="space-y-3">
          {notifications.map((notification) => {
            const meta = TYPE_META[notification.type] ?? TYPE_META.SYSTEM;
            const Icon = meta.icon;
            const busy = busyId === notification.id;

            return (
              <li key={notification.id}>
                <Card className={notification.isRead ? '' : 'border-primary/50'}>
                  <CardContent className="flex items-start gap-4 p-4">
                    <Icon
                      className="mt-0.5 h-5 w-5 shrink-0 text-primary"
                      aria-hidden="true"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="font-semibold text-slate-900 dark:text-slate-50">
                          {notification.title}
                        </h2>
                        <Badge variant="secondary">{meta.label}</Badge>
                        {!notification.isRead && (
                          <Badge>New</Badge>
                        )}
                      </div>
                      <p className="mt-1 text-sm text-slate-700 dark:text-slate-300">
                        {notification.message}
                      </p>
                      <p className="mt-2 text-xs text-muted-foreground">
                        <time dateTime={new Date(notification.createdAt).toISOString()}>
                          {formatRelativeTime(notification.createdAt)}
                        </time>
                      </p>
                    </div>

                    <div className="flex shrink-0 flex-col items-end gap-2">
                      {notification.linkUrl && (
                        <Button variant="ghost" size="sm" asChild>
                          <Link href={notification.linkUrl}>
                            {notification.linkText ?? 'View'}
                          </Link>
                        </Button>
                      )}
                      {!notification.isRead && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => markRead(notification.id)}
                          disabled={isPending || busy}
                          aria-busy={busy}
                        >
                          {busy ? (
                            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                          ) : (
                            <Check className="h-4 w-4" aria-hidden="true" />
                          )}
                          <span className="sr-only">
                            Mark &ldquo;{notification.title}&rdquo; as read
                          </span>
                          <span aria-hidden="true">Mark read</span>
                        </Button>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
