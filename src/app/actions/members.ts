'use server';

import { MEMBER_CREATE } from '@/lib/auth/permission-constants';

import { prisma } from '@/lib/db';
import { requirePermission } from '@/lib/auth/permissions';
import { auditLog } from '@/lib/services/audit';
import { z } from 'zod';

const memberSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().email(),
  phone: z.string().optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'LEAVE_OF_ABSENCE', 'ALUMNI', 'AUDITION', 'PENDING']),
  instruments: z.array(z.string()), // Instrument IDs
  sections: z.array(z.string()), // Section IDs
});

export async function createMember(data: any) {
  await requirePermission(MEMBER_CREATE);

  const validated = memberSchema.parse(data);

  // Create member
  const member = await prisma.member.create({
    data: {
      firstName: validated.firstName,
      lastName: validated.lastName,
      email: validated.email,
      phone: validated.phone,
      status: validated.status,
      instruments: {
        create: validated.instruments.map(id => ({ instrumentId: id })),
      },
      sections: {
        create: validated.sections.map(id => ({ sectionId: id })),
      },
    },
  });

  await auditLog({
    action: 'CREATE',
    entityType: 'Member',
    entityId: member.id,
    newValues: member,
  });

  return member;
}
