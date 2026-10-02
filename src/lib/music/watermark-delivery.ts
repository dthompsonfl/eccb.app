/**
 * Delivery-time watermarking glue.
 *
 * Sits between an AUTHORIZED delivery (proven by @/lib/music/access or
 * @/lib/stand/access) and the bytes going out. Its single job: decide whether
 * this piece is watermarked, work out who the copy is for, and stamp.
 *
 * It is NOT an access check and must never be used as one. Authorization runs
 * first and unchanged; this module only ever runs afterwards, on bytes that
 * have already been proven deliverable. An unauthorized caller must be turned
 * away by the route before {@link applyDeliveryWatermark} is ever called.
 */

import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { prisma } from '@/lib/db';
import {
  buildWatermarkText,
  watermarkForDelivery,
  WatermarkError,
  type WatermarkRecipient,
} from './watermark';

/** Result of stamping one delivery. */
export interface WatermarkedDelivery {
  /** Bytes to actually send. */
  bytes: Uint8Array;
  /** Whether a visible watermark was applied (false for non-PDF or disabled). */
  watermarked: boolean;
  /** Size of `bytes`, for the Content-Length header. */
  size: number;
  /** Attribution text stamped into the file, for logging. */
  attribution: string | null;
}

/** Resolved per-piece watermark decision. */
export interface WatermarkPolicy {
  /** Watermark required for this delivery? */
  enabled: boolean;
  /** Piece title, stamped alongside the recipient for traceability. */
  pieceTitle: string | null;
  /** True when the piece has no record at all (caller proved access anyway). */
  unknownPiece: boolean;
}

const PDF_CONTENT_TYPES = ['application/pdf', 'application/x-pdf'];

/**
 * Resolve the watermark policy for a piece.
 *
 * DEFAULT-SECURE: a missing row, a lookup error, or a null `watermarkEnabled`
 * all resolve to enabled. Only an explicit `false` — written by the audited
 * admin path in ./watermark-policy — disables it.
 */
export async function resolveWatermarkPolicy(pieceId: string): Promise<WatermarkPolicy> {
  try {
    const piece = await prisma.musicPiece.findUnique({
      where: { id: pieceId },
      select: { watermarkEnabled: true, title: true },
    });
    if (!piece) {
      return { enabled: true, pieceTitle: null, unknownPiece: true };
    }
    return {
      enabled: piece.watermarkEnabled !== false,
      pieceTitle: piece.title ?? null,
      unknownPiece: false,
    };
  } catch (error) {
    // Fail closed: if we cannot read the policy we watermark.
    logger.warn('Watermark policy lookup failed; defaulting to watermarked', {
      pieceId,
      error,
    });
    return { enabled: true, pieceTitle: null, unknownPiece: false };
  }
}

/**
 * Work out who a delivery is for: the Member record if one exists (a real
 * musician we can name in a licensing dispute), otherwise the account.
 */
export async function resolveWatermarkRecipient(
  userId: string | undefined,
  now: Date = new Date()
): Promise<WatermarkRecipient> {
  let memberName: string | null = null;
  let accountLabel: string | null = null;

  if (userId) {
    try {
      const record = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          name: true,
          email: true,
          member: { select: { firstName: true, lastName: true } },
        },
      });
      if (record) {
        accountLabel = record.name ?? record.email ?? null;
        if (record.member) {
          memberName = `${record.member.firstName} ${record.member.lastName}`.trim();
        }
      }
    } catch (error) {
      logger.warn('Watermark recipient lookup failed', { userId, error });
    }
  }

  return {
    memberName,
    accountLabel,
    organisation: env.NEXT_PUBLIC_APP_NAME || 'Emerald Coast Community Band',
    issuedAt: now,
  };
}

/** True when a content type should be routed through the watermarker. */
export function needsWatermark(contentType: string | null | undefined): boolean {
  if (!contentType) return false;
  const type = contentType.split(';')[0].trim().toLowerCase();
  return PDF_CONTENT_TYPES.includes(type);
}

/**
 * Stamp a delivery, or pass it through when watermarking is not applicable.
 *
 * Authorization MUST already have succeeded. Throws {@link WatermarkError} when
 * a PDF that policy says to watermark cannot be stamped — the caller must
 * refuse the bytes rather than send the clean original.
 */
export async function applyDeliveryWatermark(params: {
  bytes: Uint8Array;
  contentType: string | null | undefined;
  pieceId: string;
  userId?: string;
  now?: Date;
}): Promise<WatermarkedDelivery> {
  const { bytes, contentType, pieceId, userId } = params;
  const now = params.now ?? new Date();

  if (!needsWatermark(contentType)) {
    return { bytes, watermarked: false, size: bytes.byteLength, attribution: null };
  }

  const policy = await resolveWatermarkPolicy(pieceId);
  if (!policy.enabled) {
    logger.info('Delivering unwatermarked copy by explicit admin policy', {
      pieceId,
      userId,
    });
    return { bytes, watermarked: false, size: bytes.byteLength, attribution: null };
  }

  const recipient = await resolveWatermarkRecipient(userId, now);
  const text = buildWatermarkText(recipient);

  const stamped = await watermarkForDelivery(
    bytes,
    contentType,
    text,
    policy.pieceTitle
  );

  logger.info('Applied delivery watermark', {
    pieceId,
    userId,
    size: stamped.byteLength,
  });

  return {
    bytes: stamped,
    watermarked: true,
    size: stamped.byteLength,
    attribution: text.trail,
  };
}

/**
 * Collect a Node stream into a single Buffer.
 * Stamping needs random access to the whole document, so a PDF delivery is
 * buffered rather than piped; non-PDF content is never buffered (see
 * {@link applyDeliveryWatermarkStream}).
 */
export async function streamToBuffer(
  stream: NodeJS.ReadableStream
): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}

/**
 * Buffer, watermark and hand back a delivery stream.
 *
 * Non-PDF content is returned as an array-free passthrough by the caller: this
 * helper only handles the PDF path, because buffering a multi-hundred-megabyte
 * audio file to skip it would be waste. Callers should branch on
 * {@link needsWatermark} first.
 *
 * Throws {@link WatermarkError} when a PDF cannot be stamped — the caller must
 * return an error response and MUST NOT send the un-stamped bytes.
 */
export async function applyDeliveryWatermarkStream(params: {
  stream: NodeJS.ReadableStream;
  contentType: string | null | undefined;
  pieceId: string;
  userId?: string;
  now?: Date;
}): Promise<{ bytes: Uint8Array; watermarked: boolean; size: number }> {
  const original = await streamToBuffer(params.stream);
  const result = await applyDeliveryWatermark({ ...params, bytes: original });
  return { bytes: result.bytes, watermarked: result.watermarked, size: result.size };
}

export { WatermarkError };
