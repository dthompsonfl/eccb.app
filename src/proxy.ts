import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { randomUUID } from 'crypto';
import { logger } from '@/lib/logger';
import { getSetupState } from '@/lib/setup/state';
import { csrfValidationResponse } from '@/lib/csrf';

// Route configuration for access control
interface RouteConfig {
  requiresAuth: boolean;
  requiresAdmin?: boolean;
  redirectTo?: string;
}

// Define route patterns and their access requirements
const ROUTE_CONFIG: Record<string, RouteConfig> = {
  // Admin routes - require auth + admin role
  '/admin': { requiresAuth: true, requiresAdmin: true, redirectTo: '/login' },
  // Member/dashboard routes - require auth
  '/dashboard': { requiresAuth: true, redirectTo: '/login' },
  '/member': { requiresAuth: true, redirectTo: '/login' },
  '/music/upload': { requiresAuth: true, redirectTo: '/login' },
};

// Public routes that don't require authentication
const PUBLIC_ROUTES = [
  '/',
  '/about',
  '/contact',
  '/directors',
  '/events',
  '/gallery',
  '/news',
  '/policies',
  '/sponsors',
  '/login',
  '/signup',
  '/forgot-password',
  '/reset-password',
  '/verify-email',
  '/forbidden',
  '/offline',
];

// Auth API routes that should not be blocked
const AUTH_API_PATHS = ['/api/auth'];

// Paths that are always allowed regardless of setup state
// (setup wizard, health check, and static assets bypass the gate)
const SETUP_BYPASS_PATHS = [
  '/setup',
  '/api/setup',
  '/api/health',
];

// Paths to skip logging (health checks, static assets)
const SKIP_LOGGING_PATHS = [
  '/api/health',
  '/_next',
  '/static',
  '/favicon.ico',
  '/robots.txt',
  '/sitemap.xml',
];

// Security headers to apply to all responses
const SECURITY_HEADERS = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
  // Enforce HTTPS for 1 year on all subdomains; include in browser preload list
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
  // Prevent DNS prefetch leaking navigated origins
  'X-DNS-Prefetch-Control': 'off',
  // Enable XSS filter in browsers
  'X-XSS-Protection': '1; mode=block',
};

// Content Security Policy.
// unsafe-inline is required by Tailwind (style) and Next.js inline style injection.
// unsafe-eval is NOT included — Next.js 16 production builds do not need it.
// TODO: migrate to nonce-based CSP to fully remove unsafe-inline for script-src.
const CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",  // Next.js inline scripts; unsafe-eval intentionally omitted
  "style-src 'self' 'unsafe-inline'",   // Tailwind / CSS-in-JS requires unsafe-inline
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' wss:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

/**
 * Generate a unique request ID for log correlation
 */
function generateRequestId(): string {
  return `req_${randomUUID()}`;
}

/**
 * Check if path matches a pattern (supports prefix matching)
 */
function matchesPath(pathname: string, pattern: string): boolean {
  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -3);
    return pathname.startsWith(prefix);
  }
  return pathname === pattern || pathname.startsWith(`${pattern}/`);
}

/**
 * Determine route configuration for a given path
 */
function getRouteConfig(pathname: string): RouteConfig | null {
  for (const [pattern, config] of Object.entries(ROUTE_CONFIG)) {
    if (matchesPath(pathname, pattern)) {
      return config;
    }
  }
  return null;
}

/**
 * Check if path is public
 */
function isPublicPath(pathname: string): boolean {
  return PUBLIC_ROUTES.some(route => 
    route === pathname || (route !== '/' && pathname.startsWith(`${route}/`))
  );
}

/**
 * Check if path is an auth API path
 */
function isAuthApiPath(pathname: string): boolean {
  return AUTH_API_PATHS.some(path => pathname.startsWith(path));
}

/**
 * Check if path is exempt from the setup-ready gate.
 * This includes the setup wizard itself, its API, and the health endpoint.
 */
