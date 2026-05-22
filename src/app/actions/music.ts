'use server';

import { MUSIC_CREATE, MUSIC_DELETE, MUSIC_EDIT } from '@/lib/auth/permission-constants';

import { prisma } from '@/lib/db';
import { requirePermission } from '@/lib/auth/permissions';
import { auditLog } from '@/lib/services/audit';
import { z } from 'zod';

const musicPieceSchema = z.object({
  title: z.string().min(1, 'Title is required'),
  subtitle: z.string().optional(),
  composerId: z.string().optional(),
  arrangerId: z.string().optional(),
  publisherId: z.string().optional(),
  difficulty: z.enum(['GRADE_1', 'GRADE_2', 'GRADE_3', 'GRADE_4', 'GRADE_5', 'GRADE_6']).optional(),
  duration: z.number().optional(),
  notes: z.string().optional(),
  catalogNumber: z.string().optional(),
});

export async function createMusicPiece(data: z.infer<typeof musicPieceSchema>) {
  await requirePermission(MUSIC_CREATE);

  const validated = musicPieceSchema.parse(data);

  const piece = await prisma.musicPiece.create({
    data: validated,
  });

  await auditLog({
    action: 'CREATE',
    entityType: 'MusicPiece',
    entityId: piece.id,
    newValues: piece,
  });

  return piece;
}

export async function updateMusicPiece(id: string, data: Partial<z.infer<typeof musicPieceSchema>>) {
  await requirePermission(MUSIC_EDIT);

  const validated = musicPieceSchema.partial().parse(data);

  const piece = await prisma.musicPiece.update({
    where: { id },
    data: validated,
  });

  await auditLog({
    action: 'UPDATE',
    entityType: 'MusicPiece',
    entityId: id,
    newValues: piece,
  });

  return piece;
}

export async function deleteMusicPiece(id: string) {
  await requirePermission(MUSIC_DELETE);

  const piece = await prisma.musicPiece.delete({
    where: { id },
  });

  await auditLog({
    action: 'DELETE',
    entityType: 'MusicPiece',
    entityId: id,
    oldValues: piece,
  });
}
