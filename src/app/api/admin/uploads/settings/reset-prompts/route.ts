import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/guards';
import { checkUserPermission } from '@/lib/auth/permissions';
import { validateCSRF } from '@/lib/csrf';
import { logger } from '@/lib/logger';
import { auditLog } from '@/lib/services/audit';
import { resetPromptsToDefaults, loadSmartUploadSettingsFromDB } from '@/lib/smart-upload/bootstrap';

import { SYSTEM_CONFIG } from '@/lib/auth/permission-constants';
// =============================================================================
// POST /api/admin/uploads/settings/reset-prompts
// =============================================================================

export async function POST(request: NextRequest) {
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

    // Reset prompts to defaults
    const result = await resetPromptsToDefaults(session.user.id);

    if (!result.success) {
      return NextResponse.json(
        { error: 'Failed to reset prompts' },
        { status: 500 }
      );
    }

    // Audit log the action
    await auditLog({
      action: 'RESET_SMART_UPLOAD_PROMPTS',
      entityType: 'SETTING',
      entityId: 'smart_upload',
      newValues: { resetKeys: result.resetKeys },
    });

    logger.info('Smart upload prompts reset', {
      userId: session.user.id,
      resetKeys: result.resetKeys,
    });

    // Load the reset prompt values to return to the form
    const { settings } = await loadSmartUploadSettingsFromDB();
    const promptSettings: Record<string, string> = {};
    for (const key of result.resetKeys) {
      if (key in settings) {
        promptSettings[key] = settings[key];
      }
    }

    return NextResponse.json({
      success: true,
      message: 'Prompts reset to defaults successfully',
      prompts: promptSettings,
    });
  } catch (error) {
    logger.error('Failed to reset smart upload prompts', { error });
    return NextResponse.json(
      { error: 'Failed to reset prompts' },
      { status: 500 }
    );
  }
}

// =============================================================================
// OPTIONS
// =============================================================================

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}
