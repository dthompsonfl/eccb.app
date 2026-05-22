'use server';

import { EVENT_CREATE } from '@/lib/auth/permission-constants';

import { prisma } from '@/lib/db';
import { requirePermission } from '@/lib/auth/permissions';
import { auditLog } from '@/lib/services/audit';
import { z } from 'zod';

const eventSchema = z.object({
  title: z.string().min(1),
  type: z.enum(['CONCERT', 'REHEARSAL', 'SECTIONAL', 'BOARD_MEETING', 'SOCIAL', 'OTHER']),
  startTime: z.coerce.date(),
  endTime: z.coerce.date(),
  location: z.string().optional(),
});

export async function createEvent(data: any) {
  await requirePermission(EVENT_CREATE);

  const validated = eventSchema.parse(data);

  const event = await prisma.event.create({
    data: {
      title: validated.title,
      type: validated.type,
      startTime: validated.startTime,
      endTime: validated.endTime,
      location: validated.location,
    }
  });

  await auditLog({
    action: 'CREATE',
    entityType: 'Event',
    entityId: event.id,
    newValues: event,
  });

  return event;
}
