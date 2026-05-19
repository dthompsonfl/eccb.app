/**
 * /api/stand/practice-logs
 *
 * GET  — list practice logs (own logs only; directors can view any user's logs)
 * POST — create a practice log entry (active members only)
 *
 * Gated behind practiceTrackingEnabled setting.
 */

import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { applyRateLimit } from '@/lib/rate-limit';
import { z } from 'zod';
import { requireStandAccess, canAccessPiece } from '@/lib/stand/access';
import { getStandSettings } from '@/lib/stand/settings';
import {
  jsonOk,
  json400,
  json404,
  json500,
  parseBody,
  cuidSchema,
} from '@/lib/stand/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const practiceLogCreateSchema = z.object({
  pieceId: cuidSchema,
  assignmentId: cuidSchema.optional(),
  durationSeconds: z.number().int().positive().max(86_400).optional(),
  durationMinutes: z.number().int().positive().max(1_440).optional(),
  notes: z.string().max(2000).optional(),
  practicedAt: z.string().datetime().optional(),
});

export async function GET(request: NextRequest) {
  try {
    const rateLimited = await applyRateLimit(request, 'stand-annotation');
    if (rateLimited) return rateLimited;

    const settings = await getStandSettings();
    if (!settings.practiceTrackingEnabled) {
      return json404('Practice tracking is disabled');
    }

    const ctx = await requireStandAccess();
    if (ctx instanceof Response) return ctx;

    const { searchParams } = new URL(request.url);
    const pieceId = searchParams.get('pieceId');
    const requestedUserId = searchParams.get('userId');
    const limit = Math.min(parseInt(searchParams.get('limit') ?? '50', 10), 200);
    const offset = parseInt(searchParams.get('offset') ?? '0', 10);

    if (pieceId) {
      const hasPieceAccess = await canAccessPiece(ctx.userId, pieceId);
      if (!hasPieceAccess) return json404('Piece not found or not accessible');
    }

    const targetUserId = ctx.isDirector && requestedUserId ? requestedUserId : ctx.userId;

    const where: Record<string, unknown> = { userId: targetUserId };
    if (pieceId) where.pieceId = pieceId;

    const [logs, total] = await Promise.all([
      prisma.practiceLog.findMany({
        where,
        include: {
          piece: {
            select: {
              id: true,
              title: true,
              composer: { select: { fullName: true } },
            },
          },
        },
        orderBy: { practicedAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.practiceLog.count({ where }),
    ]);

    return jsonOk({ logs, total, limit, offset });
  } catch (error) {
    console.error('[PracticeLogs GET]', error);
    return json500();
  }
}

export async function POST(request: NextRequest) {
  try {
    const rateLimited = await applyRateLimit(request, 'stand-annotation');
    if (rateLimited) return rateLimited;

    const settings = await getStandSettings();
    if (!settings.practiceTrackingEnabled) {
      return json404('Practice tracking is disabled');
    }

    const ctx = await requireStandAccess();
    if (ctx instanceof Response) return ctx;

    const parsed = await parseBody(request, practiceLogCreateSchema);
    if (parsed instanceof Response) return parsed;

    const { pieceId, assignmentId, durationSeconds, durationMinutes, notes, practicedAt } = parsed;

    const hasAccess = await canAccessPiece(ctx.userId, pieceId);
    if (!hasAccess) return json404('Piece not found or not accessible');

    const normalizedDurationSeconds =
      durationSeconds ??
      (durationMinutes !== undefined ? durationMinutes * 60 : undefined);

    if (!normalizedDurationSeconds) {
      return json400('durationSeconds or durationMinutes is required');
    }

    const log = await prisma.practiceLog.create({
      data: {
        userId: ctx.userId,
        pieceId,
        assignmentId: assignmentId ?? null,
        durationSeconds: normalizedDurationSeconds,
        notes: notes ?? null,
        practicedAt: practicedAt ? new Date(practicedAt) : new Date(),
      },
      include: {
        piece: {
          select: {
            id: true,
            title: true,
            composer: { select: { fullName: true } },
          },
        },
      },
    });

    return jsonOk({ log }, 201);
  } catch (error) {
    console.error('[PracticeLogs POST]', error);
    return json500();
  }
}
