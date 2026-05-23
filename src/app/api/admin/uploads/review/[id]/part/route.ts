import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/auth/guards';
import { checkUserPermission } from '@/lib/auth/permissions';
import { downloadFile } from '@/lib/services/storage';
import { logger } from '@/lib/logger';
import type { DownloadResult } from '@/lib/services/storage';
import type { ParsedPartRecord } from '@/types/smart-upload';

import { MUSIC_VIEW_ALL } from '@/lib/auth/permission-constants';
import { parseSmartUploadJsonArray } from '@/lib/smart-upload/persistence';
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
    const url = new URL(req.url);
    const encodedPartStorageKey = url.searchParams.get('partStorageKey');
    if (!encodedPartStorageKey) {
      return NextResponse.json({ error: 'partStorageKey query parameter is required' }, { status: 400 });
    }

    const disposition = url.searchParams.get('disposition') === 'attachment'
      ? 'attachment'
      : 'inline';
    const partStorageKey = decodeURIComponent(encodedPartStorageKey);

    const uploadSession = await prisma.smartUploadSession.findUnique({
      where: { uploadSessionId: id },
      select: { parsedParts: true },
    });

    if (!uploadSession) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    const parsedParts = parseSmartUploadJsonArray<ParsedPartRecord>(uploadSession.parsedParts);
    const part = parsedParts.find((entry) => entry.storageKey === partStorageKey);
    if (!part) {
      return NextResponse.json({ error: 'Part not found in session' }, { status: 404 });
    }

    const safeFilename = (part.fileName || 'part.pdf').replace(/[^\w.\-() ]/g, '_');
    const downloadResult = await downloadFile(partStorageKey);
    const pdfBuffer = await toPdfBuffer(downloadResult);

    logger.info('Part PDF served', {
      sessionId: id,
      disposition,
      filename: safeFilename,
      size: pdfBuffer.length,
      storageKey: partStorageKey,
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
    logger.error('Failed to serve part PDF', { error: err.message });
    return NextResponse.json(
      { error: 'Failed to retrieve part PDF', detail: err.message },
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
  return streamToBuffer(downloadResult.stream);
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    const value = chunk as Buffer | string;
    chunks.push(Buffer.isBuffer(value) ? value : Buffer.from(value));
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
