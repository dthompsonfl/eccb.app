import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/auth/guards';
import { checkUserPermission } from '@/lib/auth/permissions';
import { uploadFile, validateFileMagicBytes } from '@/lib/services/storage';
import { applyRateLimit } from '@/lib/rate-limit';
import { validateCSRF } from '@/lib/csrf';
import { logger } from '@/lib/logger';
import { queueSmartUploadProcess } from '@/lib/jobs/smart-upload';
import { loadSmartUploadRuntimeConfig } from '@/lib/llm/config-loader';
import { computeSha256 } from '@/lib/smart-upload/duplicate-detection';
import type {
  RoutingDecision,
  ParseStatus,
  SecondPassStatus,
} from '@/types/smart-upload';

import { MUSIC_UPLOAD } from '@/lib/auth/permission-constants';
// =============================================================================
// Constants (defaults — overridden by DB config at runtime)
// =============================================================================

const DEFAULT_ALLOWED_MIME_TYPES = ['application/pdf'];
const DEFAULT_MAX_FILE_SIZE_MB = 50;

// =============================================================================
// Helper Functions
// =============================================================================

function generateStorageKey(sessionId: string, extension: string): string {
  return `smart-upload/${sessionId}/original${extension}`;
}

function getExtension(filename: string): string {
  const lastDot = filename.lastIndexOf('.');
  if (lastDot === -1) return '.pdf';
  return filename.slice(lastDot).toLowerCase();
}

// =============================================================================
// Route Handler
// =============================================================================

