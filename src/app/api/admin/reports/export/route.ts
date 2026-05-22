import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/auth/guards';
import { REPORT_EXPORT } from '@/lib/auth/permission-constants';
import { prisma } from '@/lib/db';
import { auditLog } from '@/lib/services/audit';

export const dynamic = 'force-dynamic';

export async function GET() {
  await requirePermission(REPORT_EXPORT);

  const [members, sections, instruments, events, attendance, musicPieces, musicFiles, announcements] = await Promise.all([
    prisma.member.findMany({
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        status: true,
        joinDate: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    }),
    prisma.section.findMany({ orderBy: { name: 'asc' } }),
    prisma.instrument.findMany({ orderBy: { name: 'asc' } }),
    prisma.event.findMany({
      select: {
        id: true,
        title: true,
        type: true,
        startTime: true,
        endTime: true,
        location: true,
        isPublic: true,
        isCancelled: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { startTime: 'desc' },
    }),
    prisma.attendance.findMany({
      select: {
        id: true,
        eventId: true,
        memberId: true,
        status: true,
        notes: true,
        markedAt: true,
        markedBy: true,
      },
      orderBy: { markedAt: 'desc' },
    }),
    prisma.musicPiece.findMany({
      select: {
        id: true,
        title: true,
        composer: true,
        arranger: true,
        publisher: true,
        difficulty: true,
        duration: true,
        isArchived: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { title: 'asc' },
    }),
    prisma.musicFile.findMany({
      select: {
        id: true,
        pieceId: true,
        fileName: true,
        fileType: true,
        instrument: true,
        fileSize: true,
        uploadedAt: true,
      },
      orderBy: { uploadedAt: 'desc' },
    }),
    prisma.announcement.findMany({
      select: {
        id: true,
        title: true,
        type: true,
        audience: true,
        status: true,
        isUrgent: true,
        isPinned: true,
        publishAt: true,
        publishedAt: true,
        expiresAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  const payload = {
    exportedAt: new Date().toISOString(),
    formatVersion: 1,
    tables: {
      members,
      sections,
      instruments,
      events,
      attendance,
      musicPieces,
      musicFiles,
      announcements,
    },
  };

  await auditLog({
    action: 'report.export.all',
    entityType: 'Report',
    newValues: {
      members: members.length,
      events: events.length,
      attendance: attendance.length,
      musicPieces: musicPieces.length,
    },
  });

  const body = JSON.stringify(payload, null, 2);
  return new NextResponse(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="eccb-export-${new Date().toISOString().slice(0, 10)}.json"`,
      'Cache-Control': 'no-store',
    },
  });
}
