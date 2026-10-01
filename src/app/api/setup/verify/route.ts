/**
 * Setup Verify API Route
 *
 * POST /api/setup/verify
 *
 * Force-refreshes the setup state and returns a simple pass/fail result.
 * Call this after completing a setup step (migration, seed, etc.) to confirm
 * the system is fully ready for login.
 */

import { NextResponse } from 'next/server';

import { verifySetup } from '@/lib/setup/state';
import { logger } from '@/lib/logger';
import { validateSetupReadRequest } from '@/lib/setup/setup-guard';

interface VerifyResponse {
  success: boolean;
  error?: string;
}

/**
 * POST /api/setup/verify
 * Verifies setup completion by force-refreshing state.
 */
export async function POST(request: Request): Promise<NextResponse<VerifyResponse>> {
  // Read-only: this only re-reads and reports state, so it uses the read guard.
  const authResponse = await validateSetupReadRequest(request);
  if (authResponse) return authResponse as NextResponse<VerifyResponse>;

  try {
    const result = await verifySetup();

    if (result.success) {
      logger.info('Setup verification passed – system is ready for login');
    } else {
      logger.warn('Setup verification failed', { reason: result.error });
    }

    return NextResponse.json(result, { status: result.success ? 200 : 422 });
  } catch (error) {
    logger.error(
      'Setup verify endpoint error',
      error instanceof Error ? error : new Error(String(error)),
    );

    return NextResponse.json(
      { success: false, error: 'Internal error during setup verification' },
      { status: 500 },
    );
  }
}

/**
 * GET /api/setup/verify
 * Same as POST – allows polling from the wizard UI.
 */
export async function GET(request: Request): Promise<NextResponse<VerifyResponse>> {
  return POST(request);
}
