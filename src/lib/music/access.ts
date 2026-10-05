/**
 * Canonical music-library / Digital Music Stand authorization.
 *
 * Single source of truth for "may this user see or download this music?" — every
 * Stand route, file proxy, and download endpoint must route through this module
 * instead of running its own inline query. This is deliberate: copyrighted sheet
 * music is a licensing boundary, so the failure mode must be deny-by-default and
 * the policy must be defined in exactly one place.
 *
 * Policy
 * ------
 * GLOBAL (any non-deleted, non-archived piece, any part):
 *   SUPER_ADMIN, ADMIN, DIRECTOR, STAFF, LIBRARIAN
 *   Rationale: these roles run the library. PERMISSIONS.md grants them
 *   `music.view.all` / `music.download.all`.
 *
 * ASSIGNMENT-SCOPED (everybody else, including SECTION_LEADER and plain members):
 *   Requires an ACTIVE Member record AND a MusicAssignment row for the piece.
 *   - Assignment with `partId === null`  → whole piece (librarian handed over a
 *     full set / conductor score).
 *   - Assignment with `partId === <id>`  → that part ONLY. Sibling parts of the
 *     same piece are denied.
 *   - Piece-level (non-part) files, e.g. a conductor score or full score PDF,
 *     require a whole-piece assignment. A member holding only "Trumpet 2" is
 *     denied the conductor score.
 *
 * Archived or soft-deleted pieces are denied to EVERYONE except global-access
 * roles, which retain visibility for library administration.
 */

import { prisma } from '@/lib/db';
import type { RoleType } from '@prisma/client';

/**
 * Roles with library-wide visibility. Kept as a plain string array so callers
 * can pass it straight to Prisma `in` filters; `RoleType` is the enum of record.
 */
export const MUSIC_GLOBAL_ACCESS_ROLES = [
  'SUPER_ADMIN',
  'ADMIN',
  'DIRECTOR',
  'STAFF',
  'LIBRARIAN',
] as const satisfies readonly string[];

export type MusicGlobalAccessRole = (typeof MUSIC_GLOBAL_ACCESS_ROLES)[number];

/**
 * True when the user holds any global music-access role.
 * Mirrors the privileged-role probe used throughout the Stand.
 */
export async function hasGlobalMusicAccess(userId: string): Promise<boolean> {
  const role = await prisma.userRole.findFirst({
    where: {
      userId,
      role: { type: { in: MUSIC_GLOBAL_ACCESS_ROLES as unknown as RoleType[] } },
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    select: { id: true },
  });
  return role !== null;
}

/** A member's assignment footprint for one piece. */
export interface PieceAssignmentGrant {
  /** The member has at least one assignment for the piece. */
  assigned: boolean;
  /** The member has an assignment covering the entire piece (no specific part). */
  wholePiece: boolean;
  /** Specific part ids the member is assigned. */
  partIds: string[];
}

const NO_GRANT: PieceAssignmentGrant = { assigned: false, wholePiece: false, partIds: [] };

/**
 * Resolve how (and whether) an active member may reach a piece.
 * Returns a zero-grant object for non-members — callers must treat that as deny.
 */
export async function getPieceAssignmentGrant(
  userId: string,
  pieceId: string
): Promise<PieceAssignmentGrant> {
  const member = await prisma.member.findFirst({
    where: { userId, status: 'ACTIVE' },
    select: { id: true },
  });
  if (!member) return NO_GRANT;

  const assignments = await prisma.musicAssignment.findMany({
    where: { pieceId, memberId: member.id },
    select: { partId: true },
  });

  if (assignments.length === 0) return NO_GRANT;

  const partIds = assignments
    .map((a) => a.partId)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);

  return {
    assigned: true,
    wholePiece: assignments.some((a) => a.partId === null),
    partIds,
  };
}

/**
 * Can the user open this piece in the Digital Music Stand (library mode)?
 *
 * Global-access roles: yes. Everyone else: only with an active assignment.
 */
