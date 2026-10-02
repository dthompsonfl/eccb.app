'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db';
import { requirePermission } from '@/lib/auth/guards';
import { auditLog } from '@/lib/services/audit';
import { EVENT_EDIT, MUSIC_ASSIGN } from '@/lib/auth/permission-constants';
import { sortProgramItems } from '@/lib/events/program';

export interface ReorderProgramResult {
  success: boolean;
  error?: string;
  /** The persisted running order of `EventMusic.id`s, for verification/UI. */
  order?: string[];
}

/**
 * Persist a new running order for a concert program.
 *
 * Security / integrity notes:
 *  - Requires `event.edit`; a non-admin caller is rejected by the guard before
 *    any write happens.
 *  - Every id is scoped to the event: an id belonging to another event (or a
 *    non-existent one) aborts the whole reorder rather than silently
 *    reordering somebody else's program.
 *  - Writes are one transaction with contiguous sortOrder values, so a reload
 *    and the print view read back exactly this order.
 */
export async function reorderEventProgram(
  eventId: string,
  orderedEventMusicIds: string[]
): Promise<ReorderProgramResult> {
  await requirePermission(EVENT_EDIT);

  if (!Array.isArray(orderedEventMusicIds) || orderedEventMusicIds.length === 0) {
    return { success: false, error: 'No pieces supplied' };
  }

  const unique = new Set(orderedEventMusicIds);
  if (unique.size !== orderedEventMusicIds.length) {
    return { success: false, error: 'Duplicate pieces in order' };
  }

  try {
    const existing = await prisma.eventMusic.findMany({
      where: { eventId, id: { in: [...unique] } },
      select: { id: true, sortOrder: true },
    });

    if (existing.length !== unique.size) {
      return { success: false, error: 'One or more pieces do not belong to this event' };
    }

    await prisma.$transaction(
      orderedEventMusicIds.map((id, index) =>
        prisma.eventMusic.update({
          where: { id },
          data: { sortOrder: index },
        })
      )
    );

    await auditLog({
      action: 'event.program.reorder',
      entityType: 'Event',
      entityId: eventId,
      newValues: { order: orderedEventMusicIds },
    });

    revalidatePath(`/admin/events/${eventId}`);
    revalidatePath(`/admin/events/${eventId}/program`);
    revalidatePath(`/admin/events/${eventId}/music`);
    revalidatePath(`/events/${eventId}`);
    revalidatePath(`/events/${eventId}/program`);

    return { success: true, order: orderedEventMusicIds };
  } catch (error) {
    console.error('Failed to reorder concert program:', error);
    return { success: false, error: 'Failed to reorder program' };
  }
}

/**
 * Save the program order as the compact, human-readable program listing that
 * the generated PDF/print header can show verbatim.
 *
 * `Event.programOrder` already exists in the schema; this fills it in from the
 * authoritative `EventMusic.sortOrder` values instead of letting an admin type
 * a free-text order that could drift from the real program.
 */
export async function regenerateEventProgramOrder(eventId: string): Promise<ReorderProgramResult> {
  await requirePermission(EVENT_EDIT);

  try {
    const rows = await prisma.eventMusic.findMany({
      where: { eventId },
      select: { id: true, sortOrder: true, piece: { select: { title: true } } },
    });

    const ordered = sortProgramItems(
      rows.map((row) => ({
        id: row.id,
        sortOrder: row.sortOrder,
        pieceId: '',
        title: row.piece.title,
        subtitle: null,
        composer: null,
        arranger: null,
        duration: null,
        notes: null,
        performers: [],
      }))
    );

    const text = ordered.map((row, index) => `${index + 1}. ${row.title}`).join('\n');

    await prisma.event.update({
      where: { id: eventId },
      data: { programOrder: text.length > 0 ? text : null },
    });

    await auditLog({
      action: 'event.program.regenerate',
      entityType: 'Event',
      entityId: eventId,
      newValues: { count: ordered.length },
    });

    revalidatePath(`/admin/events/${eventId}/program`);
    revalidatePath(`/events/${eventId}/program`);

    return { success: true, order: ordered.map((row) => row.id) };
  } catch (error) {
    console.error('Failed to regenerate program order:', error);
    return { success: false, error: 'Failed to regenerate program order' };
  }
}

