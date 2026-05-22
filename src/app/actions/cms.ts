'use server';

import { CMS_EDIT, CMS_PUBLISH } from '@/lib/auth/permission-constants';

import { prisma } from '@/lib/db';
import { requirePermission } from '@/lib/auth/permissions';
import { auditLog } from '@/lib/services/audit';
import { z } from 'zod';

const pageSchema = z.object({
  title: z.string().min(1),
  slug: z.string().min(1),
  content: z.string(),
  status: z.enum(['DRAFT', 'PUBLISHED', 'SCHEDULED', 'ARCHIVED']),
});

export async function createPage(data: any) {
  await requirePermission(CMS_EDIT);

  const validated = pageSchema.parse(data);

  const page = await prisma.page.create({
    data: {
      title: validated.title,
      slug: validated.slug,
      content: validated.content,
      status: validated.status,
    }
  });

  await auditLog({
    action: 'CREATE',
    entityType: 'Page',
    entityId: page.id,
    newValues: page,
  });

  return page;
}

export async function publishPage(id: string) {
  await requirePermission(CMS_PUBLISH);

  const page = await prisma.page.update({
    where: { id },
    data: { status: 'PUBLISHED', publishedAt: new Date() },
  });

  await auditLog({
    action: 'PUBLISH',
    entityType: 'Page',
    entityId: id,
    newValues: page,
  });

  return page;
}