export async function canAccessMusicPiece(userId: string, pieceId: string): Promise<boolean> {
  if (await hasGlobalMusicAccess(userId)) return true;

  // Archived / soft-deleted music is for library administrators only. This
  // check is enforced by the sibling file-level helpers (canReadPieceFile,
  // authorizeMusicFileAccess) but was MISSING here, so the Stand metadata,
  // annotation, audio and practice-log endpoints — which all resolve piece
  // access through this function — could read or write an archived or
  // soft-deleted piece. Keep the two paths consistent.
  // Use findFirst, matching the sibling archived/deleted lookups in this module
  // (see canReadPieceFile / authorizeMusicFileAccess) rather than findUnique.
  const piece = await prisma.musicPiece.findFirst({
    where: { id: pieceId },
    select: { isArchived: true, deletedAt: true },
  });
  if (!piece) return false;
  if (piece.isArchived || piece.deletedAt !== null) return false;

  const grant = await getPieceAssignmentGrant(userId, pieceId);
  return grant.assigned;
}

/**
 * Can the user open one specific PART of this piece?
 *
 * Global-access roles: yes. A member with a whole-piece assignment: yes.
 * A member assigned only part X: yes for X, NO for sibling parts.
 */
export async function canAccessMusicPart(
  userId: string,
  pieceId: string,
  partId: string
): Promise<boolean> {
  if (await hasGlobalMusicAccess(userId)) return true;
  const grant = await getPieceAssignmentGrant(userId, pieceId);
  if (!grant.assigned) return false;
  return grant.wholePiece || grant.partIds.includes(partId);
}

/**
 * Can the user reach a piece-level (non-part) file such as a conductor score or
 * a combined full score?
 *
 * Conservative by design: this requires a whole-piece assignment. A member who
 * only holds an assigned part does NOT get the full score. See the module
 * header for the open policy question this encodes.
 */
export async function canAccessMusicScoreFile(
  userId: string,
  pieceId: string
): Promise<boolean> {
  if (await hasGlobalMusicAccess(userId)) return true;
  const grant = await getPieceAssignmentGrant(userId, pieceId);
  return grant.wholePiece;
}

// ─── File-level authorization ────────────────────────────────────────────────

export type MusicFileScope = 'public' | 'global' | 'part' | 'score' | 'none';

export interface MusicFileAccess {
  allowed: boolean;
  scope: MusicFileScope;
  pieceId?: string;
  partId?: string | null;
}

/**
 * Resolve the piece/part a stored file belongs to.
 *
 * A storage key can be attached either to a MusicPart (per-part PDF) or to a
 * MusicFile (piece-level PDF such as a conductor score). Returns null when the
 * key matches neither.
 */
export async function resolveMusicFileScope(
  storageKey: string
): Promise<{ pieceId: string; partId: string | null } | null> {
  const part = await prisma.musicPart.findFirst({
    where: { storageKey },
    select: { id: true, pieceId: true },
  });
  if (part) return { pieceId: part.pieceId, partId: part.id };

  const file = await prisma.musicFile.findFirst({
    where: { storageKey },
    select: { id: true, pieceId: true, isArchived: true, piece: { select: { deletedAt: true } } },
  });
  if (!file) return null;
  // A part-scoped MusicFile (has parts attached) is treated as that part.
  const linkedPart = await prisma.musicPart.findFirst({
    where: { fileId: file.id },
    select: { id: true },
  });
  return {
    pieceId: file.pieceId,
    partId: linkedPart?.id ?? null,
  };
}

/**
 * Authorize a single stored music file for download / proxy streaming.
 * This is the ONLY check the file routes may use.
 */
