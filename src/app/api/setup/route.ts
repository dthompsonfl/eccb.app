/**
 * Setup API Route
 *
 * Main endpoint for orchestrating database setup, including:
 * - Environment validation
 * - Database initialization
 * - Schema migration
 * - Status reporting
 */

import { NextRequest, NextResponse } from 'next/server';
import { csrfValidationResponse } from '@/lib/csrf';
import { z } from 'zod';

import { checkMigrationStatus, runMigrations, seedDatabase } from '@/lib/setup/schema-automation';
import {
  SetupPhase,
  type ConnectionTestResult,
  type MigrationStatus,
  type SetupProgressStatus,
} from '@/lib/setup/types';
import { invalidateSetupStateCache } from '@/lib/setup/state';
import { logger } from '@/lib/logger';
import {
  validateSetupRequest,
  validateSetupReadRequest,
} from '@/lib/setup/setup-guard';
import { setEnvVariable } from '@/lib/setup/env-manager';
import { applyRateLimit } from '@/lib/rate-limit';

// =============================================================================
// Types
// =============================================================================

interface SetupRequest {
  action: 'init' | 'migrate' | 'seed' | 'full';
  config?: {
    host?: string;
    port?: number;
    database?: string;
    username?: string;
    password?: string;
  };
}

interface SetupResponse {
  success: boolean;
  phase: SetupPhase;
  progress: number;
  message?: string;
  error?: string;
  data?: {
    connection?: ConnectionTestResult;
    migration?: MigrationStatus;
  };
}

// =============================================================================
// Validation Schemas
// =============================================================================

const setupSchema = z.object({
  action: z.enum(['init', 'migrate', 'seed', 'full']),
  config: z
    .object({
      host: z.string().optional(),
      port: z.preprocess((v) => {
        if (typeof v === 'string') {
          const n = parseInt(v, 10);
          return Number.isNaN(n) ? undefined : n;
        }
        return typeof v === 'number' ? v : undefined;
      }, z.number().optional()),
      database: z.string().optional(),
      username: z.string().optional(),
      password: z.string().optional(),
    })
    .optional(),
});

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Get current setup status
 */
function getSetupStatus(): SetupProgressStatus {
  const migrationStatus = checkMigrationStatus();

  // Determine phase based on migration status
  let phase: SetupPhase = SetupPhase.CHECKING;
  let progress = 0;

  if (!migrationStatus.applied && migrationStatus.pendingCount > 0) {
    phase = SetupPhase.MIGRATING;
    progress = 30;
  } else if (migrationStatus.applied) {
    phase = SetupPhase.COMPLETE;
    progress = 100;
  }

  return {
    phase,
    progress,
    steps: [],
    canProceed: phase === SetupPhase.COMPLETE,
  };
}

/**
 * Run full setup process
 */
async function runFullSetup(): Promise<SetupResponse> {
  try {
    // Phase 1: Migration
    logger.info('Starting database migration');
    const migrationResult = runMigrations({ skipSeed: true });

    if (!migrationResult.success) {
      return {
        success: false,
        phase: SetupPhase.MIGRATING,
        progress: 30,
        error: migrationResult.error || 'Migration failed',
      };
    }

    // Phase 2: Seeding
    logger.info('Starting database seeding');
    const seedResult = seedDatabase();

    if (!seedResult.success) {
      return {
        success: false,
        phase: SetupPhase.SEEDING,
        progress: 70,
        error: seedResult.error || 'Seeding failed',
      };
    }

    // Invalidate any cached setup state so the proxy/router can re-evaluate readiness
    invalidateSetupStateCache();

    // Persist that setup mode should be disabled going forward (helps local dev).
    // This is best-effort; if the .env file isn't writable, we still succeed.
    try {
      process.env.SETUP_MODE = 'false';
      setEnvVariable('SETUP_MODE', 'false');
    } catch {
      // Ignore failures; this is only a convenience.
    }

    // Complete
    return {
      success: true,
      phase: SetupPhase.COMPLETE,
      progress: 100,
      message: 'Setup completed successfully',
    };
  } catch (error) {
    logger.error('Setup failed', error instanceof Error ? error : new Error(String(error)));
    return {
      success: false,
      phase: SetupPhase.CHECKING,
      progress: 0,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    };
  }
}

