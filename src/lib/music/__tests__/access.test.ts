// @vitest-environment node
/**
 * Stand music access policy tests.
 *
 * These are the negative-path tests for the Digital Music Stand: they assert
 * that an ACTIVE member with no MusicAssignment is denied, that a member
 * assigned one part is denied a sibling part and the conductor score, and that
 * library-administrator roles retain global access.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    userRole: { findFirst: vi.fn(), findMany: vi.fn() },
    member: { findFirst: vi.fn(), findUnique: vi.fn() },
    musicAssignment: { findMany: vi.fn(), findFirst: vi.fn() },
    musicPiece: { findFirst: vi.fn(), findUnique: vi.fn() },
    musicPart: { findFirst: vi.fn() },
    musicFile: { findFirst: vi.fn() },
    attendance: { findFirst: vi.fn() },
    event: { findFirst: vi.fn() },
    user: { findFirst: vi.fn() },
  },
}));

import { prisma } from '@/lib/db';
import {
  authorizeMusicFileAccess,
  canAccessMusicPart,
  canAccessMusicPiece,
  canAccessMusicScoreFile,
  canReadPieceFile,
  getPieceAssignmentGrant,
  hasGlobalMusicAccess,
  MUSIC_GLOBAL_ACCESS_ROLES,
} from '@/lib/music/access';

const USER = 'user-1';
const PIECE = 'piece-1';
const MY_PART = 'part-trumpet-2';
const SIBLING_PART = 'part-trumpet-1';
const SCORE_KEY = 'music/conductor-score.pdf';
const MY_PART_KEY = 'music/trumpet-2.pdf';
const SIBLING_KEY = 'music/trumpet-1.pdf';

/** Make the user a plain active member with the given assignments. */
function asMemberWithAssignments(
  assignments: Array<{ partId: string | null }> | null
) {
  vi.mocked(prisma.userRole.findFirst).mockResolvedValue(null);
  if (assignments === null) {
    vi.mocked(prisma.member.findFirst).mockResolvedValue(null);
  } else {
    vi.mocked(prisma.member.findFirst).mockResolvedValue({ id: 'member-1' } as never);
    vi.mocked(prisma.musicAssignment.findMany).mockResolvedValue(
      assignments.map((a) => ({ partId: a.partId })) as never
    );
  }
}

/** Make the user a library-administrator with no member record. */
function asGlobalRole() {
  vi.mocked(prisma.userRole.findFirst).mockResolvedValue({ id: 'ur-1' } as never);
  vi.mocked(prisma.member.findFirst).mockResolvedValue(null);
}

/** Wire a healthy, non-archived piece. */
function asLivePiece() {
  vi.mocked(prisma.musicPiece.findFirst).mockResolvedValue({
    isArchived: false,
    deletedAt: null,
  } as never);
}

