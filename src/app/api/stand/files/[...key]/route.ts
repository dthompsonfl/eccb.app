import { NextRequest, NextResponse } from 'next/server';
import { downloadFile } from '@/lib/services/storage';
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';
import { applyRateLimit } from '@/lib/rate-limit';
import { Readable } from 'stream';
import { requireStandAccess, canAccessEvent } from '@/lib/stand/access';
import { canReadPieceFile, resolveMusicFileScope } from '@/lib/music/access';
import {
  applyDeliveryWatermarkStream,
  needsWatermark,
  WatermarkError,
} from '@/lib/music/watermark-delivery';
import { recordTelemetry } from '@/lib/stand/telemetry';
import { getStandSettings } from '@/lib/stand/settings';
import { markScoreResponseCacheable } from '@/lib/stand/offline';

/**
 * Authenticated & scoped stand file proxy.
 *
 * Requires:
 *   - Active session with member status
 *   - Scope via `?eventId=<id>` or `?pieceId=<id>` query param
 *   - A matching MusicAssignment for the piece, unless the caller holds a
 *     global music-access role (see @/lib/music/access)
 *
 * Security:
 *   - Session-only access is NOT allowed (P0 fix)
 *   - Returns 404 (non-enumerating) for access denied
 *   - Path traversal blocked
 *   - Part-level scoping enforced: a member assigned "Trumpet 2" cannot pull
 *     a sibling part or the conductor score through this proxy.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ key: string[] }> }
) {
  // Rate limit file proxy requests
  const rateLimited = await applyRateLimit(request, 'stand-file');
  if (rateLimited) return rateLimited;

  const ctx = await requireStandAccess();
  if (ctx instanceof NextResponse) return ctx;

  const { key } = await params;
  const storageKey = decodeURIComponent(key.join('/'));

  // Reject path traversal
  if (storageKey.includes('..') || storageKey.includes('\0')) {
    logger.warn('Stand file proxy: invalid key', { storageKey });
    return NextResponse.json({ error: 'Invalid file path' }, { status: 400 });
  }

  const { searchParams } = new URL(request.url);
  const eventId = searchParams.get('eventId');
  const pieceId = searchParams.get('pieceId');

  // P0 FIX: Require at least one scope — session-only access is NOT allowed
  if (!eventId && !pieceId) {
    recordTelemetry({ event: 'stand.file.denied', userId: ctx.userId, meta: { reason: 'no-scope', storageKey } });
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // The piece this file belongs to, needed for watermarking below. Resolved
  // separately from authorization so it is available on the privileged path too.
  const scope = await resolveMusicFileScope(storageKey);

  // Privileged roles skip the per-file ownership check
  if (!ctx.isPrivileged) {
    let hasAccess = false;

    if (eventId) {
      // Verify file belongs to the event, and that the caller may attend it.
      const eventFile = await prisma.musicFile.findFirst({
        where: {
          storageKey,
          mimeType: 'application/pdf',
          isArchived: false,
          piece: { eventMusic: { some: { eventId } } },
        },
        select: { id: true, pieceId: true },
      });

      let resolvedPieceId: string | null = eventFile?.pieceId ?? null;

      if (!eventFile) {
        // Also check MusicPart storageKey
        const eventPart = await prisma.musicPart.findFirst({
          where: {
            storageKey,
            piece: { eventMusic: { some: { eventId } } },
          },
          select: { id: true, pieceId: true },
        });
        hasAccess = !!eventPart;
        resolvedPieceId = eventPart?.pieceId ?? null;
      } else {
        hasAccess = true;
      }

      // The event must also be one the caller is actually entitled to open.
      if (hasAccess && !(await canAccessEvent(ctx.userId, eventId))) {
        hasAccess = false;
      }

      // Part-level scoping: if this member holds an explicit assignment on the
      // piece, they may only read their own part, never a sibling or the score.
      if (hasAccess && resolvedPieceId) {
        hasAccess = await canReadPieceFile(ctx.userId, resolvedPieceId, storageKey, true);
      }
    } else if (pieceId) {
      // Library mode: require an assignment for the piece (or a global role,
      // already handled by ctx.isPrivileged).
      const pieceFile = await prisma.musicFile.findFirst({
        where: {
          storageKey,
          mimeType: 'application/pdf',
          isArchived: false,
          pieceId,
        },
        select: { id: true, pieceId: true },
      });

      let resolvedPieceId = pieceId;

      if (!pieceFile) {
        const piecePart = await prisma.musicPart.findFirst({
          where: { storageKey, pieceId },
          select: { id: true, pieceId: true },
        });
        hasAccess = !!piecePart;
        resolvedPieceId = piecePart?.pieceId ?? pieceId;
      } else {
        hasAccess = true;
      }

      if (hasAccess) {
        hasAccess = await canReadPieceFile(ctx.userId, resolvedPieceId, storageKey, false);
      }
    }

    if (!hasAccess) {
      // P0 FIX: Return 404 (non-enumerating) instead of 403
      recordTelemetry({ event: 'stand.file.denied', userId: ctx.userId, meta: { storageKey, eventId, pieceId } });
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
  }

  recordTelemetry({ event: 'stand.file.access', userId: ctx.userId, meta: { storageKey, eventId, pieceId } });

  try {
    const result = await downloadFile(storageKey);

    // S3 — redirect to presigned URL
    if (typeof result === 'string') {
      return NextResponse.redirect(result);
    }

    // Local — stream inline
    const { stream, metadata } = result;

    // Stamp the viewer's copy AFTER the access checks above have passed. If
    // stamping fails we return an error rather than the clean original, so a
    // broken watermark can never quietly become "no watermark".
    let body: Uint8Array | null = null;
    let deliverySize = metadata.size;
    if (needsWatermark(metadata.contentType) && scope?.pieceId) {
      try {
        const stamped = await applyDeliveryWatermarkStream({
          stream,
          contentType: metadata.contentType,
          pieceId: scope.pieceId,
          userId: ctx.userId,
        });
        body = stamped.bytes;
        deliverySize = stamped.size;
      } catch (error) {
        if (error instanceof WatermarkError) {
          logger.error('Refusing to serve unstamped copyrighted PDF to the stand', {
            error,
            storageKey,
            userId: ctx.userId,
          });
          return NextResponse.json({ error: 'Failed to retrieve file' }, { status: 500 });
        }
        throw error;
      }
    }

    const webStream = body
      ? new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(body);
            controller.close();
          },
        })
      : (Readable.toWeb(stream as Readable) as ReadableStream);

    const headers = new Headers();
    headers.set('Content-Type', metadata.contentType);
    headers.set('Content-Length', String(deliverySize));
    headers.set('Content-Disposition', 'inline');
    headers.set('Cache-Control', 'private, max-age=86400, immutable');

    // Opt in to offline caching — but only here, at the very end, on the 200 PDF
    // path, after every authorization check above has passed and after the
    // watermark has been applied. Every early return (401, 400, 404, the 500 from
    // a failed watermark, and the S3 redirect above) returns before this line, so
    // a denied or errored response can never carry the header. The S3 redirect is
    // handled by returning earlier precisely because caching it would store a
    // presigned URL, not the score.
    if (metadata.contentType === 'application/pdf') {
      markScoreResponseCacheable({
        headers,
        enabled: (await getStandSettings()).offlineEnabled,
        userId: ctx.userId,
      });
    }

    return new Response(webStream, { status: 200, headers });
  } catch (error) {
    if (error instanceof Error && error.message === 'File not found') {
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }
    logger.error('Stand file proxy error', { error, storageKey });
    return NextResponse.json({ error: 'Failed to retrieve file' }, { status: 500 });
  }
}

