import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { formatDate, formatTime } from '@/lib/date';
import {
  buildProgramDocument,
  type ProgramDocument,
  type ProgramItemInput,
  type ProgramPerformer,
} from './program';

/**
 * Prisma query for a concert program. Includes the assignment + section data
 * the program needs so the public page, print view and PDF all credit the
 * same performers from the existing `MusicAssignment` / `MemberSection`
 * models rather than a parallel program-specific table.
 */
const programInclude = {
  venue: { select: { name: true, city: true, state: true } },
  music: {
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    include: {
      piece: {
        include: {
          composer: { select: { fullName: true } },
          arranger: { select: { fullName: true } },
          assignments: {
            include: {
              member: {
                select: {
                  id: true,
                  firstName: true,
                  lastName: true,
                  deletedAt: true,
                  sections: { include: { section: { select: { name: true } } } },
                },
              },
            },
            orderBy: [{ partName: 'asc' }, { id: 'asc' }],
          },
        },
      },
    },
  },
} satisfies Prisma.EventInclude;

interface ProgramRow {
  id: string;
  title: string;
  isPublished: boolean;
  description: string | null;
  startTime: Date;
  endTime: Date;
  dressCode: string | null;
  venue: { name: string; city: string | null; state: string | null } | null;
  music: Array<{
    id: string;
    sortOrder: number;
    notes: string | null;
    piece: {
      id: string;
      title: string;
      subtitle: string | null;
      duration: number | null;
      composer: { fullName: string } | null;
      arranger: { fullName: string } | null;
      assignments: Array<{
        id: string;
        partName: string | null;
        member: {
          id: string;
          firstName: string;
          lastName: string;
          deletedAt: Date | null;
          sections: Array<{ section: { name: string } }>;
        };
      }>;
    };
  }>;
}

function mapPerformers(row: ProgramRow['music'][number]): ProgramPerformer[] {
  return row.piece.assignments
    .filter((assignment) => assignment.member.deletedAt === null)
    .map((assignment) => ({
      memberId: assignment.member.id,
      name: `${assignment.member.firstName} ${assignment.member.lastName}`.trim(),
      partName: assignment.partName,
      sectionNames: assignment.member.sections.map((s) => s.section.name).sort(),
    }))
    .sort((a, b) => {
      if (a.partName !== b.partName) {
        if (a.partName === null) return 1;
        if (b.partName === null) return -1;
        return a.partName < b.partName ? -1 : 1;
      }
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
}

export function mapProgramRows(event: ProgramRow): ProgramDocument {
  const venue = event.venue;
  const venueLabel = venue
    ? [venue.name, venue.city, venue.state].filter(Boolean).join(', ')
    : null;

  const items: ProgramItemInput[] = event.music.map((row) => ({
    id: row.id,
    sortOrder: row.sortOrder,
    pieceId: row.piece.id,
    title: row.piece.title,
    subtitle: row.piece.subtitle,
    composer: row.piece.composer?.fullName ?? null,
    arranger: row.piece.arranger?.fullName ?? null,
    duration: row.piece.duration,
    notes: row.notes,
    performers: mapPerformers(row),
  }));

  return buildProgramDocument(
    {
      id: event.id,
      title: event.title,
      isPublished: event.isPublished,
      description: event.description,
      dateLabel: formatDate(event.startTime, 'EEEE, MMMM d, yyyy'),
      timeLabel: `${formatTime(event.startTime)} – ${formatTime(event.endTime)}`,
      venueLabel,
      dressCode: event.dressCode,
    },
    items,
  );
}

/**
 * Load the program for an event.
 *
 * @param publishedOnly - when true (the default, used by public routes) an
 *   unpublished or deleted event resolves to null.
 */
export async function getEventProgram(
  eventId: string,
  options: { publishedOnly?: boolean } = {}
): Promise<ProgramDocument | null> {
  const publishedOnly = options.publishedOnly ?? true;

  const event: ProgramRow | null = await prisma.event.findFirst({
    where: { id: eventId, deletedAt: null },
    include: programInclude,
  });

  if (!event) return null;
  // A cancelled concert still gets a printed program (the audience showed up),
  // but an unpublished one is invisible on public routes.
  if (publishedOnly && !event.isPublished) return null;

  return mapProgramRows(event);
}
