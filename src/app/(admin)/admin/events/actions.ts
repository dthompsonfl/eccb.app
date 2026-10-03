'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db';
import { requirePermission } from '@/lib/auth/guards';
import { auditLog } from '@/lib/services/audit';
import { z } from 'zod';
import { EventType, AttendanceStatus } from '@prisma/client';
import { replaceEventAttendance } from '@/lib/attendance/bulk-write';
import {
  EVENT_CREATE,
  EVENT_EDIT,
  EVENT_DELETE,
  ATTENDANCE_MARK_ALL,
} from '@/lib/auth/permission-constants';

const eventSchema = z.object({
  title: z.string().min(1, 'Title is required'),
  description: z.string().optional(),
  eventType: z.enum(['REHEARSAL', 'CONCERT', 'MEETING', 'SOCIAL', 'OTHER']),
  status: z.enum(['SCHEDULED', 'CANCELLED', 'COMPLETED', 'POSTPONED']),
  startDate: z.string().min(1, 'Start date is required'),
  endDate: z.string().optional(),
  venueId: z.string().optional(),
  isPublished: z.boolean().optional(),
  requiresRSVP: z.boolean().optional(),
  maxAttendees: z.number().optional(),
  notes: z.string().optional(),
  dressCode: z.string().optional(),
  callTime: z.string().optional(),
});

export async function createEvent(formData: FormData) {
  const _session = await requirePermission(EVENT_CREATE);

  try {
    const data = {
      title: formData.get('title') as string,
      description: formData.get('description') as string || undefined,
      eventType: formData.get('eventType') as string,
      status: formData.get('status') as string || 'SCHEDULED',
      startDate: formData.get('startDate') as string,
      endDate: formData.get('endDate') as string || undefined,
      venueId: formData.get('venueId') as string || undefined,
      isPublished: formData.get('isPublished') === 'true',
      requiresRSVP: formData.get('requiresRSVP') === 'true',
      maxAttendees: formData.get('maxAttendees') ? parseInt(formData.get('maxAttendees') as string) : undefined,
      notes: formData.get('notes') as string || undefined,
      dressCode: formData.get('dressCode') as string || undefined,
      callTime: formData.get('callTime') as string || undefined,
    };

    const validated = eventSchema.parse(data);

    const event = await prisma.event.create({
      data: {
        title: validated.title,
        description: validated.description,
        type: validated.eventType as EventType,
        startTime: new Date(validated.startDate),
        endTime: validated.endDate ? new Date(validated.endDate) : new Date(validated.startDate),
        venueId: validated.venueId || undefined,
        isPublished: validated.isPublished ?? true,
        dressCode: validated.dressCode,
        callTime: validated.callTime ? new Date(validated.callTime) : undefined,
      },
    });

    await auditLog({
      action: 'event.create',
      entityType: 'Event',
      entityId: event.id,
      newValues: { title: event.title },
    });

    revalidatePath('/admin/events');
    revalidatePath('/events');
    revalidatePath('/member');

    return { success: true, eventId: event.id };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, error: error.issues[0].message };
    }
    console.error('Failed to create event:', error);
    return { success: false, error: 'Failed to create event' };
  }
}

export async function updateEvent(id: string, formData: FormData) {
  const _session = await requirePermission(EVENT_EDIT);

  try {
    const data = {
      title: formData.get('title') as string,
      description: formData.get('description') as string || undefined,
      eventType: formData.get('eventType') as string,
      status: formData.get('status') as string,
      startDate: formData.get('startDate') as string,
      endDate: formData.get('endDate') as string || undefined,
      venueId: formData.get('venueId') as string || undefined,
      isPublished: formData.get('isPublished') === 'true',
      requiresRSVP: formData.get('requiresRSVP') === 'true',
      maxAttendees: formData.get('maxAttendees') ? parseInt(formData.get('maxAttendees') as string) : undefined,
      notes: formData.get('notes') as string || undefined,
      dressCode: formData.get('dressCode') as string || undefined,
      callTime: formData.get('callTime') as string || undefined,
    };

    const validated = eventSchema.parse(data);

    const event = await prisma.event.update({
      where: { id },
      data: {
        title: validated.title,
        description: validated.description,
        type: validated.eventType as EventType,
        startTime: new Date(validated.startDate),
        endTime: validated.endDate ? new Date(validated.endDate) : new Date(validated.startDate),
        venueId: validated.venueId || null,
        isPublished: validated.isPublished ?? true,
        dressCode: validated.dressCode,
        callTime: validated.callTime ? new Date(validated.callTime) : null,
      },
    });

    await auditLog({
      action: 'event.update',
      entityType: 'Event',
      entityId: event.id,
      newValues: { title: event.title },
    });

    revalidatePath('/admin/events');
    revalidatePath(`/admin/events/${id}`);
    revalidatePath('/events');
    revalidatePath(`/events/${id}`);
    revalidatePath('/member');

    return { success: true };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, error: error.issues[0].message };
    }
    console.error('Failed to update event:', error);
    return { success: false, error: 'Failed to update event' };
  }
}

