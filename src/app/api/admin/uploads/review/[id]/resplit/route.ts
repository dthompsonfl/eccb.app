import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/auth/guards';
import { requirePermission } from '@/lib/auth/permissions';
import { logger } from '@/lib/logger';
import { validateCSRF } from '@/lib/csrf';
import { z } from 'zod';
import { downloadFile } from '@/lib/services/storage';
import { splitPdfByCuttingInstructions, validatePdfBuffer } from '@/lib/services/pdf-splitter';
import { validateAndNormalizeInstructions } from '@/lib/services/cutting-instructions';
import { buildPartFilename, buildPartStorageSlug, normalizeInstrumentLabel } from '@/lib/smart-upload/part-naming';
import { uploadFile } from '@/lib/services/storage';
import type { CuttingInstruction, ParsedPartRecord } from '@/types/smart-upload';

import { MUSIC_CREATE } from '@/lib/auth/permission-constants';
// =============================================================================
// Validation Schema
// =============================================================================

const resplitSchema = z.object({
  cuttingInstructions: z.array(z.object({
    instrument: z.string(),
    partName: z.string(),
    section: z.enum(['Woodwinds', 'Brass', 'Percussion', 'Strings', 'Keyboard', 'Vocals', 'Other', 'Score']),
    transposition: z.enum(['Bb', 'Eb', 'F', 'C', 'D', 'G', 'A']),
    partNumber: z.number(),
    pageRange: z.tuple([z.number(), z.number()]),
    chair: z.enum(['1st', '2nd', '3rd', '4th', 'Aux', 'Solo']).nullable().optional(),
    partType: z.enum(['PART', 'FULL_SCORE', 'CONDUCTOR_SCORE', 'CONDENSED_SCORE']).optional(),
  })).min(1, 'At least one cutting instruction is required'),
  reason: z.string().optional(),
});

// =============================================================================
// POST /api/admin/uploads/review/[id]/resplit
// Re-split PDF based on edited cutting instructions
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

    // Check permission
    await requirePermission(MUSIC_CREATE);

    const { id } = await params;

    // Parse and validate request body
    const body = await request.json();
    const validatedData = resplitSchema.parse(body);

    // Load session with original PDF
    const uploadSession = await prisma.smartUploadSession.findUnique({
      where: { uploadSessionId: id },
      select: {
        id: true,
        uploadSessionId: true,
        fileName: true,
        storageKey: true,
        status: true,
        tempFiles: true,
      },
    });

    if (!uploadSession) {
      return NextResponse.json({ error: 'Upload session not found' }, { status: 404 });
    }

    // Only allow resplit for sessions that haven't been committed yet
    if (uploadSession.status === 'AUTO_COMMITTED' || uploadSession.status === 'MANUALLY_APPROVED' || uploadSession.status === 'APPROVED' || uploadSession.status === 'REJECTED') {
      return NextResponse.json(
        { error: `Session is already ${uploadSession.status.toLowerCase()}` },
        { status: 400 }
      );
    }

    // Download original PDF
    const downloadResult = await downloadFile(uploadSession.storageKey);
    if (typeof downloadResult === 'string') {
      return NextResponse.json({ error: 'Failed to download PDF' }, { status: 500 });
    }

    // Convert stream to buffer
    const chunks: Buffer[] = [];
    for await (const chunk of downloadResult.stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const pdfBuffer = Buffer.concat(chunks);

    // Validate PDF and get page count
    const pdfValidation = await validatePdfBuffer(pdfBuffer);
    if (!pdfValidation.valid) {
      return NextResponse.json(
        { error: 'Invalid PDF', details: pdfValidation.error },
        { status: 400 }
      );
    }
    const totalPages = pdfValidation.pageCount ?? 1;
    const instructionValidation = validateAndNormalizeInstructions(
      validatedData.cuttingInstructions as CuttingInstruction[],
      totalPages,
      { oneIndexed: true, detectGaps: true }
    );

    if (!instructionValidation.isValid) {
      return NextResponse.json({
        error: 'Invalid cutting instructions',
        details: instructionValidation.errors,
        warnings: instructionValidation.warnings,
      }, { status: 400 });
    }

    // Check for gaps
    if (instructionValidation.warnings.some((w: string) => w.includes('gap') || w.includes('uncovered'))) {
      return NextResponse.json({
        error: 'Cutting instructions have uncovered pages',
        warnings: instructionValidation.warnings,
      }, { status: 400 });
    }

    // Delete old temp files (best-effort)
    const oldTempFiles = (uploadSession.tempFiles as string[] | null) ?? [];
    const { deleteFile } = await import('@/lib/services/storage');
    for (const key of oldTempFiles) {
      try {
        await deleteFile(key);
      } catch {
        // Best-effort cleanup
      }
    }

    // Re-split PDF with new instructions
    const splitResults = await splitPdfByCuttingInstructions(
      pdfBuffer,
      uploadSession.fileName.replace(/\.pdf$/i, ''),
      instructionValidation.instructions,
      { indexing: 'zero' }
    );

    // Upload new parts
    const parsedParts: ParsedPartRecord[] = [];
    const tempFiles: string[] = [];

    for (const result of splitResults) {
      const normalised = normalizeInstrumentLabel(result.instruction.instrument);
      const displayName = `${uploadSession.fileName.replace(/\.pdf$/i, '')} ${normalised.instrument}`;
      const slug = buildPartStorageSlug(displayName);
      const partStorageKey = `smart-upload/${id}/parts/resplit/${slug}.pdf`;
      const partFileName = buildPartFilename(displayName);

      await uploadFile(partStorageKey, result.buffer, {
        contentType: 'application/pdf',
        metadata: {
          sessionId: id,
          instrument: result.instruction.instrument,
          partName: result.instruction.partName,
          section: result.instruction.section,
          resplitBy: session.user.id,
          resplitAt: new Date().toISOString(),
        },
      });

      tempFiles.push(partStorageKey);

      parsedParts.push({
        partName: result.instruction.partName,
        instrument: result.instruction.instrument,
        section: result.instruction.section,
        transposition: result.instruction.transposition,
        partNumber: result.instruction.partNumber,
        storageKey: partStorageKey,
        fileName: partFileName,
        fileSize: result.buffer.length,
        pageCount: result.pageCount,
        pageRange: [result.instruction.pageRange[0] + 1, result.instruction.pageRange[1] + 1] as [number, number],
      });
    }

    // Update session with new parsed parts and cutting instructions
    await prisma.smartUploadSession.update({
      where: { uploadSessionId: id },
      data: {
        cuttingInstructions: validatedData.cuttingInstructions as any,
        parsedParts: parsedParts as any,
        tempFiles: tempFiles as any,
        updatedAt: new Date(),
        parseStatus: 'PARSED',
        // Clear auto-approved flag since manual resplit was done
        autoApproved: false,
      },
    });

    logger.info('Smart upload re-split completed', {
      sessionId: id,
      userId: session.user.id,
      partsCreated: parsedParts.length,
      reason: validatedData.reason,
    });

    return NextResponse.json({
      success: true,
      message: `Re-split into ${parsedParts.length} parts successfully`,
      session: {
        id,
        status: uploadSession.status,
      },
      resplit: {
        partsCreated: parsedParts.length,
        parsedParts,
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
    logger.error('Failed to resplit upload session', { error: err });
    return NextResponse.json(
      { error: 'Failed to resplit upload session' },
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
