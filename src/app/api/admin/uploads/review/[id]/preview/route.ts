import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'crypto';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/auth/guards';
import { checkUserPermission } from '@/lib/auth/permissions';
import { downloadFile } from '@/lib/services/storage';
import { renderPdfPageToImageWithInfo } from '@/lib/services/pdf-renderer';
import { parseRenderParams } from '@/lib/review-preview/render-params';
import { logger } from '@/lib/logger';
import { SmartUploadErrorCode } from '@/lib/smart-upload/error-codes';
import type { DownloadResult } from '@/lib/services/storage';

import { MUSIC_VIEW_ALL } from '@/lib/auth/permission-constants';
// =============================================================================
// GET /api/admin/uploads/review/[id]/preview
//
// Returns a base64-encoded image of the specified page of the uploaded PDF so
// that admins can visually verify the extracted metadata without leaving the
// review dialog.
//
// Query parameters (all optional, backwards-compatible):
//   page       — 0-indexed page number (default 0)
//   scale      — render DPI multiplier, clamped [1..6] (default 3)
//   maxWidth   — max output pixel width, clamped [800..4000] (default 2000)
//   format     — 'png' (default, lossless) | 'jpeg' (lossy, faster)
//   quality    — JPEG quality, clamped [60..100], ignored for PNG (default 92)
//
// Response JSON:
//   { imageBase64, totalPages, mimeType, render: { pageIndex, scale, maxWidth, format, quality } }
// =============================================================================

function stableHash(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 12);
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

    const url = new URL(req.url);
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

    // Download PDF bytes from storage (single buffer, no double-parse)
    const pdfBuffer = await fetchPdfBuffer(await downloadFile(uploadSession.storageKey));

    // Render — one pdfjs open returns both image and total page count
    const cacheTagValue = `preview:${id}:${stableHash(`${scale}:${maxWidth}:${format}:${quality}`)}`;
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

    logger.info('PDF preview generated', {
      sessionId: id,
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
    
    // P2.3 FIX: Enhanced error handling with error codes and better diagnostics
    
    // Classify the error
    let errorCode: SmartUploadErrorCode;
    let statusCode = 500;
    let detail = err.message;
    
    if (err.message.includes('out of range')) {
      errorCode = SmartUploadErrorCode.PROCESS_PAGE_TOO_LARGE;
      statusCode = 400;
      detail = `Page index out of range. Requested page may exceed PDF page count.`;
    } else if (err.message.includes('Failed to download')) {
      errorCode = SmartUploadErrorCode.STORAGE_DOWNLOAD_FAILED;
      statusCode = 503;
      detail = `Unable to retrieve PDF from storage. Please retry.`;
    } else if (err.message.includes('render') || err.message.includes('Render')) {
      errorCode = SmartUploadErrorCode.PROCESS_RENDERING_FAILED;
      statusCode = 500;
      detail = `PDF rendering failed. The PDF may be corrupted or unsupported.`;
    } else if (err.message.includes('Unauthorized')) {
      errorCode = SmartUploadErrorCode.AUTH_UNAUTHORIZED;
      statusCode = 401;
    } else if (err.message.includes('Forbidden')) {
      errorCode = SmartUploadErrorCode.AUTH_FORBIDDEN;
      statusCode = 403;
    } else {
      errorCode = SmartUploadErrorCode.UNKNOWN_ERROR;
    }
    
    // Log with context
    logger.error('PDF preview endpoint error', {
      errorCode,
      sessionId: (await params).id,
      statusCode,
      message: err.message,
      stack: err.stack,
    });
    
    return NextResponse.json(
      {
        error: 'Preview generation failed',
        errorCode,
        detail,
        timestamp: new Date().toISOString(),
      },
      { status: statusCode }
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
