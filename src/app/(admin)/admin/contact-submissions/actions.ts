'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { ContactSubmissionStatus } from '@prisma/client';
import { prisma } from '@/lib/db';
import { requirePermission } from '@/lib/auth/guards';
import { CMS_EDIT, CMS_VIEW_ALL } from '@/lib/auth/permission-constants';
import { auditLog } from '@/lib/services/audit';

const updateSchema = z.object({
  id: z.string().min(1),
  status: z.nativeEnum(ContactSubmissionStatus),
  responseNotes: z.string().trim().optional(),
});

export async function updateContactSubmission(formData: FormData) {
  const session = await requirePermission(CMS_EDIT);
  const data = updateSchema.parse({
    id: formData.get('id'),
    status: formData.get('status'),
    responseNotes: formData.get('responseNotes') || undefined,
  });

  const previous = await prisma.contactSubmission.findUnique({ where: { id: data.id } });
  const submission = await prisma.contactSubmission.update({
    where: { id: data.id },
    data: {
      status: data.status,
      responseNotes: data.responseNotes || null,
      handledBy: session.user.id,
      handledAt: new Date(),
    },
  });

  await auditLog({
    action: 'contact-submission.update',
    entityType: 'ContactSubmission',
    entityId: submission.id,
    oldValues: previous,
    newValues: { status: submission.status, responseNotes: submission.responseNotes },
  });

  revalidatePath('/admin/contact-submissions');
}

export async function markContactSubmissionRead(formData: FormData) {
  await requirePermission(CMS_VIEW_ALL);
  const id = z.string().min(1).parse(formData.get('id'));
  const submission = await prisma.contactSubmission.update({
    where: { id },
    data: { status: ContactSubmissionStatus.READ },
  });

  await auditLog({
    action: 'contact-submission.read',
    entityType: 'ContactSubmission',
    entityId: submission.id,
    newValues: { status: submission.status },
  });

  revalidatePath('/admin/contact-submissions');
}
