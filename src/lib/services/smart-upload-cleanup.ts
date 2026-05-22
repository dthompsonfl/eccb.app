import { prisma } from '@/lib/db';
import { deleteFile } from '@/lib/services/storage';
import { logger } from '@/lib/logger';
import { parseSmartUploadJsonArray, serializeSmartUploadJsonField } from '@/lib/smart-upload/persistence';

/**
 * Delete all temporary files associated with a SmartUploadSession.
 * Safe to call on reject OR on re-processing.
 *
 * Does NOT delete:
 *   - The original upload file (storageKey on SmartUploadSession)
 *   - Any MusicFile storageKeys that have already been committed to the DB
 *
 * Corp-grade goals:
 * - Stable, defensive handling when JSON fields are malformed
 * - No sensitive content logging
 * - Reduce N+1 queries without changing results
 * - Structured success/failure metrics
 */

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

function safeErrorDetails(err: unknown) {
  const e = asError(err);
  return { errorMessage: e.message, errorName: e.name, errorStack: e.stack };
}

/**
 * Delete all temporary files associated with a SmartUploadSession.
 *
 * @param sessionId - The uploadSessionId of the SmartUploadSession
 */
export async function cleanupSmartUploadTempFiles(sessionId: string): Promise<void> {
  const start = Date.now();

  // Step 1: Fetch the SmartUploadSession by uploadSessionId
  const session = await prisma.smartUploadSession.findUnique({
    where: { uploadSessionId: sessionId },
  });

  if (!session) {
    logger.warn('SmartUploadSession not found for cleanup', { sessionId });
    return;
  }

  // Step 2: Parse tempFiles JSON array from the session
  const tempFiles = parseSmartUploadJsonArray<string>(session.tempFiles);

  if (tempFiles.length === 0) {
    logger.info('No temp files to clean up', { sessionId });
    return;
  }

  // Step 3: Parse parsedParts JSON array from the session
  const parsedParts = parseSmartUploadJsonArray<{ storageKey?: string }>(session.parsedParts);

  // Step 4: Get storageKeys from parsedParts (these are the split part files)
  const committedStorageKeys = new Set<string>();

  // Also include the original upload file storageKey
  if (session.storageKey) {
    committedStorageKeys.add(session.storageKey);
  }

  // Collect candidate part keys
  const partStorageKeys = parsedParts
    .map((p) => p.storageKey)
    .filter((k): k is string => typeof k === 'string' && k.length > 0);

  // Step 5: Query MusicFile + MusicPart to find any storageKeys that have been committed to the DB
  // (Optimization: do bulk queries; behavior equivalent to the old per-key findFirst loop)
  try {
    if (partStorageKeys.length > 0) {
      const [committedFiles, committedParts] = await Promise.all([
        prisma.musicFile.findMany({
          where: { storageKey: { in: partStorageKeys } },
          select: { storageKey: true },
        }),
        prisma.musicPart.findMany({
          where: { storageKey: { in: partStorageKeys } },
          select: { storageKey: true },
        }),
      ]);

      for (const f of committedFiles) {
        if (f.storageKey) committedStorageKeys.add(f.storageKey);
      }
      for (const p of committedParts) {
        if (p.storageKey) committedStorageKeys.add(p.storageKey);
      }
    }
  } catch (err) {
    // If this check fails, we should be conservative and avoid deleting anything risky.
    const details = safeErrorDetails(err);
    logger.error('Failed to query committed storage keys; aborting cleanup to be safe', {
      sessionId,
      ...details,
    });
    return;
  }

  // Step 6: Determine which tempFiles are NOT in any committed MusicFile/MusicPart record
  const filesToDelete = tempFiles.filter((fileKey) => !committedStorageKeys.has(fileKey));

  if (filesToDelete.length === 0) {
    logger.info('All temp files are committed, nothing to delete', {
      sessionId,
      tempFilesCount: tempFiles.length,
    });
    return;
  }

  // Step 7: Delete those files using deleteFile from storage service
  let deletedCount = 0;
  let failedCount = 0;

  for (const fileKey of filesToDelete) {
    try {
      await deleteFile(fileKey);
      deletedCount++;
      logger.info('Deleted temp file', { sessionId, fileKey });
    } catch (error) {
      failedCount++;
      const details = safeErrorDetails(error);
      logger.error('Failed to delete temp file', {
        sessionId,
        fileKey,
        ...details,
      });
    }
  }

  // Step 8: Update SmartUploadSession.tempFiles to empty array
  try {
    await prisma.smartUploadSession.update({
      where: { uploadSessionId: sessionId },
      data: { tempFiles: serializeSmartUploadJsonField([]) },
    });
  } catch (err) {
    const details = safeErrorDetails(err);
    // Cleanup succeeded but session update failed; log loudly but do not throw.
    logger.error('Failed to clear SmartUploadSession.tempFiles after cleanup', {
      sessionId,
      ...details,
    });
  }

  // Step 9: Log all deletions
  logger.info('Smart upload temp files cleanup complete', {
    sessionId,
    totalTempFiles: tempFiles.length,
    deletedCount,
    failedCount,
    // This is count of committed keys we excluded from deletion (not necessarily 1:1 with tempFiles)
    skippedCommittedKeyCount: committedStorageKeys.size,
    durationMs: Date.now() - start,
  });
}