import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/auth/guards';
import { checkUserPermission } from '@/lib/auth/permissions';
import { validateCSRF } from '@/lib/csrf';
import { logger } from '@/lib/logger';
import { clearLLMConfigCache } from '@/lib/llm/config-loader';
import { auditLog } from '@/lib/services/audit';
import { SYSTEM_CONFIG } from '@/lib/auth/permission-constants';
import { z } from 'zod';
import {
  validateSmartUploadSettings,
  mergeSettingsPreservingSecrets,
  SMART_UPLOAD_SETTING_KEYS,
  maskSecrets,
} from '@/lib/smart-upload/schema';
import { loadSmartUploadSettingsFromDB } from '@/lib/smart-upload/bootstrap';
import { getDefaultPromptsRecord } from '@/lib/smart-upload/prompts';

// =============================================================================
// Schema Validation
// =============================================================================

const settingUpdateSchema = z.object({
  key: z.string(),
  value: z.string(),
});

const settingsUpdateSchema = z.object({
  settings: z.array(settingUpdateSchema),
});

// Keys that must contain valid JSON
const JSON_KEYS: string[] = [
  'smart_upload_allowed_mime_types',
  'vision_model_params',
  'verification_model_params',
  'llm_header_label_model_params',
  'llm_adjudicator_model_params',
];

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Validate JSON fields in settings
 */
function validateJsonFields(settings: Array<{ key: string; value: string }>): { valid: boolean; error?: string } {
  for (const { key, value } of settings) {
    if (JSON_KEYS.includes(key) && value) {
      try {
        JSON.parse(value);
      } catch {
        return { valid: false, error: `Invalid JSON for setting: ${key}` };
      }
    }
  }
  return { valid: true };
}

/**
 * Convert settings array to record format
 */
function settingsArrayToRecord(settings: Array<{ key: string; value: string }>): Record<string, string> {
  const record: Record<string, string> = {};
  for (const { key, value } of settings) {
    record[key] = value;
  }
  return record;
}



// =============================================================================
// GET /api/admin/uploads/settings
// =============================================================================

interface SystemSetting {
  key: string;
  value: string;
  id: string;
  description: string | null;
  updatedAt: Date;
  updatedBy: string | null;
}

export async function GET() {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const hasPermission = await checkUserPermission(session.user.id, SYSTEM_CONFIG);
    if (!hasPermission) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Load settings from DB as array (matching page.tsx expectation)
    const rows = await prisma.systemSetting.findMany({
      where: { key: { in: [...SMART_UPLOAD_SETTING_KEYS] } },
    });

    const maskedValues = maskSecrets(
      Object.fromEntries(rows.map((row) => [row.key, row.value ?? '']))
    );

    // Convert to array format expected by frontend
    const settingsMap: Record<string, SystemSetting> = {};
    for (const row of rows) {
      settingsMap[row.key] = {
        id: row.id,
        key: row.key,
        value: maskedValues[row.key] ?? '',
        description: row.description,
        updatedAt: row.updatedAt,
        updatedBy: row.updatedBy,
      };
    }

    // Inject prompt defaults when DB values are missing (pre-bootstrap state)
    const now = new Date();

    // use source-of-truth defaults from prompts module
    const defaultPrompts = getDefaultPromptsRecord();
    for (const [key, val] of Object.entries(defaultPrompts)) {
      if (!settingsMap[key] || !settingsMap[key].value) {
        settingsMap[key] = {
          id: 'default',
          key,
          value: val,
          description: null,
          updatedAt: now,
          updatedBy: null,
        };
      }
    }

    const settingsArray: SystemSetting[] = Object.values(settingsMap);

    return NextResponse.json({ settings: settingsArray });
  } catch (error) {
    logger.error('Failed to fetch smart upload settings', { error });
    return NextResponse.json({ error: 'Failed to fetch settings' }, { status: 500 });
  }
}

// =============================================================================
// PUT /api/admin/uploads/settings
// =============================================================================

export async function PUT(request: NextRequest) {
  // CSRF validation
  const csrfResult = validateCSRF(request);
  if (!csrfResult.valid) {
    return NextResponse.json(
      { error: 'CSRF validation failed', reason: csrfResult.reason },
      { status: 403 }
    );
  }

  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const hasPermission = await checkUserPermission(session.user.id, SYSTEM_CONFIG);
    if (!hasPermission) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await request.json();
    const parsed = settingsUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: parsed.error },
        { status: 400 }
      );
    }

    const { settings } = parsed.data;

    // Validate JSON fields
    const jsonValidation = validateJsonFields(settings);
    if (!jsonValidation.valid) {
      return NextResponse.json({ error: jsonValidation.error }, { status: 400 });
    }

    // Load existing settings for merging
    const { settings: existingSettings } = await loadSmartUploadSettingsFromDB();

    // Convert incoming settings to record
    const incomingRecord = settingsArrayToRecord(settings);

    // Merge settings while preserving secrets
    const mergedRecord = mergeSettingsPreservingSecrets(existingSettings, incomingRecord);

    // Validate the merged settings using the strict schema (partial for updates)
    const validationResult = validateSmartUploadSettings(mergedRecord);
    if (!validationResult.valid) {
      return NextResponse.json(
        {
          error: 'Validation failed',
          details: validationResult.errors,
        },
        { status: 400 }
      );
    }

    // Filter to only allowed keys
    const allowedKeys = new Set<string>([...SMART_UPLOAD_SETTING_KEYS]);
    const updates: Array<{ key: string; value: string }> = [];
    const skippedKeys: string[] = [];

    for (const [key, value] of Object.entries(mergedRecord)) {
      // Skip if key is not allowed
      if (!allowedKeys.has(key)) {
        skippedKeys.push(key);
        continue;
      }

      // Skip if no change from existing
      if (existingSettings[key] === value) {
        continue;
      }

      updates.push({ key, value });
    }

    if (updates.length === 0) {
      return NextResponse.json({
        success: true,
        message: 'No changes to update',
        skipped: skippedKeys,
      });
    }

    // Upsert all settings in a transaction
    await prisma.$transaction(
      updates.map(({ key, value }) =>
        prisma.systemSetting.upsert({
          where: { key },
          create: { key, value, updatedBy: session.user.id },
          update: { value, updatedBy: session.user.id },
        })
      )
    );

    await auditLog({
      action: 'UPDATE_SMART_UPLOAD_SETTINGS',
      entityType: 'SETTING',
      entityId: 'smart_upload',
      newValues: { keys: updates.map(({ key }) => key) },
    });

    clearLLMConfigCache();
    logger.info('Smart upload settings updated', {
      userId: session.user.id,
      keys: updates.map(({ key }) => key),
      skipped: skippedKeys,
    });

    return NextResponse.json({
      success: true,
      updated: updates.map(({ key }) => key),
      skipped: skippedKeys.length > 0 ? skippedKeys : undefined,
    });
  } catch (error) {
    logger.error('Failed to update smart upload settings', { error });
    return NextResponse.json({ error: 'Failed to update settings' }, { status: 500 });
  }
}

// Note: POST sub-routes (reset-prompts, test) are handled by their own dedicated
// route files:
//   - POST /api/admin/uploads/settings/reset-prompts  →  ./reset-prompts/route.ts
//   - POST /api/admin/uploads/settings/test           →  ./test/route.ts
// The base POST /api/admin/uploads/settings is not used.

// =============================================================================
// OPTIONS
// =============================================================================

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}
