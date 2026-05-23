/**
 * Smart Upload Commit Service
 *
 * Shared library ingestion transaction extracted from the approve route.
 * Called by both the manual review API (`/api/admin/uploads/review/[id]/approve`)
 * and the autonomous auto-commit worker when confidence is sufficiently high.
 *
 * Hardened for:
 *  - Idempotent commits (safe to retry after crash/restart)
 *  - Arranger support
 *  - Normalized metadata preference
 *  - Canonical instrument family resolution
 *  - Provenance write-back to session
 */

import { prisma } from "@/lib/db";
import { deleteFile } from "@/lib/services/storage";
import { logger } from "@/lib/logger";
import type { MusicDifficulty, FileType, Prisma } from "@prisma/client";
import type { ExtractedMetadata, ParsedPartRecord } from "@/types/smart-upload";
import {
  normalizeExtractedMetadata,
  normalizePersonName,
} from "./metadata-normalizer";
import { getSectionForLabel } from "./canonical-instruments";
import { isForbiddenLabel } from "./quality-gates";
import { normalizeInstrumentLabel } from "./part-naming";
import {
  computePartIdentityFingerprint,
  computeWorkFingerprintV2,
} from "./duplicate-detection";
import {
  parseSmartUploadJsonArray,
  parseSmartUploadJsonField,
  serializeSmartUploadJsonField,
} from "./persistence";

// =============================================================================
// Types
// =============================================================================

export interface CommitOverrides {
  title?: string;
  composer?: string;
  arranger?: string;
  publisher?: string;
  instrument?: string;
  partNumber?: string;
  difficulty?: string;
  ensembleType?: string;
  keySignature?: string;
  timeSignature?: string;
  tempo?: string;
}

export interface CommitResult {
  musicPieceId: string;
  musicPieceTitle: string;
  musicFileId: string;
  sessionId: string;
  partsCommitted: number;
  /** True when commit was idempotent (piece already existed). */
  wasIdempotent: boolean;
}

// =============================================================================
// Person Resolution Helper
// =============================================================================

/**
 * Find or create a Person record from a full name string.
 * Normalizes the name first, then splits intelligently.
 */
async function findOrCreatePerson(
  tx: Prisma.TransactionClient,
  rawName: string,
): Promise<string | null> {
  const normalized = normalizePersonName(rawName);
  if (!normalized) return null;

  // Check for existing person by fullName first
  const existing = await tx.person.findFirst({
    where: { fullName: normalized },
  });
  if (existing) return existing.id;

  // Split name: assume "First [Middle...] Last" pattern
  const parts = normalized.split(" ").filter(Boolean);
  const lastName = parts.length > 1 ? parts[parts.length - 1] : parts[0];
  const firstName = parts.length > 1 ? parts.slice(0, -1).join(" ") : "";

  const created = await tx.person.create({
    data: { firstName, lastName, fullName: normalized },
  });
  return created.id;
}

function normalizeCommitErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 500);
}

// =============================================================================
// Core Commit Function
// =============================================================================

/**
 * Commit a SmartUploadSession to the music library.
 *
 * Wraps the full Prisma transaction: create MusicPiece → MusicFile → MusicPart
 * records, marks the session as APPROVED, then cleans up temp files.
 *
 * **Idempotent:** If a prior commit attempt already created the piece (detectable
 * via `originalUploadId` on MusicFile), the function returns the existing IDs
 * without duplicating data.
 *
 * @param sessionId  The `uploadSessionId` of the SmartUploadSession.
 * @param overrides  Optional field overrides (typically from the review form or
 *                   adjudicator output). Falls back to extractedMetadata values.
 * @param approvedBy Optional user ID for audit trail. When called from the
 *                   worker use a sentinel like 'system:auto-commit'.
 */
