import { NextRequest, NextResponse } from 'next/server';import { revalidatePath } from 'next/cache';import { prisma } from '@/lib/db';
import { getSession } from '@/lib/auth/guards';
import { requirePermission } from '@/lib/auth/permissions';
import { logger } from '@/lib/logger';

import { MUSIC_EDIT } from '@/lib/auth/permission-constants';
/**
 * POST /api/admin/music/[id]/restore
 * Restore a music piece from trash
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

    const piece = await prisma.musicPiece.findUnique({
      where: { id },
      select: { id: true, title: true, deletedAt: true },
    });

    if (!piece) {
      return NextResponse.json({ error: 'Music piece not found' }, { status: 404 });
    }

    if (!piece.deletedAt) {
      return NextResponse.json(
        { error: 'Music piece is not in trash' },
        { status: 400 }
      );
    }

    const updated = await prisma.musicPiece.update({
      where: { id },
      data: { deletedAt: null },
      select: { id: true, title: true, deletedAt: true },
    });

    logger.info('Music piece restored from trash', {
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
      message: 'Music restored from trash',
    });
  } catch (error) {
    logger.error('Failed to restore music piece', { error });
    return NextResponse.json(
      { error: 'Failed to restore music piece' },
      { status: 500 }
    );
  }
}
