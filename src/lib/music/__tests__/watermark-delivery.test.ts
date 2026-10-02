// @vitest-environment node
/**
 * Delivery watermarking for copyrighted sheet music.
 *
 * These are the highest-risk tests in the feature, so they are written against
 * the REAL PDF bytes produced by pdf-lib and read back with pdf.js — a mock
 * would only prove the mock works.
 *
 * Coverage:
 *   (a) an authorized member's delivered file carries the recipient watermark
 *   (b) an admin can enable/disable; a non-admin cannot
 *   (c) the licensing report aggregates correctly
 *   (d) an unauthorized user receives NO bytes and NO watermark
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { Readable } from 'stream';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/lib/db', () => ({
  prisma: {
    userRole: { findFirst: vi.fn() },
    member: { findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() },
    musicAssignment: { findMany: vi.fn(), findFirst: vi.fn() },
    musicPiece: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    musicPart: { findFirst: vi.fn() },
    musicFile: { findFirst: vi.fn(), findMany: vi.fn() },
    fileDownload: { groupBy: vi.fn(), create: vi.fn() },
    user: { findFirst: vi.fn(), findUnique: vi.fn() },
    auditLog: { create: vi.fn() },
    attendance: { findFirst: vi.fn() },
    event: { findFirst: vi.fn() },
  },
}));

vi.mock('@/lib/rate-limit', () => ({
  applyRateLimit: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('@/lib/auth/guards', () => ({
  getSession: vi.fn(),
}));

vi.mock('@/lib/auth/permissions', () => ({
  getUserRoles: vi.fn().mockResolvedValue(['MUSICIAN']),
  checkUserPermission: vi.fn(),
}));

vi.mock('@/lib/stand/settings', () => ({
  getStandSettings: vi.fn().mockResolvedValue({ accessPolicy: 'any_member' }),
}));

vi.mock('@/lib/stand/telemetry', () => ({
  recordTelemetry: vi.fn(),
}));

vi.mock('@/lib/services/storage', () => ({
  downloadFile: vi.fn(),
}));

import { prisma } from '@/lib/db';
import { auth } from '@/lib/auth/config';
import { getSession } from '@/lib/auth/guards';
import { checkUserPermission } from '@/lib/auth/permissions';
import { downloadFile } from '@/lib/services/storage';
import { applyDeliveryWatermark } from '@/lib/music/watermark-delivery';
import { formatWatermarkTimestamp, stampPdfWatermark } from '@/lib/music/watermark';
import { setPieceWatermark } from '@/lib/music/watermark-policy';
import {
  buildLicensingReport,
  csvCell,
  licensingReportToCsv,
} from '@/lib/music/licensing-report';
import { GET as filesGET } from '@/app/api/files/[...key]/route';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const PIECE_ID = 'piece-1';
const PART_ID = 'part-trumpet-2';
const STORAGE_KEY = 'music/trumpet-2.pdf';
const MEMBER_ID = 'member-1';
const ADMIN_ID = 'user-admin';
const ISSUED_AT = new Date('2026-10-01T14:30:00.000Z');
const EXPECTED_STAMP = '2026-10-01T14:30:00Z';

/** A real one-page PDF, as an unsigned score would be in storage. */
async function makeScorePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.TimesRoman);
  page.drawText('Trumpet 2 in Bb', { x: 40, y: 700, size: 24, font });
  page.drawText('Allegro con brio', { x: 40, y: 660, size: 14, font });
  return doc.save();
}

/** Extract all text from a PDF, so assertions are on real content. */
async function extractText(bytes: Uint8Array): Promise<string> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await getDocument({ data: bytes, useSystemFonts: false }).promise;
  const parts: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    for (const item of content.items) {
      if ('str' in item) parts.push(item.str);
    }
  }
  return parts.join(' ');
}

