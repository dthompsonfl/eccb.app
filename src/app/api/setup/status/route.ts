/**
 * Setup Status API Route
 *
 * Returns the authoritative setup state via getSetupState().
 * Includes database connection, migration, super-admin and auth-config checks.
 */

import { NextResponse } from 'next/server';

import { getSetupState } from '@/lib/setup/state';
import { SetupPhase } from '@/lib/setup/types';
import { logger } from '@/lib/logger';
import { validateSetupReadRequest } from '@/lib/setup/setup-guard';

// =============================================================================
// Types
// =============================================================================

interface StatusResponse {
  success: boolean;
  phase: SetupPhase;
  progress: number;
  status: 'not_started' | 'in_progress' | 'completed' | 'failed';
  message: string;
  readyForLogin: boolean;
  details?: {
    database?: {
      connected: boolean;
      provider?: string;
    };
    migrations?: {
      applied: boolean;
      pendingCount: number;
    };
    superAdmin?: {
      exists: boolean;
    };
    auth?: {
      configured: boolean;
    };
  };
}

// =============================================================================
// Phase → progress / status / message mapping
// =============================================================================

function phaseToMeta(
  phase: SetupPhase,
  state: Awaited<ReturnType<typeof getSetupState>>,
): Pick<StatusResponse, 'progress' | 'status' | 'message'> {
  switch (phase) {
    case SetupPhase.COMPLETE:
      return { progress: 100, status: 'completed', message: 'System is ready' };
    case SetupPhase.MIGRATING:
      return {
        progress: 30,
        status: 'in_progress',
        message: state.pendingMigrations
          ? `${state.pendingMigrations} migration(s) pending`
          : 'Migrations have not been applied',
      };
    case SetupPhase.VERIFYING:
      return {
        progress: 70,
        status: 'in_progress',
        message: state.error ?? 'Verifying setup…',
      };
    case SetupPhase.SEEDING:
      return { progress: 80, status: 'in_progress', message: 'Seeding database…' };
    case SetupPhase.INITIALIZING:
      return { progress: 10, status: 'not_started', message: 'Database initialized, migrations required' };
    default: // CHECKING / CONFIGURING
      return {
        progress: 0,
        status: state.dbConnected ? 'in_progress' : 'failed',
        message: state.error ?? 'Checking system status…',
      };
  }
}

// =============================================================================
// API Handlers
// =============================================================================

/**
 * GET /api/setup/status
 * Returns the current setup state as a rich StatusResponse.
 */
export async function GET(request: Request): Promise<NextResponse<StatusResponse> | NextResponse> {
  // Read-only: the installer needs progress before any admin exists, so this
  // uses the weaker read guard. It never mutates and never returns secrets.
  const authResponse = await validateSetupReadRequest(request);
  if (authResponse) return authResponse;

  try {
    const state = await getSetupState();
    const meta = phaseToMeta(state.phase, state);

    const response: StatusResponse = {
      success: true,
      phase: state.phase,
      progress: meta.progress,
      status: meta.status,
      message: meta.message,
      readyForLogin: state.readyForLogin,
      details: {
        database: {
          connected: state.dbConnected,
          provider: state.provider,
        },
        migrations: {
          applied: (state.pendingMigrations ?? 0) === 0 && state.dbConnected,
          pendingCount: state.pendingMigrations ?? 0,
        },
        superAdmin: {
          exists: state.hasSuperAdmin,
        },
        auth: {
          // auth is configured when we reached COMPLETE or VERIFYING past the super-admin check
          configured:
            state.phase === SetupPhase.COMPLETE ||
            (state.phase === SetupPhase.VERIFYING &&
              state.hasSuperAdmin &&
              (state.error?.includes('auth') ?? false) === false),
        },
      },
    };

    return NextResponse.json(response);
  } catch (error) {
    logger.error(
      'Failed to get setup status',
      error instanceof Error ? error : new Error(String(error)),
    );

    const response: StatusResponse = {
      success: false,
      phase: SetupPhase.CHECKING,
      progress: 0,
      status: 'failed',
      message: error instanceof Error ? error.message : 'Failed to check status',
      readyForLogin: false,
    };

    return NextResponse.json(response, { status: 500 });
  }
}
