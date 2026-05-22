import { NextRequest, NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/auth/guards';
import { requirePermission } from '@/lib/auth/permissions';
import { logger } from '@/lib/logger';
import { z } from 'zod';

import { MUSIC_EDIT } from '@/lib/auth/permission-constants';
const bulkArchiveSchema = z.object({
  ids: z.array(z.string()).min(1),
  archived: z.boolean(),
});

/**
 * POST /api/admin/music/bulk-archive
 * Archive or unarchive multiple music pieces
 */
export async function POST(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    await requirePermission(MUSIC_EDIT);

    const body = await request.json();
    const { ids, archived } = bulkArchiveSchema.parse(body);

    const result = await prisma.musicPiece.updateMany({
      where: { id: { in: ids } },
      data: { isArchived: archived },
    });

    logger.info(`Bulk ${archived ? 'archived' : 'unarchived'} music pieces`, {
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
      message: `${result.count} music piece(s) ${archived ? 'archived' : 'unarchived'} successfully`,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation error', details: error.issues },
        { status: 400 }
      );
    }
    logger.error('Failed to bulk archive music pieces', { error });
    return NextResponse.json(
      { error: 'Failed to bulk archive music pieces' },
      { status: 500 }
    );
  }
}