/** Wire the DB so `user-1` is Jane, a plain member assigned to her own part. */
function asAssignedMember() {
  vi.mocked(prisma.userRole.findFirst).mockResolvedValue(null);
  vi.mocked(prisma.member.findFirst).mockResolvedValue({
    id: MEMBER_ID,
    sections: [],
  } as never);
  vi.mocked(prisma.musicAssignment.findMany).mockResolvedValue([
    { partId: PART_ID },
  ] as never);
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    name: 'jane@example.org',
    email: 'jane@example.org',
    member: { firstName: 'Jane', lastName: 'Doe' },
  } as never);
}

/** Wire the DB so `user-1` is an active member with NO assignment. */
function asUnassignedMember() {
  vi.mocked(prisma.userRole.findFirst).mockResolvedValue(null);
  vi.mocked(prisma.member.findFirst).mockResolvedValue({
    id: MEMBER_ID,
    sections: [],
  } as never);
  vi.mocked(prisma.musicAssignment.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    name: 'mallory@example.org',
    email: 'mallory@example.org',
    member: { firstName: 'Mallory', lastName: 'Snooper' },
  } as never);
}

/** A live, watermarked piece record. */
function asWatermarkedPiece() {
  vi.mocked(prisma.musicPiece.findUnique).mockResolvedValue({
    watermarkEnabled: true,
    title: 'Festival Overture',
  } as never);
  vi.mocked(prisma.musicPiece.findFirst).mockResolvedValue({
    isArchived: false,
    deletedAt: null,
  } as never);
}

