/**
 * /api/stand/audio
 *
 * GET    — list audio links for a piece (requires stand access + piece access)
 * POST   — create audio link (director/librarian only)
 * PUT    — update audio link by query param id (director/librarian only)
 * DELETE — delete audio link by query param id (director/librarian only)
 */

import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { applyRateLimit } from '@/lib/rate-limit';
import { z } from 'zod';
import { requireStandAccess, canAccessPiece } from '@/lib/stand/access';
import {
  jsonOk,
  json400,
  json403,
  json404,
  json500,
  parseBody,
  cuidSchema,
} from '@/lib/stand/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const audioCreateSchema = z.object({
  pieceId: cuidSchema,
  fileKey: z.string().max(500).optional().nullable(),
  url: z.string().url().max(2000).nullable().optional(),
  description: z.string().max(500).optional(),
});

const audioUpdateSchema = z.object({
  fileKey: z.string().max(500).optional().nullable(),
  url: z.string().url().max(2000).nullable().optional(),
  description: z.string().max(500).nullable().optional(),
});

function normalizeAudioPayload(input: {
  fileKey?: string | null;
  url?: string | null;
  description?: string | null;
}) {
  return {
    fileKey: input.fileKey?.trim() ?? '',
    url: input.url?.trim() || null,
    description: input.description?.trim() || null,
  };
}

async function requireManageableAudioLink(userId: string, id: string) {
  const audioLink = await prisma.audioLink.findUnique({ where: { id } });
  if (!audioLink) return { error: json404('Audio link not found') };

  const hasAccess = await canAccessPiece(userId, audioLink.pieceId);
  if (!hasAccess) return { error: json404('Piece not found') };

  return { audioLink };
}

export async function GET(request: NextRequest) {
  try {
    const rateLimited = await applyRateLimit(request, 'stand-annotation');
    if (rateLimited) return rateLimited;

    const ctx = await requireStandAccess();
    if (ctx instanceof Response) return ctx;

    const { searchParams } = new URL(request.url);
    const pieceId = searchParams.get('pieceId');
    if (!pieceId) return json400('pieceId query param required');

    const hasAccess = await canAccessPiece(ctx.userId, pieceId);
    if (!hasAccess) return json404('Piece not found');

    const audioLinks = await prisma.audioLink.findMany({
      where: { pieceId },
      orderBy: { createdAt: 'desc' },
    });

    return jsonOk({ audioLinks });
  } catch (error) {
    console.error('[Audio GET]', error);
    return json500();
  }
}

export async function POST(request: NextRequest) {
  try {
    const rateLimited = await applyRateLimit(request, 'stand-annotation');
    if (rateLimited) return rateLimited;

    const ctx = await requireStandAccess();
    if (ctx instanceof Response) return ctx;

    if (!ctx.isLibrarian) {
      return json403('Only directors or librarians can add audio links');
    }

    const parsed = await parseBody(request, audioCreateSchema);
    if (parsed instanceof Response) return parsed;

    const { pieceId, fileKey, url, description } = parsed;
    const normalized = normalizeAudioPayload({ fileKey, url, description });

    const hasAccess = await canAccessPiece(ctx.userId, pieceId);
    if (!hasAccess) return json404('Piece not found');

    if (!normalized.fileKey && !normalized.url) {
      return json400('Either fileKey or url must be provided');
    }

    const audioLink = await prisma.audioLink.create({
      data: {
        pieceId,
        fileKey: normalized.fileKey,
        url: normalized.url,
        description: normalized.description,
      },
    });

    return jsonOk({ audioLink }, 201);
  } catch (error) {
    console.error('[Audio POST]', error);
    return json500();
  }
}

export async function PUT(request: NextRequest) {
  try {
    const rateLimited = await applyRateLimit(request, 'stand-annotation');
    if (rateLimited) return rateLimited;

    const ctx = await requireStandAccess();
    if (ctx instanceof Response) return ctx;
    if (!ctx.isLibrarian) {
      return json403('Only directors or librarians can update audio links');
    }

    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    if (!id) return json400('id query param required');

    const existing = await requireManageableAudioLink(ctx.userId, id);
    if (existing.error) return existing.error;

    const parsed = await parseBody(request, audioUpdateSchema);
    if (parsed instanceof Response) return parsed;

    const normalized = normalizeAudioPayload(parsed);
    if (!normalized.fileKey && !normalized.url) {
      return json400('Either fileKey or url must be provided');
    }

    const audioLink = await prisma.audioLink.update({
      where: { id },
      data: normalized,
    });

    return jsonOk({ audioLink });
  } catch (error) {
    console.error('[Audio PUT]', error);
    return json500();
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const rateLimited = await applyRateLimit(request, 'stand-annotation');
    if (rateLimited) return rateLimited;

    const ctx = await requireStandAccess();
    if (ctx instanceof Response) return ctx;
    if (!ctx.isLibrarian) {
      return json403('Only directors or librarians can delete audio links');
    }

    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    if (!id) return json400('id query param required');

    const existing = await requireManageableAudioLink(ctx.userId, id);
    if (existing.error) return existing.error;

    await prisma.audioLink.delete({ where: { id } });
    return jsonOk({ success: true });
  } catch (error) {
    console.error('[Audio DELETE]', error);
    return json500();
  }
}
