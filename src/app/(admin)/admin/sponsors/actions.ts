'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requirePermission } from '@/lib/auth/guards';
import { CMS_EDIT, CMS_DELETE } from '@/lib/auth/permission-constants';
import { auditLog } from '@/lib/services/audit';
import { SponsorLevel } from '@prisma/client';

const sponsorSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(2, 'Sponsor name is required'),
  level: z.nativeEnum(SponsorLevel).default(SponsorLevel.BRONZE),
  description: z.string().trim().optional(),
  websiteUrl: z.string().trim().url('Website must be a valid URL').or(z.literal('')).optional(),
  logoUrl: z.string().trim().url('Logo URL must be a valid URL').or(z.literal('')).optional(),
  sortOrder: z.coerce.number().int().min(0).default(0),
  isActive: z.coerce.boolean().default(false),
});

function parseSponsor(formData: FormData) {
  return sponsorSchema.parse({
    id: formData.get('id') || undefined,
    name: formData.get('name'),
    level: formData.get('level') || SponsorLevel.BRONZE,
    description: formData.get('description') || undefined,
    websiteUrl: formData.get('websiteUrl') || undefined,
    logoUrl: formData.get('logoUrl') || undefined,
    sortOrder: formData.get('sortOrder') || 0,
    isActive: formData.get('isActive') === 'on' || formData.get('isActive') === 'true',
  });
}

export async function createSponsor(formData: FormData) {
  const session = await requirePermission(CMS_EDIT);
  const data = parseSponsor(formData);

  const sponsor = await prisma.sponsor.create({
    data: {
      name: data.name,
      level: data.level,
      description: data.description || null,
      websiteUrl: data.websiteUrl || null,
      logoUrl: data.logoUrl || null,
      sortOrder: data.sortOrder,
      isActive: data.isActive,
      updatedBy: session.user.id,
    },
  });

  await auditLog({
    action: 'sponsor.create',
    entityType: 'Sponsor',
    entityId: sponsor.id,
    newValues: { name: sponsor.name, level: sponsor.level, isActive: sponsor.isActive },
  });

  revalidatePath('/admin/sponsors');
  revalidatePath('/sponsors');
}

export async function updateSponsor(formData: FormData) {
  const session = await requirePermission(CMS_EDIT);
  const data = parseSponsor(formData);
  if (!data.id) throw new Error('Sponsor id is required');

  const previous = await prisma.sponsor.findUnique({ where: { id: data.id } });
  const sponsor = await prisma.sponsor.update({
    where: { id: data.id },
    data: {
      name: data.name,
      level: data.level,
      description: data.description || null,
      websiteUrl: data.websiteUrl || null,
      logoUrl: data.logoUrl || null,
      sortOrder: data.sortOrder,
      isActive: data.isActive,
      updatedBy: session.user.id,
    },
  });

  await auditLog({
    action: 'sponsor.update',
    entityType: 'Sponsor',
    entityId: sponsor.id,
    oldValues: previous,
    newValues: sponsor,
  });

  revalidatePath('/admin/sponsors');
  revalidatePath('/sponsors');
}

export async function deleteSponsor(formData: FormData) {
  await requirePermission(CMS_DELETE);
  const id = z.string().min(1).parse(formData.get('id'));
  const previous = await prisma.sponsor.findUnique({ where: { id } });

  await prisma.sponsor.delete({ where: { id } });
  await auditLog({
    action: 'sponsor.delete',
    entityType: 'Sponsor',
    entityId: id,
    oldValues: previous,
  });

  revalidatePath('/admin/sponsors');
  revalidatePath('/sponsors');
}
