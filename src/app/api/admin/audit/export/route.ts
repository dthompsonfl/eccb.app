import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/auth/guards';
import { AUDIT_VIEW } from '@/lib/auth/permission-constants';
import {
  exportAuditLogsCsv,
  exportAuditLogsJson,
} from '@/app/(admin)/admin/audit/actions';

export async function GET(request: NextRequest) {
  try {
    await requirePermission(AUDIT_VIEW);

    const searchParams = request.nextUrl.searchParams;
    const format = searchParams.get('format') || 'csv';
    const userName = searchParams.get('userName') || undefined;
    const action = searchParams.get('action') || undefined;
    const entityType = searchParams.get('entityType') || undefined;
    const userId = searchParams.get('userId') || undefined;
    const dateFrom = searchParams.get('dateFrom') || undefined;
    const dateTo = searchParams.get('dateTo') || undefined;

    const filters = {
      userName,
      action,
      entityType,
      userId,
      dateFrom,
      dateTo,
    };

    if (format === 'json') {
      const json = await exportAuditLogsJson(filters);
      return new NextResponse(json, {
        headers: {
          'Content-Type': 'application/json',
          'Content-Disposition': `attachment; filename="audit-logs-${new Date().toISOString().split('T')[0]}.json"`,
        },
      });
    } else {
      const csv = await exportAuditLogsCsv(filters);
      return new NextResponse(csv, {
        headers: {
          'Content-Type': 'text/csv',
          'Content-Disposition': `attachment; filename="audit-logs-${new Date().toISOString().split('T')[0]}.csv"`,
        },
      });
    }
  } catch (error) {
    console.error('Failed to export audit logs:', error);
    return NextResponse.json(
      { error: 'Failed to export audit logs' },
      { status: 500 }
    );
  }
}
