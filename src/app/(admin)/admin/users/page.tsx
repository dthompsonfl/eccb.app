import Link from 'next/link';
import { prisma } from '@/lib/db';
import { requirePermission } from '@/lib/auth/guards';
import { USER_MANAGE } from '@/lib/auth/permission-constants';
import { formatDate } from '@/lib/date';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Users,
  UserPlus,
  Search,
  MoreHorizontal,
  Eye,
  Edit,
  Mail,
  Shield,
  ShieldOff,
  Key,
  Trash2,
  UserCheck,
  UserX,
  AlertCircle,
} from 'lucide-react';
import { getUsers, getUserStats } from './actions';

interface SearchParams {
  search?: string;
  status?: string;
  role?: string;
  page?: string;
}

interface FilterParams {
  search?: string;
  status?: string;
  role?: string;
  page?: number;
}

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await requirePermission(USER_MANAGE);
  const params = await searchParams;

  const search = params.search || '';
  const status = (params.status as 'active' | 'banned' | 'unverified') || '';
  const roleFilter = params.role || '';
  const page = parseInt(params.page || '1');
  const limit = 20;

  const [{ users, total, totalPages }, stats, roles] = await Promise.all([
    getUsers(
      {
        search,
        status: status || undefined,
        hasRole: roleFilter || undefined,
      },
      page,
      limit
    ),
    getUserStats(),
    prisma.role.findMany({
      select: { id: true, name: true, displayName: true },
      orderBy: { name: 'asc' },
    }),
  ]);

  const _statusColors: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
    active: 'default',
    banned: 'destructive',
    unverified: 'outline',
  };

  // Helper to build filter URL
  const buildFilterUrl = (overrides: FilterParams = {}) => {
    const newParams = new URLSearchParams();
    const newSearch = overrides.search !== undefined ? overrides.search : search;
    const newStatus = overrides.status !== undefined ? overrides.status : status;
    const newRole = overrides.role !== undefined ? overrides.role : roleFilter;
    const newPage = overrides.page !== undefined ? overrides.page : 1;

    if (newSearch) newParams.set('search', newSearch);
    if (newStatus) newParams.set('status', newStatus);
    if (newRole) newParams.set('role', newRole);
    if (newPage > 1) newParams.set('page', newPage.toString());

    const queryString = newParams.toString();
    return `/admin/users${queryString ? `?${queryString}` : ''}`;
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">User Management</h1>
          <p className="text-muted-foreground">
            Manage user accounts, sessions, and access control
          </p>
        </div>
        <Link href="/admin/users/new">
          <Button>
            <UserPlus className="mr-2 h-4 w-4" />
            Create User
          </Button>
        </Link>
      </div>

      {/* Stats */}
      <div className="grid gap-4 md:grid-cols-6">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Total Users</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.total}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Active</CardTitle>
            <UserCheck className="h-4 w-4 text-green-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">{stats.active}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Banned</CardTitle>
            <UserX className="h-4 w-4 text-red-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-red-600">{stats.banned}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Unverified</CardTitle>
            <AlertCircle className="h-4 w-4 text-amber-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-amber-600">{stats.unverified}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">With Member</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.withMember}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">No Member</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.withoutMember}</div>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <Card>
        <CardHeader>
          <CardTitle>User Accounts</CardTitle>
          <CardDescription>Search and manage user accounts</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col sm:flex-row gap-4 mb-6">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                name="search"
                placeholder="Search by name or email..."
                defaultValue={search}
                className="pl-9"
              />
            </div>
            <Select name="status" defaultValue={status}>
              <SelectTrigger className="w-[150px]">
                <SelectValue placeholder="All Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Status</SelectItem>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="banned">Banned</SelectItem>
                <SelectItem value="unverified">Unverified</SelectItem>
              </SelectContent>
            </Select>
            <Select name="role" defaultValue={roleFilter}>
              <SelectTrigger id="role" name="role" className="w-[150px]">
                <SelectValue placeholder="All Roles" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Roles</SelectItem>
                {roles.map((role) => (
                  <SelectItem key={role.id} value={role.id}>
                    {role.displayName || role.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button type="submit">Filter</Button>
          </form>

          {users.length === 0 ? (
            <div className="text-center py-12">
              <Users className="mx-auto h-12 w-12 text-muted-foreground" />
              <h3 className="mt-4 text-lg font-semibold">No users found</h3>
              <p className="text-muted-foreground">
                {search || status || roleFilter
                  ? 'Try adjusting your search or filters'
                  : 'Create your first user to get started'}
              </p>
            </div>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>User</TableHead>
                    <TableHead>Member Profile</TableHead>
                    <TableHead>Roles</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>2FA</TableHead>
                    <TableHead>Sessions</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {users.map((user) => {
                    const displayName = user.member
                      ? `${user.member.firstName} ${user.member.lastName}`
                      : user.name || user.email;

                    return (
                      <TableRow key={user.id}>
                        <TableCell>
                          <div>
                            <p className="font-medium">{displayName}</p>
                            <p className="text-sm text-muted-foreground">{user.email}</p>
                          </div>
                        </TableCell>
                        <TableCell>
                          {user.member ? (
                            <Link
                              href={`/admin/members/${user.member.id}`}
                              className="text-primary hover:underline"
                            >
                              {user.member.firstName} {user.member.lastName}
                            </Link>
                          ) : (
                            <span className="text-sm text-muted-foreground">No profile</span>
                          )}
                        </TableCell>
                        <TableCell>
                          {user.roles.length > 0 ? (
                            <div className="flex flex-wrap gap-1">
                              {user.roles.slice(0, 2).map((userRole) => (
                                <Badge key={userRole.id} variant="secondary" className="text-xs">
                                  {userRole.role.displayName || userRole.role.name}
                                </Badge>
                              ))}
                              {user.roles.length > 2 && (
                                <Badge variant="outline" className="text-xs">
                                  +{user.roles.length - 2}
                                </Badge>
                              )}
                            </div>
                          ) : (
                            <span className="text-sm text-muted-foreground">No roles</span>
                          )}
                        </TableCell>
                        <TableCell>
                          {user.banned ? (
                            <Badge variant="destructive">Banned</Badge>
                          ) : !user.emailVerified ? (
                            <Badge variant="outline">Unverified</Badge>
                          ) : (
                            <Badge variant="default">Active</Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          {user.twoFactorEnabled ? (
                            <Badge variant="default" className="text-xs">
                              Enabled
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="text-xs">
                              Disabled
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          <span className="text-sm">{user._count.sessions}</span>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {formatDate(user.createdAt)}
                        </TableCell>
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
                                <Link href={`/admin/users/${user.id}`}>
                                  <Eye className="mr-2 h-4 w-4" />
                                  View Details
                                </Link>
                              </DropdownMenuItem>
                              <DropdownMenuItem asChild>
                                <Link href={`/admin/users/${user.id}/edit`}>
                                  <Edit className="mr-2 h-4 w-4" />
                                  Edit User
                                </Link>
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem asChild>
                                <Link href={`/admin/roles?search=${user.email}`}>
                                  <Shield className="mr-2 h-4 w-4" />
                                  Manage Roles
                                </Link>
                              </DropdownMenuItem>
                              <DropdownMenuItem asChild>
                                <Link href={`/admin/roles/permissions?userId=${user.id}`}>
                                  <Key className="mr-2 h-4 w-4" />
                                  Custom Permissions
                                </Link>
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem>
                                <Mail className="mr-2 h-4 w-4" />
                                Send Password Reset
                              </DropdownMenuItem>
                              {user.banned ? (
                                <DropdownMenuItem>
                                  <ShieldOff className="mr-2 h-4 w-4" />
                                  Unban User
                                </DropdownMenuItem>
                              ) : (
                                <DropdownMenuItem className="text-destructive">
                                  <ShieldOff className="mr-2 h-4 w-4" />
                                  Ban User
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuSeparator />
                              <DropdownMenuItem className="text-destructive">
                                <Trash2 className="mr-2 h-4 w-4" />
                                Delete User
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="flex items-center justify-between mt-4">
                  <p className="text-sm text-muted-foreground">
                    Showing {(page - 1) * limit + 1} to {Math.min(page * limit, total)} of {total}{' '}
                    users
                  </p>
                  <div className="flex items-center gap-2">
                    <Link href={buildFilterUrl({ page: page - 1 })}>
                      <Button variant="outline" size="sm" disabled={page <= 1}>
                        Previous
                      </Button>
                    </Link>
                    <span className="text-sm">
                      Page {page} of {totalPages}
                    </span>
                    <Link href={buildFilterUrl({ page: page + 1 })}>
                      <Button variant="outline" size="sm" disabled={page >= totalPages}>
                        Next
                      </Button>
                    </Link>
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