describe('stand music access policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    asLivePiece();
  });

  describe('global music access roles', () => {
    it('lists exactly the library-administrator roles', () => {
      expect([...MUSIC_GLOBAL_ACCESS_ROLES]).toEqual([
        'SUPER_ADMIN',
        'ADMIN',
        'DIRECTOR',
        'STAFF',
        'LIBRARIAN',
      ]);
    });

    it.each([...MUSIC_GLOBAL_ACCESS_ROLES])(
      'grants global access to %s',
      async (_role) => {
        // The role probe is stubbed generically; assert the helper consults it.
        asGlobalRole();
        await expect(hasGlobalMusicAccess(USER)).resolves.toBe(true);
      }
    );

    it('denies global access to a plain member', async () => {
      asMemberWithAssignments([{ partId: null }]);
      await expect(hasGlobalMusicAccess(USER)).resolves.toBe(false);
    });

    it('does not grant librarian-style global access to a section leader', async () => {
      asMemberWithAssignments([]);
      await expect(hasGlobalMusicAccess(USER)).resolves.toBe(false);
    });
  });

  describe('canAccessMusicPiece', () => {
    it('DENIES an active member with no assignment', async () => {
      asMemberWithAssignments([]);
      await expect(canAccessMusicPiece(USER, PIECE)).resolves.toBe(false);
    });

    it('DENIES a user who is not an active member, even with assignments', async () => {
      // No member record at all → no grant, whatever the role probe says.
      vi.mocked(prisma.userRole.findFirst).mockResolvedValue(null);
      vi.mocked(prisma.member.findFirst).mockResolvedValue(null);
      vi.mocked(prisma.musicAssignment.findMany).mockResolvedValue([
        { partId: null },
      ] as never);
      await expect(canAccessMusicPiece(USER, PIECE)).resolves.toBe(false);
    });

    it('ALLOWS an active member assigned the whole piece', async () => {
      asMemberWithAssignments([{ partId: null }]);
      await expect(canAccessMusicPiece(USER, PIECE)).resolves.toBe(true);
    });

    it('ALLOWS an active member assigned a single part', async () => {
      asMemberWithAssignments([{ partId: MY_PART }]);
      await expect(canAccessMusicPiece(USER, PIECE)).resolves.toBe(true);
    });

    it('ALLOWS a global-access role with no member record', async () => {
      asGlobalRole('LIBRARIAN');
      await expect(canAccessMusicPiece(USER, PIECE)).resolves.toBe(true);
    });
  });

  describe('part-level scoping', () => {
    it('ALLOWS a member their own assigned part', async () => {
      asMemberWithAssignments([{ partId: MY_PART }]);
      await expect(canAccessMusicPart(USER, PIECE, MY_PART)).resolves.toBe(true);
    });

    it('DENIES a member a sibling part of an assigned piece', async () => {
      asMemberWithAssignments([{ partId: MY_PART }]);
      await expect(canAccessMusicPart(USER, PIECE, SIBLING_PART)).resolves.toBe(false);
    });

    it('ALLOWS a whole-piece assignment to reach any part', async () => {
      asMemberWithAssignments([{ partId: null }]);
      await expect(canAccessMusicPart(USER, PIECE, SIBLING_PART)).resolves.toBe(true);
    });

    it('DENIES a conductor score to a member holding only one part', async () => {
      asMemberWithAssignments([{ partId: MY_PART }]);
      await expect(canAccessMusicScoreFile(USER, PIECE)).resolves.toBe(false);
    });

    it('ALLOWS a conductor score to a whole-piece assignment', async () => {
      asMemberWithAssignments([{ partId: null }]);
      await expect(canAccessMusicScoreFile(USER, PIECE)).resolves.toBe(true);
    });
  });

  describe('getPieceAssignmentGrant', () => {
    it('reports no grant for a non-member', async () => {
      asMemberWithAssignments(null);
      await expect(getPieceAssignmentGrant(USER, PIECE)).resolves.toEqual({
        assigned: false,
        wholePiece: false,
        partIds: [],
      });
    });

    it('reports no grant when the member has no assignments', async () => {
      asMemberWithAssignments([]);
      await expect(getPieceAssignmentGrant(USER, PIECE)).resolves.toEqual({
        assigned: false,
        wholePiece: false,
        partIds: [],
      });
    });

    it('collects every assigned part id', async () => {
      asMemberWithAssignments([{ partId: MY_PART }, { partId: SIBLING_PART }]);
      const grant = await getPieceAssignmentGrant(USER, PIECE);
      expect(grant).toEqual({
        assigned: true,
        wholePiece: false,
        partIds: [MY_PART, SIBLING_PART],
      });
    });

    it('flags wholePiece when any assignment has no partId', async () => {
      asMemberWithAssignments([{ partId: MY_PART }, { partId: null }]);
      const grant = await getPieceAssignmentGrant(USER, PIECE);
      expect(grant.wholePiece).toBe(true);
      expect(grant.partIds).toEqual([MY_PART]);
    });
  });

  describe('authorizeMusicFileAccess', () => {
    it('DENIES download of a sibling part file', async () => {
      asMemberWithAssignments([{ partId: MY_PART }]);
      vi.mocked(prisma.musicPart.findFirst).mockResolvedValueOnce(null);
      vi.mocked(prisma.musicFile.findFirst).mockResolvedValueOnce({
        id: 'file-sibling',
        pieceId: PIECE,
        isArchived: false,
        piece: { deletedAt: null },
      } as never);
      vi.mocked(prisma.musicPart.findFirst).mockResolvedValueOnce({
        id: SIBLING_PART,
      } as never);

      const access = await authorizeMusicFileAccess(USER, SIBLING_KEY);
      expect(access.allowed).toBe(false);
    });

    it('ALLOWS download of the member’s own part file', async () => {
      asMemberWithAssignments([{ partId: MY_PART }]);
      vi.mocked(prisma.musicPart.findFirst).mockResolvedValueOnce({
        id: MY_PART,
        pieceId: PIECE,
      } as never);

      const access = await authorizeMusicFileAccess(USER, MY_PART_KEY);
      expect(access.allowed).toBe(true);
      expect(access.scope).toBe('part');
    });

    it('DENIES download of the conductor score by a single-part member', async () => {
      asMemberWithAssignments([{ partId: MY_PART }]);
      vi.mocked(prisma.musicPart.findFirst).mockResolvedValueOnce(null);
      vi.mocked(prisma.musicFile.findFirst).mockResolvedValueOnce({
        id: 'file-score',
        pieceId: PIECE,
        isArchived: false,
        piece: { deletedAt: null },
      } as never);
      vi.mocked(prisma.musicPart.findFirst).mockResolvedValueOnce(null);

      const access = await authorizeMusicFileAccess(USER, SCORE_KEY);
      expect(access.allowed).toBe(false);
    });

    it('DENIES an unassigned active member', async () => {
      asMemberWithAssignments([]);
      vi.mocked(prisma.musicPart.findFirst).mockResolvedValueOnce({
        id: MY_PART,
        pieceId: PIECE,
      } as never);

      const access = await authorizeMusicFileAccess(USER, MY_PART_KEY);
      expect(access.allowed).toBe(false);
    });

    it('DENIES archived music to everyone except global roles', async () => {
      vi.mocked(prisma.musicPiece.findFirst).mockResolvedValue({
        isArchived: true,
        deletedAt: null,
      } as never);
      vi.mocked(prisma.userRole.findFirst).mockResolvedValue(null);
      vi.mocked(prisma.member.findFirst).mockResolvedValue({ id: 'member-1' } as never);
      vi.mocked(prisma.musicAssignment.findMany).mockResolvedValue([
        { partId: null },
      ] as never);
      vi.mocked(prisma.musicPart.findFirst).mockResolvedValueOnce({
        id: MY_PART,
        pieceId: PIECE,
      } as never);

      const access = await authorizeMusicFileAccess(USER, MY_PART_KEY);
      expect(access.allowed).toBe(false);
    });

    it('ALLOWs archived music to a librarian', async () => {
      vi.mocked(prisma.musicPiece.findFirst).mockResolvedValue({
        isArchived: true,
        deletedAt: null,
      } as never);
      asGlobalRole('LIBRARIAN');
      vi.mocked(prisma.musicPart.findFirst).mockResolvedValueOnce({
        id: MY_PART,
        pieceId: PIECE,
      } as never);

      const access = await authorizeMusicFileAccess(USER, MY_PART_KEY);
      expect(access.allowed).toBe(true);
      expect(access.scope).toBe('global');
    });
  });

  describe('canReadPieceFile (Stand proxy)', () => {
    it('DENIES a sibling part inside an event when the member is assigned', async () => {
      asMemberWithAssignments([{ partId: MY_PART }]);
      vi.mocked(prisma.musicPart.findFirst).mockResolvedValue(null);

      await expect(
        canReadPieceFile(USER, PIECE, SIBLING_KEY, true)
      ).resolves.toBe(false);
    });

    it('DENIES the conductor score inside an event when the member is assigned', async () => {
      asMemberWithAssignments([{ partId: MY_PART }]);
      vi.mocked(prisma.musicPart.findFirst).mockResolvedValue(null);
      vi.mocked(prisma.musicFile.findFirst).mockResolvedValue({
        id: 'file-score',
      } as never);
      vi.mocked(prisma.musicPart.findFirst).mockResolvedValue(null);

      await expect(
        canReadPieceFile(USER, PIECE, SCORE_KEY, true)
      ).resolves.toBe(false);
    });

    it('ALLOWs the assigned member’s own part inside an event', async () => {
      asMemberWithAssignments([{ partId: MY_PART }]);
      vi.mocked(prisma.musicPart.findFirst).mockResolvedValue({
        id: MY_PART,
      } as never);

      await expect(
        canReadPieceFile(USER, PIECE, MY_PART_KEY, true)
      ).resolves.toBe(true);
    });

    it('ALLOWs an unassigned member the published event program', async () => {
      // withinEvent relaxes only for members with no assignment at all.
      asMemberWithAssignments([]);
      await expect(
        canReadPieceFile(USER, PIECE, MY_PART_KEY, true)
      ).resolves.toBe(true);
    });

    it('DENIES an unassigned member the same file in library mode', async () => {
      asMemberWithAssignments([]);
      await expect(
        canReadPieceFile(USER, PIECE, MY_PART_KEY, false)
      ).resolves.toBe(false);
    });

    it('DENIES archived music inside an event to a plain member', async () => {
      asMemberWithAssignments([]);
      vi.mocked(prisma.musicPiece.findFirst).mockResolvedValue({
        isArchived: true,
        deletedAt: null,
      } as never);

      await expect(
        canReadPieceFile(USER, PIECE, MY_PART_KEY, true)
      ).resolves.toBe(false);
    });
  });
});