/**
 * Attach an existing `MusicAssignment` (member + part) to a program item's
 * piece. Uses the existing assignment model — no program-specific join table.
 */
export async function assignProgramPerformer(input: {
  eventId: string;
  pieceId: string;
  memberId: string;
  partName?: string;
}): Promise<{ success: boolean; error?: string }> {
  const session = await requirePermission(MUSIC_ASSIGN);

  try {
    const inProgram = await prisma.eventMusic.findFirst({
      where: { eventId: input.eventId, pieceId: input.pieceId },
      select: { id: true },
    });

    if (!inProgram) {
      return { success: false, error: 'Piece is not in this concert program' };
    }

    const existing = await prisma.musicAssignment.findFirst({
      where: { pieceId: input.pieceId, memberId: input.memberId },
      select: { id: true },
    });

    if (existing) {
      if (!input.partName) {
        return { success: true };
      }
      await prisma.musicAssignment.update({
        where: { id: existing.id },
        data: { partName: input.partName },
      });
    } else {
      const created = await prisma.musicAssignment.create({
        data: {
          pieceId: input.pieceId,
          memberId: input.memberId,
          partName: input.partName,
          assignedBy: session.user.id,
        },
        select: { id: true },
      });
      await prisma.musicAssignmentHistory.create({
        data: {
          assignmentId: created.id,
          action: 'ASSIGNED',
          notes: `Assigned for concert program (event ${input.eventId})`,
          performedBy: session.user.id,
        },
      });
    }

    await auditLog({
      action: 'event.program.assign',
      entityType: 'Event',
      entityId: input.eventId,
      newValues: { pieceId: input.pieceId, memberId: input.memberId, partName: input.partName },
    });

    revalidatePath(`/admin/events/${input.eventId}/program`);
    revalidatePath(`/events/${input.eventId}/program`);

    return { success: true };
  } catch (error) {
    console.error('Failed to assign program performer:', error);
    return { success: false, error: 'Failed to assign performer' };
  }
}

/** Remove a performer from a program item by deleting the existing assignment. */
export async function unassignProgramPerformer(input: {
  eventId: string;
  pieceId: string;
  memberId: string;
}): Promise<{ success: boolean; error?: string }> {
  await requirePermission(MUSIC_ASSIGN);

  try {
    const inProgram = await prisma.eventMusic.findFirst({
      where: { eventId: input.eventId, pieceId: input.pieceId },
      select: { id: true },
    });

    if (!inProgram) {
      return { success: false, error: 'Piece is not in this concert program' };
    }

    const assignment = await prisma.musicAssignment.findFirst({
      where: { pieceId: input.pieceId, memberId: input.memberId },
      select: { id: true },
    });

    if (assignment) {
      await prisma.$transaction([
        prisma.musicAssignmentHistory.create({
          data: {
            assignmentId: assignment.id,
            action: 'UNASSIGNED',
            notes: `Removed from concert program (event ${input.eventId})`,
            performedBy: 'system',
          },
        }),
        prisma.musicAssignment.delete({ where: { id: assignment.id } }),
      ]);
    }

    await auditLog({
      action: 'event.program.unassign',
      entityType: 'Event',
      entityId: input.eventId,
      oldValues: { pieceId: input.pieceId, memberId: input.memberId },
    });

    revalidatePath(`/admin/events/${input.eventId}/program`);
    revalidatePath(`/events/${input.eventId}/program`);

    return { success: true };
  } catch (error) {
    console.error('Failed to unassign program performer:', error);
    return { success: false, error: 'Failed to remove performer' };
  }
}
