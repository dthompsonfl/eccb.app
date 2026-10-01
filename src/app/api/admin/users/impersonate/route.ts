import { NextRequest, NextResponse } from 'next/server';
import { startImpersonation } from '@/lib/auth/impersonation';
import { validateCSRF } from '@/lib/csrf';
import { applyRateLimit } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import { z } from 'zod';

const impersonateUserSchema = z.object({
  userId: z.string().min(1, 'User ID is required'),
});

/**
 * Start an impersonation session.
 *
 * Better Auth sets the session cookies itself (and plants a signed
 * `better-auth.admin_session` cookie so the session can be ended later). Those
 * `Set-Cookie` headers are forwarded verbatim onto this response — dropping
 * them is precisely what made the previous implementation a no-op that still
 * reported success.
 */
export async function POST(request: NextRequest) {
  try {
    // Impersonation is a sensitive admin action: rate limit it as one.
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

    const validated = impersonateUserSchema.safeParse(await request.json());
    if (!validated.success) {
      return NextResponse.json(
        { success: false, error: validated.error.issues[0].message },
        { status: 400 },
      );
    }

    const result = await startImpersonation(validated.data.userId, request.headers);

    if (!result.success) {
      return NextResponse.json({ success: false, error: result.error }, { status: result.status });
    }

    const response = NextResponse.json({
      success: true,
      impersonatedUser: result.impersonatedUser,
    });

    // Forward every cookie Better Auth produced, including the expiring
    // delete-cookies for the admin's own session. Never log these values.
    for (const cookie of result.setCookies) {
      response.headers.append('set-cookie', cookie);
    }

    // The browser must re-fetch with the new cookie rather than serve the
    // impersonated dashboard from a warm cache.
    response.headers.set('cache-control', 'no-store');

    return response;
  } catch (error) {
    logger.error('Error in impersonate user API', {
      error: error instanceof Error ? error.message : 'unknown',
    });
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 },
    );
  }
}