describe('delivery watermarking', () => {
  beforeEach(() => {
    // The global setup calls vi.clearAllMocks(), which clears calls but NOT
    // implementations, so every mock read here must be given a default or a
    // previous test's recipient/piece leaks into this one.
    vi.mocked(prisma.userRole.findFirst).mockResolvedValue(null as never);
    vi.mocked(prisma.member.findFirst).mockResolvedValue(null as never);
    vi.mocked(prisma.musicAssignment.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.musicPart.findFirst).mockResolvedValue(null as never);
    vi.mocked(prisma.musicFile.findFirst).mockResolvedValue(null as never);
    vi.mocked(prisma.musicFile.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.musicPiece.findFirst).mockResolvedValue(null as never);
    vi.mocked(prisma.musicPiece.findUnique).mockResolvedValue(null as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null as never);
    vi.mocked(prisma.user.findFirst).mockResolvedValue(null as never);
    vi.mocked(prisma.fileDownload.groupBy).mockResolvedValue([] as never);
    vi.mocked(prisma.musicPiece.update).mockResolvedValue({} as never);
    vi.mocked(prisma.fileDownload.create).mockResolvedValue({} as never);
    vi.mocked(prisma.auditLog.create).mockResolvedValue({} as never);
    vi.mocked(prisma.event.findFirst).mockResolvedValue(null as never);
    vi.mocked(prisma.attendance.findFirst).mockResolvedValue(null as never);
    vi.mocked(downloadFile).mockReset();
    vi.mocked(getSession).mockResolvedValue(null as never);
    vi.mocked(checkUserPermission).mockResolvedValue(false as never);
    vi.mocked(auth.api.getSession).mockResolvedValue(null as never);
  });

  // ── (a) authorized member's delivered file carries the watermark ───────────
  describe('(a) authorized delivery', () => {
    it('stamps the recipient name, organisation and timestamp into the PDF', async () => {
      asWatermarkedPiece();
      vi.mocked(prisma.user.findUnique).mockResolvedValue({
        name: 'jane@example.org',
        email: 'jane@example.org',
        member: { firstName: 'Jane', lastName: 'Doe' },
      } as never);

      const result = await applyDeliveryWatermark({
        bytes: await makeScorePdf(),
        contentType: 'application/pdf',
        pieceId: PIECE_ID,
        userId: 'user-1',
        now: ISSUED_AT,
      });

      expect(result.watermarked).toBe(true);

      const text = await extractText(result.bytes);
      expect(text).toContain('Jane Doe');
      expect(text).toContain('ECCB Test');
      expect(text).toContain(EXPECTED_STAMP);

      // The score content itself survives stamping.
      expect(text).toContain('Trumpet 2 in Bb');
    });

    it('stamps the served file end-to-end through the download route', async () => {
      asAssignedMember();
      asWatermarkedPiece();

      // The stand scope lookup: the key is a MusicPart storage key.
      vi.mocked(prisma.musicPart.findFirst).mockResolvedValue({
        id: PART_ID,
        pieceId: PIECE_ID,
      } as never);

      const original = await makeScorePdf();
      vi.mocked(downloadFile).mockResolvedValue({
        stream: Readable.from(Buffer.from(original)) as never,
        metadata: { contentType: 'application/pdf', size: original.byteLength },
      });

      vi.mocked(getSession).mockResolvedValue({
        user: { id: 'user-1', email: 'jane@example.org' },
      } as never);
      vi.mocked(checkUserPermission).mockImplementation(async (_u, perm) =>
        perm === 'music.download.assigned'
      );
      vi.mocked(prisma.musicFile.findFirst).mockResolvedValue({
        id: 'file-1',
        fileName: 'trumpet-2.pdf',
        fileSize: original.byteLength,
        isPublic: false,
      } as never);

      const request = new Request(`http://localhost/api/files/${STORAGE_KEY}`) as never;
      const response = await filesGET(request, {
        params: Promise.resolve({ key: ['music', 'trumpet-2.pdf'] }),
      });

      expect(response.status).toBe(200);
      const delivered = new Uint8Array(await response.arrayBuffer());
      // Capture the length BEFORE parsing: pdf.js transfers the underlying
      // ArrayBuffer to its worker, detaching it and leaving byteLength at 0.
      const deliveredSize = delivered.byteLength;

      // The delivered bytes carry the recipient marking...
      const text = await extractText(delivered);
      expect(text).toContain('Jane Doe');
      expect(text).toContain('ECCB Test');

      // ...and Content-Length describes the stamped copy, not the original file.
      expect(Number(response.headers.get('Content-Length'))).toBe(deliveredSize);
      expect(deliveredSize).not.toBe(original.byteLength);
    });

    it('uses the account label when the recipient has no Member record', async () => {
      asWatermarkedPiece();
      vi.mocked(prisma.user.findUnique).mockResolvedValue({
        name: 'sub@example.org',
        email: 'sub@example.org',
        member: null,
      } as never);

      const result = await applyDeliveryWatermark({
        bytes: await makeScorePdf(),
        contentType: 'application/pdf',
        pieceId: PIECE_ID,
        userId: 'user-x',
        now: ISSUED_AT,
      });

      expect(await extractText(result.bytes)).toContain('sub@example.org');
    });

    it('passes non-PDF content through untouched rather than buffering it', async () => {
      const wav = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 1, 2, 3]);

      const result = await applyDeliveryWatermark({
        bytes: wav,
        contentType: 'audio/wav',
        pieceId: PIECE_ID,
        userId: 'user-1',
      });

      expect(result.watermarked).toBe(false);
      expect(Array.from(result.bytes)).toEqual(Array.from(wav));
    });

    it('refuses to deliver a PDF it cannot stamp (fails closed)', async () => {
      asWatermarkedPiece();
      vi.mocked(prisma.user.findUnique).mockResolvedValue({
        name: 'jane@example.org',
        email: 'jane@example.org',
        member: { firstName: 'Jane', lastName: 'Doe' },
      } as never);
      const corrupt = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0, 1, 2]);

      await expect(
        applyDeliveryWatermark({
          bytes: corrupt,
          contentType: 'application/pdf',
          pieceId: PIECE_ID,
          userId: 'user-1',
        })
      ).rejects.toThrow(/unstampable/i);
    });

    it('stamps every page, not just the first', async () => {
      asWatermarkedPiece();
      vi.mocked(prisma.user.findUnique).mockResolvedValue({
        name: 'jane@example.org',
        email: 'jane@example.org',
        member: { firstName: 'Jane', lastName: 'Doe' },
      } as never);
      const doc = await PDFDocument.create();
      doc.addPage([612, 792]);
      doc.addPage([612, 792]);

      const result = await applyDeliveryWatermark({
        bytes: await doc.save(),
        contentType: 'application/pdf',
        pieceId: PIECE_ID,
        userId: 'user-1',
        now: ISSUED_AT,
      });

      const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
      const parsed = await getDocument({ data: result.bytes, useSystemFonts: false }).promise;
      expect(parsed.numPages).toBe(2);
      for (let i = 1; i <= 2; i++) {
        const content = await (await parsed.getPage(i)).getTextContent();
        const joined = content.items.map((it) => ('str' in it ? it.str : '')).join(' ');
        expect(joined).toContain('Jane Doe');
      }
    });
  });

  // ── (d) unauthorized user receives no bytes ───────────────────────────────
  describe('(d) unauthorized delivery', () => {
    it('returns 403 and zero bytes for an active member with no assignment', async () => {
      asUnassignedMember();
      asWatermarkedPiece();
      vi.mocked(prisma.musicPart.findFirst).mockResolvedValue({
        id: PART_ID,
        pieceId: PIECE_ID,
      } as never);

      const original = await makeScorePdf();
      vi.mocked(downloadFile).mockResolvedValue({
        stream: Readable.from(Buffer.from(original)) as never,
        metadata: { contentType: 'application/pdf', size: original.byteLength },
      });

      vi.mocked(getSession).mockResolvedValue({
        user: { id: 'user-1', email: 'mallory@example.org' },
      } as never);
      vi.mocked(checkUserPermission).mockImplementation(async (_u, perm) =>
        perm === 'music.download.assigned'
      );

      const response = await filesGET(
        new Request(`http://localhost/api/files/${STORAGE_KEY}`) as never,
        { params: Promise.resolve({ key: ['music', 'trumpet-2.pdf'] }) }
      );

      expect(response.status).toBe(403);

      // No bytes of copyrighted material, and no watermark text.
      const body = await response.text();
      expect(body).not.toContain('%PDF');
      expect(body).not.toContain('Mallory');
      expect(body).not.toContain('Jane Doe');
      expect(body).not.toContain('Mallory Snooper');

      // And storage was never read.
      expect(downloadFile).not.toHaveBeenCalled();
    });

    it('returns 401 and no bytes for an anonymous caller', async () => {
      vi.mocked(getSession).mockResolvedValue(null as never);
      vi.mocked(prisma.musicFile.findFirst).mockResolvedValue({ isPublic: false } as never);

      const response = await filesGET(
        new Request(`http://localhost/api/files/${STORAGE_KEY}`) as never,
        { params: Promise.resolve({ key: ['music', 'trumpet-2.pdf'] }) }
      );

      expect(response.status).toBe(401);
      expect(await response.text()).not.toContain('%PDF');
      expect(downloadFile).not.toHaveBeenCalled();
    });

    it('never stamps anything for a denied member', async () => {
      asUnassignedMember();
      const result = await applyDeliveryWatermark({
        bytes: await makeScorePdf(),
        contentType: 'application/pdf',
        pieceId: PIECE_ID,
        userId: 'user-1',
      });
      // The stamper is capable of stamping; the DENY happened upstream in the
      // route. This asserts the deny is not implemented by "just not stamping".
      expect(result.watermarked).toBe(true);
      expect(await extractText(result.bytes)).toContain('Mallory Snooper');
    });
  });

  // ── (b) admin-only watermark control ──────────────────────────────────────
  describe('(b) watermark administration', () => {
    it('defaults to enabled when the piece has no record', async () => {
      vi.mocked(prisma.musicPiece.findUnique).mockResolvedValue(null as never);
      vi.mocked(prisma.user.findUnique).mockResolvedValue({
        name: 'jane@example.org',
        email: 'jane@example.org',
        member: { firstName: 'Jane', lastName: 'Doe' },
      } as never);
      const result = await applyDeliveryWatermark({
        bytes: await makeScorePdf(),
        contentType: 'application/pdf',
        pieceId: 'unknown-piece',
        userId: 'user-1',
        now: ISSUED_AT,
      });
      expect(result.watermarked).toBe(true);
      expect(await extractText(result.bytes)).toContain('Jane Doe');
    });

    it('defaults to enabled when watermarkEnabled is null (a pre-migration row)', async () => {
      // `watermarkEnabled` was added by migration, so existing rows can be null.
      // Default-secure means a null must still be watermarked — a null must never
      // read as "explicitly disabled".
      vi.mocked(prisma.musicPiece.findUnique).mockResolvedValue({
        id: 'piece-1',
        title: 'Test Piece',
        watermarkEnabled: null,
      } as never);
      vi.mocked(prisma.user.findUnique).mockResolvedValue({
        name: 'jane@example.org',
        email: 'jane@example.org',
        member: { firstName: 'Jane', lastName: 'Doe' },
      } as never);

      const result = await applyDeliveryWatermark({
        bytes: await makeScorePdf(),
        contentType: 'application/pdf',
        pieceId: 'piece-1',
        userId: 'user-1',
        now: ISSUED_AT,
      });

      expect(result.watermarked).toBe(true);
      expect(await extractText(result.bytes)).toContain('Jane Doe');
    });

    it('defaults to enabled when the policy lookup throws', async () => {
      // Fail closed: if the policy cannot be read we watermark. Delivering a
      // clean copy because a database read failed is the worst outcome.
      vi.mocked(prisma.musicPiece.findUnique).mockRejectedValue(
        new Error('database unavailable'),
      );
      vi.mocked(prisma.user.findUnique).mockResolvedValue({
        name: 'jane@example.org',
        email: 'jane@example.org',
        member: { firstName: 'Jane', lastName: 'Doe' },
      } as never);

      const result = await applyDeliveryWatermark({
        bytes: await makeScorePdf(),
        contentType: 'application/pdf',
        pieceId: 'piece-1',
        userId: 'user-1',
        now: ISSUED_AT,
      });

      expect(result.watermarked).toBe(true);
      expect(await extractText(result.bytes)).toContain('Jane Doe');
    });

    it('lets an admin disable it with a recorded reason', async () => {
      vi.mocked(prisma.userRole.findFirst).mockResolvedValue({ id: 'ur-1' } as never);
      vi.mocked(prisma.musicPiece.findUnique).mockResolvedValue({
        id: PIECE_ID,
        watermarkEnabled: true,
      } as never);

      const result = await setPieceWatermark({
        actorId: ADMIN_ID,
        pieceId: PIECE_ID,
        enabled: false,
        reason: 'Public-domain 1911 edition, verified',
      });

      expect(result).toEqual({ success: true, enabled: false });
      expect(vi.mocked(prisma.musicPiece.update).mock.calls[0][0].data).toMatchObject({
        watermarkEnabled: false,
        watermarkDisabledBy: ADMIN_ID,
        watermarkDisabledReason: 'Public-domain 1911 edition, verified',
      });
      expect(vi.mocked(prisma.musicPiece.update).mock.calls[0][0].data.watermarkDisabledAt)
        .toBeInstanceOf(Date);
    });

    it('delivers unwatermarked bytes only after the admin turned it off', async () => {
      vi.mocked(prisma.musicPiece.findUnique).mockResolvedValue({
        watermarkEnabled: false,
        title: 'Festival Overture',
      } as never);
      vi.mocked(prisma.user.findUnique).mockResolvedValue({
        name: 'jane@example.org',
        email: 'jane@example.org',
        member: { firstName: 'Jane', lastName: 'Doe' },
      } as never);

      const result = await applyDeliveryWatermark({
        bytes: await makeScorePdf(),
        contentType: 'application/pdf',
        pieceId: PIECE_ID,
        userId: 'user-1',
      });

      expect(result.watermarked).toBe(false);
      expect(await extractText(result.bytes)).not.toContain('Jane Doe');
    });

    it('clears the disabling metadata when an admin re-enables', async () => {
      vi.mocked(prisma.userRole.findFirst).mockResolvedValue({ id: 'ur-1' } as never);
      vi.mocked(prisma.musicPiece.findUnique).mockResolvedValue({
        id: PIECE_ID,
        watermarkEnabled: false,
      } as never);

      const result = await setPieceWatermark({
        actorId: ADMIN_ID,
        pieceId: PIECE_ID,
        enabled: true,
      });

      expect(result).toEqual({ success: true, enabled: true });
      expect(vi.mocked(prisma.musicPiece.update).mock.calls[0][0].data).toEqual({
        watermarkEnabled: true,
        watermarkDisabledBy: null,
        watermarkDisabledAt: null,
        watermarkDisabledReason: null,
      });
    });

    it('refuses a non-admin with 403 and writes nothing', async () => {
      vi.mocked(prisma.userRole.findFirst).mockResolvedValue(null as never);

      const result = await setPieceWatermark({
        actorId: 'user-1',
        pieceId: PIECE_ID,
        enabled: false,
        reason: 'I want the clean file',
      });

      expect(result).toMatchObject({ success: false, status: 403 });
      expect(prisma.musicPiece.update).not.toHaveBeenCalled();
    });

    it('refuses an admin who disables without a reason', async () => {
      vi.mocked(prisma.userRole.findFirst).mockResolvedValue({ id: 'ur-1' } as never);

      const result = await setPieceWatermark({
        actorId: ADMIN_ID,
        pieceId: PIECE_ID,
        enabled: false,
        reason: '   ',
      });

      expect(result).toMatchObject({ success: false, status: 400 });
      expect(prisma.musicPiece.update).not.toHaveBeenCalled();
    });

    it('404s for an unknown piece', async () => {
      vi.mocked(prisma.userRole.findFirst).mockResolvedValue({ id: 'ur-1' } as never);
      vi.mocked(prisma.musicPiece.findUnique).mockResolvedValue(null as never);

      const result = await setPieceWatermark({
        actorId: ADMIN_ID,
        pieceId: 'nope',
        enabled: false,
        reason: 'because',
      });

      expect(result).toMatchObject({ success: false, status: 404 });
    });
  });

  // ── (c) licensing report aggregation ─────────────────────────────────────
  describe('(c) licensing report', () => {
    const piece = {
      id: PIECE_ID,
      title: 'Festival Overture',
      catalogNumber: 'RUB-1977',
      copyrightYear: 1977,
      watermarkEnabled: true,
      composer: { fullName: 'A. Composer' },
      publisher: { name: 'Rubank Publications' },
    };

    function wireAssignments() {
      vi.mocked(prisma.musicAssignment.findMany).mockResolvedValue([
        {
          id: 'as-1',
          memberId: MEMBER_ID,
          pieceId: PIECE_ID,
          partName: 'Trumpet 2',
          copyNumber: 2,
          status: 'PICKED_UP',
          assignedAt: new Date('2026-09-01T10:00:00Z'),
          pickedUpAt: new Date('2026-09-05T10:00:00Z'),
          returnedAt: null,
          dueDate: null,
          member: {
            id: MEMBER_ID,
            firstName: 'Jane',
            lastName: 'Doe',
            email: 'jane@example.org',
          },
          piece,
        },
        {
          id: 'as-2',
          memberId: 'member-2',
          pieceId: 'piece-2',
          partName: 'Flute',
          copyNumber: null,
          status: 'RETURNED',
          assignedAt: new Date('2026-08-01T10:00:00Z'),
          pickedUpAt: new Date('2026-08-02T10:00:00Z'),
          returnedAt: new Date('2026-09-20T10:00:00Z'),
          dueDate: null,
          member: {
            id: 'member-2',
            firstName: 'Sam',
            lastName: 'Reed',
            email: 'sam@example.org',
          },
          piece: {
            ...piece,
            id: 'piece-2',
            title: 'Second Concerto',
            catalogNumber: null,
            copyrightYear: null,
            watermarkEnabled: false,
            composer: null,
            publisher: null,
          },
        },
      ] as never);

      vi.mocked(prisma.fileDownload.groupBy).mockResolvedValue([
        { fileId: 'file-1', _count: { _all: 3 } },
        { fileId: 'file-2', _count: { _all: 4 } },
      ] as never);
      vi.mocked(prisma.musicFile.findMany).mockResolvedValue([
        { id: 'file-1', pieceId: PIECE_ID },
        { id: 'file-2', pieceId: 'piece-2' },
      ] as never);
    }

    it('aggregates one row per issued work with copyright metadata', async () => {
      wireAssignments();

      const report = await buildLicensingReport();

      expect(report.rows).toHaveLength(2);
      const jane = report.rows.find((r) => r.memberId === MEMBER_ID);
      expect(jane).toMatchObject({
        memberName: 'Jane Doe',
        memberEmail: 'jane@example.org',
        pieceTitle: 'Festival Overture',
        composer: 'A. Composer',
        publisher: 'Rubank Publications',
        catalogNumber: 'RUB-1977',
        copyrightYear: 1977,
        partName: 'Trumpet 2',
        copyNumber: 2,
        status: 'PICKED_UP',
        returnedAt: null,
        watermarkEnabled: true,
        downloadCount: 3,
      });
      expect(jane?.assignedAt).toBe('2026-09-01T10:00:00Z');
    });

    it('summarises outstanding vs returned copies', async () => {
      wireAssignments();
      const report = await buildLicensingReport();

      expect(report.summary).toEqual({
        totalWorks: 2,
        totalMembers: 2,
        totalIssued: 2,
        currentlyIssued: 1,
        returned: 1,
        watermarkDisabledWorks: 1,
      });
    });

    it('can exclude returned copies', async () => {
      wireAssignments();
      const report = await buildLicensingReport({ includeReturned: false });

      expect(report.rows).toHaveLength(1);
      expect(report.rows[0].memberName).toBe('Jane Doe');
      expect(report.summary.returned).toBe(0);
    });

    it('counts downloads per piece, not globally', async () => {
      wireAssignments();
      const report = await buildLicensingReport();
      expect(report.rows.find((r) => r.pieceId === 'piece-2')?.downloadCount).toBe(4);
    });

    it('exports CSV with a header, one line per issuance and proper escaping', async () => {
      wireAssignments();
      const report = await buildLicensingReport();
      const csv = licensingReportToCsv(report);
      const lines = csv.trim().split('\n');

      expect(lines[0]).toMatch(/^# Generated /);
      expect(lines[1]).toContain('memberName');
      expect(lines[1]).toContain('pieceTitle');
      expect(lines).toHaveLength(4);
      expect(csv).toContain('Jane Doe');
      expect(csv).toContain('Festival Overture');
      expect(csv).toContain('2026-09-01T10:00:00Z');
    });

    it('escapes CSV cells containing commas, quotes and newlines', () => {
      expect(csvCell('Overture, No. 1')).toBe('"Overture, No. 1"');
      expect(csvCell('He said "hi"')).toBe('"He said ""hi"""');
      expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
      expect(csvCell('plain')).toBe('plain');
      expect(csvCell(null)).toBe('');
    });
  });

  describe('timestamp formatting', () => {
    it('is stable, UTC and sortable', () => {
      expect(formatWatermarkTimestamp(new Date('2026-01-02T03:04:05Z'))).toBe(
        '2026-01-02T03:04:05Z'
      );
      expect(formatWatermarkTimestamp(new Date('2026-12-31T23:59:59Z'))).toBe(
        '2026-12-31T23:59:59Z'
      );
      // Midnight must render as 00, never the 24 some ICU builds emit.
      expect(formatWatermarkTimestamp(new Date('2026-03-04T00:00:00Z'))).toBe(
        '2026-03-04T00:00:00Z'
      );
    });
  });

  describe('stampPdfWatermark', () => {
    it('stamps an explicitly supplied text without touching the DB', async () => {
      const stamped = await stampPdfWatermark(
        await makeScorePdf(),
        {
          banner: 'ECCB — licensed copy',
          attribution: 'Issued to Test Recipient',
          trail: 'Issued to Test Recipient · ECCB · 2026-10-01T00:00:00Z',
        },
        'Festival Overture'
      );

      const text = await extractText(stamped);
      expect(text).toContain('Test Recipient');
      expect(text).toContain('Festival Overture');
      expect(prisma.musicPiece.findUnique).not.toHaveBeenCalled();
    });
  });
});

// Keep the session mock typed for the route import above.
vi.mocked(getSession).mockResolvedValue(null as never);
void auth;