/**
 * Admin control over watermarking.
 *
 * Watermarking is default-ON because copyrighted sheet music issued to a named
 * member has to be traceable. Disabling it is therefore an explicitly
 * privileged, audited act: only a user holding a library-administrator music
 * role (@/lib/music/access hasGlobalMusicAccess — the same authority that
 * grants standing to manage the catalog) may change the flag, and the change is
 * written to the audit log with a mandatory reason.
 *
 * Members can never reach this path: the function re-checks the role on every
 * call rather than trusting the caller (a route, a server action, a test).
 */

import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';
import { hasGlobalMusicAccess } from './access';

/** Why an admin is turning the watermark off. Required when disabling. */
export interface SetWatermarkInput {
  /** Who is making the change. */
  actorId: string;
  pieceId: string;
  enabled: boolean;
  /** Justification, mandatory when `enabled` is false. */
  reason?: string | null;
}

export type SetWatermarkResult =
  | { success: true; enabled: boolean }
  | { success: false; error: string; status: number };

const MAX_REASON_LENGTH = 500;

/**
 * Turn watermarking on or off for a piece.
 *
 * @returns `{ success: false, status: 403 }` for a non-admin, `404` for an
 *          unknown piece, `400` when disabling without a reason.
 */
export async function setPieceWatermark(
  input: SetWatermarkInput
): Promise<SetWatermarkResult> {
  const { actorId, pieceId, enabled } = input;
  const reason = input.reason?.trim() ?? '';

  if (!(await hasGlobalMusicAccess(actorId))) {
    logger.warn('Watermark change denied: not a library administrator', {
      actorId,
      pieceId,
      enabled,
    });
    return {
      success: false,
      status: 403,
      error: 'Only library administrators may change watermark settings',
    };
  }

  if (!enabled && reason.length === 0) {
    return {
      success: false,
      status: 400,
      error: 'A reason is required when disabling watermarking',
    };
  }

  if (reason.length > MAX_REASON_LENGTH) {
    return {
      success: false,
      status: 400,
      error: `Reason must be ${MAX_REASON_LENGTH} characters or fewer`,
    };
  }

  const piece = await prisma.musicPiece.findUnique({
    where: { id: pieceId },
    select: { id: true, watermarkEnabled: true },
  });
  if (!piece) {
    return { success: false, status: 404, error: 'Piece not found' };
  }

  await prisma.musicPiece.update({
    where: { id: pieceId },
    data: enabled
      ? {
          watermarkEnabled: true,
          watermarkDisabledBy: null,
          watermarkDisabledAt: null,
          watermarkDisabledReason: null,
        }
      : {
          watermarkEnabled: false,
          watermarkDisabledBy: actorId,
          watermarkDisabledAt: new Date(),
          watermarkDisabledReason: reason,
        },
  });

  await recordWatermarkAudit({
    actorId,
    pieceId,
    enabled,
    previous: piece.watermarkEnabled,
    reason,
  });

  logger.info('Watermark setting changed', { actorId, pieceId, enabled, reason });
  return { success: true, enabled };
}

/**
 * Audit trail entry. Imported lazily-compatible: auditLog is best-effort and
 * must never fail the change itself.
 */
async function recordWatermarkAudit(params: {
  actorId: string;
  pieceId: string;
  enabled: boolean;
  previous: boolean;
  reason: string;
}): Promise<void> {
  try {
    const { auditLog } = await import('@/lib/services/audit');
    await auditLog({
      action: params.enabled ? 'music.watermark.enable' : 'music.watermark.disable',
      entityType: 'MusicPiece',
      entityId: params.pieceId,
      oldValues: { watermarkEnabled: params.previous },
      newValues: {
        watermarkEnabled: params.enabled,
        actorId: params.actorId,
        reason: params.reason || null,
      },
    });
  } catch (error) {
    logger.error('Failed to audit watermark change', { error, pieceId: params.pieceId });
  }
}
