import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requirePermission } from '@/lib/auth/guards';
import { USER_MANAGE } from '@/lib/auth/permission-constants';
import { formatDate, formatDateTime } from '@/lib/date';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  ArrowLeft,
  Edit,
  Shield,
  ShieldOff,
  Key,
  UserCheck,
  UserX,
  AlertCircle,
  Monitor,
  Clock,
  MapPin,
  LogOut,
  Users,
} from 'lucide-react';
import { getUserDetails, revokeAllSessions, revokeSession } from '../actions';
import { UserActions } from './user-actions';

export default async function UserDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePermission(USER_MANAGE);
  const { id } = await params;

  const user = await getUserDetails(id);

  if (!user) {
    notFound();
  }

  const displayName = user.member
    ? `${user.member.firstName} ${user.member.lastName}`
    : user.name || user.email;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href="/admin/users">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <h1 className="text-3xl font-bold tracking-tight">{displayName}</h1>
            <p className="text-muted-foreground">{user.email}</p>
          </div>
        </div>
        <div className="flex gap-2">
          <Link href={`/admin/users/${user.id}/edit`}>
            <Button variant="outline">
              <Edit className="mr-2 h-4 w-4" />
              Edit
            </Button>
          </Link>
          <UserActions user={user} />
        </div>
      </div>

      {/* Status Banner */}
      {user.banned && (
        <Card className="border-destructive bg-destructive/10">
          <CardContent className="flex items-center gap-4 pt-6">
            <ShieldOff className="h-6 w-6 text-destructive" />
            <div>
              <p className="font-semibold text-destructive">This user has been banned</p>
              {user.banReason && (
                <p className="text-sm text-muted-foreground">Reason: {user.banReason}</p>
              )}
              {user.banExpires && (
                <p className="text-sm text-muted-foreground">
                  Expires: {formatDateTime(user.banExpires)}
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {!user.emailVerified && (
        <Card className="border-amber-500 bg-amber-50 dark:bg-amber-950/30">
          <CardContent className="flex items-center gap-4 pt-6">
            <AlertCircle className="h-6 w-6 text-amber-500" />
            <div>
              <p className="font-semibold text-amber-600 dark:text-amber-500">
                Email not verified
              </p>
              <p className="text-sm text-muted-foreground">
                This user has not verified their email address
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 md:grid-cols-2">
        {/* Account Info */}
        <Card>
          <CardHeader>
            <CardTitle>Account Information</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex justify-between">
              <span className="text-muted-foreground">User ID</span>
              <code className="text-sm bg-muted px-2 py-1 rounded">{user.id}</code>
            </div>
            <Separator />
            <div className="flex justify-between">
              <span className="text-muted-foreground">Email</span>
              <span>{user.email}</span>
            </div>
            <Separator />
            <div className="flex justify-between">
              <span className="text-muted-foreground">Email Verified</span>
              {user.emailVerified ? (
                <Badge variant="default">
                  <UserCheck className="mr-1 h-3 w-3" />
                  Verified
                </Badge>
              ) : (
                <Badge variant="outline">
                  <UserX className="mr-1 h-3 w-3" />
                  Unverified
                </Badge>
              )}
            </div>
            <Separator />
            <div className="flex justify-between">
              <span className="text-muted-foreground">Two-Factor Auth</span>
              {user.twoFactorEnabled ? (
                <Badge variant="default">Enabled</Badge>
              ) : (
                <Badge variant="outline">Disabled</Badge>
              )}
            </div>
            <Separator />
            <div className="flex justify-between">
              <span className="text-muted-foreground">Created</span>
              <span>{formatDateTime(user.createdAt)}</span>
            </div>
            <Separator />
            <div className="flex justify-between">
              <span className="text-muted-foreground">Last Updated</span>
              <span>{formatDateTime(user.updatedAt)}</span>
            </div>
          </CardContent>
        </Card>

        {/* Member Profile */}
        <Card>
          <CardHeader>
            <CardTitle>Member Profile</CardTitle>
            <CardDescription>
              Band membership information linked to this account
            </CardDescription>
          </CardHeader>
          <CardContent>
            {user.member ? (
              <div className="space-y-4">
                <div className="flex justify-between items-center">
                  <div>
                    <p className="font-medium">
                      {user.member.firstName} {user.member.lastName}
                    </p>
                    <p className="text-sm text-muted-foreground">Member Profile</p>
                  </div>
                  <Link href={`/admin/members/${user.member.id}`}>
                    <Button variant="outline" size="sm">
                      View Profile
                    </Button>
                  </Link>
                </div>
              </div>
            ) : (
              <div className="text-center py-6">
                <Users className="mx-auto h-12 w-12 text-muted-foreground" />
                <p className="mt-2 text-muted-foreground">No member profile linked</p>
                <Link href={`/admin/members/new?userId=${user.id}`}>
                  <Button variant="outline" size="sm" className="mt-4">
                    Create Member Profile
                  </Button>
                </Link>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Roles */}
        <Card>
          <CardHeader>
            <CardTitle>Roles & Permissions</CardTitle>
            <CardDescription>Assigned roles and their permissions</CardDescription>
          </CardHeader>
          <CardContent>
            {user.roles.length > 0 ? (
              <div className="space-y-3">
                {user.roles.map((userRole) => (
                  <div
                    key={userRole.id}
                    className="flex items-center justify-between p-3 bg-muted rounded-lg"
                  >
                    <div>
                      <p className="font-medium">
                        {userRole.role.displayName || userRole.role.name}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        Assigned {formatDate(userRole.assignedAt)}
                      </p>
                    </div>
                    <Badge variant="secondary">{userRole.role.type}</Badge>
                  </div>
                ))}
                <Link href={`/admin/roles?search=${user.email}`}>
                  <Button variant="outline" size="sm" className="w-full mt-2">
                    <Shield className="mr-2 h-4 w-4" />
                    Manage Roles
                  </Button>
                </Link>
              </div>
            ) : (
              <div className="text-center py-6">
                <Shield className="mx-auto h-12 w-12 text-muted-foreground" />
                <p className="mt-2 text-muted-foreground">No roles assigned</p>
                <Link href={`/admin/roles?search=${user.email}`}>
                  <Button variant="outline" size="sm" className="mt-4">
                    Assign Roles
                  </Button>
                </Link>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Auth Providers */}
        <Card>
          <CardHeader>
            <CardTitle>Authentication Providers</CardTitle>
            <CardDescription>How this user can sign in</CardDescription>
          </CardHeader>
          <CardContent>
            {user.accounts.length > 0 ? (
              <div className="space-y-3">
                {user.accounts.map((account) => (
                  <div
                    key={account.id}
                    className="flex items-center justify-between p-3 bg-muted rounded-lg"
                  >
                    <div className="flex items-center gap-3">
                      <Key className="h-4 w-4" />
                      <div>
                        <p className="font-medium capitalize">{account.providerId}</p>
                        <p className="text-sm text-muted-foreground">
                          Added {formatDate(account.createdAt)}
                        </p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-6">
                <Key className="mx-auto h-12 w-12 text-muted-foreground" />
                <p className="mt-2 text-muted-foreground">Email/Password only</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      /*Sessions */
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Active Sessions</CardTitle>
              <CardDescription>Devices where this user is logged in</CardDescription>
            </div>
            {user._count.sessions > 0 && (
              <form action={async () => {
                'use server';
                await revokeAllSessions(user.id);
              }}>
                <Button variant="destructive" size="sm" type="submit">
                  <LogOut className="mr-2 h-4 w-4" />
                  Revoke All Sessions
                </Button>
              </form>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {user.sessions.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Device</TableHead>
                  <TableHead>IP Address</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {user.sessions.map((session) => (
                  <TableRow key={session.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Monitor className="h-4 w-4 text-muted-foreground" />
                        <span className="text-sm truncate max-w-[200px]">
                          {session.userAgent || 'Unknown device'}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <MapPin className="h-4 w-4 text-muted-foreground" />
                        <span className="text-sm">{session.ipAddress || 'Unknown'}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Clock className="h-4 w-4 text-muted-foreground" />
                        <span className="text-sm">{formatDateTime(session.createdAt)}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <span className="text-sm">{formatDateTime(session.expiresAt)}</span>
                    </TableCell>
                    <TableCell className="text-right">
                      <form action={async () => {
                        'use server';
                        await revokeSession(session.id);
                      }}>
                        <Button variant="ghost" size="sm" type="submit">
                          <LogOut className="h-4 w-4" />
                        </Button>
                      </form>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="text-center py-6">
              <Monitor className="mx-auto h-12 w-12 text-muted-foreground" />
              <p className="mt-2 text-muted-foreground">No active sessions</p>
            </div>
          )}
          {user._count.sessions > 5 && (
            <p className="text-sm text-muted-foreground text-center mt-4">
              Showing 5 of {user._count.sessions} total sessions
            </p>
          )}
        </CardContent>
      </Card>

      {/* Audit Log Summary */}
      <Card>
        <CardHeader>
          <CardTitle>Audit History</CardTitle>
          <CardDescription>Recent activity for this user</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-center py-6">
            <p className="text-muted-foreground">
              {user._count.auditLogs} audit log entries
            </p>
            <Link href={`/admin/audit?userId=${user.id}`}>
              <Button variant="outline" size="sm" className="mt-4">
                View Audit Logs
              </Button>
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
