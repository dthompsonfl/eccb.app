/**
 * /api/stand/navigation-links
 *
 * GET  — list navigation links for a piece (any stand member)
 * POST — create navigation link (director/librarian only)
 */

import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { applyRateLimit } from '@/lib/rate-limit';
import { z } from 'zod';
import { requireStandAccess, canAccessPiece } from '@/lib/stand/access';
import { jsonOk, json400, json403, json404, json500, parseBody, cuidSchema } from '@/lib/stand/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const navLinkCreateSchema = z.object({
  musicId: cuidSchema,
  fromPage: z.number().int().positive().max(5000).default(1),
  fromX: z.number().min(0).max(1),
  fromY: z.number().min(0).max(1),
  toPage: z.number().int().positive().max(5000).default(1),
  toMusicId: cuidSchema.nullable().optional(),
  toX: z.number().min(0).max(1),
  toY: z.number().min(0).max(1),
  label: z.string().max(200).optional(),
});

export async function GET(request: NextRequest) {
  try {
    const rateLimited = await applyRateLimit(request, 'stand-annotation');
    if (rateLimited) return rateLimited;

    const ctx = await requireStandAccess();
    if (ctx instanceof Response) return ctx;

    const { searchParams } = new URL(request.url);
    const musicId = searchParams.get('musicId');
    if (!musicId) return json400('musicId query param required');

    const hasAccess = await canAccessPiece(ctx.userId, musicId);
    if (!hasAccess) return json404('Piece not found');

    const navigationLinks = await prisma.navigationLink.findMany({
      where: { musicId },
      orderBy: { createdAt: 'asc' },
    });

    return jsonOk({ navigationLinks });
  } catch (error) {
    console.error('[NavLinks GET]', error);
    return json500();
  }
}

export async function POST(request: NextRequest) {
  try {
    const rateLimited = await applyRateLimit(request, 'stand-annotation');
    if (rateLimited) return rateLimited;

    const ctx = await requireStandAccess();
    if (ctx instanceof Response) return ctx;

    // Navigation links are director/librarian-only (they guide the whole ensemble)
    if (!ctx.isLibrarian) return json403('Only directors or librarians can create navigation links');

    const parsed = await parseBody(request, navLinkCreateSchema);
    if (parsed instanceof Response) return parsed;

    const { musicId, fromPage, fromX, fromY, toPage, toMusicId, toX, toY, label } = parsed;

    const hasSourceAccess = await canAccessPiece(ctx.userId, musicId);
    if (!hasSourceAccess) return json404('Source piece not found');

    if (toMusicId) {
      const hasTargetAccess = await canAccessPiece(ctx.userId, toMusicId);
      if (!hasTargetAccess) return json404('Destination piece not found');
    }

    const link = await prisma.navigationLink.create({
      data: {
        musicId,
        fromPage,
        fromX,
        fromY,
        toPage,
        toMusicId: toMusicId ?? null,
        toX,
        toY,
        label: label ?? null,
      },
    });

    return jsonOk({ navigationLink: link }, 201);
  } catch (error) {
    console.error('[NavLinks POST]', error);
    return json500();
  }
}
