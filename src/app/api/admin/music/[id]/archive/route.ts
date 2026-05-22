import { NextRequest, NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/auth/guards';
import { requirePermission } from '@/lib/auth/permissions';
import { logger } from '@/lib/logger';

import { MUSIC_EDIT } from '@/lib/auth/permission-constants';
/**
 * POST /api/admin/music/[id]/archive
 * Archive or unarchive a music piece
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    await requirePermission(MUSIC_EDIT);

    const { id } = await params;
    const body = await request.json();
    const { archived } = body;

    const piece = await prisma.musicPiece.findUnique({
      where: { id },
      select: { id: true, title: true, isArchived: true },
    });

    if (!piece) {
      return NextResponse.json({ error: 'Music piece not found' }, { status: 404 });
    }

    const updated = await prisma.musicPiece.update({
      where: { id },
      data: { isArchived: archived },
      select: { id: true, title: true, isArchived: true },
    });

    logger.info(`Music piece ${archived ? 'archived' : 'unarchived'}`, {
      pieceId: id,
      title: piece.title,
      userId: session.user.id,
    });

    // Invalidate cache for music pages
    revalidatePath('/admin/music');
    revalidatePath(`/admin/music/${id}`);
    revalidatePath('/member/music');

    return NextResponse.json({
      success: true,
      piece: updated,
      message: archived ? 'Music archived successfully' : 'Music unarchived successfully',
    });
  } catch (error) {
    logger.error('Failed to archive music piece', { error });
    return NextResponse.json(
      { error: 'Failed to archive music piece' },
      { status: 500 }
    );
  }
}
