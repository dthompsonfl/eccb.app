/**
 * /api/stand/annotations
 *
 * GET  — fetch annotations (scoped by session + layer permissions)
 * POST — create annotation (enforces layer + stroke size limits)
 */

import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { applyRateLimit } from '@/lib/rate-limit';
import { z } from 'zod';
import {
  requireStandAccess,
  annotationVisibilityFilter,
  assertCanWriteLayer,
  canAccessPiece,
} from '@/lib/stand/access';
import { getStandSettings } from '@/lib/stand/settings';
import {
  jsonOk,
  json400,
  json404,
  json500,
  parseBody,
  cuidSchema,
  layerSchema,
} from '@/lib/stand/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const annotationCreateSchema = z.object({
  musicId: cuidSchema,
  page: z.number().int().positive().max(5000),
  layer: layerSchema,
  strokeData: z.record(z.string(), z.unknown()),
  sectionId: cuidSchema.nullable().optional(),
});

function normalizeStrokeData(strokeData: unknown): Record<string, unknown> {
  if (typeof strokeData === 'string') {
    try {
      const parsed = JSON.parse(strokeData);
      return parsed && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  return strokeData && typeof strokeData === 'object'
    ? (strokeData as Record<string, unknown>)
    : {};
}

export async function GET(request: NextRequest) {
  try {
    const rateLimited = await applyRateLimit(request, 'stand-annotation');
    if (rateLimited) return rateLimited;

    const ctx = await requireStandAccess();
    if (ctx instanceof Response) return ctx;

    const { searchParams } = new URL(request.url);
    const musicId = searchParams.get('musicId');
    const page = searchParams.get('page');
    const layer = searchParams.get('layer');

    if (!musicId) return json400('musicId query param required');

    const hasPieceAccess = await canAccessPiece(ctx.userId, musicId);
    if (!hasPieceAccess) return json404('Piece not found');

    const visibilityFilter = annotationVisibilityFilter(ctx, musicId);
    const where: Record<string, unknown> = { ...visibilityFilter };
    if (page) where.page = parseInt(page, 10);
    if (layer && ['PERSONAL', 'SECTION', 'DIRECTOR'].includes(layer)) {
      where.layer = layer;
    }

    const annotations = await prisma.annotation.findMany({
      where,
      select: {
        id: true,
        musicId: true,
        page: true,
        layer: true,
        strokeData: true,
        userId: true,
        sectionId: true,
        createdAt: true,
        updatedAt: true,
        user: { select: { id: true, name: true } },
      },
      orderBy: [{ page: 'asc' }, { createdAt: 'asc' }],
    });

    return jsonOk({
      annotations: annotations.map((annotation) => ({
        ...annotation,
        strokeData: normalizeStrokeData(annotation.strokeData),
      })),
    });
  } catch (error) {
    console.error('[Annotations GET]', error);
    return json500();
  }
}

export async function POST(request: NextRequest) {
  try {
    const rateLimited = await applyRateLimit(request, 'stand-annotation');
    if (rateLimited) return rateLimited;

    const ctx = await requireStandAccess();
    if (ctx instanceof Response) return ctx;

    const parsed = await parseBody(request, annotationCreateSchema);
    if (parsed instanceof Response) return parsed;

    const { musicId, page, layer, strokeData, sectionId } = parsed;

    const hasPieceAccess = await canAccessPiece(ctx.userId, musicId);
    if (!hasPieceAccess) return json404('Piece not found');

    const layerErr = assertCanWriteLayer(ctx, layer, sectionId);
    if (layerErr) return layerErr;

    const settings = await getStandSettings();
    const strokeJson = JSON.stringify(strokeData);
    if (strokeJson.length > settings.maxStrokeDataBytes) {
      return json400(
        `Stroke data exceeds limit (${settings.maxStrokeDataBytes} bytes)`
      );
    }

    const count = await prisma.annotation.count({
      where: { musicId, page, userId: ctx.userId, layer: 'PERSONAL' },
    });

    if (layer === 'PERSONAL' && count >= settings.maxAnnotationsPerPage) {
      return json400(
        `Annotation limit reached for this page (max ${settings.maxAnnotationsPerPage})`
      );
    }

    const annotation = await prisma.annotation.create({
      data: {
        musicId,
        page,
        layer,
        strokeData,
        userId: ctx.userId,
        sectionId:
          layer === 'SECTION'
            ? (sectionId ?? ctx.userSectionIds[0] ?? null)
            : null,
      },
    });

    return jsonOk(
      {
        annotation: {
          ...annotation,
          strokeData: normalizeStrokeData(annotation.strokeData),
        },
      },
      201
    );
  } catch (error) {
    console.error('[Annotations POST]', error);
    return json500();
  }
}