export async function commitSmartUploadSessionToLibrary(
  sessionId: string,
  overrides: CommitOverrides = {},
  approvedBy = "system:auto-commit",
): Promise<CommitResult> {
  // 1. Load session
  const uploadSession = await prisma.smartUploadSession.findUnique({
    where: { uploadSessionId: sessionId },
  });

  if (!uploadSession) {
    throw new Error(`SmartUploadSession not found: ${sessionId}`);
  }

  // ── Idempotency check: committed pointers on session ─────────────────────
  if (
    uploadSession.commitStatus === "COMPLETE" &&
    uploadSession.committedPieceId &&
    uploadSession.committedFileId
  ) {
    const [piece, partsCount] = await Promise.all([
      prisma.musicPiece.findUnique({
        where: { id: uploadSession.committedPieceId },
        select: { title: true },
      }),
      prisma.musicPart.count({
        where: { pieceId: uploadSession.committedPieceId },
      }),
    ]);

    if (piece) {
      logger.info("Commit idempotency: session already marked committed", {
        sessionId,
      });
      return {
        musicPieceId: uploadSession.committedPieceId,
        musicPieceTitle: piece.title,
        musicFileId: uploadSession.committedFileId,
        sessionId,
        partsCommitted: partsCount,
        wasIdempotent: true,
      };
    }
  }

  // ── Idempotency check: committed file lookup ─────────────────────
  // If this session was already committed, return existing data instead of failing.
  // IMPORTANT: filter to the *original* MusicFile only (fileType != 'PART').
  // Part files also share originalUploadId=sessionId, so a plain findFirst
  // would non-deterministically return a part file and give back wrong IDs.
  const existingImportedFile = await prisma.musicFile.findFirst({
    where: {
      originalUploadId: sessionId,
      fileType: { not: "PART" },
    },
    select: {
      id: true,
      pieceId: true,
      piece: { select: { id: true, title: true } },
    },
  });

  if (existingImportedFile) {
    logger.info("Commit idempotency: session already committed", { sessionId });

    const now = new Date();
    await prisma.smartUploadSession
      .update({
        where: { uploadSessionId: sessionId },
        data: {
          status: approvedBy.startsWith("system:")
            ? "AUTO_COMMITTED"
            : "MANUALLY_APPROVED",
          reviewedBy: approvedBy,
          reviewedAt: uploadSession.reviewedAt ?? now,
          commitStatus: "COMPLETE",
          committedAt: uploadSession.committedAt ?? now,
          committedPieceId: existingImportedFile.piece.id,
          committedFileId: existingImportedFile.id,
          commitError: null,
        },
      })
      .catch(() => {
        // best-effort recovery write for legacy sessions
      });

    // Count existing parts for this piece
    const partsCount = await prisma.musicPart.count({
      where: { pieceId: existingImportedFile.pieceId },
    });

    return {
      musicPieceId: existingImportedFile.piece.id,
      musicPieceTitle: existingImportedFile.piece.title,
      musicFileId: existingImportedFile.id,
      sessionId,
      partsCommitted: partsCount,
      wasIdempotent: true,
    };
  }

  // ── Status eligibility ────────────────────────────────────────────
  const isAutonomousCommit = approvedBy.startsWith("system:");
  const allowedStatuses = new Set(
    isAutonomousCommit
      ? [
          "AUTO_COMMITTING",
          "REQUIRES_REVIEW",
          "PENDING_REVIEW",
          "AUTO_COMMITTED",
          "APPROVED",
        ]
      : ["REQUIRES_REVIEW", "PENDING_REVIEW"],
  );

  if (!allowedStatuses.has(uploadSession.status)) {
    throw new Error(
      `Session ${sessionId} is not commit-eligible (status: ${uploadSession.status})`,
    );
  }

  // ── CAS-style locking: attempt to transition from NOT_STARTED/FAILED to IN_PROGRESS ─────────
  const casResult = await prisma.smartUploadSession.updateMany({
    where: {
      uploadSessionId: sessionId,
      OR: [
        { commitStatus: { in: ["NOT_STARTED", "FAILED"] } },
        { commitStatus: null },
      ],
    },
    data: {
      commitStatus: "IN_PROGRESS",
      commitAttempts: { increment: 1 },
      commitError: null,
    },
  });

  if (casResult.count === 0) {
    // Another process is already committing this session
    // Check if it's already complete
    const currentSession = await prisma.smartUploadSession.findUnique({
      where: { uploadSessionId: sessionId },
      select: {
        commitStatus: true,
        committedPieceId: true,
        committedFileId: true,
      },
    });

    if (
      currentSession?.commitStatus === "COMPLETE" &&
      currentSession.committedPieceId
    ) {
      // Already committed by another process - return idempotent result
      const piece = await prisma.musicPiece.findUnique({
        where: { id: currentSession.committedPieceId },
        select: { title: true },
      });
      const partsCount = await prisma.musicPart.count({
        where: { pieceId: currentSession.committedPieceId },
      });

      logger.info("Commit idempotency: another process completed the commit", {
        sessionId,
      });
      return {
        musicPieceId: currentSession.committedPieceId,
        musicPieceTitle: piece?.title ?? "Unknown",
        musicFileId: currentSession.committedFileId!,
        sessionId,
        partsCommitted: partsCount,
        wasIdempotent: true,
      };
    }

    // It's IN_PROGRESS - wait briefly and retry once
    await new Promise((resolve) => setTimeout(resolve, 500));
    const retrySession = await prisma.smartUploadSession.findUnique({
      where: { uploadSessionId: sessionId },
      select: {
        commitStatus: true,
        committedPieceId: true,
        committedFileId: true,
      },
    });

    if (
      retrySession?.commitStatus === "COMPLETE" &&
      retrySession.committedPieceId
    ) {
      const piece = await prisma.musicPiece.findUnique({
        where: { id: retrySession.committedPieceId },
        select: { title: true },
      });
      const partsCount = await prisma.musicPart.count({
        where: { pieceId: retrySession.committedPieceId },
      });

      return {
        musicPieceId: retrySession.committedPieceId,
        musicPieceTitle: piece?.title ?? "Unknown",
        musicFileId: retrySession.committedFileId!,
        sessionId,
        partsCommitted: partsCount,
        wasIdempotent: true,
      };
    }

    throw new Error(
      `Session ${sessionId} is already being committed by another process`,
    );
  }

  // ── Prepare metadata ─────────────────────────────────────────────
  const extractedMetadata = parseSmartUploadJsonField<ExtractedMetadata | null>(
    uploadSession.extractedMetadata,
    null,
  );
  const parsedParts = parseSmartUploadJsonArray<ParsedPartRecord>(
    uploadSession.parsedParts,
  );
  const hasPreSplitParts = parsedParts.length > 0;
  const cuttingInstructions = parseSmartUploadJsonArray<
    NonNullable<ExtractedMetadata["cuttingInstructions"]>[number]
  >(uploadSession.cuttingInstructions);

  // Normalize metadata using the normalizer pipeline when we have extracted data
  const normalized = extractedMetadata
    ? normalizeExtractedMetadata(
        sessionId,
        extractedMetadata,
        cuttingInstructions ?? undefined,
        uploadSession.fileName,
      )
    : null;

  // Resolve final values: overrides → normalized → raw → fallback
  const title =
    overrides.title?.trim() ||
    normalized?.title.normalized ||
    extractedMetadata?.title?.trim() ||
    uploadSession.fileName;

  const finalMusicFileKeys: string[] = [];

  // ── Pre-commit validation: reject forbidden labels ────────────────
  if (isAutonomousCommit && parsedParts.length > 0) {
    const badPart = parsedParts.find(
      (p) => isForbiddenLabel(p.instrument) || isForbiddenLabel(p.partName),
    );
    if (badPart) {
      throw new Error(
        `Cannot auto-commit: part "${badPart.partName}" has forbidden label (instrument="${badPart.instrument}"). Requires human review.`,
      );
    }
  }

  // 2. Transaction with error handling
  let txResult: {
    musicPiece: { id: string; title: string };
    musicFile: { id: string };
    partsCommitted: number;
  };

  try {
    txResult = await prisma.$transaction(
      async (tx: Prisma.TransactionClient) => {
        // 2a. Composer
        const composerName = (
          overrides.composer ??
          normalized?.composer.normalized ??
          extractedMetadata?.composer ??
          ""
        ).trim();
        const composerId = await findOrCreatePerson(tx, composerName);

        // 2b. Arranger
        const arrangerName = (
          overrides.arranger ??
          normalized?.arranger.normalized ??
          extractedMetadata?.arranger ??
          ""
        ).trim();
        const arrangerId = await findOrCreatePerson(tx, arrangerName);

        // 2c. Publisher
        let publisherId: string | null = null;
        const publisherName = (
          overrides.publisher ??
          normalized?.publisher.normalized ??
          extractedMetadata?.publisher ??
          ""
        ).trim();
        if (publisherName) {
          let publisher = await tx.publisher.findUnique({
            where: { name: publisherName },
          });
          if (!publisher) {
            publisher = await tx.publisher.create({
              data: { name: publisherName },
            });
          }
          publisherId = publisher.id;
        }

        // 2d. Work fingerprint — used for library-level deduplication
        const workFP = computeWorkFingerprintV2(
          title,
          composerName || null,
          arrangerName || null,
        );
        const workFingerprintHash = workFP.hash;

        // 2e. Find-or-create MusicPiece (work-level dedup by title+composer+arranger)
        const existingPiece = await tx.musicPiece.findFirst({
          where: { workFingerprintHash },
        });
        const pieceAlreadyExisted = Boolean(existingPiece);

        const pieceData = {
          title,
          composerId,
          arrangerId,
          publisherId,
          workFingerprintHash,
          difficulty: (overrides.difficulty ?? null) as MusicDifficulty | null,
          confidenceScore: extractedMetadata?.confidenceScore ?? null,
          source: "SMART_UPLOAD" as const,
          ensembleType:
            overrides.ensembleType ??
            normalized?.ensembleType.normalized ??
            extractedMetadata?.ensembleType ??
            null,
          keySignature:
            overrides.keySignature ?? extractedMetadata?.keySignature ?? null,
          timeSignature:
            overrides.timeSignature ?? extractedMetadata?.timeSignature ?? null,
          tempo: overrides.tempo ?? extractedMetadata?.tempo ?? null,
        };

        let musicPiece: Awaited<ReturnType<typeof tx.musicPiece.create>>;

        if (existingPiece) {
          // Piece already in library — update only fields that are currently null
          // to avoid overwriting manually curated metadata.
          const nullUpdates = Object.fromEntries(
            Object.entries(pieceData).filter(([key, value]) => {
              const existingValue = (existingPiece as Record<string, unknown>)[key];
              return existingValue == null && value != null;
            })
          ) as Partial<typeof pieceData>;
          musicPiece =
            Object.keys(nullUpdates).length > 0
              ? await tx.musicPiece.update({
                  where: { id: existingPiece.id },
                  data: nullUpdates,
                })
              : existingPiece;
        } else {
          musicPiece = await tx.musicPiece.create({
            data: {
              ...pieceData,
              notes: `Imported via Smart Upload on ${new Date().toISOString()}`,
            },
          });
        }

        // 2f. MusicFile — create new or version-bump existing
        const fileType = (extractedMetadata?.fileType ??
          "FULL_SCORE") as FileType;
        let musicFile: Awaited<ReturnType<typeof tx.musicFile.create>>;

        if (pieceAlreadyExisted) {
          // Look for the primary (non-part) file for this piece
          const existingFile = await tx.musicFile.findFirst({
            where: {
              pieceId: musicPiece.id,
              fileType: { not: "PART" as FileType },
            },
            orderBy: { uploadedAt: "desc" },
          });

          if (existingFile) {
            // Snapshot current file as a version before updating
            const versionCount = await tx.musicFileVersion.count({
              where: { fileId: existingFile.id },
            });
            await tx.musicFileVersion.create({
              data: {
                fileId: existingFile.id,
                version: versionCount + 1,
                fileName: existingFile.fileName,
                storageKey: existingFile.storageKey,
                fileSize: existingFile.fileSize,
                mimeType: existingFile.mimeType,
                changeNote: `Superseded by re-upload session ${uploadSession.uploadSessionId} on ${new Date().toISOString()}`,
                uploadedBy: approvedBy,
              },
            });

            // Point the file record at the new storage key
            musicFile = await tx.musicFile.update({
              where: { id: existingFile.id },
              data: {
                fileName: uploadSession.fileName,
                fileSize: uploadSession.fileSize,
                mimeType: uploadSession.mimeType,
                storageKey: uploadSession.storageKey,
                uploadedBy: approvedBy,
                extractedMetadata:
                  serializeSmartUploadJsonField(extractedMetadata),
                originalUploadId: uploadSession.uploadSessionId,
                contentHash: uploadSession.sourceSha256 ?? null,
                version: (existingFile.version ?? 1) + 1,
              },
            });
          } else {
            // Piece exists but has no primary file yet — create one
            musicFile = await tx.musicFile.create({
              data: {
                pieceId: musicPiece.id,
                fileName: uploadSession.fileName,
                fileType,
                fileSize: uploadSession.fileSize,
                mimeType: uploadSession.mimeType,
                storageKey: uploadSession.storageKey,
                uploadedBy: approvedBy,
                extractedMetadata:
                  serializeSmartUploadJsonField(extractedMetadata),
                source: "SMART_UPLOAD",
                originalUploadId: uploadSession.uploadSessionId,
                contentHash: uploadSession.sourceSha256 ?? null,
              },
            });
          }
        } else {
          musicFile = await tx.musicFile.create({
            data: {
              pieceId: musicPiece.id,
              fileName: uploadSession.fileName,
              fileType,
              fileSize: uploadSession.fileSize,
              mimeType: uploadSession.mimeType,
              storageKey: uploadSession.storageKey,
              uploadedBy: approvedBy,
              extractedMetadata:
                serializeSmartUploadJsonField(extractedMetadata),
              source: "SMART_UPLOAD",
              originalUploadId: uploadSession.uploadSessionId,
              contentHash: uploadSession.sourceSha256 ?? null,
            },
          });
        }
        finalMusicFileKeys.push(uploadSession.storageKey);

        // 2g. MusicParts
        let partsCommitted = 0;

        if (hasPreSplitParts && parsedParts.length > 0) {
          for (const part of parsedParts) {
            const normalizedPart = normalizeInstrumentLabel(
              part.instrument?.trim() || "Unknown",
            );
            const instrumentName =
              normalizedPart.instrument?.trim() || "Unknown";
            const partName = part.partName?.trim() || instrumentName;
            const partFingerprintHash = computePartIdentityFingerprint(
              musicPiece.id,
              instrumentName,
              partName,
              normalizedPart.chair,
              normalizedPart.transposition,
            );
            const family = getSectionForLabel(instrumentName);

            let instrument = await tx.instrument.findFirst({
              where: { name: { equals: instrumentName } },
            });
            if (!instrument) {
              instrument = await tx.instrument.create({
                data: { name: instrumentName, family, sortOrder: 999 },
              });
            }

            let existingMusicPart = null as Awaited<
              ReturnType<typeof tx.musicPart.findFirst>
            >;
            if (pieceAlreadyExisted) {
              existingMusicPart = await tx.musicPart.findFirst({
                where: {
                  pieceId: musicPiece.id,
                  partFingerprintHash,
                },
              });

              if (!existingMusicPart) {
                existingMusicPart = await tx.musicPart.findFirst({
                  where: {
                    pieceId: musicPiece.id,
                    instrumentId: instrument.id,
                    partNumber: part.partNumber ?? null,
                  },
                });
              }
            }

            if (existingMusicPart) {
              // Update the existing PART file by stable fingerprint (fallback to legacy key shape)
              let existingPartFile = await tx.musicFile.findFirst({
                where: {
                  pieceId: musicPiece.id,
                  fileType: "PART" as FileType,
                  partFingerprintHash,
                },
              });

              if (!existingPartFile) {
                existingPartFile = await tx.musicFile.findFirst({
                  where: {
                    pieceId: musicPiece.id,
                    fileType: "PART" as FileType,
                    partNumber: part.partNumber ?? null,
                    instrumentName,
                  },
                });
              }

              let partFileId: string | null = null;
              if (existingPartFile) {
                const pvCount = await tx.musicFileVersion.count({
                  where: { fileId: existingPartFile.id },
                });
                await tx.musicFileVersion.create({
                  data: {
                    fileId: existingPartFile.id,
                    version: pvCount + 1,
                    fileName: existingPartFile.fileName,
                    storageKey: existingPartFile.storageKey,
                    fileSize: existingPartFile.fileSize,
                    mimeType: existingPartFile.mimeType,
                    changeNote: `Superseded by re-upload session ${uploadSession.uploadSessionId}`,
                    uploadedBy: approvedBy,
                  },
                });

                const updatedPartFile = await tx.musicFile.update({
                  where: { id: existingPartFile.id },
                  data: {
                    fileName: part.fileName,
                    fileSize: part.fileSize,
                    storageKey: part.storageKey,
                    uploadedBy: approvedBy,
                    originalUploadId: uploadSession.uploadSessionId,
                    contentHash: uploadSession.sourceSha256 ?? null,
                    version: (existingPartFile.version ?? 1) + 1,
                    partFingerprintHash,
                    partLabel: partName,
                    instrumentName,
                    section: part.section ?? null,
                    partNumber: part.partNumber ?? null,
                    pageCount: part.pageCount ?? null,
                  },
                });
                partFileId = updatedPartFile.id;
                finalMusicFileKeys.push(part.storageKey);
              } else {
                const createdPartFile = await tx.musicFile.create({
                  data: {
                    pieceId: musicPiece.id,
                    fileName: part.fileName,
                    fileType: "PART" as FileType,
                    fileSize: part.fileSize,
                    mimeType: "application/pdf",
                    storageKey: part.storageKey,
                    uploadedBy: approvedBy,
                    source: "SMART_UPLOAD",
                    originalUploadId: uploadSession.uploadSessionId,
                    contentHash: uploadSession.sourceSha256 ?? null,
                    partFingerprintHash,
                    partLabel: partName,
                    instrumentName,
                    section: part.section ?? null,
                    partNumber: part.partNumber ?? null,
                    pageCount: part.pageCount ?? null,
                  },
                });
                partFileId = createdPartFile.id;
                finalMusicFileKeys.push(part.storageKey);
              }

              await tx.musicPart.update({
                where: { id: existingMusicPart.id },
                data: {
                  partName,
                  fileId: partFileId ?? existingMusicPart.fileId,
                  section: part.section ?? null,
                  partNumber: part.partNumber ?? null,
                  partLabel: partName,
                  transposition:
                    part.transposition ?? normalizedPart.transposition ?? null,
                  pageCount: part.pageCount ?? null,
                  storageKey: part.storageKey ?? null,
                  partFingerprintHash,
                },
              });
            } else {
              const partFile = await tx.musicFile.create({
                data: {
                  pieceId: musicPiece.id,
                  fileName: part.fileName,
                  fileType: "PART" as FileType,
                  fileSize: part.fileSize,
                  mimeType: "application/pdf",
                  storageKey: part.storageKey,
                  uploadedBy: approvedBy,
                  source: "SMART_UPLOAD",
                  originalUploadId: uploadSession.uploadSessionId,
                  contentHash: uploadSession.sourceSha256 ?? null,
                  partFingerprintHash,
                  partLabel: partName,
                  instrumentName,
                  section: part.section ?? null,
                  partNumber: part.partNumber ?? null,
                  pageCount: part.pageCount ?? null,
                },
              });
              finalMusicFileKeys.push(part.storageKey);

              await tx.musicPart.create({
                data: {
                  pieceId: musicPiece.id,
                  instrumentId: instrument.id,
                  partName,
                  fileId: partFile.id,
                  section: part.section ?? null,
                  partNumber: part.partNumber ?? null,
                  partLabel: partName,
                  transposition:
                    part.transposition ?? normalizedPart.transposition ?? null,
                  pageCount: part.pageCount ?? null,
                  storageKey: part.storageKey ?? null,
                  partFingerprintHash,
                },
              });
            }
            partsCommitted++;
          }
        } else if (
          extractedMetadata?.isMultiPart &&
          Array.isArray(extractedMetadata.parts) &&
          extractedMetadata.parts.length > 0
        ) {
          for (const part of extractedMetadata.parts) {
            const normalizedPart = normalizeInstrumentLabel(
              part.instrument?.trim() || "Unknown",
            );
            const instrumentName = normalizedPart.instrument?.trim();
            if (!instrumentName) continue;
            const partName = part.partName?.trim() || instrumentName;
            const partFingerprintHash = computePartIdentityFingerprint(
              musicPiece.id,
              instrumentName,
              partName,
              normalizedPart.chair,
              normalizedPart.transposition,
            );
            const family = getSectionForLabel(instrumentName);

            let instrument = await tx.instrument.findFirst({
              where: { name: { equals: instrumentName } },
            });
            if (!instrument) {
              instrument = await tx.instrument.create({
                data: { name: instrumentName, family, sortOrder: 999 },
              });
            }
            await tx.musicPart.create({
              data: {
                pieceId: musicPiece.id,
                instrumentId: instrument.id,
                partName,
                fileId: musicFile.id,
                partFingerprintHash,
              },
            });
            partsCommitted++;
          }
        } else {
          // Single instrument from override or extractedMetadata
          const instrumentName =
            overrides.instrument?.trim() ??
            extractedMetadata?.instrument?.trim() ??
            "";
          if (instrumentName) {
            const normalizedPart = normalizeInstrumentLabel(instrumentName);
            const canonicalInstrument =
              normalizedPart.instrument || instrumentName;
            const partName = overrides.partNumber ?? canonicalInstrument;
            const partFingerprintHash = computePartIdentityFingerprint(
              musicPiece.id,
              canonicalInstrument,
              partName,
              normalizedPart.chair,
              normalizedPart.transposition,
            );
            const family = getSectionForLabel(instrumentName);
            let instrument = await tx.instrument.findFirst({
              where: { name: { equals: instrumentName } },
            });
            if (!instrument) {
              instrument = await tx.instrument.create({
                data: { name: instrumentName, family, sortOrder: 999 },
              });
            }
            await tx.musicPart.create({
              data: {
                pieceId: musicPiece.id,
                instrumentId: instrument.id,
                partName,
                fileId: musicFile.id,
                partFingerprintHash,
              },
            });
            partsCommitted++;
          }
        }

        // 2g. Mark session approved and commit complete (CAS-style update)
        await tx.smartUploadSession.update({
          where: { uploadSessionId: sessionId },
          data: {
            status: isAutonomousCommit ? "AUTO_COMMITTED" : "MANUALLY_APPROVED",
            reviewedBy: approvedBy,
            reviewedAt: new Date(),
            commitStatus: "COMPLETE",
            committedAt: new Date(),
            committedPieceId: musicPiece.id,
            committedFileId: musicFile.id,
            commitError: null,
          },
        });

        return { musicPiece, musicFile, partsCommitted };
      },
      { maxWait: 30000, timeout: 60000 },
    );
  } catch (error) {
    // Transaction failed - mark as FAILED and persist error
    const errorMessage = normalizeCommitErrorMessage(error);
    const errorCode = (error as { code?: string }).code;

    // Handle Prisma unique constraint violations (P2002) as race-condition recovery
    if (errorCode === "P2002") {
      logger.warn(
        "Commit: Unique constraint violation - checking for existing commit",
        {
          sessionId,
          error: errorMessage,
        },
      );

      // Check if another process already committed
      const existingSession = await prisma.smartUploadSession.findUnique({
        where: { uploadSessionId: sessionId },
        select: {
          commitStatus: true,
          committedPieceId: true,
          committedFileId: true,
        },
      });

      if (
        existingSession?.commitStatus === "COMPLETE" &&
        existingSession.committedPieceId
      ) {
        const piece = await prisma.musicPiece.findUnique({
          where: { id: existingSession.committedPieceId },
          select: { title: true },
        });
        const partsCount = await prisma.musicPart.count({
          where: { pieceId: existingSession.committedPieceId },
        });

        logger.info(
          "Commit idempotency: race condition resolved, commit already complete",
          { sessionId },
        );
        return {
          musicPieceId: existingSession.committedPieceId,
          musicPieceTitle: piece?.title ?? "Unknown",
          musicFileId: existingSession.committedFileId!,
          sessionId,
          partsCommitted: partsCount,
          wasIdempotent: true,
        };
      }
    }

    // Mark session as failed
    await prisma.smartUploadSession
      .update({
        where: { uploadSessionId: sessionId },
        data: {
          status: "FAILED",
          requiresHumanReview: true,
          commitStatus: "FAILED",
          commitError: errorMessage,
        },
      })
      .catch((updateErr: unknown) => {
        // Best-effort error persistence
        logger.error("Failed to persist commit error", {
          sessionId,
          originalError: errorMessage,
          updateError:
            updateErr instanceof Error ? updateErr.message : String(updateErr),
        });
      });

    logger.error("Commit transaction failed", {
      sessionId,
      error: errorMessage,
      errorCode,
    });

    throw new Error(`Commit failed for session ${sessionId}: ${errorMessage}`);
  }

  // 3. Cleanup orphaned temp files (best-effort, non-fatal)
  const tempFiles = parseSmartUploadJsonArray<string>(uploadSession.tempFiles);
  const toDelete = tempFiles.filter((key) => !finalMusicFileKeys.includes(key));
  for (const key of toDelete) {
    try {
      await deleteFile(key);
    } catch (err) {
      logger.warn("Auto-commit: failed to delete temp file", {
        sessionId,
        key,
        err,
      });
    }
  }

  logger.info("Smart upload committed to library", {
    sessionId,
    approvedBy,
    title,
    pieceId: txResult.musicPiece.id,
    partsCommitted: txResult.partsCommitted,
  });

  return {
    musicPieceId: txResult.musicPiece.id,
    musicPieceTitle: txResult.musicPiece.title,
    musicFileId: txResult.musicFile.id,
    sessionId,
    partsCommitted: txResult.partsCommitted,
    wasIdempotent: false,
  };
}
