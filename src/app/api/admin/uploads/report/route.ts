import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requirePermission } from '@/lib/auth/permissions';
import { logger } from '@/lib/logger';

import { MUSIC_VIEW_ALL } from '@/lib/auth/permission-constants';
import { parseSmartUploadJsonField } from '@/lib/smart-upload/persistence';
export async function GET(_request: NextRequest) {
  try {
    await requirePermission(MUSIC_VIEW_ALL);
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    // Fetch sessions (limit to avoid runaway payloads)
    const sessions = await prisma.smartUploadSession.findMany({
      orderBy: { createdAt: 'desc' },
      take: 2000,
      select: {
        uploadSessionId: true,
        fileName: true,
        status: true,
        parseStatus: true,
        secondPassStatus: true,
        routingDecision: true,
        confidenceScore: true,
        requiresHumanReview: true,
        autoApproved: true,
        createdAt: true,
        updatedAt: true,
        extractedMetadata: true,
      },
    });

    return NextResponse.json({
      sessions: sessions.map((session) => ({
        ...session,
        extractedMetadata: parseSmartUploadJsonField(session.extractedMetadata, null),
      })),
    });
  } catch (error) {
    logger.error('Failed to fetch smart upload report', { error });
    return NextResponse.json({ error: 'Failed to fetch report' }, { status: 500 });
  }
}
