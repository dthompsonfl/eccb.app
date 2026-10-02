/**
 * PATCH /api/push/consent   — grant or revoke push consent for the session user
 * GET  /api/push/consent   — read current consent state
 *
 * This is the ONLY way a member becomes eligible for push, and it is always an
 * explicit `enabled: true` from the member's own browser. There is no default-on
 * path: no flag is pre-set, no environment variable can enable it, and the
 * send path re-checks consent on every delivery regardless of what is stored.
 *
 * Revoking deletes every stored endpoint for the member — see setPushConsent().
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/guards';
import { applyRateLimit } from '@/lib/rate-limit';
import { csrfValidationResponse } from '@/lib/csrf';
import { getPushConsent, setPushConsent } from '@/lib/communications/push/consent';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const rateLimited = await applyRateLimit(request, 'push-subscribe');
  if (rateLimited) return rateLimited;

  const session = await getSession();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const consent = await getPushConsent(userId);
  return NextResponse.json(consent);
}

export async function PATCH(request: NextRequest) {
  const rateLimited = await applyRateLimit(request, 'push-subscribe');
  if (rateLimited) return rateLimited;

  const csrfFailure = csrfValidationResponse(request);
  if (csrfFailure) return csrfFailure;

  const session = await getSession();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { enabled?: unknown };
  try {
    body = (await request.json()) as { enabled?: unknown };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // Strict boolean check. A truthy value like "false" or 1 must not be able to
  // turn push on; consent has to be an unambiguous act.
  if (typeof body.enabled !== 'boolean') {
    return NextResponse.json(
      { error: '`enabled` must be a boolean' },
      { status: 400 },
    );
  }

  const consent = await setPushConsent(userId, body.enabled);
  return NextResponse.json(consent);
}
