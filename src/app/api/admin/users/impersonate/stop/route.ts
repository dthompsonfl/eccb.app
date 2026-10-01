import { NextRequest, NextResponse } from 'next/server';
import { stopImpersonation } from '@/lib/auth/impersonation';
import { validateCSRF } from '@/lib/csrf';
import { applyRateLimit } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

/**
 * End the current impersonation session and restore the original admin.
 *
 * No permission check here by design: Better Auth only completes this call
 * when the caller's session carries `impersonatedBy`, and the only sessions
 * that do are ones `startImpersonation` created after a `USER_MANAGE` check.
 * Requiring admin permission again would fail, because the caller is
 * currently signed in *as the target*.
 */
export async function POST(request: NextRequest) {
  try {
    const rateLimitResponse = await applyRateLimit(request, 'adminAction');
    if (rateLimitResponse) {
      return rateLimitResponse;
    }

    const csrfResult = validateCSRF(request);
    if (!csrfResult.valid) {
      return NextResponse.json(
        { success: false, error: 'CSRF validation failed', reason: csrfResult.reason },
        { status: 403 },
      );
    }

    const result = await stopImpersonation(request.headers);

    if (!result.success) {
      return NextResponse.json({ success: false, error: result.error }, { status: result.status });
    }

    const response = NextResponse.json({
      success: true,
      restoredUser: result.restoredUser,
    });

    for (const cookie of result.setCookies) {
      response.headers.append('set-cookie', cookie);
    }
    response.headers.set('cache-control', 'no-store');

    return response;
  } catch (error) {
    logger.error('Error in stop impersonation API', {
      error: error instanceof Error ? error.message : 'unknown',
    });
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 },
    );
  }
}