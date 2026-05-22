import { MUSIC_UPLOAD, SYSTEM_CONFIG } from '@/lib/auth/permission-constants';
/**
 * POST /api/admin/uploads/second-pass
 *
 * Enqueues a BullMQ second-pass verification job for the given session.
 * The actual LLM work is done by smart-upload-worker.ts (processSecondPass).
 *
 * Eligible session states for enqueueing: secondPassStatus is null, 'NOT_NEEDED',
 * 'FAILED', or 'COMPLETE'.
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/auth/guards';
import { checkUserPermission } from '@/lib/auth/permissions';
import { applyRateLimit } from '@/lib/rate-limit';
import { validateCSRF } from '@/lib/csrf';
import { logger } from '@/lib/logger';
import { queueSmartUploadSecondPass } from '@/lib/jobs/smart-upload';
import type { SecondPassStatus } from '@/types/smart-upload';

// =============================================================================
// POST /api/admin/uploads/second-pass
// =============================================================================

export async function POST(request: NextRequest) {
  // Apply HTTP-level rate limit before any auth work
  const rateLimitResponse = await applyRateLimit(request, 'second-pass');
  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  // Allow service-token auth for internal worker calls (no CSRF needed)
  // Only enable this path when a real token is configured.
  const authHeader = request.headers.get('authorization');
  const configuredServiceToken = process.env.SMART_UPLOAD_SERVICE_TOKEN;
  const isServiceToken =
    Boolean(configuredServiceToken) &&
    authHeader?.startsWith('Bearer ') &&
    authHeader.slice(7) === configuredServiceToken;

  if (!isServiceToken) {
    const csrfResult = validateCSRF(request);
    if (!csrfResult.valid) {
      return NextResponse.json(
        { error: 'CSRF validation failed', reason: csrfResult.reason },
        { status: 403 }
      );
    }

    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const hasMusicUpload = await checkUserPermission(session.user.id, MUSIC_UPLOAD);
    const hasSystemConfig = await checkUserPermission(session.user.id, SYSTEM_CONFIG);
    if (!hasMusicUpload && !hasSystemConfig) {
      logger.warn('Second pass enqueue denied: missing permission', { userId: session.user.id });
      return NextResponse.json(
        { error: 'Forbidden: music upload or system config permission required' },
        { status: 403 }
      );
    }
  }

  // Parse body
  let sessionId: string;
  try {
    const body = await request.json();
    sessionId = body.sessionId;
    if (!sessionId || typeof sessionId !== 'string') {
      return NextResponse.json({ error: 'sessionId is required' }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  try {
    // Verify session exists and is eligible
    const smartSession = await prisma.smartUploadSession.findUnique({
      where: { uploadSessionId: sessionId },
      select: { uploadSessionId: true, secondPassStatus: true, status: true },
    });

    if (!smartSession) {
      return NextResponse.json({ error: 'Upload session not found' }, { status: 404 });
    }

    const currentStatus = smartSession.secondPassStatus as SecondPassStatus | null;
    const eligibleStatuses: Array<SecondPassStatus | null> = [
      null,
      'NOT_NEEDED',
      'FAILED',
      'COMPLETE',
    ];
    if (!eligibleStatuses.includes(currentStatus)) {
      return NextResponse.json(
        {
          error: `Session is not eligible to queue a second pass. Current secondPassStatus: "${currentStatus}"`,
        },
        { status: 400 }
      );
    }

    // Mark as QUEUED before enqueueing to prevent duplicate submissions
    await prisma.smartUploadSession.update({
      where: { uploadSessionId: sessionId },
      data: { secondPassStatus: 'QUEUED' },
    });

    // Enqueue the BullMQ job — worker handles all LLM execution
    const job = await queueSmartUploadSecondPass(sessionId);

    logger.info('Second pass queued', { sessionId, jobId: job.id });

    return NextResponse.json(
      {
        success: true,
        sessionId,
        secondPassStatus: 'QUEUED',
        jobId: job.id,
        message: 'Second pass verification queued. Check session status for progress.',
      },
      { status: 202 }
    );
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error('Failed to queue second pass', { error: err, sessionId });

    // Best-effort rollback so client can retry
    try {
      await prisma.smartUploadSession.update({
        where: { uploadSessionId: sessionId },
        data: { secondPassStatus: 'FAILED' },
      });
    } catch {
      // ignore
    }

    return NextResponse.json(
      { error: 'Failed to queue second pass', reason: err.message },
      { status: 500 }
    );
  }
}

// =============================================================================
// OPTIONS handler for CORS
// =============================================================================

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    },
  });
}
