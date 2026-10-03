import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/guards';
import { setPieceWatermark } from '@/lib/music/watermark-policy';
import { logger } from '@/lib/logger';
import { applyRateLimit } from '@/lib/rate-limit';

/**
 * Turn watermarking on/off for one piece.
 *
 * Library administrators only. The permission check lives in
 * @/lib/music/watermark-policy (re-checked per call, not trusted from here),
 * so this route cannot accidentally become the weaker path.
 */
export async function PATCH(request: NextRequest) {
    // Rate limit this admin mutation. Without it a hijacked or over-
    // privileged session could hammer destructive or AI-spending
    // endpoints without bound.
    const rateLimited = await applyRateLimit(request, 'adminAction');
    if (rateLimited) return rateLimited;

  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { pieceId, enabled, reason } = (payload ?? {}) as {
    pieceId?: unknown;
    enabled?: unknown;
    reason?: unknown;
  };

  if (typeof pieceId !== 'string' || pieceId.length === 0) {
    return NextResponse.json({ error: 'pieceId is required' }, { status: 400 });
  }
  if (typeof enabled !== 'boolean') {
    return NextResponse.json({ error: 'enabled must be a boolean' }, { status: 400 });
  }
  if (reason !== undefined && reason !== null && typeof reason !== 'string') {
    return NextResponse.json({ error: 'reason must be a string' }, { status: 400 });
  }

  const result = await setPieceWatermark({
    actorId: session.user.id,
    pieceId,
    enabled,
    reason: reason ?? null,
  });

  if (!result.success) {
    logger.warn('Watermark API request rejected', {
      userId: session.user.id,
      pieceId,
      status: result.status,
    });
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json({ pieceId, watermarkEnabled: result.enabled });
}
