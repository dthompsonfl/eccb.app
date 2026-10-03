/**
 * GET /api/privacy/export — GDPR Art. 15 (access) + Art. 20 (portability).
 *
 * Self-service by default: `?subject` is only honoured when the caller holds
 * `privacy.export`, so a member cannot enumerate another member's id and pull
 * their record. Returns the JSON document as a download (the Art. 20 portable
 * format) or, with `?format=csv`, a spreadsheet-friendly flattening of the
 * tabular records.
 */

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth/config';
import { headers } from 'next/headers';
import { applyRateLimit } from '@/lib/rate-limit';
import { buildPersonalDataExport, exportFileName, toCsvBundle } from '@/lib/privacy/export';
import { canExportFor } from '@/lib/privacy/erasure';
import { auditLog } from '@/lib/services/audit';

export const dynamic = 'force-dynamic';

/** Cap the identifier we will even look up. CUIDs are 25 chars. */
const MAX_SUBJECT_LENGTH = 64;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const rateLimitResponse = await applyRateLimit(request, 'privacy-export');
  if (rateLimitResponse) return rateLimitResponse;

  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const params = request.nextUrl.searchParams;
  const requestedSubject = params.get('subject');
  const format = params.get('format') === 'csv' ? 'csv' : 'json';

  let subjectUserId = session.user.id;
  if (requestedSubject && requestedSubject !== session.user.id) {
    if (requestedSubject.length > MAX_SUBJECT_LENGTH) {
      return NextResponse.json({ error: 'Invalid subject' }, { status: 400 });
    }
    const allowed = await canExportFor(session.user.id, requestedSubject);
    if (!allowed) {
      // 404, not 403: do not confirm that some other account id exists.
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    subjectUserId = requestedSubject;
  }

  let document;
  try {
    document = await buildPersonalDataExport(subjectUserId);
  } catch {
    return NextResponse.json({ error: 'Unable to build export' }, { status: 500 });
  }

  // An export is a disclosure of personal data. It is recorded whether or not
  // the member ever opens the file.
  await auditLog({
    action: 'privacy.export.generated',
    entityType: 'User',
    entityId: subjectUserId,
    newValues: { subjectUserId, requestedByUserId: session.user.id, format },
  });

  const generatedAt = new Date(document.metadata.generatedAt);

  if (format === 'csv') {
    const csv = toCsvBundle(document);
    return new NextResponse(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${exportFileName(generatedAt, 'csv')}"`,
        'Cache-Control': 'no-store',
      },
    });
  }

  return new NextResponse(JSON.stringify(document, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${exportFileName(generatedAt, 'json')}"`,
      'Cache-Control': 'no-store',
    },
  });
}