function isSetupBypassPath(pathname: string): boolean {
  return SETUP_BYPASS_PATHS.some(p => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * Check if path should skip logging
 */
function shouldSkipLogging(pathname: string): boolean {
  return SKIP_LOGGING_PATHS.some(path => pathname.startsWith(path)) || pathname.includes('.');
}

/**
 * Apply security headers to response
 */
function applySecurityHeaders(response: NextResponse): void {
  // Apply standard security headers
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    response.headers.set(key, value);
  }
  
  // Apply CSP
  response.headers.set('Content-Security-Policy', CSP_DIRECTIVES);
}

/**
 * Check if user is authenticated via session cookie
 */
function isAuthenticated(request: NextRequest): boolean {
  return request.cookies.has('better-auth.session_token') ||
         request.cookies.has('__Secure-better-auth.session_token');
}

/**
 * Log incoming request
 */
function logRequest(
  request: NextRequest,
  requestId: string,
  requestLogger: ReturnType<typeof logger.withRequestId>
): void {
  const { pathname, search } = request.nextUrl;
  const method = request.method;
  const userAgent = request.headers.get('user-agent') || 'unknown';
  const ip = request.headers.get('x-forwarded-for') || 
             request.headers.get('x-real-ip') || 
             'unknown';
  
  requestLogger.info(`Request started: ${method} ${pathname}`, {
    method,
    path: pathname,
    query: search || undefined,
    userAgent,
    ip: Array.isArray(ip) ? ip[0] : ip,
  });
}

/**
 * Log completed request with duration
 */
function logResponse(
  request: NextRequest,
  response: NextResponse,
  requestId: string,
  startTime: number,
  requestLogger: ReturnType<typeof logger.withRequestId>
): void {
  const { pathname } = request.nextUrl;
  const method = request.method;
  const duration = Date.now() - startTime;
  const status = response.status;
  
  // Determine log level based on status and duration
  const isSlow = duration > 1000;
  const isError = status >= 400;
  
  const context = {
    method,
    path: pathname,
    status,
    duration,
    durationMs: duration,
  };
  
  if (isError) {
    requestLogger.warn(`Request completed with error: ${method} ${pathname} ${status}`, context);
  } else if (isSlow) {
    requestLogger.warn(`Slow request: ${method} ${pathname} took ${duration}ms`, context);
  } else {
    requestLogger.debug(`Request completed: ${method} ${pathname} ${status}`, context);
  }
}

/**
 * Proxy function - Next.js 16 middleware equivalent
 */
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const requestId = generateRequestId();
  const startTime = Date.now();
  
  // Create request-scoped logger
  const requestLogger = logger.withRequestId(requestId);
  
  // Log incoming request (skip for health checks and static assets)
  const skipLogging = shouldSkipLogging(pathname);
  if (!skipLogging) {
    logRequest(request, requestId, requestLogger);
  }
  
  // Create response with request ID header
  const response = NextResponse.next();
  response.headers.set('X-Request-Id', requestId);
  
  // Apply security headers to all responses
  applySecurityHeaders(response);

  // Allow static assets
  if (
    pathname.startsWith('/_next') ||
    pathname.startsWith('/static') ||
    pathname.startsWith('/images') ||
    pathname === '/favicon.ico' ||
    pathname === '/robots.txt' ||
    pathname === '/sitemap.xml' ||
    pathname.includes('.') // Static files
  ) {
    if (!skipLogging) {
      logResponse(request, response, requestId, startTime, requestLogger);
    }
    return response;
  }

  // Allow auth API routes (Better Auth handles its own security)
  if (isAuthApiPath(pathname)) {
    if (!skipLogging) {
      logResponse(request, response, requestId, startTime, requestLogger);
    }
    return response;
  }

  // ── CSRF protection for mutating API requests ────────────────────────────
  // Validate Origin/Referer for all state-changing API calls.
  // Excluded paths: /api/auth (BetterAuth owns its CSRF), /api/setup, /api/health.
  if (
    pathname.startsWith('/api') &&
    !isAuthApiPath(pathname) &&
    !isSetupBypassPath(pathname)
  ) {
    const csrfError = csrfValidationResponse(request);
    if (csrfError) {
      requestLogger.warn('CSRF validation failed', {
        method: request.method,
        path: pathname,
        origin: request.headers.get('origin'),
        referer: request.headers.get('referer'),
      });
      const csrfResponse = NextResponse.json(
        { error: 'CSRF validation failed' },
        { status: 403 },
      );
      applySecurityHeaders(csrfResponse);
      csrfResponse.headers.set('X-Request-Id', requestId);
      if (!skipLogging) {
        logResponse(request, csrfResponse, requestId, startTime, requestLogger);
      }
      return csrfResponse;
    }
  }

  // Allow other API routes (they handle their own auth)
  if (pathname.startsWith('/api')) {
    if (!skipLogging) {
      logResponse(request, response, requestId, startTime, requestLogger);
    }
    return response;
  }

  // ── Setup readiness gate ──────────────────────────────────────────────────
  // If the system is not ready for login, redirect every non-bypass page
  // request to the setup wizard.
  if (!isSetupBypassPath(pathname)) {
    try {
      const setupState = await getSetupState();
      if (!setupState.readyForLogin) {
        requestLogger.info(`Setup not complete (${setupState.phase}), redirecting ${pathname} → /setup`);
        const setupUrl = new URL('/setup', request.url);
        const redirectResponse = NextResponse.redirect(setupUrl);
        redirectResponse.headers.set('X-Request-Id', requestId);
        applySecurityHeaders(redirectResponse);
        if (!skipLogging) {
          logResponse(request, redirectResponse, requestId, startTime, requestLogger);
        }
        return redirectResponse;
      }
    } catch (err) {
      // If we cannot determine setup state, log and continue rather than
      // hard-blocking the request – the page itself will handle the error.
      requestLogger.warn('Failed to read setup state in proxy', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // ── End setup gate ────────────────────────────────────────────────────────

  // Allow public routes
  if (isPublicPath(pathname)) {
    if (!skipLogging) {
      logResponse(request, response, requestId, startTime, requestLogger);
    }
    return response;
  }

  // Get route configuration
  const routeConfig = getRouteConfig(pathname);
  
  // If route requires authentication
  if (routeConfig?.requiresAuth) {
    if (!isAuthenticated(request)) {
      // Log redirect
      requestLogger.info(`Unauthenticated access attempt to ${pathname}, redirecting to login`);
      
      // Redirect to login with return URL
      const loginUrl = new URL(routeConfig.redirectTo || '/login', request.url);
      loginUrl.searchParams.set('callbackUrl', pathname);
      const redirectResponse = NextResponse.redirect(loginUrl);
      redirectResponse.headers.set('X-Request-Id', requestId);
      applySecurityHeaders(redirectResponse);
      
      if (!skipLogging) {
        logResponse(request, redirectResponse, requestId, startTime, requestLogger);
      }
      
      return redirectResponse;
    }
    
    // For admin routes, set a header to indicate admin check needed
    // The actual admin verification happens server-side in the page/action
    if (routeConfig.requiresAdmin) {
      response.headers.set('x-requires-admin', 'true');
    }
  }

  // Log response
  if (!skipLogging) {
    logResponse(request, response, requestId, startTime, requestLogger);
  }

  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
