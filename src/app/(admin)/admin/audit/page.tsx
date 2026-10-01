import Link from 'next/link';
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
  FileText,
  Search,
  Download,
  Activity,
  User,
  Calendar,
  Filter,
  Clock,
  Globe,
} from 'lucide-react';
import {
  getAuditLogs,
  getAuditLogStats,
  getUniqueActions,
  getUniqueEntityTypes,
} from './actions';
import { AuditLogDetailDialog } from './audit-log-detail-dialog';
import { requirePermission } from '@/lib/auth/guards';
import { AUDIT_VIEW } from '@/lib/auth/permission-constants';

interface SearchParams {
  search?: string;
  action?: string;
  entityType?: string;
  userId?: string;
  dateFrom?: string;
  dateTo?: string;
  page?: string | number;
}

export default async function AdminAuditPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  // Audit logs are the most sensitive admin surface. This page had no guard of
  // its own and relied solely on the layout shell gate; it now requires the
  // canonical audit permission.
  await requirePermission(AUDIT_VIEW);

  const params = await searchParams;

  const search = params.search || '';
  const actionFilter = params.action || '';
  const entityTypeFilter = params.entityType || '';
  const userIdFilter = params.userId || '';
  const dateFrom = params.dateFrom || '';
  const dateTo = params.dateTo || '';
  const page = typeof params.page === 'string' ? parseInt(params.page) : (params.page ?? 1);
  const limit = 50;

  const [{ logs, total, totalPages }, stats, uniqueActions, uniqueEntityTypes] = await Promise.all([
    getAuditLogs(
      {
        userName: search || undefined,
        action: actionFilter || undefined,
        entityType: entityTypeFilter || undefined,
        userId: userIdFilter || undefined,
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
      },
      page,
      limit
    ),
    getAuditLogStats(30),
    getUniqueActions(),
    getUniqueEntityTypes(),
  ]);

  // Helper to build filter URL
  const buildFilterUrl = (overrides: Partial<SearchParams> = {}) => {
    const newParams = new URLSearchParams();
    const newSearch = overrides.search !== undefined ? overrides.search : search;
    const newAction = overrides.action !== undefined ? overrides.action : actionFilter;
    const newEntityType = overrides.entityType !== undefined ? overrides.entityType : entityTypeFilter;
    const newUserId = overrides.userId !== undefined ? overrides.userId : userIdFilter;
    const newDateFrom = overrides.dateFrom !== undefined ? overrides.dateFrom : dateFrom;
    const newDateTo = overrides.dateTo !== undefined ? overrides.dateTo : dateTo;
    const newPage =
      typeof overrides.page === 'string' ? parseInt(overrides.page) : (overrides.page ?? 1);

    if (newSearch) newParams.set('search', newSearch);
    if (newAction) newParams.set('action', newAction);
    if (newEntityType) newParams.set('entityType', newEntityType);
    if (newUserId) newParams.set('userId', newUserId);
    if (newDateFrom) newParams.set('dateFrom', newDateFrom);
    if (newDateTo) newParams.set('dateTo', newDateTo);
    if (newPage > 1) newParams.set('page', newPage.toString());

    const queryString = newParams.toString();
    return `/admin/audit${queryString ? `?${queryString}` : ''}`;
  };

  // Get action badge color
  const getActionBadgeVariant = (action: string): 'default' | 'secondary' | 'destructive' | 'outline' => {
    if (action.includes('delete') || action.includes('ban')) return 'destructive';
    if (action.includes('create')) return 'default';
    if (action.includes('update')) return 'secondary';
    return 'outline';
  };

  // Format action for display
  const formatAction = (action: string): string => {
    return action
      .split('.')
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' → ');
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Audit Logs</h1>
          <p className="text-muted-foreground">
            View and search system activity logs
          </p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline">
              <Download className="mr-2 h-4 w-4" />
              Export
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>Export Format</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link
                href={`/api/admin/audit/export?format=csv${search ? `&userName=${encodeURIComponent(search)}` : ''}${actionFilter ? `&action=${encodeURIComponent(actionFilter)}` : ''}${entityTypeFilter ? `&entityType=${encodeURIComponent(entityTypeFilter)}` : ''}${userIdFilter ? `&userId=${encodeURIComponent(userIdFilter)}` : ''}${dateFrom ? `&dateFrom=${encodeURIComponent(dateFrom)}` : ''}${dateTo ? `&dateTo=${encodeURIComponent(dateTo)}` : ''}`}
                target="_blank"
              >
                <FileText className="mr-2 h-4 w-4" />
                Export as CSV
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link
                href={`/api/admin/audit/export?format=json${search ? `&userName=${encodeURIComponent(search)}` : ''}${actionFilter ? `&action=${encodeURIComponent(actionFilter)}` : ''}${entityTypeFilter ? `&entityType=${encodeURIComponent(entityTypeFilter)}` : ''}${userIdFilter ? `&userId=${encodeURIComponent(userIdFilter)}` : ''}${dateFrom ? `&dateFrom=${encodeURIComponent(dateFrom)}` : ''}${dateTo ? `&dateTo=${encodeURIComponent(dateTo)}` : ''}`}
                target="_blank"
              >
                <FileText className="mr-2 h-4 w-4" />
                Export as JSON
              </Link>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Stats */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Total (30 days)</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.total}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Top Action</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-lg font-bold truncate">
              {stats.byAction[0]?.action || 'N/A'}
            </div>
            <p className="text-xs text-muted-foreground">
              {stats.byAction[0]?.count || 0} occurrences
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Top Entity</CardTitle>
            <FileText className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-lg font-bold truncate">
              {stats.byEntityType[0]?.entityType || 'N/A'}
            </div>
            <p className="text-xs text-muted-foreground">
              {stats.byEntityType[0]?.count || 0} records
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Most Active User</CardTitle>
            <User className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-lg font-bold truncate">
              {stats.byUser[0]?.userName || 'N/A'}
            </div>
            <p className="text-xs text-muted-foreground">
              {stats.byUser[0]?.count || 0} actions
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <Card>
        <CardHeader>
          <CardTitle>Activity Log</CardTitle>
          <CardDescription>Search and filter audit log entries</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col sm:flex-row gap-4 mb-6">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                name="search"
                placeholder="Search by user name..."
                defaultValue={search}
                className="pl-9"
              />
            </div>
            <Select name="action" defaultValue={actionFilter}>
              <SelectTrigger id="action" name="action" className="w-[180px]">
                <SelectValue placeholder="All Actions" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Actions</SelectItem>
                {uniqueActions.map((action) => (
                  <SelectItem key={action} value={action}>
                    {formatAction(action)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select name="entityType" defaultValue={entityTypeFilter}>
              <SelectTrigger id="entityType" name="entityType" className="w-[150px]">
                <SelectValue placeholder="All Entities" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Entities</SelectItem>
                {uniqueEntityTypes.map((type) => (
                  <SelectItem key={type} value={type}>
                    {type}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button type="submit">
              <Filter className="mr-2 h-4 w-4" />
              Filter
            </Button>
          </form>

          {/* Date Range Filters */}
          <div className="flex flex-col sm:flex-row gap-4 mb-6">
            <div className="flex items-center gap-2">
              <Calendar className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">From:</span>
              <Input
                name="dateFrom"
                type="date"
                defaultValue={dateFrom}
                className="w-[180px]"
              />
            </div>
            <div className="flex items-center gap-2">
              <Calendar className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">To:</span>
              <Input
                name="dateTo"
                type="date"
                defaultValue={dateTo}
                className="w-[180px]"
              />
            </div>
          </div>

          {logs.length === 0 ? (
            <div className="text-center py-12">
              <Activity className="mx-auto h-12 w-12 text-muted-foreground" />
              <h3 className="mt-4 text-lg font-semibold">No audit logs found</h3>
              <p className="text-muted-foreground">
                {search || actionFilter || entityTypeFilter || dateFrom || dateTo
                  ? 'Try adjusting your search or filters'
                  : 'No activity has been logged yet'}
              </p>
            </div>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Timestamp</TableHead>
                    <TableHead>User</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead>Entity</TableHead>
                    <TableHead>IP Address</TableHead>
                    <TableHead className="text-right">Details</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {logs.map((log) => (
                    <TableRow key={log.id}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Clock className="h-4 w-4 text-muted-foreground" />
                          <div>
                            <p className="text-sm">{formatDate(log.timestamp)}</p>
                            <p className="text-xs text-muted-foreground">
                              {log.timestamp.toLocaleTimeString()}
                            </p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <User className="h-4 w-4 text-muted-foreground" />
                          <div>
                            <p className="text-sm font-medium">
                              {log.userName || 'System'}
                            </p>
                            {log.userId && (
                              <p className="text-xs text-muted-foreground">
                                ID: {log.userId.slice(0, 8)}...
                              </p>
                            )}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant={getActionBadgeVariant(log.action)}>
                          {formatAction(log.action)}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div>
                          <p className="text-sm font-medium">{log.entityType}</p>
                          {log.entityId && (
                            <p className="text-xs text-muted-foreground">
                              ID: {log.entityId.slice(0, 8)}...
                            </p>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Globe className="h-4 w-4 text-muted-foreground" />
                          <span className="text-sm">
                            {log.ipAddress || 'N/A'}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <AuditLogDetailDialog log={log} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="flex items-center justify-between mt-4">
                  <p className="text-sm text-muted-foreground">
                    Showing {(page - 1) * limit + 1} to {Math.min(page * limit, total)} of {total}{' '}
                    entries
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
