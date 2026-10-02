import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/guards';
import { hasGlobalMusicAccess } from '@/lib/music/access';
import {
  buildLicensingReport,
  licensingReportFilename,
  licensingReportToCsv,
} from '@/lib/music/licensing-report';
import { logger } from '@/lib/logger';

/** Parse an ISO date query param; returns null when absent or unparseable. */
function parseDate(value: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Licensing / copyright usage report.
 *
 * GET /api/admin/music/licensing-report?format=csv|json
 *
 * Library administrators only: this report names members and the copyrighted
 * works they were issued, which is exactly the data an unauthorised caller must
 * not be able to enumerate. Authorization uses the same global music-access
 * role check as the library itself.
 */
export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!(await hasGlobalMusicAccess(session.user.id))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const params = request.nextUrl.searchParams;
  const format = params.get('format') ?? 'json';
  if (format !== 'csv' && format !== 'json') {
    return NextResponse.json({ error: 'format must be csv or json' }, { status: 400 });
  }

  try {
    const report = await buildLicensingReport({
      since: parseDate(params.get('since')),
      until: parseDate(params.get('until')),
      memberId: params.get('memberId'),
      pieceId: params.get('pieceId'),
      includeReturned: params.get('includeReturned') !== 'false',
    });

    if (format === 'json') {
      return NextResponse.json(report);
    }

    return new NextResponse(licensingReportToCsv(report), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${licensingReportFilename()}"`,
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (error) {
    logger.error('Failed to build licensing report', { error });
    return NextResponse.json({ error: 'Failed to build report' }, { status: 500 });
  }
}
