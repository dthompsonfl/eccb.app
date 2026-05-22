import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requirePermission } from '@/lib/auth/permissions';
import { logger } from '@/lib/logger';

import { MUSIC_VIEW_ALL } from '@/lib/auth/permission-constants';
function deriveWorkflowStage(
  parseStatus: string | null,
  secondPassStatus: string | null,
  status: string
): string {
  if (status === 'AUTO_COMMITTED' || status === 'MANUALLY_APPROVED' || status === 'APPROVED') return 'approved';
  if (status === 'REJECTED') return 'rejected';
  if (parseStatus === 'PARSE_FAILED') return 'parse_failed';
  if (secondPassStatus === 'FAILED') return 'second_pass_failed';
  if (secondPassStatus === 'IN_PROGRESS' || secondPassStatus === 'QUEUED') return 'second_pass';
  if (parseStatus === 'PARSING') return 'parsing';
  if (parseStatus === 'PARSED') return 'parsed_pending_review';
  return 'queued';
}

/**
 * GET /api/admin/uploads/status/[sessionId]
 *
 * Get the status of a smart upload session.
 * Used for polling progress from the frontend.
 *
 * Requires `music.view.all` permission.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  try {
    await requirePermission(MUSIC_VIEW_ALL);
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    const { sessionId } = await params;

    const session = await prisma.smartUploadSession.findUnique({
      where: { uploadSessionId: sessionId },
      select: {
        id: true,
        uploadSessionId: true,
        status: true,
        parseStatus: true,
        secondPassStatus: true,
        confidenceScore: true,
        routingDecision: true,
        commitStatus: true,
        commitError: true,
        requiresHumanReview: true,
        fileName: true,
        storageKey: true,
        fileSize: true,
        extractedMetadata: true,
        parsedParts: true,
        cuttingInstructions: true,
        autoApproved: true,
        ocrTextChars: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!session) {
      return NextResponse.json(
        { error: 'Session not found' },
        { status: 404 }
      );
    }

    const progressStep =
      session.commitStatus === 'COMPLETE'
        ? 'commit_complete'
        : session.secondPassStatus === 'QUEUED' || session.secondPassStatus === 'RUNNING'
          ? 'second_pass'
          : session.parseStatus === 'PARSE_COMPLETED'
            ? 'parse_complete'
            : 'processing';

    const workflow = {
      stage: deriveWorkflowStage(session.parseStatus, session.secondPassStatus, session.status),
      requiresHumanReview: Boolean(session.requiresHumanReview),
      parseFailed: session.parseStatus === 'PARSE_FAILED',
      secondPassFailed: session.secondPassStatus === 'FAILED',
      completed: session.status === 'AUTO_COMMITTED' || session.status === 'MANUALLY_APPROVED' || session.status === 'APPROVED' || session.status === 'REJECTED' || session.status === 'FAILED',
      parseStatus: session.parseStatus,
      ocrStatus: session.ocrTextChars && session.ocrTextChars > 0 ? 'COMPLETED' : 'NOT_USED',
      secondPassStatus: session.secondPassStatus,
      commitStatus: session.commitStatus,
      failureCode: session.commitError ? 'COMMIT_FAILED' : null,
      failureStage: session.commitError ? 'commit' : null,
      progressStep,
      reviewReasons: session.requiresHumanReview ? ['requires_human_review'] : [],
      duplicateFlags: {
        sourceSha256Present: Boolean((session.extractedMetadata as Record<string, unknown> | null)?.sourceSha256),
      },
      preview: {
        originalAvailable: Boolean(session.storageKey),
        partPreviewAvailable: Array.isArray(session.parsedParts) && session.parsedParts.length > 0,
      },
    };

    return NextResponse.json({ session, workflow });
  } catch (error) {
    logger.error('Error fetching upload status', { error });
    return NextResponse.json(
      { error: 'Failed to fetch upload status' },
      { status: 500 }
    );
  }
}
