/**
 * POST /api/push/subscribe   — register this browser for push
 * POST /api/push/unsubscribe — remove this browser (or every browser) from push
 *
 * Both require an authenticated session and a CSRF-validating origin. Consent
 * is granted separately via PATCH /api/push/consent; subscribing without prior
 * consent is rejected with 403 so that no code path can enrol a member who has
 * not asked for push.
 *
 * Authorization is by session only. There is no path here that takes a userId
 * from the request body — the user is always the session user, so one member
 * cannot subscribe or unsubscribe another's browser.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/guards';
import { applyRateLimit } from '@/lib/rate-limit';
import { csrfValidationResponse } from '@/lib/csrf';
import {
  subscribeUser,
  unsubscribeUser,
  unsubscribeAllForUser,
} from '@/lib/communications/push/subscriptions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const rateLimited = await applyRateLimit(request, 'push-subscribe');
  if (rateLimited) return rateLimited;

  const csrfFailure = csrfValidationResponse(request);
  if (csrfFailure) return csrfFailure;

  const session = await getSession();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const subscription = (body as { subscription?: unknown })?.subscription;
  const result = await subscribeUser(userId, subscription);

  if (!result.success) {
    if (result.error === 'not-consented') {
      // Distinguish this from a bad payload: the client needs to know it must
      // ask the member for consent first, not retry blindly.
      return NextResponse.json(
        { error: 'Push notifications are not enabled for this account' },
        { status: 403 },
      );
    }
    return NextResponse.json({ error: 'Invalid push subscription' }, { status: 400 });
  }

  return NextResponse.json({
    success: true,
    subscriptionId: result.subscriptionId,
  });
}

async function handleUnsubscribe(request: NextRequest): Promise<Response> {
  const rateLimited = await applyRateLimit(request, 'push-subscribe');
  if (rateLimited) return rateLimited;

  const csrfFailure = csrfValidationResponse(request);
  if (csrfFailure) return csrfFailure;

  const session = await getSession();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { endpoint?: unknown; all?: unknown };
  try {
    body = (await request.json()) as { endpoint?: unknown; all?: unknown };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (body.all === true) {
    const { removed } = await unsubscribeAllForUser(userId);
    return NextResponse.json({ success: true, removed });
  }

  const result = await unsubscribeUser(userId, body.endpoint);
  if (!result.success) {
    return NextResponse.json({ error: 'Invalid endpoint' }, { status: 400 });
  }

  return NextResponse.json({ success: true, removed: result.removed });
}

export { handleUnsubscribe as DELETE };
