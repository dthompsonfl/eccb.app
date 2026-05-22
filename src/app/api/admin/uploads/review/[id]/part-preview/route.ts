import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'crypto';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/auth/guards';
import { checkUserPermission } from '@/lib/auth/permissions';
import { downloadFile } from '@/lib/services/storage';
import { renderPdfPageToImageWithInfo } from '@/lib/services/pdf-renderer';
import { parseRenderParams } from '@/lib/review-preview/render-params';
import { logger } from '@/lib/logger';
import type { DownloadResult } from '@/lib/services/storage';

import { MUSIC_VIEW_ALL } from '@/lib/auth/permission-constants';
import { parseSmartUploadJsonArray } from '@/lib/smart-upload/persistence';
// =============================================================================
// GET /api/admin/uploads/review/[id]/part-preview
//
// Returns a base64-encoded image of the specified page of a parsed part PDF from
// the SmartUploadSession. The part storage key must belong to the session's
// parsedParts JSON.
//
// Query parameters (all optional, backwards-compatible):
//   partStorageKey — required; storage key of the part PDF
//   page           — 0-indexed page number (default 0)
//   scale          — render DPI multiplier, clamped [1..6] (default 3)
//   maxWidth       — max output pixel width, clamped [800..4000] (default 2000)
//   format         — 'png' (default, lossless) | 'jpeg' (lossy, faster)
//   quality        — JPEG quality, clamped [60..100], ignored for PNG (default 92)
//
// Response JSON:
//   { imageBase64, totalPages, mimeType, render: { pageIndex, scale, maxWidth, format, quality } }
// =============================================================================

function stableHash(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 12);
}

interface ParsedPart {
  storageKey?: string;
  [key: string]: unknown;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Auth check
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const hasPerm = await checkUserPermission(session.user.id, MUSIC_VIEW_ALL);
    if (!hasPerm) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { id } = await params;

    // Parse query parameters
    const url = new URL(req.url);
    const partStorageKeyEncoded = url.searchParams.get('partStorageKey');

    if (!partStorageKeyEncoded) {
      return NextResponse.json(
        { error: 'partStorageKey query parameter is required' },
        { status: 400 }
      );
    }

    // Decode the part storage key (URL-encoded)
    const partStorageKey = decodeURIComponent(partStorageKeyEncoded);

    const { pageIndex, scale, maxWidth, format, quality } = parseRenderParams(url);

    if (isNaN(pageIndex) || pageIndex < 0) {
      return NextResponse.json(
        { error: 'Invalid page parameter. Must be a non-negative integer.' },
        { status: 400 }
      );
    }

    // Look up the upload session
    const uploadSession = await prisma.smartUploadSession.findUnique({
      where: { uploadSessionId: id },
    });

    if (!uploadSession) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    // Parse parsedParts JSON and verify the part storage key belongs to this session.
    // The field is stored as LongText JSON, not a Prisma Json column.
    const parsedParts = parseSmartUploadJsonArray<ParsedPart>(uploadSession.parsedParts);

    const partExists = parsedParts.some((part) => part.storageKey === partStorageKey);
    if (!partExists) {
      logger.warn('Part storage key not found in session', { sessionId: id, partStorageKey });
      return NextResponse.json(
        { error: 'Part not found in session' },
        { status: 404 }
      );
    }

    // Download the part PDF from storage (single buffer, no double-parse)
    const pdfBuffer = await fetchPdfBuffer(await downloadFile(partStorageKey));

    // Render — one pdfjs open returns both image and total page count
    const cacheTagValue = `part-preview:${id}:${stableHash(partStorageKey)}:${stableHash(`${scale}:${maxWidth}:${format}:${quality}`)}`;
    const result = await renderPdfPageToImageWithInfo(pdfBuffer, {
      pageIndex,
      scale,
      maxWidth,
      format,
      quality,
      cacheTag: cacheTagValue,
    });

    if (pageIndex >= result.totalPages) {
      return NextResponse.json(
        {
          error: 'Page out of range',
          detail: `Requested page ${pageIndex} but PDF has ${result.totalPages} page(s) (0-${result.totalPages - 1}).`,
        },
        { status: 400 }
      );
    }

    logger.info('Part PDF preview generated', {
      sessionId: id,
      partStorageKey,
      pageIndex,
      totalPages: result.totalPages,
      scale,
      maxWidth,
      format,
      quality,
      imageLength: result.imageBase64.length,
    });

    return NextResponse.json(
      {
        imageBase64: result.imageBase64,
        totalPages: result.totalPages,
        mimeType: result.mimeType,
        render: { pageIndex, scale, maxWidth, format, quality },
      },
      { headers: { 'Cache-Control': 'private, max-age=300, stale-while-revalidate=60' } }
    );
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    if (err.message.includes('out of range')) {
      logger.warn('Part PDF preview page out of range', { message: err.message });
      return NextResponse.json(
        { error: 'Page out of range', detail: err.message },
        { status: 400 }
      );
    }
    logger.error('Failed to generate part PDF preview', { error: err.message });
    return NextResponse.json(
      { error: 'Failed to generate preview', detail: err.message },
      { status: 500 }
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchPdfBuffer(downloadResult: string | DownloadResult): Promise<Buffer> {
  if (typeof downloadResult === 'string') {
    const res = await fetch(downloadResult);
    if (!res.ok) throw new Error(`Failed to download PDF from storage: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  return streamToBuffer((downloadResult as DownloadResult).stream);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    const c = chunk as Buffer | string;
    chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  }
  return Buffer.concat(chunks);
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}
