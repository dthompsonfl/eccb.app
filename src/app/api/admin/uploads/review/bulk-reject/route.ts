import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/auth/guards';
import { requirePermission } from '@/lib/auth/permissions';
import { logger } from '@/lib/logger';
import { cleanupSmartUploadTempFiles } from '@/lib/services/smart-upload-cleanup';
import { validateCSRF } from '@/lib/csrf';
import { z } from 'zod';

import { MUSIC_EDIT } from '@/lib/auth/permission-constants';
// =============================================================================
// Validation Schema
// =============================================================================

const bulkRejectSchema = z.object({
  sessionIds: z.array(z.string()).min(1, 'At least one session ID is required'),
  reason: z.string().optional(),
});

// =============================================================================
// POST /api/admin/uploads/review/bulk-reject
//
// Rejects multiple upload sessions at once. Sessions that have already been
// committed to the library are skipped.
// =============================================================================

export async function POST(request: NextRequest) {
  try {
    const csrfResult = validateCSRF(request);
    if (!csrfResult.valid) {
      return NextResponse.json(
        { error: 'CSRF validation failed', reason: csrfResult.reason },
        { status: 403 }
      );
    }

    // Check authentication
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Check permission
    await requirePermission(MUSIC_EDIT);

    // Parse body
    const body = await request.json();
    const { sessionIds, reason } = bulkRejectSchema.parse(body);

    // Load all pending sessions to validate before rejecting
    const uploadSessions = await prisma.smartUploadSession.findMany({
      where: {
        uploadSessionId: { in: sessionIds },
        status: { in: ['REQUIRES_REVIEW', 'PENDING_REVIEW'] },
      },
      select: {
        uploadSessionId: true,
        status: true,
      },
    });

    if (uploadSessions.length === 0) {
      return NextResponse.json(
        { error: 'No pending sessions found for the provided IDs' },
        { status: 400 }
      );
    }

    // Check which sessions are already committed to the library in bulk
    const committedFiles = await prisma.musicFile.findMany({
      where: {
        originalUploadId: { in: uploadSessions.map(s => s.uploadSessionId) },
      },
      select: {
        originalUploadId: true,
      },
    });

    const committedIds = new Set(committedFiles.map(f => f.originalUploadId));

    const rejected: string[] = [];
    const skipped: { id: string; reason: string }[] = [];
    const toRejectIds: string[] = [];

    for (const uploadSession of uploadSessions) {
      if (committedIds.has(uploadSession.uploadSessionId)) {
        skipped.push({
          id: uploadSession.uploadSessionId,
          reason: 'Session has already been committed to the library',
        });
      } else {
        toRejectIds.push(uploadSession.uploadSessionId);
      }
    }

    if (toRejectIds.length > 0) {
      const now = new Date();

      // Batch update the session statuses to REJECTED
      await prisma.smartUploadSession.updateMany({
        where: {
          uploadSessionId: { in: toRejectIds },
        },
        data: {
          status: 'REJECTED',
          reviewedBy: session.user.id,
          reviewedAt: now,
          routingDecision: reason ? `REJECTED: ${reason}` : 'REJECTED',
        },
      });

      rejected.push(...toRejectIds);

      // Clean up temporary files in parallel (best-effort)
      // Use Promise.allSettled to ensure one failure doesn't stop others
      const cleanupResults = await Promise.allSettled(
        toRejectIds.map(id => cleanupSmartUploadTempFiles(id))
      );

      // Log cleanup failures
      cleanupResults.forEach((result, index) => {
        if (result.status === 'rejected') {
          logger.warn('Failed to clean up temp files after rejection (bulk)', {
            sessionId: toRejectIds[index],
            error: result.reason instanceof Error ? result.reason.message : String(result.reason),
          });
        }
      });

      logger.info('Smart uploads rejected in bulk', {
        count: toRejectIds.length,
        userId: session.user.id,
        reason: reason ?? 'No reason provided',
        sessionIds: toRejectIds,
      });
    }

    return NextResponse.json({
      success: true,
      rejected: rejected.length,
      skipped: skipped.length,
      rejectedIds: rejected,
      skippedDetails: skipped,
      message: `Rejected ${rejected.length} upload(s).${skipped.length > 0 ? ` Skipped ${skipped.length} (see skippedDetails).` : ''}`,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation error', details: error.issues },
        { status: 400 }
      );
    }

    console.error('[BulkRejectRoute] caught error:', error);
    logger.error('Failed to bulk reject upload sessions', { error });
    return NextResponse.json(
      { error: 'Failed to bulk reject upload sessions' },
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
