import { NextRequest, NextResponse } from 'next/server';import { revalidatePath } from 'next/cache';import { prisma } from '@/lib/db';
import { getSession } from '@/lib/auth/guards';
import { requirePermission } from '@/lib/auth/permissions';
import { logger } from '@/lib/logger';
import { z } from 'zod';

import { MUSIC_EDIT } from '@/lib/auth/permission-constants';
const bulkRestoreSchema = z.object({
  ids: z.array(z.string()).min(1),
});

/**
 * POST /api/admin/music/bulk-restore
 * Restore multiple music pieces from trash
 */
export async function POST(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    await requirePermission(MUSIC_EDIT);

    const body = await request.json();
    const { ids } = bulkRestoreSchema.parse(body);

    const result = await prisma.musicPiece.updateMany({
      where: { id: { in: ids }, deletedAt: { not: null } },
      data: { deletedAt: null },
    });

    logger.info('Bulk restored music pieces from trash', {
      count: result.count,
      ids,
      userId: session.user.id,
    });
    // Invalidate cache for music library page
    revalidatePath('/admin/music');
    revalidatePath('/member/music');
    return NextResponse.json({
      success: true,
      count: result.count,
      message: `${result.count} music piece(s) restored from trash`,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation error', details: error.issues },
        { status: 400 }
      );
    }
    logger.error('Failed to bulk restore music pieces', { error });
    return NextResponse.json(
      { error: 'Failed to bulk restore music pieces' },
      { status: 500 }
    );
  }
}
