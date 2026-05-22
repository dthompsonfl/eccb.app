import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/auth/guards';
import { requirePermission } from '@/lib/auth/permissions';
import { logger } from '@/lib/logger';
import type {
  ParsedPartRecord,
  CuttingInstruction,
  ExtractedMetadata,
  ParseStatus,
  SecondPassStatus,
} from '@/types/smart-upload';

import { MUSIC_VIEW_ALL } from '@/lib/auth/permission-constants';
// =============================================================================
// Types
// =============================================================================

interface ExceptionQueueLinks {
  previewPath: string;
  openPath: string;
  downloadPath: string;
}

function buildOriginalLinks(sessionId: string): ExceptionQueueLinks {
  return {
    previewPath: `/api/admin/uploads/review/${sessionId}/preview?page=0`,
    openPath: `/api/admin/uploads/review/${sessionId}/original?disposition=inline`,
    downloadPath: `/api/admin/uploads/review/${sessionId}/original?disposition=attachment`,
  };
}

function buildPartLinks(sessionId: string, storageKey: string): ExceptionQueueLinks {
  const encodedStorageKey = encodeURIComponent(storageKey);
  return {
    previewPath: `/api/admin/uploads/review/${sessionId}/part-preview?partStorageKey=${encodedStorageKey}&page=0`,
    openPath: `/api/admin/uploads/review/${sessionId}/part?partStorageKey=${encodedStorageKey}&disposition=inline`,
    downloadPath: `/api/admin/uploads/review/${sessionId}/part?partStorageKey=${encodedStorageKey}&disposition=attachment`,
  };
}

function deriveExceptionKind(
  parseStatus: ParseStatus | null,
  secondPassStatus: SecondPassStatus | null,
  requiresHumanReview: boolean | null,
  confidenceScore: number | null
): string {
  if (parseStatus === 'PARSE_FAILED') return 'parse_failure';
  if (secondPassStatus === 'FAILED') return 'second_pass_failure';
  if (requiresHumanReview) return 'human_review_required';
  if ((confidenceScore ?? 0) < 85) return 'low_confidence';
  return 'review_pending';
}

function deriveExceptionSummary(
  kind: string,
  confidenceScore: number | null,
  metadata: ExtractedMetadata | null
): string {
  switch (kind) {
    case 'parse_failure':
      return 'PDF parsing or segmentation failed before a safe split could be produced.';
    case 'second_pass_failure':
      return 'Second-pass verification failed; manual review is required before commit.';
    case 'human_review_required':
      return metadata?.notes || 'Processing detected ambiguity or uncovered ranges that require reviewer intervention.';
    case 'low_confidence':
      return `Confidence is ${confidenceScore ?? 0}%; reviewer confirmation is required before commit.`;
    default:
      return 'Awaiting reviewer confirmation before commit.';
  }
}

// =============================================================================
// GET /api/admin/uploads/review - List sessions for review
// =============================================================================

