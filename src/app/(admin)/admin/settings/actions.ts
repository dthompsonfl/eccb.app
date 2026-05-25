'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { clearLLMConfigCache } from '@/lib/llm/config-loader';
import { requirePermission } from '@/lib/auth/guards';
import { auditLog } from '@/lib/services/audit';
import { SYSTEM_CONFIG } from '@/lib/auth/permission-constants';

const _settingSchema = z.object({
  key: z.string().min(1),
  value: z.string(),
});

export async function updateSetting(key: string, value: string) {
  const session = await requirePermission(SYSTEM_CONFIG);

  try {
    const existing = await prisma.systemSetting.findUnique({
      where: { key },
    });

    if (existing) {
      await prisma.systemSetting.update({
        where: { key },
        data: { value, updatedBy: session.user.id },
      });
    } else {
      await prisma.systemSetting.create({
        data: { key, value, updatedBy: session.user.id },
      });
    }

    await auditLog({
      action: 'UPDATE_SETTING',
      entityType: 'SETTING',
      entityId: key,
      newValues: { key, value: value.substring(0, 100) },
    });

    clearLLMConfigCache();
    revalidatePath('/admin/settings');
    return { success: true };
  } catch (error) {
    console.error('Error updating setting:', error);
    return { success: false, error: 'Failed to update setting' };
  }
}

export async function updateSettings(settings: Record<string, string>) {
  const session = await requirePermission(SYSTEM_CONFIG);

  try {
    // ⚡ Bolt: Batch settings updates in a single transaction to avoid N+1 queries
    const upsertQueries = Object.entries(settings).map(([key, value]) => {
      return prisma.systemSetting.upsert({
        where: { key },
        update: { value, updatedBy: session.user.id },
        create: { key, value, updatedBy: session.user.id },
      });
    });

    await prisma.$transaction(upsertQueries);

    await auditLog({
      action: 'UPDATE_SETTINGS',
      entityType: 'SETTING',
      entityId: 'bulk',
      newValues: { keys: Object.keys(settings) },
    });

    clearLLMConfigCache();
    revalidatePath('/admin/settings');
    return { success: true };
  } catch (error) {
    console.error('Error updating settings:', error);
    return { success: false, error: 'Failed to update settings' };
  }
}
