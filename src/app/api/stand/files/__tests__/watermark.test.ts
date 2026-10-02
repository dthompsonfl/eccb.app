// @vitest-environment node
/**
 * Stand file proxy + watermarking.
 *
 * The Digital Music Stand is where copyrighted music is actually read, so this
 * route is the most security-sensitive delivery path in the app. These tests
 * pin two things together:
 *
 *   1. An authorized member's view of the score is watermarked with their name,
 *      the organisation and an issue timestamp, in the real PDF bytes.
 *   2. An unauthorized member gets a non-enumerating 404 and ZERO bytes — the
 *      watermark must never become a mechanism that serves content.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { Readable } from 'stream';

vi.mock('@/lib/rate-limit', () => ({
  applyRateLimit: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    userRole: { findFirst: vi.fn() },
    member: { findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() },
    musicAssignment: { findMany: vi.fn(), findFirst: vi.fn() },
    musicPiece: { findFirst: vi.fn(), findUnique: vi.fn() },
    musicPart: { findFirst: vi.fn() },
    musicFile: { findFirst: vi.fn(), findMany: vi.fn() },
    fileDownload: { groupBy: vi.fn(), create: vi.fn() },
    audioLink: { findFirst: vi.fn() },
    event: { findFirst: vi.fn() },
    attendance: { findFirst: vi.fn() },
    user: { findFirst: vi.fn(), findUnique: vi.fn() },
    auditLog: { create: vi.fn() },
  },
}));

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock('@/lib/auth/permissions', () => ({
  getUserRoles: vi.fn().mockResolvedValue(['MUSICIAN']),
}));

vi.mock('@/lib/stand/settings', () => ({
  getStandSettings: vi.fn().mockResolvedValue({ accessPolicy: 'any_member' }),
}));

vi.mock('@/lib/services/storage', () => ({
  downloadFile: vi.fn(),
}));

vi.mock('@/lib/stand/telemetry', () => ({
  recordTelemetry: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { GET } from '@/app/api/stand/files/[...key]/route';
import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db';
import { downloadFile } from '@/lib/services/storage';

const PIECE_ID = 'piece-1';
const MY_PART_ID = 'part-trumpet-2';
const MY_PART_KEY = 'music/trumpet-2.pdf';
const SIBLING_KEY = 'music/trumpet-1.pdf';

const params = Promise.resolve({ key: ['music', 'trumpet-2.pdf'] });

async function makeScorePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.TimesRoman);
  page.drawText('Trumpet 2 in Bb', { x: 40, y: 700, size: 24, font });
  return doc.save();
}

async function extractText(bytes: Uint8Array): Promise<string> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await getDocument({ data: bytes, useSystemFonts: false }).promise;
  const parts: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    for (const item of content.items) {
      if ('str' in item) parts.push(item.str);
    }
  }
  return parts.join(' ');
}

function request(key: string, query = '?pieceId=' + PIECE_ID): NextRequest {
  return new NextRequest(`http://localhost:3000/api/stand/files/${key}${query}`);
}

const mockAuth = auth as unknown as { api: { getSession: ReturnType<typeof vi.fn> } };

/** Jane, an ACTIVE member holding ONLY "Trumpet 2". */
function asPartAssignedMember() {
  mockAuth.api.getSession.mockResolvedValue({ user: { id: 'user-1' } });
  vi.mocked(prisma.userRole.findFirst).mockResolvedValue(null as never);
  vi.mocked(prisma.member.findFirst).mockResolvedValue({
    id: 'member-1',
    sections: [],
  } as never);
  vi.mocked(prisma.musicAssignment.findMany).mockResolvedValue([
    { partId: MY_PART_ID },
  ] as never);
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    name: 'jane@example.org',
    email: 'jane@example.org',
    member: { firstName: 'Jane', lastName: 'Doe' },
  } as never);
}

/** Mallory, an ACTIVE member with NO assignment on the piece. */
function asUnassignedMember() {
  mockAuth.api.getSession.mockResolvedValue({ user: { id: 'user-1' } });
  vi.mocked(prisma.userRole.findFirst).mockResolvedValue(null as never);
  vi.mocked(prisma.member.findFirst).mockResolvedValue({
    id: 'member-1',
    sections: [],
  } as never);
  vi.mocked(prisma.musicAssignment.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    name: 'mallory@example.org',
    email: 'mallory@example.org',
    member: { firstName: 'Mallory', lastName: 'Snooper' },
  } as never);
}