export async function GET(request: NextRequest) {
  try {
    // Check authentication
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Check permission using canonical constant
    await requirePermission(MUSIC_VIEW_ALL);

    // Get search params
    const searchParams = request.nextUrl.searchParams;
    const status = searchParams.get('status') || 'REQUIRES_REVIEW';
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') || '50', 10)));
    const skip = (page - 1) * limit;

    // Build where clause — default to exception sessions (PENDING_REVIEW)
    const where = {
      status: status as 'PROCESSING' | 'AUTO_COMMITTING' | 'AUTO_COMMITTED' | 'REQUIRES_REVIEW' | 'MANUALLY_APPROVED' | 'REJECTED' | 'FAILED' | 'PENDING_REVIEW' | 'APPROVED',
    };

    // Fetch sessions with pagination
    const [sessions, totalCount] = await Promise.all([
      prisma.smartUploadSession.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.smartUploadSession.count({ where }),
    ]);

    // Transform sessions to include extracted metadata and new fields
    const transformedSessions = sessions.map((s) => {
      const metadata = s.extractedMetadata as ExtractedMetadata | null;
      const parsedParts = s.parsedParts as ParsedPartRecord[] | null;
      const parseStatus = s.parseStatus as ParseStatus | null;
      const secondPassStatus = s.secondPassStatus as SecondPassStatus | null;
      const exceptionKind = deriveExceptionKind(
        parseStatus,
        secondPassStatus,
        s.requiresHumanReview,
        s.confidenceScore
      );

      return {
        id: s.uploadSessionId,
        fileName: s.fileName,
        fileSize: s.fileSize,
        mimeType: s.mimeType,
        storageKey: s.storageKey,
        confidenceScore: s.confidenceScore,
        status: s.status,
        uploadedBy: s.uploadedBy,
        reviewedBy: s.reviewedBy,
        reviewedAt: s.reviewedAt,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        extractedMetadata: metadata,
        parsedParts: parsedParts,
        parseStatus,
        secondPassStatus,
        autoApproved: s.autoApproved,
        cuttingInstructions: s.cuttingInstructions as CuttingInstruction[] | null,
        requiresHumanReview: s.requiresHumanReview,
        routingDecision: s.routingDecision,
        exceptionQueue: {
          kind: exceptionKind,
          summary: deriveExceptionSummary(exceptionKind, s.confidenceScore, metadata),
          original: {
            fileName: s.fileName,
            storageKey: s.storageKey,
            links: buildOriginalLinks(s.uploadSessionId),
          },
          parts: (parsedParts ?? []).map((part) => ({
            ...part,
            links: buildPartLinks(s.uploadSessionId, part.storageKey),
          })),
          provenance: {
            sourceSha256: metadata && 'sourceSha256' in metadata ? (metadata as Record<string, unknown>).sourceSha256 : null,
            rawOcrTextAvailable: Boolean(s.rawOcrText),
            ocrEngineUsed: s.ocrEngineUsed ?? metadata?.ocrProvenance?.ocrEngine ?? metadata?.ocrProvenance?.textLayerEngine ?? null,
            ocrTextChars: s.ocrTextChars,
            llmFallbackReasons: metadata?.ocrProvenance?.llmFallbackReasons ?? [],
            strategyHistoryCount: Array.isArray(s.strategyHistory) ? s.strategyHistory.length : 0,
          },
        },
      };
    });

    // Get counts by status (optimized into a single query)
    const statusCounts = await prisma.smartUploadSession.groupBy({
      by: ['status'],
      where: { status: { in: ['REQUIRES_REVIEW', 'MANUALLY_APPROVED', 'AUTO_COMMITTED', 'REJECTED', 'FAILED', 'PROCESSING', 'AUTO_COMMITTING', 'PENDING_REVIEW', 'APPROVED'] } },
      _count: { _all: true },
    });

    // Map grouped counts to individual variables
    const pendingCount = (statusCounts.find(c => c.status === 'REQUIRES_REVIEW')?._count._all ?? 0)
      + (statusCounts.find(c => c.status === 'PENDING_REVIEW')?._count._all ?? 0);
    const approvedCount = (statusCounts.find(c => c.status === 'MANUALLY_APPROVED')?._count._all ?? 0)
      + (statusCounts.find(c => c.status === 'AUTO_COMMITTED')?._count._all ?? 0)
      + (statusCounts.find(c => c.status === 'APPROVED')?._count._all ?? 0);
    const rejectedCount = statusCounts.find(c => c.status === 'REJECTED')?._count._all ?? 0;
    const processingCount = (statusCounts.find(c => c.status === 'PROCESSING')?._count._all ?? 0)
      + (statusCounts.find(c => c.status === 'AUTO_COMMITTING')?._count._all ?? 0);
    const failedCount = statusCounts.find(c => c.status === 'FAILED')?._count._all ?? 0;

    return NextResponse.json({
      sessions: transformedSessions,
      pagination: {
        page,
        limit,
        totalCount,
        totalPages: Math.ceil(totalCount / limit),
      },
      stats: {
        pending: pendingCount,
        approved: approvedCount,
        rejected: rejectedCount,
        processing: processingCount,
        failed: failedCount,
      },
    });
  } catch (error) {
    logger.error('Failed to fetch upload sessions', { error });
    return NextResponse.json(
      { error: 'Failed to fetch upload sessions' },
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
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    },
  });
}
