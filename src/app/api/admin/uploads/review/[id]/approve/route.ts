import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/auth/guards';
import { requirePermission } from '@/lib/auth/permissions';
import { logger } from '@/lib/logger';
import { validateCSRF } from '@/lib/csrf';
import { z } from 'zod';
import { commitSmartUploadSessionToLibrary } from '@/lib/smart-upload/commit';
import type { CommitOverrides } from '@/lib/smart-upload/commit';

import { MUSIC_CREATE } from '@/lib/auth/permission-constants';
// =============================================================================
// Validation Schema
// =============================================================================

const approveSchema = z.object({
  title: z.string().min(1, 'Title is required'),
  composer: z.string().optional(),
  arranger: z.string().optional(),
  publisher: z.string().optional(),
  instrument: z.string().optional(),
  partNumber: z.string().optional(),
  difficulty: z.string().optional(),
  ensembleType: z.string().optional(),
  keySignature: z.string().optional(),
  timeSignature: z.string().optional(),
  tempo: z.string().optional(),
});

// =============================================================================
// POST /api/admin/uploads/review/[id]/approve
// =============================================================================

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
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

    const { id } = await params;

    // Parse and validate request body
    const body = await request.json();
    const validatedData = approveSchema.parse(body);

    // Early check: ensure session exists and is pending review
    const existingSession = await prisma.smartUploadSession.findUnique({
      where: { uploadSessionId: id },
      select: { status: true },
    });
    if (!existingSession) {
      return NextResponse.json({ error: 'Upload session not found' }, { status: 404 });
    }
    if (existingSession.status !== 'REQUIRES_REVIEW' && existingSession.status !== 'PENDING_REVIEW') {
      return NextResponse.json({ error: 'Session is not awaiting review' }, { status: 400 });
    }

    const overrides: CommitOverrides = {
      title: validatedData.title,
      composer: validatedData.composer,
      arranger: validatedData.arranger,
      publisher: validatedData.publisher,
      instrument: validatedData.instrument,
      partNumber: validatedData.partNumber,
      difficulty: validatedData.difficulty,
      ensembleType: validatedData.ensembleType,
      keySignature: validatedData.keySignature,
      timeSignature: validatedData.timeSignature,
      tempo: validatedData.tempo,
    };

    // Delegate to shared commit function (also called by auto-commit worker)
    const commitResult = await commitSmartUploadSessionToLibrary(id, overrides, session.user.id);

    // Fetch updated session for reviewedAt / status in response
    const updatedSession = await prisma.smartUploadSession.findUnique({
      where: { uploadSessionId: id },
      select: { status: true, reviewedAt: true },
    });

    logger.info('Smart upload approved and imported via review route', {
      sessionId: id,
      userId: session.user.id,
      pieceId: commitResult.musicPieceId,
      title: commitResult.musicPieceTitle,
      wasIdempotent: commitResult.wasIdempotent,
    });

    return NextResponse.json({
      success: true,
      session: {
        id,
        status: updatedSession?.status,
        reviewedAt: updatedSession?.reviewedAt,
      },
      musicPiece: {
        id: commitResult.musicPieceId,
        title: commitResult.musicPieceTitle,
      },
      musicFile: {
        id: commitResult.musicFileId,
      },
      partsCommitted: commitResult.partsCommitted,
      wasIdempotent: commitResult.wasIdempotent,
      message: commitResult.wasIdempotent
        ? `Session was already committed. Existing piece: "${commitResult.musicPieceTitle}".`
        : `Successfully approved and imported "${commitResult.musicPieceTitle}" to music library.`,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation error', details: error.issues },
        { status: 400 }
      );
    }

    const err = error instanceof Error ? error : new Error(String(error));

    // Surface domain errors as 400 to the client
    // errors related to existence or eligibility are handled above,
    // but keep a catch-all for other domain errors
    if (err.message.includes('already committed')) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }

    logger.error('Failed to approve upload session', { error: err });
    return NextResponse.json(
      { error: 'Failed to approve upload session' },
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
