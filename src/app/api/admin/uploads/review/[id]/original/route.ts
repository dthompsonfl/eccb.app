import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/auth/guards';
import { checkUserPermission } from '@/lib/auth/permissions';
import { downloadFile } from '@/lib/services/storage';
import { logger } from '@/lib/logger';
import type { DownloadResult } from '@/lib/services/storage';

import { MUSIC_VIEW_ALL } from '@/lib/auth/permission-constants';
// =============================================================================
// GET /api/admin/uploads/review/[id]/original
//
// Serves the original uploaded PDF for inline viewing or download.
//
// Query parameters:
//   disposition — 'inline' (default, open in browser) | 'attachment' (download)
//
// Returns the raw PDF bytes with appropriate Content-Type and
// Content-Disposition headers.
// =============================================================================

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const hasPerm = await checkUserPermission(session.user.id, MUSIC_VIEW_ALL);
    if (!hasPerm) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { id } = await params;

    const uploadSession = await prisma.smartUploadSession.findUnique({
      where: { uploadSessionId: id },
      select: { storageKey: true, fileName: true },
    });

    if (!uploadSession) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    const url = new URL(req.url);
    const disposition = url.searchParams.get('disposition') === 'attachment'
      ? 'attachment'
      : 'inline';

    const safeFilename = (uploadSession.fileName || 'document.pdf')
      .replace(/[^\w.\-() ]/g, '_');

    const downloadResult = await downloadFile(uploadSession.storageKey);
    const pdfBuffer = await toPdfBuffer(downloadResult);

    logger.info('Original PDF served', {
      sessionId: id,
      disposition,
      filename: safeFilename,
      size: pdfBuffer.length,
    });

    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(pdfBuffer);
        controller.close();
      },
    });

    return new NextResponse(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `${disposition}; filename="${safeFilename}"`,
        'Content-Length': String(pdfBuffer.length),
        'Cache-Control': 'private, max-age=600',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error('Failed to serve original PDF', { error: err.message });
    return NextResponse.json(
      { error: 'Failed to retrieve original PDF', detail: err.message },
      { status: 500 }
    );
  }
}

async function toPdfBuffer(downloadResult: string | DownloadResult): Promise<Buffer> {
  if (typeof downloadResult === 'string') {
    const res = await fetch(downloadResult);
    if (!res.ok) throw new Error(`Failed to download PDF from storage: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  return streamToBuffer((downloadResult as DownloadResult).stream);
}

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
