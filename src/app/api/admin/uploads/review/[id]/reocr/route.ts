import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { prisma } from '@/lib/db';
import { getSession } from '@/lib/auth/guards';
import { requirePermission } from '@/lib/auth/permissions';
import { validateCSRF } from '@/lib/csrf';
import { applyRateLimit } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import { queueOcrProcess } from '@/lib/jobs/smart-upload';
import { MUSIC_CREATE } from '@/lib/auth/permission-constants';

/**
 * Re-run non-LLM OCR for an already-uploaded Smart Upload session.
 *
 * This is the only producer for the dedicated OCR queue. Without it the OCR
 * worker (started unconditionally by src/workers/index.ts) held a BullMQ
 * consumer and a Redis connection open in production while never receiving a
 * job.
 *
 * Smart Upload already OCRs inline during the main processing job. This
 * endpoint exists for the operator-driven re-run: a different OCR engine, a
 * different render scale, or filling in a title/composer the first pass missed
 * — without re-uploading the PDF and without blocking a request.
 */

const reocrSchema = z.object({
  // Engine names must match OcrFallbackOptions['ocrEngine'] in
  // src/lib/services/ocr-fallback.ts. 'vision_api' is accepted by the type but
  // is not implemented, so it is deliberately excluded here rather than
  // offering an operator a choice that cannot work.
  ocrEngine: z.enum(['pdf_text', 'tesseract', 'ocrmypdf', 'native']).optional(),
  /** OCR strategy: header crop, full first page, or both. */
  ocrMode: z.enum(['header', 'full', 'both']).optional(),
  /** Max pages to probe for an embedded text layer. */
  maxTextProbePages: z.number().int().min(1).max(200).optional(),
  /** Max pages to OCR. 0 means unlimited. */
  maxOcrPages: z.number().int().min(0).max(1000).optional(),
  /** Only accept OCR-derived metadata above this confidence. */
  autoAcceptConfidenceThreshold: z.number().min(0).max(100).optional(),
  /**
   * Overwrite an already-extracted title/composer. Default false so a re-OCR
   * cannot silently clobber metadata a librarian already corrected.
   */
  overwriteExistingMetadata: z.boolean().optional().default(false),
  /** Optional operator note, recorded in the log. */
  reason: z.string().max(500).optional(),
});

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const rateLimitResponse = await applyRateLimit(request, 'adminAction');
    if (rateLimitResponse) {
      return rateLimitResponse;
    }

    const csrfResult = validateCSRF(request);
    if (!csrfResult.valid) {
      return NextResponse.json(
        { error: 'CSRF validation failed', reason: csrfResult.reason },
        { status: 403 },
      );
    }

    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Authorization: re-running OCR is a music-library mutation.
    await requirePermission(MUSIC_CREATE);

    const { id: sessionId } = await params;

    const body = await request.json().catch(() => ({}));
    const parsed = reocrSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request', details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const session1 = await prisma.smartUploadSession.findUnique({
      where: { uploadSessionId: sessionId },
      select: {
        uploadSessionId: true,
        fileName: true,
        storageKey: true,
        status: true,
      },
    });

    if (!session1) {
      return NextResponse.json({ error: 'Upload session not found' }, { status: 404 });
    }

    if (!session1.storageKey) {
      return NextResponse.json(
        { error: 'Upload session has no stored file to OCR' },
        { status: 409 },
      );
    }

    const { overwriteExistingMetadata, reason, ...ocrOptions } = parsed.data;

    const job = await queueOcrProcess({
      sessionId: session1.uploadSessionId,
      filename: session1.fileName,
      options: ocrOptions,
      overwriteExistingMetadata,
    });

    logger.info('Re-OCR queued', {
      sessionId: session1.uploadSessionId,
      jobId: job.id,
      userId: session.user.id,
      overwriteExistingMetadata,
      reason,
    });

    return NextResponse.json(
      {
        success: true,
        sessionId: session1.uploadSessionId,
        jobId: job.id ?? null,
        message: 'OCR pass queued. The session will show updated metadata when it completes.',
      },
      { status: 202 },
    );
  } catch (error) {
    logger.error(
      'Failed to queue re-OCR',
      error instanceof Error ? error : new Error(String(error)),
    );
    return NextResponse.json({ error: 'Failed to queue OCR processing' }, { status: 500 });
  }
}
