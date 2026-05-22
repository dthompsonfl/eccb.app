import { notFound } from 'next/navigation';
import Link from 'next/link';
import { prisma } from '@/lib/db';
import { requirePermission } from '@/lib/auth/guards';
import { formatDate, formatRelativeTime } from '@/lib/date';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  ArrowLeft,
  Edit,
  Mail,
  Phone,
  Music,
  Calendar,
  AlertTriangle,
} from 'lucide-react';

import { MEMBER_VIEW_ALL } from '@/lib/auth/permission-constants';
interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function MemberDetailPage({ params }: PageProps) {
  await requirePermission(MEMBER_VIEW_ALL);
  const { id } = await params;

  const member = await prisma.member.findUnique({
    where: { id },
    include: {
      user: {
        include: {
          roles: {
            include: { role: true },
          },
        },
      },
      instruments: {
        include: { instrument: true },
      },
      sections: {
        include: { section: true },
      },
      musicAssignments: {
        include: {
          piece: {
            include: {
              composer: true,
            },
          },
        },
        take: 10,
        orderBy: { assignedAt: 'desc' },
      },
      attendance: {
        include: {
          event: true,
        },
        take: 10,
        orderBy: { event: { startTime: 'desc' } },
      },
    },
  });

  if (!member) {
    notFound();
  }

  const statusColors: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
    ACTIVE: 'default',
    INACTIVE: 'secondary',
    LEAVE: 'outline',
    PENDING: 'outline',
    ALUMNI: 'secondary',
  };

  const getInitials = (firstName: string, lastName: string) => {
    return `${firstName[0] || ''}${lastName[0] || ''}`.toUpperCase() || '?';
  };

  const memberName = `${member.firstName} ${member.lastName}`;
  const memberEmail = member.email || member.user?.email || '';
  const primaryInstrument = member.instruments.find((mi) => mi.isPrimary);
  const secondaryInstruments = member.instruments.filter((mi) => !mi.isPrimary);
  const primarySection = member.sections[0];
  const primaryRole = member.user?.roles[0]?.role;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href="/admin/members">
            <Button variant="outline" size="icon">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <h1 className="text-3xl font-bold tracking-tight">{memberName}</h1>
            <p className="text-muted-foreground">{memberEmail}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Link href={`/admin/members/${id}/edit`}>
            <Button>
              <Edit className="mr-2 h-4 w-4" />
              Edit Member
            </Button>
          </Link>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-3">
        {/* Profile Card */}
        <Card>
          <CardContent className="pt-6">
            <div className="flex flex-col items-center text-center">
              <Avatar className="h-24 w-24">
                <AvatarImage src={member.profilePhoto || member.user?.image || undefined} />
                <AvatarFallback className="text-2xl">
                  {getInitials(member.firstName, member.lastName)}
                </AvatarFallback>
              </Avatar>
              <h2 className="mt-4 text-xl font-semibold">{memberName}</h2>
              <p className="text-muted-foreground">
                {primarySection?.section.name || 'No Section'}
              </p>
              <div className="mt-4 flex items-center gap-2">
                <Badge variant={statusColors[member.status]}>
                  {member.status}
                </Badge>
                {primaryRole && (
                  <Badge variant="outline">
                    {primaryRole.displayName || primaryRole.name}
                  </Badge>
                )}
              </div>
              <div className="mt-6 w-full space-y-2 text-sm">
                {member.phone && (
                  <div className="flex items-center gap-2">
                    <Phone className="h-4 w-4 text-muted-foreground" />
                    <span>{member.phone}</span>
                  </div>
                )}
                {memberEmail && (
                  <div className="flex items-center gap-2">
                    <Mail className="h-4 w-4 text-muted-foreground" />
                    <span>{memberEmail}</span>
                  </div>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Details */}
        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle>Member Details</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="text-sm text-muted-foreground">Primary Instrument</p>
              <p className="font-medium">
                {primaryInstrument?.instrument.name || 'Not set'}
              </p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Section</p>
              <p className="font-medium">{primarySection?.section.name || 'Not assigned'}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Join Date</p>
              <p className="font-medium">
                {member.joinDate ? formatDate(member.joinDate) : 'Not set'}
              </p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Member Since</p>
              <p className="font-medium">
                {formatRelativeTime(member.createdAt)}
              </p>
            </div>
            {secondaryInstruments.length > 0 && (
              <div className="sm:col-span-2">
                <p className="text-sm text-muted-foreground">Other Instruments</p>
                <div className="mt-1 flex flex-wrap gap-2">
                  {secondaryInstruments.map((mi) => (
                    <Badge key={mi.id} variant="outline">
                      {mi.instrument.name}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
            {member.emergencyName && (
              <div className="sm:col-span-2">
                <div className="flex items-center gap-2 text-sm text-muted-foreground mb-2">
                  <AlertTriangle className="h-4 w-4" />
                  Emergency Contact
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <div>
                    <p className="text-sm text-muted-foreground">Name</p>
                    <p className="font-medium">{member.emergencyName}</p>
                  </div>
                  {member.emergencyPhone && (
                    <div>
                      <p className="text-sm text-muted-foreground">Phone</p>
                      <p className="font-medium">{member.emergencyPhone}</p>
                    </div>
                  )}
                  {member.emergencyEmail && (
                    <div>
                      <p className="text-sm text-muted-foreground">Email</p>
                      <p className="font-medium">{member.emergencyEmail}</p>
                    </div>
                  )}
                </div>
              </div>
            )}
            {member.notes && (
              <div className="sm:col-span-2">
                <p className="text-sm text-muted-foreground">Notes</p>
                <p className="mt-1">{member.notes}</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="music" className="space-y-4">
        <TabsList>
          <TabsTrigger value="music">
            <Music className="mr-2 h-4 w-4" />
            Assigned Music ({member.musicAssignments.length})
          </TabsTrigger>
          <TabsTrigger value="attendance">
            <Calendar className="mr-2 h-4 w-4" />
            Attendance ({member.attendance.length})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="music">
          <Card>
            <CardHeader>
              <CardTitle>Assigned Music</CardTitle>
              <CardDescription>
                Music pieces assigned to this member
              </CardDescription>
            </CardHeader>
            <CardContent>
              {member.musicAssignments.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">
                  No music assigned to this member.
                </p>
              ) : (
                <div className="space-y-4">
                  {member.musicAssignments.map((assignment) => (
                    <div
                      key={assignment.id}
                      className="flex items-center justify-between border-b pb-4 last:border-0"
                    >
                      <div>
                        <Link
                          href={`/admin/music/${assignment.piece.id}`}
                          className="font-medium hover:underline"
                        >
                          {assignment.piece.title}
                        </Link>
                        {assignment.piece.composer && (
                          <p className="text-sm text-muted-foreground">
                            {assignment.piece.composer.firstName}{' '}
                            {assignment.piece.composer.lastName}
                          </p>
                        )}
                        {assignment.partName && (
                          <Badge variant="outline" className="mt-1">
                            {assignment.partName}
                          </Badge>
                        )}
                      </div>
                      <div className="text-sm text-muted-foreground">
                        {formatDate(assignment.assignedAt)}
                      </div>
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
              <CardTitle>Attendance History</CardTitle>
              <CardDescription>
                Recent attendance records for rehearsals and events
              </CardDescription>
            </CardHeader>
            <CardContent>
              {member.attendance.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">
                  No attendance records found.
                </p>
              ) : (
                <div className="space-y-4">
                  {member.attendance.map((record) => (
                    <div
                      key={record.id}
                      className="flex items-center justify-between border-b pb-4 last:border-0"
                    >
                      <div>
                        <Link
                          href={`/admin/events/${record.event.id}`}
                          className="font-medium hover:underline"
                        >
                          {record.event.title}
                        </Link>
                        <p className="text-sm text-muted-foreground">
                          {formatDate(record.event.startTime)}
                        </p>
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