export async function POST(request: NextRequest) {
  const rateLimitResponse = await applyRateLimit(request, 'smart-upload');
  if (rateLimitResponse) {
    return rateLimitResponse;
  }

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

  const hasPermission = await checkUserPermission(session.user.id, MUSIC_UPLOAD);
  if (!hasPermission) {
    logger.warn('Smart upload denied: missing permission', { userId: session.user.id });
    return NextResponse.json({ error: 'Forbidden: Music upload permission required' }, { status: 403 });
  }

  try {
    // Load DB-configured limits (fall back to defaults if DB unavailable)
    let maxFileSizeMb = DEFAULT_MAX_FILE_SIZE_MB;
    let allowedMimeTypes: string[] = DEFAULT_ALLOWED_MIME_TYPES;
    try {
      const cfg = await loadSmartUploadRuntimeConfig();
      maxFileSizeMb = cfg.maxFileSizeMb ?? DEFAULT_MAX_FILE_SIZE_MB;
      if (cfg.allowedMimeTypes && cfg.allowedMimeTypes.length > 0) {
        allowedMimeTypes = cfg.allowedMimeTypes;
      }
    } catch {
      logger.warn('Could not load smart upload config from DB; using defaults for upload limits');
    }
    const maxFileSizeBytes = maxFileSizeMb * 1024 * 1024;

    const formData = await request.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    if (file.size > maxFileSizeBytes) {
      return NextResponse.json(
        { error: `File too large. Maximum size is ${maxFileSizeMb}MB` },
        { status: 400 }
      );
    }

    if (!allowedMimeTypes.includes(file.type)) {
      return NextResponse.json(
        { error: `Invalid file type. Allowed types: ${allowedMimeTypes.join(', ')}` },
        { status: 400 }
      );
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const isValidPdf = validateFileMagicBytes(buffer, 'application/pdf');
    if (!isValidPdf) {
      logger.warn('Smart upload rejected: invalid PDF magic bytes', {
        userId: session.user.id,
        filename: file.name,
      });
      return NextResponse.json(
        { error: 'File content does not match PDF format' },
        { status: 400 }
      );
    }

    logger.info('Processing smart upload', {
      userId: session.user.id,
      filename: file.name,
      size: file.size,
    });

    const sessionId = crypto.randomUUID();
    const extension = getExtension(file.name);
    const storageKey = generateStorageKey(sessionId, extension);

    // Compute source SHA-256 before upload for dedup/idempotency
    const sourceSha256 = computeSha256(buffer);

    // ── Duplicate detection ──────────────────────────────────────────────────
    // Check for an existing session or committed MusicFile with the same hash.
    // This prevents library spam when the same PDF is uploaded multiple times.
    const [existingSession, existingMusicFile] = await Promise.all([
      prisma.smartUploadSession.findFirst({
        where: { sourceSha256 },
        select: { uploadSessionId: true, status: true, createdAt: true, fileName: true },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.musicFile.findFirst({
        where: {
          // originalUploadId is set on committed files; we look for contentHash match
          // via the sourceSha256 stored in the session's extractedMetadata.
          // More reliable: join through SmartUploadSession via originalUploadId.
          originalUploadId: {
            in: await prisma.smartUploadSession
              .findMany({ where: { sourceSha256 }, select: { uploadSessionId: true } })
              .then((sessions) => sessions.map((s) => s.uploadSessionId)),
          },
          fileType: { not: 'PART' },
        },
        select: { id: true, pieceId: true, piece: { select: { title: true } } },
      }),
    ]);

    if (existingMusicFile) {
      logger.info('Smart upload duplicate detected (already committed)', {
        userId: session.user.id,
        filename: file.name,
        sourceSha256,
        existingPieceId: existingMusicFile.pieceId,
      });
      return NextResponse.json(
        {
          success: false,
          duplicate: true,
          conflictType: 'committed_duplicate',
          code: 'SMART_UPLOAD_DUPLICATE_COMMITTED',
          reason: 'exact_duplicate',
          existingPiece: {
            id: existingMusicFile.pieceId,
            title: existingMusicFile.piece?.title,
            libraryUrl: `/admin/music/library/${existingMusicFile.pieceId}`,
          },
          actions: {
            viewPiecePath: `/admin/music/library/${existingMusicFile.pieceId}`,
            reviewQueuePath: '/admin/uploads/review',
          },
          message: `This file has already been imported as "${existingMusicFile.piece?.title ?? 'Unknown'}". Importing it again would create a duplicate.`,
        },
        { status: 409 }
      );
    }

    if (existingSession && existingSession.status !== 'REJECTED') {
      logger.info('Smart upload duplicate detected (existing session)', {
        userId: session.user.id,
        filename: file.name,
        sourceSha256,
        existingSessionId: existingSession.uploadSessionId,
        existingStatus: existingSession.status,
      });
      return NextResponse.json(
        {
          success: false,
          duplicate: true,
          conflictType: 'existing_session',
          code: 'SMART_UPLOAD_DUPLICATE_SESSION',
          reason: (existingSession.status === 'AUTO_COMMITTED' || existingSession.status === 'MANUALLY_APPROVED' || existingSession.status === 'APPROVED') ? 'approved_session' : 'pending_session',
          existingSession: {
            id: existingSession.uploadSessionId,
            status: existingSession.status,
            fileName: existingSession.fileName,
            createdAt: existingSession.createdAt,
            reviewUrl: `/admin/uploads/review?sessionId=${existingSession.uploadSessionId}`,
            statusUrl: `/api/admin/uploads/status/${existingSession.uploadSessionId}`,
          },
          actions: {
            resumeSessionPath: `/admin/uploads/review?sessionId=${existingSession.uploadSessionId}`,
            reviewQueuePath: '/admin/uploads/review',
          },
          message: `This exact file was already uploaded on ${existingSession.createdAt.toISOString().slice(0, 10)} and is ${(existingSession.status === 'REQUIRES_REVIEW' || existingSession.status === 'PENDING_REVIEW') ? 'pending review' : 'already processed'}. Re-use the existing session rather than uploading again.`,
        },
        { status: 409 }
      );
    }

    // Upload file to storage
    await uploadFile(storageKey, buffer, {
      contentType: 'application/pdf',
      metadata: {
        originalFilename: file.name,
        uploadedBy: session.user.id,
        sessionId,
      },
    });

    // Create smart upload session with canonical initial states
    // The worker will update this with actual metadata after processing
    const smartUploadSession = await prisma.smartUploadSession.create({
      data: {
        uploadSessionId: sessionId,
        fileName: file.name,
        fileSize: file.size,
        mimeType: 'application/pdf',
        storageKey,
        sourceSha256,
        extractedMetadata: JSON.stringify({
          title: file.name.replace(/\.pdf$/i, ''),
          confidenceScore: 0,
          sourceSha256,
        }),
        confidenceScore: 0,
        status: 'PROCESSING',
        uploadedBy: session.user.id,
        parseStatus: 'NOT_PARSED' as ParseStatus,
        secondPassStatus: 'NOT_NEEDED' as SecondPassStatus,
        autoApproved: false,
        llmCallCount: 0,
      },
    });

    logger.info('Smart upload session created, queueing for processing', {
      sessionId: smartUploadSession.uploadSessionId,
      userId: session.user.id,
      sourceSha256,
    });

    // Queue the smart upload for background processing
    // Handle enqueue failures explicitly instead of fire-and-forget
    let enqueueSucceeded = true;
    try {
      await queueSmartUploadProcess(smartUploadSession.uploadSessionId, smartUploadSession.id);
    } catch (enqueueErr) {
      enqueueSucceeded = false;
      logger.error('Failed to queue smart upload for processing', {
        error: enqueueErr instanceof Error ? enqueueErr.message : String(enqueueErr),
        sessionId,
      });

      // Update session to reflect the failed enqueue so it doesn't
      // appear as a live session that will never be processed
      try {
        await prisma.smartUploadSession.update({
          where: { uploadSessionId: sessionId },
          data: {
            parseStatus: 'PARSE_FAILED',
            routingDecision: 'QUEUE_ENQUEUE_FAILED',
          },
        });
      } catch {
        // Best-effort; do not mask original error
      }
    }

    return NextResponse.json({
      success: enqueueSucceeded,
      session: {
        id: smartUploadSession.uploadSessionId,
        fileName: smartUploadSession.fileName,
        confidenceScore: smartUploadSession.confidenceScore,
        status: smartUploadSession.status,
        createdAt: smartUploadSession.createdAt,
        parseStatus: enqueueSucceeded ? smartUploadSession.parseStatus : 'PARSE_FAILED',
        secondPassStatus: smartUploadSession.secondPassStatus,
        autoApproved: smartUploadSession.autoApproved,
        routingDecision: enqueueSucceeded ? null : ('QUEUE_ENQUEUE_FAILED' as RoutingDecision),
      },
      enqueued: enqueueSucceeded,
      message: enqueueSucceeded
        ? 'Upload accepted and queued for background processing.'
        : 'Upload saved but background processing failed to start. Please retry or contact support.',
    }, { status: enqueueSucceeded ? 202 : 503 });
  } catch (error) {
    logger.error('Smart upload failed', { error, userId: session?.user?.id });

    return NextResponse.json(
      { error: 'Smart upload failed' },
      { status: 500 }
    );
  }
}

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
