import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/guards';
import { checkUserPermission } from '@/lib/auth/permissions';
import { validateCSRF } from '@/lib/csrf';
import { logger } from '@/lib/logger';
import { auditLog } from '@/lib/services/audit';
import { z } from 'zod';
import {
  listApiKeys,
  listApiKeysGrouped,
  createApiKey,
  updateApiKey,
  deleteApiKey,
  ensureProvidersExist,
  migrateSystemSettingKeysToApiKeyTable,
} from '@/lib/llm/api-key-service';
import { LLM_PROVIDER_VALUES } from '@/lib/llm/providers';

import { SYSTEM_CONFIG } from '@/lib/auth/permission-constants';
// =============================================================================
// Schemas
// =============================================================================

const createKeySchema = z.object({
  providerSlug: z.enum(LLM_PROVIDER_VALUES as unknown as [string, ...string[]]),
  label: z.string().min(1).max(200),
  plaintextKey: z.string().min(1),
  isPrimary: z.boolean().optional(),
});

const updateKeySchema = z.object({
  id: z.string().uuid(),
  label: z.string().min(1).max(200).optional(),
  plaintextKey: z.string().min(1).optional(),
  isPrimary: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

const deleteKeySchema = z.object({
  id: z.string().uuid(),
});

// =============================================================================
// GET /api/admin/uploads/api-keys — List all API keys (masked)
// =============================================================================

export async function GET(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const hasPermission = await checkUserPermission(session.user.id, SYSTEM_CONFIG);
    if (!hasPermission) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Ensure providers exist before listing
    await ensureProvidersExist();

    const grouped = req.nextUrl.searchParams.get('grouped') === 'true';
    if (grouped) {
      const keys = await listApiKeysGrouped();
      return NextResponse.json({ keys });
    }

    const providerSlug = req.nextUrl.searchParams.get('provider') || undefined;
    const keys = await listApiKeys(
      providerSlug as Parameters<typeof listApiKeys>[0]
    );
    return NextResponse.json({ keys });
  } catch (err) {
    logger.error('Failed to list API keys', { error: String(err) });
    return NextResponse.json(
      { error: 'Failed to list API keys' },
      { status: 500 }
    );
  }
}

// =============================================================================
// POST /api/admin/uploads/api-keys — Create, Update, Delete, or Migrate
// =============================================================================

export async function POST(req: NextRequest) {
  try {
    // CSRF validation FIRST (defense in depth)
    const csrf = validateCSRF(req);
    if (!csrf.valid) {
      return NextResponse.json({ error: 'CSRF validation failed' }, { status: 403 });
    }

    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const hasPermission = await checkUserPermission(session.user.id, SYSTEM_CONFIG);
    if (!hasPermission) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await req.json();
    const action = body.action as string;

    switch (action) {
      case 'create': {
        const parsed = createKeySchema.safeParse(body);
        if (!parsed.success) {
          return NextResponse.json(
            { error: 'Validation failed', details: parsed.error.flatten() },
            { status: 400 }
          );
        }

        const key = await createApiKey({
          ...parsed.data,
          providerSlug: parsed.data.providerSlug as Parameters<typeof createApiKey>[0]['providerSlug'],
          createdBy: session.user.id,
        });

        await auditLog({
          action: 'SETTING_UPDATED',
          entityType: 'APIKey',
          entityId: key.id,
          newValues: { label: parsed.data.label, provider: parsed.data.providerSlug },
        });

        return NextResponse.json({ key });
      }

      case 'update': {
        const parsed = updateKeySchema.safeParse(body);
        if (!parsed.success) {
          return NextResponse.json(
            { error: 'Validation failed', details: parsed.error.flatten() },
            { status: 400 }
          );
        }

        const { id, ...updates } = parsed.data;
        const key = await updateApiKey(id, updates);

        await auditLog({
          action: 'SETTING_UPDATED',
          entityType: 'APIKey',
          entityId: id,
          newValues: { label: key.label, provider: key.providerSlug },
        });

        return NextResponse.json({ key });
      }

      case 'delete': {
        const parsed = deleteKeySchema.safeParse(body);
        if (!parsed.success) {
          return NextResponse.json(
            { error: 'Validation failed', details: parsed.error.flatten() },
            { status: 400 }
          );
        }

        await deleteApiKey(parsed.data.id);

        await auditLog({
          action: 'SETTING_UPDATED',
          entityType: 'APIKey',
          entityId: parsed.data.id,
        });

        return NextResponse.json({ success: true });
      }

      case 'migrate': {
        await migrateSystemSettingKeysToApiKeyTable();

        await auditLog({
          action: 'SETTING_UPDATED',
          entityType: 'APIKey',
          entityId: 'migration',
          newValues: { action: 'bulk_migration' },
        });

        return NextResponse.json({ success: true, message: 'Migration complete' });
      }

      default:
        return NextResponse.json(
          { error: `Unknown action: ${action}. Valid: create, update, delete, migrate` },
          { status: 400 }
        );
    }
  } catch (err) {
    logger.error('API key operation failed', { error: String(err) });
    return NextResponse.json(
      { error: 'API key operation failed', message: String(err) },
      { status: 500 }
    );
  }
}
