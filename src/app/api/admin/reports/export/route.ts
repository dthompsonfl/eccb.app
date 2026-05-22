import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requirePermission } from '@/lib/auth/guards';
import { REPORT_VIEW } from '@/lib/auth/permission-constants';

export async function GET() {
  await requirePermission(REPORT_VIEW);

  const [members, events, musicPieces, musicFiles, attendance] = await Promise.all([
    prisma.member.findMany({
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        status: true,
        joinDate: true,
        leaveDate: true,
        isSubstitute: true,
        createdAt: true,
        updatedAt: true,
        sections: {
          select: {
            isLeader: true,
            assignedAt: true,
            section: { select: { id: true, name: true } },
          },
        },
        instruments: {
          select: {
            isPrimary: true,
            instrument: { select: { id: true, name: true, family: true } },
          },
        },
      },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    }),
    prisma.event.findMany({
      select: {
        id: true,
        title: true,
        description: true,
        type: true,
        startTime: true,
        endTime: true,
        location: true,
        venueId: true,
        callTime: true,
        dressCode: true,
        isPublished: true,
        isCancelled: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { startTime: 'desc' },
    }),
    prisma.musicPiece.findMany({
      select: {
        id: true,
        title: true,
        subtitle: true,
        difficulty: true,
        duration: true,
        genre: true,
        style: true,
        instrumentation: true,
        catalogNumber: true,
        isArchived: true,
        createdAt: true,
        updatedAt: true,
        composer: { select: { id: true, fullName: true } },
        arranger: { select: { id: true, fullName: true } },
        publisher: { select: { id: true, name: true } },
      },
      orderBy: { title: 'asc' },
    }),
    prisma.musicFile.findMany({
      select: {
        id: true,
        pieceId: true,
        fileName: true,
        fileType: true,
        fileSize: true,
        mimeType: true,
        version: true,
        description: true,
        isPublic: true,
        isArchived: true,
        uploadedAt: true,
        uploadedBy: true,
        instrumentName: true,
        pageCount: true,
        partLabel: true,
        partNumber: true,
        section: true,
      },
      orderBy: { uploadedAt: 'desc' },
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
  ]);

  const exportedAt = new Date().toISOString();
  const body = JSON.stringify(
    {
      exportedAt,
      schemaVersion: 1,
      data: {
        members,
        events,
        musicPieces,
        musicFiles,
        attendance,
      },
    },
    null,
    2,
  );

  return new NextResponse(body, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="eccb-full-report-${exportedAt.slice(0, 10)}.json"`,
      'Cache-Control': 'no-store',
    },
  });
}
