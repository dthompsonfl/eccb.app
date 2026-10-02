/**
 * GET /api/push/vapid-key
 *
 * Returns the client-safe push config: whether push is available and the VAPID
 * PUBLIC key. The private key is never part of this response — see
 * getPublicVapidConfig().
 *
 * Auth is required: even though the public key is not a secret, there is no
 * reason to advertise push capability to anonymous visitors.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/guards';
import { applyRateLimit } from '@/lib/rate-limit';
import { getPublicVapidConfig } from '@/lib/communications/push/settings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const rateLimited = await applyRateLimit(request, 'push-subscribe');
  if (rateLimited) return rateLimited;

  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const config = await getPublicVapidConfig();
  return NextResponse.json(config);
}