export async function deleteEvent(id: string) {
  const _session = await requirePermission(EVENT_DELETE);

  try {
    const event = await prisma.event.delete({
      where: { id },
    });

    await auditLog({
      action: 'event.delete',
      entityType: 'Event',
      entityId: id,
      newValues: { title: event.title },
    });

    revalidatePath('/admin/events');
    revalidatePath('/events');

    return { success: true };
  } catch (error) {
    console.error('Failed to delete event:', error);
    return { success: false, error: 'Failed to delete event' };
  }
}

export async function recordAttendance(
  eventId: string,
  records: Array<{ memberId: string; status: string; notes?: string }>
) {
  const session = await requirePermission(ATTENDANCE_MARK_ALL);

  try {
    // Atomic replace, shared with the admin attendance action and the
    // /api/attendance/bulk route. This third copy of the same write was an
    // un-transacted deleteMany()+createMany(): a failure between the two wiped
    // every attendance row for the event. See lib/attendance/bulk-write.
    const { count } = await prisma.$transaction(async (tx) =>
      replaceEventAttendance(
        tx,
        eventId,
        records.map((record) => ({
          memberId: record.memberId,
          status: record.status as AttendanceStatus,
          notes: record.notes,
        })),
        session.user.id,
      ),
    );

    await auditLog({
      action: 'attendance.record',
      entityType: 'Event',
      entityId: eventId,
      newValues: { recordCount: count },
    });

    revalidatePath(`/admin/events/${eventId}/attendance`);

    return { success: true };
  } catch (error) {
    console.error('Failed to record attendance:', error);
    return { success: false, error: 'Failed to record attendance' };
  }
}

export async function addMusicToEvent(eventId: string, pieceId: string, sortOrder?: number) {
  const _session = await requirePermission(EVENT_EDIT);

  try {
    const eventPiece = await prisma.eventMusic.create({
      data: {
        eventId,
        pieceId,
        sortOrder: sortOrder ?? 0,
      },
      include: {
        piece: true,
      },
    });

    await auditLog({
      action: 'event.music.add',
      entityType: 'Event',
      entityId: eventId,
      newValues: { piece: eventPiece.piece.title },
    });

    revalidatePath(`/admin/events/${eventId}`);

    return { success: true };
  } catch (error) {
    console.error('Failed to add music to event:', error);
    return { success: false, error: 'Failed to add music' };
  }
}

export async function removeMusicFromEvent(eventId: string, eventPieceId: string) {
  const _session = await requirePermission(EVENT_EDIT);

  try {
    const eventPiece = await prisma.eventMusic.delete({
      where: { id: eventPieceId },
      include: {
        piece: true,
      },
    });

    await auditLog({
      action: 'event.music.remove',
      entityType: 'Event',
      entityId: eventId,
      newValues: { piece: eventPiece.piece.title },
    });

    revalidatePath(`/admin/events/${eventId}`);
    revalidatePath(`/admin/events/${eventId}/music`);

    return { success: true };
  } catch (error) {
    console.error('Failed to remove music from event:', error);
    return { success: false, error: 'Failed to remove music' };
  }
}

export async function reorderEventMusic(eventId: string, orderedIds: string[]) {
  const _session = await requirePermission(EVENT_EDIT);

  try {
    // Update sortOrder for each entry in the given order within a single transaction
    // to prevent N+1 queries and avoid exhausting connection pool
    await prisma.$transaction(
      orderedIds.map((id, index) =>
        prisma.eventMusic.update({
          where: { id },
          data: { sortOrder: index },
        })
      )
    );

    await auditLog({
      action: 'event.music.reorder',
      entityType: 'Event',
      entityId: eventId,
      newValues: { count: orderedIds.length },
    });

    revalidatePath(`/admin/events/${eventId}`);
    revalidatePath(`/admin/events/${eventId}/music`);

    return { success: true };
  } catch (error) {
    console.error('Failed to reorder music:', error);
    return { success: false, error: 'Failed to reorder music' };
  }
}

export async function updateEventStatus(id: string, status: string) {
  const _session = await requirePermission(EVENT_EDIT);

  try {
    const event = await prisma.event.update({
      where: { id },
      data: { isCancelled: status === 'CANCELLED' },
    });

    await auditLog({
      action: 'event.status_change',
      entityType: 'Event',
      entityId: id,
      newValues: { title: event.title, status },
    });

    revalidatePath('/admin/events');
    revalidatePath(`/admin/events/${id}`);
    revalidatePath('/events');

    return { success: true };
  } catch (error) {
    console.error('Failed to update event status:', error);
    return { success: false, error: 'Failed to update status' };
  }
}
