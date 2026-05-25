import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/auth/guards';
import { requirePermission } from '@/lib/auth/permissions';
import { MUSIC_CREATE } from '@/lib/auth/permission-constants';
import { logger } from '@/lib/logger';
import { z } from 'zod';
import { validateCSRF } from '@/lib/csrf';
import { commitSmartUploadSessionToLibrary } from '@/lib/smart-upload/commit';
import type { ExtractedMetadata } from '@/types/smart-upload';

// =============================================================================
// Validation Schema
// =============================================================================

const bulkApproveSchema = z.object({
  sessionIds: z.array(z.string()).min(1, 'At least one session ID is required'),
});

// =============================================================================
// POST /api/admin/uploads/review/bulk-approve
//
// Approves multiple upload sessions at once using the shared commit service.
// Sessions with insufficient metadata are skipped and reported back.
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

    // Check permission using canonical constant
    await requirePermission(MUSIC_CREATE);

    // Parse body
    const body = await request.json();
    const { sessionIds } = bulkApproveSchema.parse(body);

    // Load all pending sessions to validate before committing
    const uploadSessions = await prisma.smartUploadSession.findMany({
      where: {
        uploadSessionId: { in: sessionIds },
        status: 'PENDING_REVIEW',
      },
      select: {
        uploadSessionId: true,
        extractedMetadata: true,
      },
    });

    if (uploadSessions.length === 0) {
      return NextResponse.json(
        { error: 'No pending sessions found for the provided IDs' },
        { status: 400 }
      );
    }

    const approved: string[] = [];
    const skipped: { id: string; reason: string }[] = [];

    for (const uploadSession of uploadSessions) {
      const extractedMetadata = (uploadSession.extractedMetadata as unknown) as ExtractedMetadata | null;

      // Skip sessions with no usable title
      if (!extractedMetadata?.title?.trim()) {
        skipped.push({
          id: uploadSession.uploadSessionId,
          reason: 'No title in extracted metadata — please review manually',
        });
        continue;
      }

      try {
        // Delegate to the shared commit function — same path as single approve
        const result = await commitSmartUploadSessionToLibrary(
          uploadSession.uploadSessionId,
          { title: extractedMetadata.title },
          session.user.id
        );

        if (result.wasIdempotent) {
          skipped.push({
            id: uploadSession.uploadSessionId,
            reason: 'Already committed (idempotent)',
          });
        } else {
          approved.push(uploadSession.uploadSessionId);
        }

        logger.info('Bulk approve: session approved', {
          sessionId: uploadSession.uploadSessionId,
          userId: session.user.id,
          pieceId: result.musicPieceId,
          title: result.musicPieceTitle,
          wasIdempotent: result.wasIdempotent,
        });
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        logger.error('Bulk approve: failed to approve session', {
          sessionId: uploadSession.uploadSessionId,
          error: error.message,
        });
        skipped.push({
          id: uploadSession.uploadSessionId,
          reason: `Import error: ${error.message}`,
        });
      }
    }

    return NextResponse.json({
      success: true,
      approved: approved.length,
      skipped: skipped.length,
      approvedIds: approved,
      skippedDetails: skipped,
      message: `Approved ${approved.length} upload(s).${skipped.length > 0 ? ` Skipped ${skipped.length} (see skippedDetails).` : ''}`,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation error', details: error.issues },
        { status: 400 }
      );
    }

    logger.error('Failed to bulk approve upload sessions', { error });
    return NextResponse.json(
      { error: 'Failed to bulk approve upload sessions' },
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
