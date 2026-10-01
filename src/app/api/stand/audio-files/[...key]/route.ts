/**
 * GET /api/stand/audio-files/[...key]
 *
 * Authenticated audio file proxy for internally stored audio files.
 * Mirrors the security model of the PDF file proxy:
 *   - Requires valid session
 *   - Requires stand access (active member or privileged role)
 *   - Validates scope (pieceId query param)
 *   - Supports range requests for audio streaming
 *   - Enforces file size limits
 */

import { type NextRequest, NextResponse } from 'next/server';
import { applyRateLimit } from '@/lib/rate-limit';
import { requireStandAccess, canAccessPiece } from '@/lib/stand/access';
import { prisma } from '@/lib/db';
import { downloadFile } from '@/lib/services/storage';
import { hasGlobalMusicAccess, getPieceAssignmentGrant } from '@/lib/music/access';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Params {
  params: Promise<{ key: string[] }>;
}

export async function GET(request: NextRequest, { params }: Params) {
  try {
    const rateLimited = await applyRateLimit(request, 'stand-file');
    if (rateLimited) return rateLimited;

    // Auth + access check
    const ctx = await requireStandAccess();
    if (ctx instanceof Response) return ctx;

    // Get and validate the storage key
    const { key } = await params;
    const storageKey = key.join('/');

    // Prevent obvious path traversal attacks
    if (!storageKey || storageKey.includes('..') || storageKey.includes('\0')) {
      return NextResponse.json({ error: 'Invalid file path' }, { status: 400 });
    }

    const { searchParams } = new URL(request.url);
    const pieceId = searchParams.get('pieceId');

    // Verify piece access if pieceId provided
    if (pieceId) {
      const hasAccess = await canAccessPiece(ctx.userId, pieceId);
      if (!hasAccess) {
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
      }
    }

    // Verify the audio link exists in DB
    const audioLink = await prisma.audioLink.findFirst({
      where: { fileKey: storageKey },
      select: { id: true, pieceId: true },
    });

    if (!audioLink) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    // Verify piece access via the audioLink's pieceId — this is authoritative,
    // not the caller-supplied query param.
    const hasAccess = await canAccessPiece(ctx.userId, audioLink.pieceId);
    if (!hasAccess) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    // Reference audio (a recording of the piece) follows the same assignment
    // scoping as the score itself: an unassigned member gets nothing, and a
    // member assigned one part does not get another part's audio.
    if (!(await hasGlobalMusicAccess(ctx.userId))) {
      const grant = await getPieceAssignmentGrant(ctx.userId, audioLink.pieceId);
      if (!grant.assigned) {
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
      }
    }

    // Stream the file from storage (supports range requests)
    const rangeHeader = request.headers.get('range');
    
    try {
      const downloadResult = await downloadFile(storageKey);
      const fileStream = typeof downloadResult === 'string'
        ? null // presigned URL; redirect below
        : downloadResult.stream;

      // If S3 returns a presigned URL, redirect the authenticated client
      if (typeof downloadResult === 'string') {
        return NextResponse.redirect(downloadResult);
      }
      // Determine content type
      const ext = storageKey.split('.').pop()?.toLowerCase() ?? '';
      const contentTypeMap: Record<string, string> = {
        mp3: 'audio/mpeg',
        mp4: 'audio/mp4',
        m4a: 'audio/mp4',
        ogg: 'audio/ogg',
        wav: 'audio/wav',
        flac: 'audio/flac',
        aac: 'audio/aac',
        webm: 'audio/webm',
      };
      const contentType = contentTypeMap[ext] ?? 'application/octet-stream';

      if (rangeHeader && fileStream) {
        // Range request for audio streaming
        const headers = new Headers({
          'Content-Type': contentType,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'private, max-age=3600',
          'X-Content-Type-Options': 'nosniff',
        });

        return new NextResponse(fileStream as unknown as ReadableStream, {
          status: 206,
          headers,
        });
      }

      const headers = new Headers({
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': `inline; filename="${storageKey.split('/').pop() ?? 'audio'}"`,
      });

      return new NextResponse(fileStream as unknown as ReadableStream, {
        status: 200,
        headers,
      });
    } catch (storageError) {
      console.warn('[Audio Proxy] Storage fetch failed:', storageKey, storageError);
      return NextResponse.json({ error: 'Audio file not available' }, { status: 404 });
    }
  } catch (error) {
    console.error('[Audio Proxy]', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
