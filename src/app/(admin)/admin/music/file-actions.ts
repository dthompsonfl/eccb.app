'use server';

import { MUSIC_EDIT, MUSIC_VIEW_ALL } from '@/lib/auth/permission-constants';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db';
import { requirePermission } from '@/lib/auth/guards';
import { uploadFile, deleteFile } from '@/lib/services/storage';
import { auditLog } from '@/lib/services/audit';
import { FileType } from '@prisma/client';
import { invalidateMusicCache } from '@/lib/cache';

function getFileType(mimeType: string): FileType {
  if (mimeType.includes('pdf')) return FileType.FULL_SCORE;
  if (mimeType.includes('audio')) return FileType.AUDIO;
  return FileType.OTHER;
}

export async function uploadMusicFile(musicPieceId: string, formData: FormData) {
  const session = await requirePermission(MUSIC_EDIT);

  try {
    const file = formData.get('file') as File;
    const partType = formData.get('partType') as string | null;
    const instrumentId = formData.get('instrumentId') as string | null;
    const fileType = formData.get('fileType') as string | null;
    const description = formData.get('description') as string | null;
    const changeNote = formData.get('changeNote') as string | null;
    const existingFileId = formData.get('existingFileId') as string | null;

    if (!file || file.size === 0) {
      return { success: false, error: 'No file provided' };
    }

    const buffer = await file.arrayBuffer();
    const key = `music/${musicPieceId}/${Date.now()}-${file.name}`;
    await uploadFile(key, Buffer.from(buffer), {
      contentType: file.type,
    });

    // If updating an existing file (new version)
    if (existingFileId) {
      const existingFile = await prisma.musicFile.findUnique({
        where: { id: existingFileId },
        include: { versions: true },
      });

      if (!existingFile) {
        return { success: false, error: 'Existing file not found' };
      }

      // Create version record for the old version
      await prisma.musicFileVersion.create({
        data: {
          fileId: existingFile.id,
          version: existingFile.version,
          fileName: existingFile.fileName,
          storageKey: existingFile.storageKey,
          fileSize: existingFile.fileSize,
          mimeType: existingFile.mimeType,
          changeNote: changeNote || undefined,
          uploadedBy: session.user.id,
        },
      });

      // Update the main file record
      const updatedFile = await prisma.musicFile.update({
        where: { id: existingFileId },
        data: {
          fileName: file.name,
          storageKey: key,
          fileSize: file.size,
          mimeType: file.type,
          fileType: (fileType as FileType) || existingFile.fileType,
          description: description || existingFile.description,
          version: { increment: 1 },
        },
      });

      await auditLog({
        action: 'music.file.version',
        entityType: 'MusicFile',
        entityId: updatedFile.id,
        newValues: { fileName: file.name, version: updatedFile.version, pieceId: musicPieceId },
      });

      // Invalidate caches
      await invalidateMusicCache(musicPieceId);

      revalidatePath(`/admin/music/${musicPieceId}`);

      return { success: true, fileId: updatedFile.id, version: updatedFile.version };
    }

    // Create new file
    const musicFile = await prisma.musicFile.create({
      data: {
        pieceId: musicPieceId,
        fileName: file.name,
        storageKey: key,
        mimeType: file.type,
        fileSize: file.size,
        fileType: getFileType(file.type),
        description: description || undefined,
        uploadedBy: session.user.id,
      },
    });

    // Link to part if specified
    if (instrumentId && partType) {
      await prisma.musicPart.create({
        data: {
          pieceId: musicPieceId,
          instrumentId,
          partName: partType,
          fileId: musicFile.id,
        },
      });
    }

    await auditLog({
      action: 'music.file.upload',
      entityType: 'MusicFile',
      entityId: musicFile.id,
      newValues: { fileName: file.name, pieceId: musicPieceId },
    });

    // Invalidate caches
    await invalidateMusicCache(musicPieceId);

    revalidatePath(`/admin/music/${musicPieceId}`);

    return { success: true, fileId: musicFile.id };
  } catch (error) {
    console.error('Failed to upload music file:', error);
    return { success: false, error: 'Failed to upload file' };
  }
}

export async function updateMusicFile(fileId: string, data: {
  description?: string;
  fileType?: FileType;
  isPublic?: boolean;
}) {
  const _session = await requirePermission(MUSIC_EDIT);

  try {
    const file = await prisma.musicFile.findUnique({
      where: { id: fileId },
    });

    if (!file) {
      return { success: false, error: 'File not found' };
    }

    const _updatedFile = await prisma.musicFile.update({
      where: { id: fileId },
      data,
    });

    await auditLog({
      action: 'music.file.update',
      entityType: 'MusicFile',
      entityId: fileId,
      oldValues: {
        description: file.description,
        fileType: file.fileType,
        isPublic: file.isPublic
      },
      newValues: data,
    });

    // Invalidate caches
    await invalidateMusicCache(file.pieceId);

    revalidatePath(`/admin/music/${file.pieceId}`);

    return { success: true };
  } catch (error) {
    console.error('Failed to update music file:', error);
    return { success: false, error: 'Failed to update file' };
  }
}

export async function getFileVersionHistory(fileId: string) {
  await requirePermission(MUSIC_VIEW_ALL);

  try {
    const versions = await prisma.musicFileVersion.findMany({
      where: { fileId },
      orderBy: { version: 'desc' },
    });

    return { success: true, versions };
  } catch (error) {
    console.error('Failed to get file version history:', error);
    return { success: false, error: 'Failed to get version history' };
  }
}

export async function archiveMusicFile(fileId: string) {
  await requirePermission(MUSIC_EDIT);

  try {
    const file = await prisma.musicFile.findUnique({
      where: { id: fileId },
    });

    if (!file) {
      return { success: false, error: 'File not found' };
    }

    // Soft delete by marking as archived (preserves version history)
    await prisma.musicFile.update({
      where: { id: fileId },
      data: { isArchived: true },
    });

    await auditLog({
      action: 'music.file.archive',
      entityType: 'MusicFile',
      entityId: fileId,
      newValues: { fileName: file.fileName, pieceId: file.pieceId },
    });

    // Invalidate caches
    await invalidateMusicCache(file.pieceId);

    revalidatePath(`/admin/music/${file.pieceId}`);

    return { success: true };
  } catch (error) {
    console.error('Failed to archive music file:', error);
    return { success: false, error: 'Failed to archive file' };
  }
}

export async function deleteMusicFile(fileId: string) {
  await requirePermission(MUSIC_EDIT);

  try {
    const file = await prisma.musicFile.findUnique({
      where: { id: fileId },
    });

    if (!file) {
      return { success: false, error: 'File not found' };
    }

    await deleteFile(file.storageKey);
    await prisma.musicFile.delete({ where: { id: file.id } });

    await auditLog({
      action: 'music.file.delete',
      entityType: 'MusicFile',
      entityId: fileId,
      newValues: { fileName: file.fileName, pieceId: file.pieceId },
    });

    // Invalidate caches
    await invalidateMusicCache(file.pieceId);

    revalidatePath(`/admin/music/${file.pieceId}`);

    return { success: true };
  } catch (error) {
    console.error('Failed to delete music file:', error);
    return { success: false, error: 'Failed to delete file' };
  }
}