/** The score part is Jane's part; a sibling part also exists on the piece. */
function asPieceWithParts() {
  vi.mocked(prisma.musicPart.findFirst).mockImplementation(
    async (args: unknown) => {
      const where = (args as { where: { storageKey?: string } }).where;
      if (where?.storageKey === MY_PART_KEY) {
        return { id: MY_PART_ID, pieceId: PIECE_ID } as never;
      }
      return { id: 'part-trumpet-1', pieceId: PIECE_ID } as never;
    }
  );
  vi.mocked(prisma.musicPiece.findFirst).mockResolvedValue({
    isArchived: false,
    deletedAt: null,
  } as never);
}

function asWatermarkedPiece() {
  vi.mocked(prisma.musicPiece.findUnique).mockResolvedValue({
    watermarkEnabled: true,
    title: 'Festival Overture',
  } as never);
}

async function serveScore(bytes: Uint8Array): Promise<void> {
  vi.mocked(downloadFile).mockResolvedValue({
    stream: Readable.from(Buffer.from(bytes)) as never,
    metadata: { contentType: 'application/pdf', size: bytes.byteLength },
  });
}

describe('Stand file proxy watermarking', () => {
  beforeEach(() => {
    vi.mocked(prisma.musicAssignment.findMany).mockReset();
    vi.mocked(prisma.userRole.findFirst).mockReset();
    vi.mocked(prisma.member.findFirst).mockReset();
    vi.mocked(prisma.musicPart.findFirst).mockReset();
    vi.mocked(prisma.musicPiece.findFirst).mockReset();
    vi.mocked(prisma.musicPiece.findUnique).mockReset();
    vi.mocked(prisma.musicFile.findFirst).mockReset();
    vi.mocked(prisma.user.findUnique).mockReset();
    vi.mocked(downloadFile).mockReset();
    mockAuth.api.getSession.mockReset();
  });

  it('stamps the viewer\'s copy with the recipient and organisation', async () => {
    asPartAssignedMember();
    asPieceWithParts();
    asWatermarkedPiece();
    await serveScore(await makeScorePdf());

    const response = await GET(request(MY_PART_KEY), { params });

    expect(response.status).toBe(200);
    const delivered = new Uint8Array(await response.arrayBuffer());
    expect(delivered.byteLength).toBeGreaterThan(0);

    const text = await extractText(delivered);
    expect(text).toContain('Jane Doe');
    expect(text).toContain('ECCB Test');
    // The score itself is still readable.
    expect(text).toContain('Trumpet 2 in Bb');
  });

  it('gives an unassigned member a 404 and zero bytes', async () => {
    asUnassignedMember();
    asPieceWithParts();
    asWatermarkedPiece();
    const original = await makeScorePdf();
    await serveScore(original);

    const response = await GET(request(MY_PART_KEY), { params });

    expect(response.status).toBe(404);

    const body = await response.text();
    expect(body).not.toContain('%PDF');
    expect(body).not.toContain('Mallory');
    expect(body).not.toContain('Jane Doe');
    expect(body).not.toContain('Trumpet 2');

    // Storage was never read: no bytes left the building.
    expect(downloadFile).not.toHaveBeenCalled();
  });

  it('still denies a sibling part to a member assigned a different part', async () => {
    asPartAssignedMember();
    asPieceWithParts();
    asWatermarkedPiece();
    await serveScore(await makeScorePdf());

    const response = await GET(request(SIBLING_KEY), {
      params: Promise.resolve({ key: ['music', 'trumpet-1.pdf'] }),
    });

    expect(response.status).toBe(404);
    expect(downloadFile).not.toHaveBeenCalled();
  });

  it('404s without a scope, before touching storage', async () => {
    asPartAssignedMember();
    asPieceWithParts();
    asWatermarkedPiece();
    await serveScore(await makeScorePdf());

    const response = await GET(request(MY_PART_KEY, ''), { params });

    expect(response.status).toBe(404);
    expect(downloadFile).not.toHaveBeenCalled();
  });

  it('refuses to serve when the PDF cannot be stamped', async () => {
    asPartAssignedMember();
    asPieceWithParts();
    asWatermarkedPiece();
    const corrupt = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0, 1, 2]);
    await serveScore(corrupt);

    const response = await GET(request(MY_PART_KEY), { params });

    // Fails closed: 500 rather than the clean file.
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).not.toContain('%PDF');
  });
});