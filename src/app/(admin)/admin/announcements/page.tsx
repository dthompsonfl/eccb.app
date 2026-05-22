import Link from 'next/link';
import { prisma } from '@/lib/db';
import { requirePermission } from '@/lib/auth/guards';
import { formatDate } from '@/lib/date';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Megaphone,
  Plus,
  MoreHorizontal,
  Edit,
  Pin,
  AlertTriangle,
  Info,
  Calendar,
  Send,
  Archive,
} from 'lucide-react';
import { DeleteAnnouncementButton } from './delete-button';

import { CMS_VIEW_ALL } from '@/lib/auth/permission-constants';
export default async function AdminAnnouncementsPage() {
  await requirePermission(CMS_VIEW_ALL);

  const announcements = await prisma.announcement.findMany({
    include: {
      author: {
        select: { name: true },
      },
    },
    orderBy: [
      { isPinned: 'desc' },
      { publishAt: 'desc' },
    ],
  });

  const typeIcons: Record<string, React.ReactNode> = {
    INFO: <Info className="h-4 w-4 text-blue-500" />,
    WARNING: <AlertTriangle className="h-4 w-4 text-amber-500" />,
    URGENT: <AlertTriangle className="h-4 w-4 text-red-500" />,
    EVENT: <Calendar className="h-4 w-4 text-green-500" />,
  };

  const typeColors: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
    INFO: 'secondary',
    WARNING: 'outline',
    URGENT: 'destructive',
    EVENT: 'default',
  };

  const audienceLabels: Record<string, string> = {
    ALL: 'Everyone',
    MEMBERS: 'Members Only',
    ADMINS: 'Admins Only',
  };

  const now = new Date();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Announcements</h1>
          <p className="text-muted-foreground">
            Manage announcements and notifications
          </p>
        </div>
        <Link href="/admin/announcements/new">
          <Button>
            <Plus className="mr-2 h-4 w-4" />
            New Announcement
          </Button>
        </Link>
      </div>

      {/* Stats */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Total</CardTitle>
            <Megaphone className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{announcements.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Active</CardTitle>
            <Badge variant="default">Live</Badge>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {announcements.filter(a => 
                a.publishAt && a.publishAt <= now && (!a.expiresAt || a.expiresAt > now)
              ).length}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Pinned</CardTitle>
            <Pin className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {announcements.filter(a => a.isPinned).length}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Announcements List */}
      <Card>
        <CardHeader>
          <CardTitle>All Announcements</CardTitle>
          <CardDescription>
            Manage announcements shown to members and visitors
          </CardDescription>
        </CardHeader>
        <CardContent>
          {announcements.length === 0 ? (
            <div className="text-center py-12">
              <Megaphone className="mx-auto h-12 w-12 text-muted-foreground" />
              <h3 className="mt-4 text-lg font-semibold">No announcements</h3>
              <p className="text-muted-foreground">
                Create your first announcement
              </p>
              <Link href="/admin/announcements/new">
                <Button className="mt-4">
                  <Plus className="mr-2 h-4 w-4" />
                  New Announcement
                </Button>
              </Link>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Title</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Audience</TableHead>
                  <TableHead>Published</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead>Author</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {announcements.map((announcement) => {
                  const isActive = announcement.publishAt && announcement.publishAt <= now && 
                    (!announcement.expiresAt || announcement.expiresAt > now);
                  const isExpired = announcement.expiresAt && announcement.expiresAt < now;
                  const isScheduled = announcement.publishAt && announcement.publishAt > now;

                  return (
                    <TableRow key={announcement.id}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          {announcement.isPinned && (
                            <Pin className="h-4 w-4 text-primary" />
                          )}
                          <div>
                            <p className="font-medium">{announcement.title}</p>
                            <p className="text-sm text-muted-foreground line-clamp-1">
                              {announcement.content.substring(0, 100)}...
                            </p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          {typeIcons[announcement.type]}
                          <Badge variant={typeColors[announcement.type]}>
                            {announcement.type}
                          </Badge>
                        </div>
                      </TableCell>
                      <TableCell>
                        {audienceLabels[announcement.audience]}
                      </TableCell>
                      <TableCell>
                        {isScheduled ? (
                          <Badge variant="outline">Scheduled</Badge>
                        ) : isActive ? (
                          <Badge variant="default">Active</Badge>
                        ) : isExpired ? (
                          <Badge variant="secondary">Expired</Badge>
                        ) : null}
                        <p className="text-xs text-muted-foreground mt-1">
                          {announcement.publishAt ? formatDate(announcement.publishAt) : 'Not scheduled'}
                        </p>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {announcement.expiresAt
                          ? formatDate(announcement.expiresAt)
                          : 'Never'}
                      </TableCell>
                      <TableCell>{announcement.author?.name || 'Unknown'}</TableCell>
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
                              <Link href={`/admin/announcements/${announcement.id}`}>
                                <Edit className="mr-2 h-4 w-4" />
                                Edit
                              </Link>
                            </DropdownMenuItem>
                            {announcement.status === 'DRAFT' && (
                              <DropdownMenuItem asChild>
                                <form action={async () => {
                                  'use server';
                                  const { publishAnnouncement } = await import('./actions');
                                  await publishAnnouncement(announcement.id);
                                }}>
                                  <button type="submit" className="flex w-full items-center">
                                    <Send className="mr-2 h-4 w-4" />
                                    Publish Now
                                  </button>
                                </form>
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuItem asChild>
                              <form action={async () => {
                                'use server';
                                const { toggleAnnouncementPin } = await import('./actions');
                                await toggleAnnouncementPin(announcement.id);
                              }}>
                                <button type="submit" className="flex w-full items-center">
                                  <Pin className="mr-2 h-4 w-4" />
                                  {announcement.isPinned ? 'Unpin' : 'Pin'}
                                </button>
                              </form>
                            </DropdownMenuItem>
                            {announcement.status !== 'ARCHIVED' && (
                              <DropdownMenuItem asChild>
                                <form action={async () => {
                                  'use server';
                                  const { archiveAnnouncement } = await import('./actions');
                                  await archiveAnnouncement(announcement.id);
                                }}>
                                  <button type="submit" className="flex w-full items-center">
                                    <Archive className="mr-2 h-4 w-4" />
                                    Archive
                                  </button>
                                </form>
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuSeparator />
                            <DropdownMenuItem asChild className="text-destructive focus:text-destructive">
                              <DeleteAnnouncementButton id={announcement.id} title={announcement.title} />
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
