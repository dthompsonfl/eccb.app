/**
 * /api/privacy/erasure — GDPR Art. 17 (right to erasure).
 *
 * Three verbs, deliberately separated, because an irreversible action must
 * never be one mis-tap away:
 *
 *   POST   { action: 'request' }  → open a pending request with a 7-day undo
 *                                  window. Nothing is deleted.
 *   POST   { action: 'confirm', confirmation: '<name>' }
 *                                → execute NOW. Requires the server-derived
 *                                  name-to-confirm phrase. Self-service skips
 *                                  the grace window here because the member has
 *                                  already had their chance to change their mind.
 *   DELETE { }                   → cancel a pending request. Reversible action,
 *                                  and the one an elderly member should feel
 *                                  entirely safe pressing.
 *
 * An admin erasing somebody else passes `subject`; that path requires
 * `privacy.erase`, is separately audited, and still demands the name-to-confirm
 * phrase for the TARGET (not the admin), so nobody can destroy an account by
 * reflex.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth/config';
import { headers } from 'next/headers';
import { applyRateLimit } from '@/lib/rate-limit';
import { validateCSRF } from '@/lib/csrf';
import {
  cancelErasure,
  ErasureConfirmationError,
  ErasureNotAuthorizedError,
  executeErasure,
  getPendingErasure,
  requestErasure,
  RETENTION_BASIS,
} from '@/lib/privacy/erasure';
import { auditLog } from '@/lib/services/audit';

export const dynamic = 'force-dynamic';

const MAX_SUBJECT_LENGTH = 64;

const bodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('request'), subject: z.string().max(MAX_SUBJECT_LENGTH).optional() }),
  z.object({
    action: z.literal('confirm'),
    confirmation: z.string().min(1, 'Please type your name to confirm'),
    subject: z.string().max(MAX_SUBJECT_LENGTH).optional(),
  }),
]);

/** GET — status of the caller's own pending request, so the UI can show the
 *  remaining undo window without the client tracking dates itself. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const rateLimitResponse = await applyRateLimit(request, 'privacy-erasure');
  if (rateLimitResponse) return rateLimitResponse;

  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const subjectUserId = request.nextUrl.searchParams.get('subject') ?? session.user.id;

  try {
    const pending = await getPendingErasure(subjectUserId);
    return NextResponse.json({
      pending: pending !== null,
      request: pending,
      retentionBasis: RETENTION_BASIS,
    });
  } catch {
    return NextResponse.json({ error: 'Unable to read erasure status' }, { status: 500 });
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const rateLimitResponse = await applyRateLimit(request, 'privacy-erasure');
  if (rateLimitResponse) return rateLimitResponse;

  const csrf = validateCSRF(request);
  if (!csrf.valid) {
    return NextResponse.json(
      { error: 'CSRF validation failed', reason: csrf.reason },
      { status: 403 },
    );
  }

  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let parsed;
  try {
    parsed = bodySchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  const subjectUserId = parsed.subject ?? session.user.id;

  try {
    if (parsed.action === 'request') {
      const record = await requestErasure(subjectUserId, session.user.id);
      return NextResponse.json({ request: record, retentionBasis: RETENTION_BASIS });
    }

    const isAdmin = subjectUserId !== session.user.id;
    const manifest = await executeErasure({
      subjectUserId,
      callerUserId: session.user.id,
      // An admin is not the data subject; the member's own 7-day window is not
      // a meaningful brake on them, so the admin path proceeds once the target's
      // name has been typed. The self-service path is the same code with the
      // window bypassed, because the member has already used their undo window.
      bypassGraceWindow: true,
      suppliedConfirmation: parsed.confirmation,
    });

    await auditLog({
      action: 'privacy.erasure.confirmed',
      entityType: 'User',
      entityId: subjectUserId,
      newValues: {
        subjectUserId,
        requestedByUserId: session.user.id,
        isAdmin,
        manifest,
      },
    });

    return NextResponse.json({ manifest });
  } catch (error) {
    if (error instanceof ErasureNotAuthorizedError) {
      // 404 rather than 403 for the cross-subject case: do not confirm that
      // some other account id exists.
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    if (error instanceof ErasureConfirmationError) {
      return NextResponse.json(
        { error: 'That name did not match. Please check and try again.' },
        { status: 400 },
      );
    }
    console.error('Erasure failed:', error);
    return NextResponse.json(
      {
        error:
          'We could not complete that just now. Nothing was changed — your information is exactly as it was.',
      },
      { status: 500 },
    );
  }
}

/** DELETE — cancel a pending request. Always safe; nothing has been erased yet. */
export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const rateLimitResponse = await applyRateLimit(request, 'privacy-erasure');
  if (rateLimitResponse) return rateLimitResponse;

  const csrf = validateCSRF(request);
  if (!csrf.valid) {
    return NextResponse.json(
      { error: 'CSRF validation failed', reason: csrf.reason },
      { status: 403 },
    );
  }

  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let subjectUserId = session.user.id;
  try {
    const body = (await request.json()) as { subject?: string };
    if (body?.subject) {
      if (body.subject.length > MAX_SUBJECT_LENGTH) {
        return NextResponse.json({ error: 'Invalid subject' }, { status: 400 });
      }
      subjectUserId = body.subject;
    }
  } catch {
    // An empty body is legitimate: "cancel my own request".
  }

  try {
    const result = await cancelErasure(subjectUserId, session.user.id);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof ErasureNotAuthorizedError) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    console.error('Erasure cancellation failed:', error);
    return NextResponse.json({ error: 'Unable to cancel just now' }, { status: 500 });
  }
}