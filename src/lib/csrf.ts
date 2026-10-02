import { NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { resolveOriginForHost } from '@/lib/allowed-origins';

/**
 * CSRF Validation Result
 */
export interface CSRFResult {
  valid: boolean;
  reason?: string;
}

/**
 * Validate CSRF token for mutating requests (POST, PUT, DELETE, PATCH)
 * 
 * This implements Origin/Host validation to prevent CSRF attacks:
 * 1. For browser requests: Origin header must match Host
 * 2. For server-to-server: X-API-Key header can bypass (for future API access)
 * 
 * @param request - The incoming request
 * @returns CSRFResult indicating if the request is valid
 */
export function validateCSRF(request: NextRequest): CSRFResult {
  const method = request.method.toUpperCase();
  
  // Only validate mutating methods
  const mutatingMethods = ['POST', 'PUT', 'DELETE', 'PATCH'];
  if (!mutatingMethods.includes(method)) {
    return { valid: true };
  }
  
  // Check for API key bypass (server-to-server requests)
  const apiKey = request.headers.get('x-api-key');
  if (apiKey) {
    // In the future, validate against stored API keys
    // For now, we reject API key requests as not configured
    return { 
      valid: false, 
      reason: 'API key authentication not configured',
    };
  }
  
  // Get Origin and Host headers
  const origin = request.headers.get('origin');
  const host = request.headers.get('host');
  
  // If no Origin header, check Referer as fallback
  if (!origin) {
    const referer = request.headers.get('referer');
    
    if (!referer) {
      // No origin or referer - could be a direct API call or CSRF attack
      // In strict mode, we reject this
      return {
        valid: false,
        reason: 'Missing Origin and Referer headers',
      };
    }
    
    // Parse referer to get origin
    try {
      const refererUrl = new URL(referer);
      const refererOrigin = refererUrl.origin;
      
      // Compare referer origin with host
      const expectedOrigin = getExpectedOrigin(host);
      if (!expectedOrigin) {
        return {
          valid: false,
          reason: 'Unable to determine expected origin',
        };
      }
      
      if (refererOrigin !== expectedOrigin) {
        return {
          valid: false,
          reason: 'Referer origin mismatch',
        };
      }
      
      return { valid: true };
    } catch {
      return {
        valid: false,
        reason: 'Invalid Referer header',
      };
    }
  }
  
  // Validate Origin against Host
  const expectedOrigin = getExpectedOrigin(host);
  if (!expectedOrigin) {
    return {
      valid: false,
      reason: 'Unable to determine expected origin',
    };
  }
  
  if (origin !== expectedOrigin) {
    return {
      valid: false,
      reason: `Origin mismatch: expected ${expectedOrigin}, got ${origin}`,
    };
  }
  
  return { valid: true };
}

/**
 * Get the expected origin based on the request Host header.
 *
 * The expected origin is resolved from the configured allowlist
 * (`NEXT_PUBLIC_APP_URL` + `ALLOWED_ORIGINS`, see lib/allowed-origins.ts) and
 * never from attacker-controllable request data. A `Host` outside the
 * allowlist yields `null`, which callers treat as a hard rejection — this is
 * what stops the classic bypass of sending `Host: evil.com` together with
 * `Origin: https://evil.com`.
 *
 * Returning an allowlisted origin for a known host is what lets the same
 * build serve loopback, the LAN address, a Tailscale address and a forwarded
 * public IP without weakening CSRF protection.
 */
function getExpectedOrigin(host: string | null): string | null {
  const fromAllowlist = resolveOriginForHost(host);
  if (fromAllowlist) {
    return fromAllowlist;
  }

  if (env.NODE_ENV !== 'production') {
    // Development convenience only: loopback hosts on plain http.
    if (host && (host.startsWith('localhost:') || host.startsWith('127.0.0.1:'))) {
      return `http://${host}`;
    }
  }

  return null;
}

/**
 * Middleware helper to validate CSRF and return appropriate response
 * 
 * @param request - The incoming request
 * @returns null if valid, or a Response object with error details
 */
export function csrfValidationResponse(request: NextRequest): Response | null {
  const result = validateCSRF(request);
  
  if (!result.valid) {
    return new Response(
      JSON.stringify({
        error: 'CSRF validation failed',
        reason: result.reason,
      }),
      {
        status: 403,
        headers: {
          'Content-Type': 'application/json',
        },
      }
    );
  }
  
  return null;
}

/**
 * Create a CSRF token for forms (optional, for double-submit cookie pattern)
 * This is an alternative approach if Origin validation is not sufficient
 */
export function generateCSRFToken(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
}
