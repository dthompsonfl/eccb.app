/**
 * Setup Repair API Route
 *
 * Repair broken database connections and fix setup issues:
 * - Reset and reapply migrations
 * - Re-seed database
 * - Fix connection issues
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { repairDatabase, runMigrations, seedDatabase } from '@/lib/setup/schema-automation';
import {
  validateSetupRequest,
  validateDestructiveConfirmation,
} from '@/lib/setup/setup-guard';
import { applyRateLimit } from '@/lib/rate-limit';
import { validateCSRF } from '@/lib/csrf';
import { SetupPhase, type MigrationStatus } from '@/lib/setup/types';
import { logger } from '@/lib/logger';

// =============================================================================
// Types
// =============================================================================

interface RepairResponse {
  success: boolean;
  phase: SetupPhase;
  progress: number;
  message?: string;
  error?: string;
  details?: {
    migrations?: MigrationStatus;
    seed?: {
      success: boolean;
      tablesSeeded?: number;
    };
  };
}

// =============================================================================
// Validation Schemas
// =============================================================================

const repairSchema = z.object({
  action: z.enum(['reset', 'migrate', 'seed', 'full']),
  force: z.boolean().optional().default(false),
  confirm: z.string().optional(),
});

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Run full repair process
 */
async function runFullRepair(force: boolean): Promise<RepairResponse> {
  try {
    logger.info('Starting full repair process');

    // Step 1: Reset and migrate
    const repairResult = repairDatabase({ skipSeed: true, force });

    if (!repairResult.success) {
      return {
        success: false,
        phase: SetupPhase.MIGRATING,
        progress: 50,
        error: repairResult.error || 'Repair failed during migration',
      };
    }

    // Step 2: Seed
    const seedResult = seedDatabase();

    if (!seedResult.success) {
      return {
        success: false,
        phase: SetupPhase.SEEDING,
        progress: 80,
        error: seedResult.error || 'Repair failed during seeding',
      };
    }

    return {
      success: true,
      phase: SetupPhase.COMPLETE,
      progress: 100,
      message: 'Repair completed successfully',
      details: {
        seed: {
          success: seedResult.success,
          tablesSeeded: seedResult.tablesSeeded,
        },
      },
    };
  } catch (error) {
    logger.error('Full repair failed', error instanceof Error ? error : new Error(String(error)));
    return {
      success: false,
      phase: SetupPhase.CHECKING,
      progress: 0,
      error: error instanceof Error ? error.message : 'Unknown error during repair',
    };
  }
}

// =============================================================================
// API Handlers
// =============================================================================

/**
 * POST /api/setup/repair
 * Run repair operations
 */
export async function POST(request: NextRequest): Promise<NextResponse<RepairResponse>> {
  // ── Rate limiting ──────────────────────────────────────────────────────
  // Repair is rare and destructive; a tight budget prevents both brute force
  // against the setup token and accidental hammering of the database.
  const rateLimitResponse = await applyRateLimit(request, 'adminAction');
  if (rateLimitResponse) {
    return rateLimitResponse as NextResponse<RepairResponse>;
  }

  // ── CSRF ───────────────────────────────────────────────────────────────
  // Repair can be driven purely by a setup token (no session cookie), in which
  // case the token itself is the authorization proof and there is no ambient
  // credential for a cross-site request to borrow.
  const hasSessionCookie =
    request.cookies.has('better-auth.session_token') ||
    request.cookies.has('__Secure-better-auth.session_token');

  if (hasSessionCookie) {
    const csrf = validateCSRF(request);
    if (!csrf.valid) {
      logger.warn('CSRF validation failed for setup repair', { reason: csrf.reason });
      return NextResponse.json(
        { success: false, phase: SetupPhase.CHECKING, progress: 0, error: 'CSRF validation failed' },
        { status: 403 },
      );
    }
  }

  // ── Authorization ──────────────────────────────────────────────────────
  // Note: a healthy application does NOT bypass this. See setup-guard.ts.
  const guardResult = await validateSetupRequest(request);
  if (guardResult) {
    return guardResult as NextResponse<RepairResponse>;
  }

  try {
    // Validate request body
    const body = await request.json();
    const validation = repairSchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json(
        {
          success: false,
          phase: SetupPhase.CHECKING,
          progress: 0,
          error: validation.error.issues.map((e) => e.message).join(', '),
        },
        { status: 400 },
      );
    }

    const { action, force = false, confirm } = validation.data;

    // ── Explicit confirmation for irreversible operations ────────────────
    // 'reset' drops and recreates the schema; 'full' does the same via repair.
    // Requiring the caller to echo the action name prevents a stray or
    // replayed request from destroying data.
    if (action === 'reset' || action === 'full') {
      const confirmationError = validateDestructiveConfirmation(action, confirm);
      if (confirmationError) {
        logger.warn('Destructive setup repair blocked: missing confirmation', { action });
        return confirmationError as NextResponse<RepairResponse>;
      }
    }

    logger.info(`Repair action: ${action}`, { force, confirmed: action === 'reset' || action === 'full' });

    // Handle different repair actions
    switch (action) {
      case 'reset': {
        logger.info('Resetting database');
        const resetResult = repairDatabase({ force });

        return NextResponse.json({
          success: resetResult.success,
          phase: resetResult.success ? SetupPhase.COMPLETE : SetupPhase.MIGRATING,
          progress: resetResult.success ? 100 : 50,
          error: resetResult.error,
        });
      }

      case 'migrate': {
        logger.info('Running migrations');
        const migrationResult = runMigrations({ skipSeed: true });

        return NextResponse.json({
          success: migrationResult.success,
          phase: migrationResult.success ? SetupPhase.COMPLETE : SetupPhase.MIGRATING,
          progress: migrationResult.success ? 100 : 50,
          error: migrationResult.error,
        });
      }

      case 'seed': {
        logger.info('Seeding database');
        const seedResult = seedDatabase();

        return NextResponse.json({
          success: seedResult.success,
          phase: seedResult.success ? SetupPhase.COMPLETE : SetupPhase.SEEDING,
          progress: seedResult.success ? 100 : 80,
          error: seedResult.error,
          details: {
            seed: {
              success: seedResult.success,
              tablesSeeded: seedResult.tablesSeeded,
            },
          },
        });
      }

      case 'full': {
        return NextResponse.json(await runFullRepair(force));
      }

      default:
        return NextResponse.json(
          {
            success: false,
            phase: SetupPhase.CHECKING,
            progress: 0,
            error: `Unknown repair action: ${action}`,
          },
          { status: 400 },
        );
    }
  } catch (error) {
    logger.error('Repair request failed', error instanceof Error ? error : new Error(String(error)));

    return NextResponse.json(
      {
        success: false,
        phase: SetupPhase.CHECKING,
        progress: 0,
        error: error instanceof Error ? error.message : 'Repair request failed',
      },
      { status: 500 },
    );
  }
}
