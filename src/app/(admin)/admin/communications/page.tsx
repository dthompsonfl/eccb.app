import { prisma } from '@/lib/db';
import { requirePermission } from '@/lib/auth/guards';
import Link from 'next/link';
import { formatDate } from '@/lib/date';
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Mail,
  Plus,
  MoreHorizontal,
  Send,
  Eye,
  Users,
  UserCheck,
  Music,
  Calendar,
} from 'lucide-react';

import { ANNOUNCEMENT_VIEW_ALL } from '@/lib/auth/permission-constants';
export default async function AdminCommunicationsPage() {
  await requirePermission(ANNOUNCEMENT_VIEW_ALL);

  // Get recent email logs
  const emailLogs = await prisma.emailLog.findMany({
    include: {
      sentBy: {
        select: { name: true, email: true },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });

  // Get email stats
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [totalSent, recentSent, successfulSent] = await Promise.all([
    prisma.emailLog.count(),
    prisma.emailLog.count({
      where: { createdAt: { gte: thirtyDaysAgo } },
    }),
    prisma.emailLog.count({
      where: { status: 'SENT' },
    }),
  ]);

  const statusColors: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
    SENT: 'default',
    PENDING: 'secondary',
    FAILED: 'destructive',
    BOUNCED: 'destructive',
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Communications</h1>
          <p className="text-muted-foreground">
            Manage email communications with members
          </p>
        </div>
        <Button asChild>
          <Link href="/admin/communications/compose">
            <Plus className="mr-2 h-4 w-4" />
            Compose Email
          </Link>
        </Button>
      </div>

      {/* Stats Cards */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Sent</CardTitle>
            <Mail className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totalSent}</div>
            <p className="text-xs text-muted-foreground">All time</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Last 30 Days</CardTitle>
            <Calendar className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{recentSent}</div>
            <p className="text-xs text-muted-foreground">Emails sent</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Success Rate</CardTitle>
            <UserCheck className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {totalSent > 0 ? Math.round((successfulSent / totalSent) * 100) : 0}%
            </div>
            <p className="text-xs text-muted-foreground">Delivery rate</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Quick Actions</CardTitle>
            <Send className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="space-y-2">
            <Button variant="outline" size="sm" className="w-full" asChild>
              <Link href="/admin/communications/compose?type=rehearsal">
                <Music className="mr-2 h-3 w-3" />
                Rehearsal Reminder
              </Link>
            </Button>
            <Button variant="outline" size="sm" className="w-full" asChild>
              <Link href="/admin/communications/compose?type=announcement">
                <Users className="mr-2 h-3 w-3" />
                Band Announcement
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* Email Log Table */}
      <Card>
        <CardHeader>
          <CardTitle>Email History</CardTitle>
          <CardDescription>
            Recent email communications sent to members
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Subject</TableHead>
                <TableHead>Recipients</TableHead>
                <TableHead>Sent By</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Date</TableHead>
                <TableHead className="w-[50px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {emailLogs.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-8">
                    <Mail className="mx-auto h-8 w-8 text-muted-foreground" />
                    <p className="mt-2 text-muted-foreground">No emails sent yet</p>
                  </TableCell>
                </TableRow>
              ) : (
                emailLogs.map((log) => (
                  <TableRow key={log.id}>
                    <TableCell className="font-medium max-w-[300px] truncate">
                      {log.subject}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{log.recipientCount} recipients</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {log.sentBy?.name || 'System'}
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusColors[log.status]}>
                        {log.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDate(log.createdAt)}
                    </TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem asChild>
                            <Link href={`/admin/communications/${log.id}`}>
                              <Eye className="mr-2 h-4 w-4" />
                              View Details
                            </Link>
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
