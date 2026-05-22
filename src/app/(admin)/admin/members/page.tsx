import Link from 'next/link';
import { prisma } from '@/lib/db';
import { requirePermission, getMemberSectionFilter, getSession } from '@/lib/auth/guards';
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
  Music,
  Download,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Lock,
} from 'lucide-react';

import { MEMBER_VIEW_ALL } from '@/lib/auth/permission-constants';
interface SearchParams {
  search?: string;
  status?: string;
  section?: string;
  instrument?: string;
  role?: string;
  sort?: string;
  order?: string;
  page?: string | number;
}

type SortField = 'name' | 'joinDate' | 'status' | 'createdAt';
type SortOrder = 'asc' | 'desc';

export default async function AdminMembersPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await requirePermission(MEMBER_VIEW_ALL);
  const params = await searchParams;

  // Get the current session to check for section leader scoping
  const _session = await getSession();
  const sectionFilterId = await getMemberSectionFilter();
  const isSectionLeaderScoped = sectionFilterId !== null;

  const search = params.search || '';
  const status = params.status || '';
  // If user is a section leader, always filter to their section
  const sectionId = sectionFilterId || params.section || '';
  const instrumentId = params.instrument || '';
  const roleId = params.role || '';
  const sortField = (params.sort as SortField) || 'name';
  const sortOrder = (params.order as SortOrder) || 'asc';
  const page = typeof params.page === 'number' ? params.page : parseInt(params.page || '1');
  const limit = 20;

  // Build where clause
  const where: Record<string, unknown> = {};

  if (status) {
    where.status = status;
  }

  if (sectionId) {
    where.sections = {
      some: { sectionId },
    };
  }

  if (instrumentId) {
    where.instruments = {
      some: { instrumentId },
    };
  }

  if (roleId) {
    where.user = {
      roles: {
        some: { roleId },
      },
    };
  }

  if (search) {
    const searchConditions = [
      { firstName: { contains: search, mode: 'insensitive' } },
      { lastName: { contains: search, mode: 'insensitive' } },
      { email: { contains: search, mode: 'insensitive' } },
    ];
    
    // If there's already a user filter from role, merge with AND
    if (roleId) {
      where.user = {
        ...where.user as object,
        AND: [
          where.user as object,
          {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { email: { contains: search, mode: 'insensitive' } },
            ],
          },
        ],
      };
    } else {
      (where as Record<string, unknown>).OR = [
        ...searchConditions,
        { user: { name: { contains: search, mode: 'insensitive' } } },
        { user: { email: { contains: search, mode: 'insensitive' } } },
      ];
    }
  }

  // Build orderBy clause
  const orderBy: Record<string, unknown>[] = [];
  switch (sortField) {
    case 'name':
      orderBy.push({ lastName: sortOrder }, { firstName: sortOrder });
      break;
    case 'joinDate':
      orderBy.push({ joinDate: sortOrder });
      break;
    case 'status':
      orderBy.push({ status: sortOrder });
      break;
    case 'createdAt':
      orderBy.push({ createdAt: sortOrder });
      break;
    default:
      orderBy.push({ lastName: 'asc' });
  }

  const [members, total, sections, instruments, roles, stats] = await Promise.all([
    prisma.member.findMany({
      where,
      include: {
        user: {
          include: {
            roles: {
              include: { role: true },
            },
          },
        },
        instruments: {
          where: { isPrimary: true },
          include: { instrument: true },
        },
        sections: {
          include: { section: true },
        },
      },
      orderBy,
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.member.count({ where }),
    prisma.section.findMany({
      select: { id: true, name: true },
      orderBy: { sortOrder: 'asc' },
    }),
    prisma.instrument.findMany({
      select: { id: true, name: true, family: true },
      orderBy: [{ family: 'asc' }, { name: 'asc' }],
    }),
    prisma.role.findMany({
      select: { id: true, name: true, displayName: true },
      orderBy: { name: 'asc' },
    }),
    prisma.member.groupBy({
      by: ['status'],
      _count: true,
    }),
  ]);

  const totalPages = Math.ceil(total / limit);

  const statusCounts = stats.reduce(
    (acc, s) => {
      acc[s.status] = s._count;
      return acc;
    },
    {} as Record<string, number>
  );

  const statusColors: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
    ACTIVE: 'default',
    INACTIVE: 'secondary',
    LEAVE_OF_ABSENCE: 'outline',
    PENDING: 'outline',
    AUDITION: 'outline',
    ALUMNI: 'secondary',
  };

  // Helper to build filter URL
  const buildFilterUrl = (overrides: Partial<SearchParams> = {}) => {
    const params = new URLSearchParams();
    const newSearch = overrides.search !== undefined ? overrides.search : search;
    const newStatus = overrides.status !== undefined ? overrides.status : status;
    const newSection = overrides.section !== undefined ? overrides.section : sectionId;
    const newInstrument = overrides.instrument !== undefined ? overrides.instrument : instrumentId;
    const newRole = overrides.role !== undefined ? overrides.role : roleId;
    const newSort = overrides.sort !== undefined ? overrides.sort : sortField;
    const newOrder = overrides.order !== undefined ? overrides.order : sortOrder;
    const newPage = typeof overrides.page === 'number' ? overrides.page : (overrides.page ? parseInt(overrides.page) : 1);

    if (newSearch) params.set('search', newSearch);
    if (newStatus) params.set('status', newStatus);
    if (newSection) params.set('section', newSection);
    if (newInstrument) params.set('instrument', newInstrument);
    if (newRole) params.set('role', newRole);
    if (newSort !== 'name') params.set('sort', newSort);
    if (newOrder !== 'asc') params.set('order', newOrder);
    if (newPage > 1) params.set('page', newPage.toString());

    const queryString = params.toString();
    return `/admin/members${queryString ? `?${queryString}` : ''}`;
  };

  // Helper to build export API URL
  const buildExportUrl = () => {
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    if (status) params.set('status', status);
    if (sectionId) params.set('section', sectionId);
    if (instrumentId) params.set('instrument', instrumentId);
    if (roleId) params.set('role', roleId);

    const queryString = params.toString();
    return `/api/admin/members/export${queryString ? `?${queryString}` : ''}`;
  };

  // Helper to render sort icon
  const getSortIcon = (field: SortField) => {
    if (sortField !== field) return <ArrowUpDown className="ml-1 h-4 w-4" />;
    return sortOrder === 'asc' ? (
      <ArrowUp className="ml-1 h-4 w-4" />
    ) : (
      <ArrowDown className="ml-1 h-4 w-4" />
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Members</h1>
          <p className="text-muted-foreground">
            Manage band members, sections, and instruments
          </p>
        </div>
        <div className="flex gap-2">
          <a href={buildExportUrl()}>
            <Button variant="outline" type="button">
              <Download className="mr-2 h-4 w-4" />
              Export CSV
            </Button>
          </a>
          <Link href="/admin/members/new">
            <Button>
              <UserPlus className="mr-2 h-4 w-4" />
              Add Member
            </Button>
          </Link>
        </div>
      </div>

      {/* Stats */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Total Members</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {Object.values(statusCounts).reduce((a, b) => a + b, 0)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Active</CardTitle>
            <Badge variant="default">Active</Badge>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{statusCounts.ACTIVE || 0}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">On Leave</CardTitle>
            <Badge variant="outline">Leave</Badge>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{statusCounts.LEAVE_OF_ABSENCE || 0}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Pending</CardTitle>
            <Badge variant="secondary">Pending</Badge>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{statusCounts.PENDING || 0}</div>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Member Directory</CardTitle>
              <CardDescription>Search and filter band members</CardDescription>
            </div>
            {isSectionLeaderScoped && (
              <div className="flex items-center gap-2 text-sm text-amber-600 dark:text-amber-500 bg-amber-50 dark:bg-amber-950/30 px-3 py-1.5 rounded-md">
                <Lock className="h-4 w-4" />
                <span>Scoped to your section only</span>
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col sm:flex-row gap-4 mb-6">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                name="search"
                placeholder="Search by name, email, or instrument..."
                defaultValue={search}
                className="pl-9"
              />
            </div>
            <Select name="status" defaultValue={status}>
              <SelectTrigger id="status" name="status" className="w-[150px]">
                <SelectValue placeholder="All Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Status</SelectItem>
                <SelectItem value="ACTIVE">Active</SelectItem>
                <SelectItem value="INACTIVE">Inactive</SelectItem>
                <SelectItem value="LEAVE_OF_ABSENCE">On Leave</SelectItem>
                <SelectItem value="PENDING">Pending</SelectItem>
                <SelectItem value="AUDITION">Audition</SelectItem>
                <SelectItem value="ALUMNI">Alumni</SelectItem>
              </SelectContent>
            </Select>
            <Select name="section" defaultValue={sectionId} disabled={isSectionLeaderScoped}>
              <SelectTrigger id="section" name="section" className={`w-[180px] ${isSectionLeaderScoped ? 'opacity-60 cursor-not-allowed' : ''}`}>
                <SelectValue placeholder="All Sections" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Sections</SelectItem>
                {sections.map((section) => (
                  <SelectItem key={section.id} value={section.id}>
                    {section.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select name="instrument" defaultValue={instrumentId}>
              <SelectTrigger id="instrument" name="instrument" className="w-[180px]">
                <SelectValue placeholder="All Instruments" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Instruments</SelectItem>
                {instruments.map((instrument) => (
                  <SelectItem key={instrument.id} value={instrument.id}>
                    {instrument.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select name="role" defaultValue={roleId}>
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

          {members.length === 0 ? (
            <div className="text-center py-12">
              <Users className="mx-auto h-12 w-12 text-muted-foreground" />
              <h3 className="mt-4 text-lg font-semibold">No members found</h3>
              <p className="text-muted-foreground">
                {search || status || sectionId || instrumentId || roleId
                  ? 'Try adjusting your search or filters'
                  : 'Add your first member to get started'}
              </p>
            </div>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>
                      <Link href={buildFilterUrl({ sort: 'name', order: sortField === 'name' && sortOrder === 'asc' ? 'desc' : 'asc' })} className="flex items-center hover:text-foreground">
                        Name {getSortIcon('name')}
                      </Link>
                    </TableHead>
                    <TableHead>Section</TableHead>
                    <TableHead>Instrument</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>
                      <Link href={buildFilterUrl({ sort: 'status', order: sortField === 'status' && sortOrder === 'asc' ? 'desc' : 'asc' })} className="flex items-center hover:text-foreground">
                        Status {getSortIcon('status')}
                      </Link>
                    </TableHead>
                    <TableHead>
                      <Link href={buildFilterUrl({ sort: 'joinDate', order: sortField === 'joinDate' && sortOrder === 'asc' ? 'desc' : 'asc' })} className="flex items-center hover:text-foreground">
                        Joined {getSortIcon('joinDate')}
                      </Link>
                    </TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {members.map((member) => {
                    const memberName = `${member.firstName} ${member.lastName}`;
                    const memberEmail = member.email || member.user?.email || '';
                    const primarySection = member.sections[0]?.section;
                    const primaryInstrument = member.instruments[0]?.instrument;
                    const primaryRole = member.user?.roles[0]?.role;

                    return (
                      <TableRow key={member.id}>
                        <TableCell>
                          <div>
                            <p className="font-medium">{memberName}</p>
                            <p className="text-sm text-muted-foreground">
                              {memberEmail}
                            </p>
                          </div>
                        </TableCell>
                        <TableCell>{primarySection?.name || '—'}</TableCell>
                        <TableCell>
                          {primaryInstrument?.name || '—'}
                        </TableCell>
                        <TableCell>
                          {primaryRole ? (
                            <span className="text-sm">
                              {primaryRole.displayName || primaryRole.name}
                            </span>
                          ) : (
                            '—'
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge variant={statusColors[member.status] || 'secondary'}>
                            {member.status.replace('_', ' ')}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {member.joinDate ? formatDate(member.joinDate) : '—'}
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
                                <Link href={`/admin/members/${member.id}`}>
                                  <Eye className="mr-2 h-4 w-4" />
                                  View Details
                                </Link>
                              </DropdownMenuItem>
                              <DropdownMenuItem asChild>
                                <Link href={`/admin/members/${member.id}/edit`}>
                                  <Edit className="mr-2 h-4 w-4" />
                                  Edit Member
                                </Link>
                              </DropdownMenuItem>
                              <DropdownMenuItem asChild>
                                <Link href={`/admin/members/${member.id}/music`}>
                                  <Music className="mr-2 h-4 w-4" />
                                  Assigned Music
                                </Link>
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem>
                                <Mail className="mr-2 h-4 w-4" />
                                Send Email
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
                    Showing {(page - 1) * limit + 1} to{' '}
                    {Math.min(page * limit, total)} of {total} members
                  </p>
                  <div className="flex items-center gap-2">
                    <Link
                      href={buildFilterUrl({ page: page - 1 })}
                    >
                      <Button variant="outline" size="sm" disabled={page <= 1}>
                        Previous
                      </Button>
                    </Link>
                    <span className="text-sm">
                      Page {page} of {totalPages}
                    </span>
                    <Link
                      href={buildFilterUrl({ page: page + 1 })}
                    >
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={page >= totalPages}
                      >
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