export async function authorizeMusicFileAccess(
  userId: string,
  storageKey: string
): Promise<MusicFileAccess> {
  const resolved = await resolveMusicFileScope(storageKey);
  if (!resolved) return { allowed: false, scope: 'none' };

  const { pieceId, partId } = resolved;

  const piece = await prisma.musicPiece.findFirst({
    where: { id: pieceId },
    select: { isArchived: true, deletedAt: true },
  });
  if (!piece) return { allowed: false, scope: 'none', pieceId };

  const isGlobal = await hasGlobalMusicAccess(userId);

  // Archived / soft-deleted music is only reachable by library administrators.
  if ((piece.isArchived || piece.deletedAt !== null) && !isGlobal) {
    return { allowed: false, scope: 'none', pieceId, partId };
  }

  if (isGlobal) return { allowed: true, scope: 'global', pieceId, partId };

  const grant = await getPieceAssignmentGrant(userId, pieceId);
  if (!grant.assigned) return { allowed: false, scope: 'none', pieceId, partId };

  if (partId) {
    // Assigned only to sibling parts? Deny.
    if (grant.wholePiece || grant.partIds.includes(partId)) {
      return { allowed: true, scope: 'part', pieceId, partId };
    }
    return { allowed: false, scope: 'none', pieceId, partId };
  }

  // Piece-level file (conductor / full score): needs a whole-piece assignment.
  if (grant.wholePiece) return { allowed: true, scope: 'score', pieceId, partId: null };
  return { allowed: false, scope: 'none', pieceId, partId: null };
}

/**
 * Stand-proxy variant of {@link authorizeMusicFileAccess}, for a file that has
 * ALREADY been proven to belong to `pieceId` (or to an event containing it).
 *
 * `withinEvent` relaxes exactly one rule, and only for members with NO
 * assignment on the piece at all: inside an event they are entitled to, they may
 * read the published concert program. This is the intended rehearsal surface.
 *
 * The moment a member has an explicit assignment, part-level scoping applies in
 * full — they never get a sibling part or the conductor score. That is the
 * conservative reading of an unresolved licensing question, so it is enforced
 * here explicitly rather than inferred from a coarse scope string.
 */
export async function canReadPieceFile(
  userId: string,
  pieceId: string,
  storageKey: string,
  withinEvent: boolean
): Promise<boolean> {
  if (await hasGlobalMusicAccess(userId)) return true;

  const piece = await prisma.musicPiece.findFirst({
    where: { id: pieceId },
    select: { isArchived: true, deletedAt: true },
  });
  if (!piece) return false;

  // Archived / soft-deleted music is for library administrators only.
  if (piece.isArchived || piece.deletedAt !== null) return false;

  const partId = await resolvePartIdForStorageKey(pieceId, storageKey);

  const grant = await getPieceAssignmentGrant(userId, pieceId);

  if (!grant.assigned) {
    // Unassigned member: only the published-event program is reachable.
    //
    // Critically, this must NOT expose an individual player's part. A member
    // assigned to Trumpet 2 has no business reading Flute 1's part, but the
    // piece-level relaxation below previously returned `withinEvent` for EVERY
    // file on the piece — conductor score AND every sibling part. The event
    // programme is the piece as published; it is not a licence to read other
    // musicians' individual parts.
    if (!withinEvent) return false;
    if (partId) return false; // a specific part always requires an assignment
    return true;
  }

  if (partId) {
    // Assigned: own part only, unless the assignment covers the whole piece.
    return grant.wholePiece || grant.partIds.includes(partId);
  }

  // Piece-level file (conductor / full score): requires a whole-piece assignment.
  return grant.wholePiece;
}

/** Which part (if any) does this storage key represent within the given piece? */
async function resolvePartIdForStorageKey(
  pieceId: string,
  storageKey: string
): Promise<string | null> {
  const part = await prisma.musicPart.findFirst({
    where: { storageKey, pieceId },
    select: { id: true },
  });
  if (part) return part.id;

  const file = await prisma.musicFile.findFirst({
    where: { storageKey, pieceId },
    select: { id: true },
  });
  if (!file) return null;

  const linked = await prisma.musicPart.findFirst({
    where: { fileId: file.id },
    select: { id: true },
  });
  return linked?.id ?? null;
}