// =============================================================================
// API Handlers
// =============================================================================

/**
 * GET /api/setup
 * Get current setup status
 */
export async function GET(request: Request): Promise<NextResponse<SetupResponse> | NextResponse> {
  // Read-only status: uses the weaker read guard so the installer can poll
  // before any administrator exists. It never mutates and returns no secrets.
  const authResponse = await validateSetupReadRequest(request);
  if (authResponse) return authResponse;

  try {
    const status = getSetupStatus();

    return NextResponse.json({
      success: true,
      phase: status.phase,
      progress: status.progress,
      message: status.canProceed ? 'System is ready' : 'Setup required',
    });
  } catch (error) {
    logger.error('Failed to get setup status', error instanceof Error ? error : new Error(String(error)));

    return NextResponse.json(
      {
        success: false,
        phase: SetupPhase.CHECKING,
        progress: 0,
        error: error instanceof Error ? error.message : 'Failed to check setup status',
      },
      { status: 500 },
    );
  }
}

/**
 * POST /api/setup
 * Run setup operations
 */
export async function POST(request: NextRequest): Promise<NextResponse<SetupResponse> | NextResponse> {
  // Rate limit: setup actions run migrations and seeding, so they must not be
  // reachable in a tight loop by an unauthenticated caller.
  const rateLimitResponse = await applyRateLimit(request, 'adminAction');
  if (rateLimitResponse) {
    return rateLimitResponse as NextResponse<SetupResponse>;
  }

  // CSRF: the proxy does not blanket-exempt this route (only /api/setup/status
  // and /api/setup/verify are exempt), so validate defensively here too.
  const csrfError = csrfValidationResponse(request);
  if (csrfError) {
    return csrfError as NextResponse<SetupResponse>;
  }

  // Validate request is authorized for setup. A healthy application does NOT
  // bypass this guard — see src/lib/setup/setup-guard.ts.
  const authResponse = await validateSetupRequest(request);
  if (authResponse) return authResponse;

  try {
    // Validate request body
    const body = await request.json();
    const validation = setupSchema.safeParse(body);

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

    const { action } = validation.data as SetupRequest;

    // Handle different actions
    switch (action) {
      case 'init': {
        // simply verify that the provided or current database is reachable
        logger.info('Running connection test');
        try {
          // checkMigrationStatus executes a lightweight query; it will throw if
          // the connection cannot be established.
          const status = checkMigrationStatus();
          return NextResponse.json({
            success: true,
            phase: status.applied ? SetupPhase.COMPLETE : SetupPhase.CHECKING,
            progress: status.applied ? 100 : 0,
            message: 'Connection successful',
            data: { connection: { ok: true } },
          });
        } catch (err) {
          logger.warn('Connection test failed', { error: err });
          return NextResponse.json(
            {
              success: false,
              phase: SetupPhase.CHECKING,
              progress: 0,
              error: err instanceof Error ? err.message : 'Connection failed',
            },
            { status: 400 },
          );
        }
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
        });
      }

      case 'full': {
        const result = await runFullSetup();
        if (result.success) {
          invalidateSetupStateCache();
        }
        return NextResponse.json(result);
      }

      default:
        return NextResponse.json(
          {
            success: false,
            phase: SetupPhase.CHECKING,
            progress: 0,
            error: `Unknown action: ${action}`,
          },
          { status: 400 },
        );
    }
  } catch (error) {
    logger.error('Setup request failed', error instanceof Error ? error : new Error(String(error)));

    return NextResponse.json(
      {
        success: false,
        phase: SetupPhase.CHECKING,
        progress: 0,
        error: error instanceof Error ? error.message : 'Setup request failed',
      },
      { status: 500 },
    );
  }
}
