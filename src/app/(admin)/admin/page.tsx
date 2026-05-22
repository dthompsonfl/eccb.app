import { Metadata } from 'next';
import Link from 'next/link';
import { prisma } from '@/lib/db';
import { 
  Users, 
  Music, 
  Calendar, 
  ShieldCheck,
  ChevronRight,
  Clock,
  Activity,
  UserPlus,
  MessageSquare,
  ImageIcon,
  Handshake
} from 'lucide-react';
import { formatDate, formatRelativeTime } from '@/lib/date';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

export const metadata: Metadata = {
  title: 'Admin Dashboard',
};

async function getDashboardStats() {
  const [
    memberCount,
    musicCount,
    eventCount,
    upcomingEvents,
    recentAuditLogs,
    newContactSubmissions,
    publicGalleryImages,
    activeSponsors,
  ] = await Promise.all([
    prisma.member.count({ where: { deletedAt: null } }),
    prisma.musicPiece.count({ where: { deletedAt: null } }),
    prisma.event.count({ where: { deletedAt: null } }),
    prisma.event.findMany({
      where: {
        startTime: { gte: new Date() },
        deletedAt: null,
      },
      orderBy: { startTime: 'asc' },
      take: 4,
    }),
    prisma.auditLog.findMany({
      orderBy: { timestamp: 'desc' },
      take: 6,
      include: { user: true },
    }),
    prisma.contactSubmission.count({ where: { status: 'NEW' } }),
    prisma.galleryImage.count({ where: { isPublished: true } }),
    prisma.sponsor.count({ where: { isActive: true } }),
  ]);

  return {
    memberCount,
    musicCount,
    eventCount,
    upcomingEvents,
    recentAuditLogs,
    newContactSubmissions,
    publicGalleryImages,
    activeSponsors,
  };
}

export default async function AdminDashboardPage() {
  const stats = await getDashboardStats();

  return (
    <div className="space-y-10">
      {/* Header */}
      <div className="flex flex-col justify-between gap-4 md:flex-row md:items-end">
        <div>
          <h1 className="font-display text-4xl font-black text-foreground uppercase tracking-tight">
            System Overview
          </h1>
          <p className="text-muted-foreground italic">
            Band management and system administration
          </p>
        </div>
        <div className="flex gap-3">
          <Button asChild size="sm" variant="outline" className="h-10">
            <Link href="/admin/settings">System Settings</Link>
          </Button>
          <Button asChild size="sm" className="h-10 bg-primary">
            <Link href="/admin/members/new">
              <UserPlus className="mr-2 h-4 w-4" /> Add Member
            </Link>
          </Button>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-7">
        <div className="rounded-2xl border bg-card p-6 shadow-sm">
          <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Users size={20} />
          </div>
          <p className="text-sm font-medium text-muted-foreground">Total Members</p>
          <h4 className="text-2xl font-bold">{stats.memberCount}</h4>
        </div>
        
        <div className="rounded-2xl border bg-card p-6 shadow-sm">
          <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-blue-500/10 text-blue-600">
            <Music size={20} />
          </div>
          <p className="text-sm font-medium text-muted-foreground">Library Pieces</p>
          <h4 className="text-2xl font-bold">{stats.musicCount}</h4>
        </div>

        <div className="rounded-2xl border bg-card p-6 shadow-sm">
          <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-accent/10 text-accent">
            <Calendar size={20} />
          </div>
          <p className="text-sm font-medium text-muted-foreground">Total Events</p>
          <h4 className="text-2xl font-bold">{stats.eventCount}</h4>
        </div>

        <div className="rounded-2xl border bg-card p-6 shadow-sm">
          <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-slate-500/10 text-slate-600">
            <ShieldCheck size={20} />
          </div>
          <p className="text-sm font-medium text-muted-foreground">Audit Logs</p>
          <h4 className="text-2xl font-bold">Live</h4>
        </div>

        <div className="rounded-2xl border bg-card p-6 shadow-sm">
          <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-orange-500/10 text-orange-600">
            <MessageSquare size={20} />
          </div>
          <p className="text-sm font-medium text-muted-foreground">New Messages</p>
          <h4 className="text-2xl font-bold">{stats.newContactSubmissions}</h4>
        </div>

        <div className="rounded-2xl border bg-card p-6 shadow-sm">
          <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600">
            <ImageIcon size={20} />
          </div>
          <p className="text-sm font-medium text-muted-foreground">Gallery Images</p>
          <h4 className="text-2xl font-bold">{stats.publicGalleryImages}</h4>
        </div>

        <div className="rounded-2xl border bg-card p-6 shadow-sm">
          <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-violet-500/10 text-violet-600">
            <Handshake size={20} />
          </div>
          <p className="text-sm font-medium text-muted-foreground">Sponsors</p>
          <h4 className="text-2xl font-bold">{stats.activeSponsors}</h4>
        </div>
      </div>

      <div className="grid gap-10 lg:grid-cols-2">
        {/* Upcoming Events */}
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <h3 className="font-display text-xl font-bold uppercase tracking-wider">
              Upcoming Events
            </h3>
            <Link 
              href="/admin/events" 
              className="text-sm font-medium text-primary hover:underline flex items-center"
            >
              Manage All <ChevronRight size={14} />
            </Link>
          </div>
          
          <div className="space-y-4">
            {stats.upcomingEvents.length > 0 ? (
              stats.upcomingEvents.map((event: any) => (
                <div 
                  key={event.id}
                  className="flex items-center justify-between rounded-xl border bg-card p-4 transition-all hover:shadow-md"
                >
                  <div className="flex items-center gap-4">
                    <div className="flex h-12 w-12 flex-col items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <span className="text-[10px] font-bold uppercase">{formatDate(event.startTime, 'MMM')}</span>
                      <span className="text-lg font-black">{formatDate(event.startTime, 'd')}</span>
                    </div>
                    <div>
                      <h5 className="font-bold text-foreground">{event.title}</h5>
                      <p className="text-xs text-muted-foreground">
                        {event.type} • {formatDate(event.startTime, 'h:mm a')}
                      </p>
                    </div>
                  </div>
                  <Badge variant={event.isPublished ? "default" : "secondary"}>
                    {event.isPublished ? "Public" : "Draft"}
                  </Badge>
                </div>
              ))
            ) : (
              <p className="py-10 text-center text-sm text-muted-foreground italic border-2 border-dashed rounded-2xl">
                No upcoming events found.
              </p>
            )}
          </div>
        </div>

        {/* Audit Logs */}
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <h3 className="font-display text-xl font-bold uppercase tracking-wider">
              System Activity
            </h3>
            <Link 
              href="/admin/audit" 
              className="text-sm font-medium text-primary hover:underline flex items-center"
            >
              Full Audit Trail <ChevronRight size={14} />
            </Link>
          </div>
          
          <div className="space-y-4">
            {stats.recentAuditLogs.map((log: any) => (
              <div 
                key={log.id}
                className="flex items-start gap-4 rounded-xl border bg-card p-4 text-sm"
              >
                <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted">
                  <Activity size={14} className="text-muted-foreground" />
                </div>
                <div className="space-y-1">
                  <p className="text-foreground">
                    <span className="font-bold">{log.user?.name || 'System'}</span>
                    {' '}{log.action}{' '}
                    <span className="font-medium text-primary">{log.entityType}</span>
                  </p>
                  <p className="flex items-center gap-2 text-xs text-muted-foreground uppercase tracking-wider">
                    <Clock size={10} /> {formatRelativeTime(log.timestamp)}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

