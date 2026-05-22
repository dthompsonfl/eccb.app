'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { LeadershipProfileType } from '@prisma/client';
import { prisma } from '@/lib/db';
import { requirePermission } from '@/lib/auth/guards';
import { CMS_EDIT, CMS_DELETE } from '@/lib/auth/permission-constants';
import { auditLog } from '@/lib/services/audit';

const leadershipSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(2, 'Name is required'),
  role: z.string().trim().min(2, 'Role is required'),
  profileType: z.nativeEnum(LeadershipProfileType).default(LeadershipProfileType.VOLUNTEER),
  bio: z.string().trim().optional(),
  photoUrl: z.string().trim().url('Photo URL must be valid').or(z.literal('')).optional(),
  email: z.string().trim().email('Email must be valid').or(z.literal('')).optional(),
  sortOrder: z.coerce.number().int().min(0).default(0),
  isPublished: z.coerce.boolean().default(false),
});

function parseLeadership(formData: FormData) {
  return leadershipSchema.parse({
    id: formData.get('id') || undefined,
    name: formData.get('name'),
    role: formData.get('role'),
    profileType: formData.get('profileType') || LeadershipProfileType.VOLUNTEER,
    bio: formData.get('bio') || undefined,
    photoUrl: formData.get('photoUrl') || undefined,
    email: formData.get('email') || undefined,
    sortOrder: formData.get('sortOrder') || 0,
    isPublished: formData.get('isPublished') === 'on' || formData.get('isPublished') === 'true',
  });
}

export async function createLeadershipProfile(formData: FormData) {
  const session = await requirePermission(CMS_EDIT);
  const data = parseLeadership(formData);

  const profile = await prisma.leadershipProfile.create({
    data: {
      name: data.name,
      role: data.role,
      profileType: data.profileType,
      bio: data.bio || null,
      photoUrl: data.photoUrl || null,
      email: data.email || null,
      sortOrder: data.sortOrder,
      isPublished: data.isPublished,
      updatedBy: session.user.id,
    },
  });

  await auditLog({
    action: 'leadership.create',
    entityType: 'LeadershipProfile',
    entityId: profile.id,
    newValues: { name: profile.name, role: profile.role, profileType: profile.profileType },
  });

  revalidatePath('/admin/leadership');
  revalidatePath('/directors');
}

export async function updateLeadershipProfile(formData: FormData) {
  const session = await requirePermission(CMS_EDIT);
  const data = parseLeadership(formData);
  if (!data.id) throw new Error('Leadership profile id is required');

  const previous = await prisma.leadershipProfile.findUnique({ where: { id: data.id } });
  const profile = await prisma.leadershipProfile.update({
    where: { id: data.id },
    data: {
      name: data.name,
      role: data.role,
      profileType: data.profileType,
      bio: data.bio || null,
      photoUrl: data.photoUrl || null,
      email: data.email || null,
      sortOrder: data.sortOrder,
      isPublished: data.isPublished,
      updatedBy: session.user.id,
    },
  });

  await auditLog({
    action: 'leadership.update',
    entityType: 'LeadershipProfile',
    entityId: profile.id,
    oldValues: previous,
    newValues: profile,
  });

  revalidatePath('/admin/leadership');
  revalidatePath('/directors');
}

export async function deleteLeadershipProfile(formData: FormData) {
  await requirePermission(CMS_DELETE);
  const id = z.string().min(1).parse(formData.get('id'));
  const previous = await prisma.leadershipProfile.findUnique({ where: { id } });

  await prisma.leadershipProfile.delete({ where: { id } });
  await auditLog({
    action: 'leadership.delete',
    entityType: 'LeadershipProfile',
    entityId: id,
    oldValues: previous,
  });

  revalidatePath('/admin/leadership');
  revalidatePath('/directors');
}
