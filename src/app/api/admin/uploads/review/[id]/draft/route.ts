import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/auth/guards';
import { requirePermission } from '@/lib/auth/permissions';
import { logger } from '@/lib/logger';
import { validateCSRF } from '@/lib/csrf';
import { z } from 'zod';
import type { ExtractedMetadata } from '@/types/smart-upload';

import { MUSIC_CREATE } from '@/lib/auth/permission-constants';
import { parseSmartUploadJsonArray, parseSmartUploadJsonField, serializeSmartUploadJsonField } from '@/lib/smart-upload/persistence';
// =============================================================================
// Validation Schema
// =============================================================================

const draftMetadataSchema = z.object({
  title: z.string().optional(),
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
  notes: z.string().optional(),
});

const draftSchema = z.object({
  metadata: draftMetadataSchema.optional(),
  cuttingInstructions: z.array(z.object({
    instrument: z.string(),
    partName: z.string(),
    section: z.enum(['Woodwinds', 'Brass', 'Percussion', 'Strings', 'Keyboard', 'Vocals', 'Other', 'Score']),
    transposition: z.enum(['Bb', 'Eb', 'F', 'C', 'D', 'G', 'A']),
    partNumber: z.number(),
    pageRange: z.tuple([z.number(), z.number()]),
    chair: z.enum(['1st', '2nd', '3rd', '4th', 'Aux', 'Solo']).nullable().optional(),
    partType: z.enum(['PART', 'FULL_SCORE', 'CONDUCTOR_SCORE', 'CONDENSED_SCORE']).optional(),
  })).optional(),
});

// =============================================================================
// POST /api/admin/uploads/review/[id]/draft
// Save draft metadata edits without committing
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
    const validatedData = draftSchema.parse(body);

    // Check session exists and is in a state that allows draft edits
    const existingSession = await prisma.smartUploadSession.findUnique({
      where: { uploadSessionId: id },
      select: {
        status: true,
        extractedMetadata: true,
        cuttingInstructions: true,
      },
    });

    if (!existingSession) {
      return NextResponse.json({ error: 'Upload session not found' }, { status: 404 });
    }

    // Only allow drafts for sessions that haven't been committed yet
    if (existingSession.status === 'AUTO_COMMITTED' || existingSession.status === 'MANUALLY_APPROVED' || existingSession.status === 'APPROVED' || existingSession.status === 'REJECTED') {
      return NextResponse.json(
        { error: `Session is already ${existingSession.status.toLowerCase()}` },
        { status: 400 }
      );
    }

    // Merge metadata changes with existing extracted metadata
    const currentMetadata = parseSmartUploadJsonField<ExtractedMetadata | null>(existingSession.extractedMetadata, null);
    const mergedMetadata: ExtractedMetadata = currentMetadata
      ? {
          ...currentMetadata,
          ...(validatedData.metadata?.title !== undefined && { title: validatedData.metadata.title }),
          ...(validatedData.metadata?.composer !== undefined && { composer: validatedData.metadata.composer }),
          ...(validatedData.metadata?.arranger !== undefined && { arranger: validatedData.metadata.arranger }),
          ...(validatedData.metadata?.publisher !== undefined && { publisher: validatedData.metadata.publisher }),
          ...(validatedData.metadata?.instrument !== undefined && { instrument: validatedData.metadata.instrument }),
          ...(validatedData.metadata?.partNumber !== undefined && { partNumber: validatedData.metadata.partNumber }),
          ...(validatedData.metadata?.ensembleType !== undefined && { ensembleType: validatedData.metadata.ensembleType }),
          ...(validatedData.metadata?.keySignature !== undefined && { keySignature: validatedData.metadata.keySignature }),
          ...(validatedData.metadata?.timeSignature !== undefined && { timeSignature: validatedData.metadata.timeSignature }),
          ...(validatedData.metadata?.tempo !== undefined && { tempo: validatedData.metadata.tempo }),
          ...(validatedData.metadata?.notes !== undefined && {
            notes: currentMetadata.notes
              ? `${currentMetadata.notes} | Draft: ${validatedData.metadata.notes}`
              : `Draft: ${validatedData.metadata.notes}`,
          }),
        }
      : {
          title: validatedData.metadata?.title || 'Unknown Title',
          confidenceScore: 0,
          fileType: 'FULL_SCORE',
          isMultiPart: false,
          parts: [],
          cuttingInstructions: [],
        };

    // Prepare update data
    const updateData: Parameters<typeof prisma.smartUploadSession.update>[0]['data'] = {
      extractedMetadata: serializeSmartUploadJsonField(mergedMetadata),
      updatedAt: new Date(),
    };

    // Update cutting instructions if provided
    if (validatedData.cuttingInstructions) {
      updateData.cuttingInstructions = serializeSmartUploadJsonField(validatedData.cuttingInstructions);
    }

    // Persist draft changes
    await prisma.smartUploadSession.update({
      where: { uploadSessionId: id },
      data: updateData,
    });

    logger.info('Smart upload draft saved', {
      sessionId: id,
      userId: session.user.id,
      metadataFields: Object.keys(validatedData.metadata || {}),
      hasCuttingInstructions: !!validatedData.cuttingInstructions,
    });

    return NextResponse.json({
      success: true,
      message: 'Draft saved successfully',
      session: {
        id,
        status: existingSession.status,
      },
      draft: {
        metadata: validatedData.metadata,
        cuttingInstructions: validatedData.cuttingInstructions,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation error', details: error.issues },
        { status: 400 }
      );
    }

    const err = error instanceof Error ? error : new Error(String(error));
    logger.error('Failed to save draft', { error: err });
    return NextResponse.json(
      { error: 'Failed to save draft' },
      { status: 500 }
    );
  }
}

// =============================================================================
// GET /api/admin/uploads/review/[id]/draft
// Retrieve current draft state
// =============================================================================

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Check authentication
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Check permission
    await requirePermission(MUSIC_CREATE);

    const { id } = await params;

    const uploadSession = await prisma.smartUploadSession.findUnique({
      where: { uploadSessionId: id },
      select: {
        uploadSessionId: true,
        status: true,
        extractedMetadata: true,
        cuttingInstructions: true,
        updatedAt: true,
      },
    });

    if (!uploadSession) {
      return NextResponse.json({ error: 'Upload session not found' }, { status: 404 });
    }

    const metadata = parseSmartUploadJsonField<ExtractedMetadata | null>(uploadSession.extractedMetadata, null);

    return NextResponse.json({
      success: true,
      session: {
        id: uploadSession.uploadSessionId,
        status: uploadSession.status,
        updatedAt: uploadSession.updatedAt,
      },
      draft: {
        metadata: metadata
          ? {
              title: metadata.title,
              composer: metadata.composer,
              arranger: metadata.arranger,
              publisher: metadata.publisher,
              instrument: metadata.instrument,
              partNumber: metadata.partNumber,
              ensembleType: metadata.ensembleType,
              keySignature: metadata.keySignature,
              timeSignature: metadata.timeSignature,
              tempo: metadata.tempo,
              notes: metadata.notes,
            }
          : null,
        cuttingInstructions: parseSmartUploadJsonArray(uploadSession.cuttingInstructions),
      },
    });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error('Failed to retrieve draft', { error: err });
    return NextResponse.json(
      { error: 'Failed to retrieve draft' },
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
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    },
  });
}
