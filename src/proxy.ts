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
  // Static legal/accessibility pages linked from the public footer.
  '/privacy',
  '/terms',
  '/accessibility',
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
const BASE_SECURITY_HEADERS = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  // Enforce HTTPS for 1 year on all subdomains; include in browser preload list
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
  // Prevent DNS prefetch leaking navigated origins
  'X-DNS-Prefetch-Control': 'off',
  // Enable XSS filter in browsers
  'X-XSS-Protection': '1; mode=block',
};

/**
 * Permissions-Policy, least privilege.
 *
 * The microphone is denied everywhere EXCEPT the Digital Music Stand routes,
 * which are the only pages that call getUserMedia() (Tuner and Audio Tracker).
 * Declaring microphone=() globally while shipping a tuner would make the
 * feature permanently broken in every browser, so it is granted per-route.
 *
 * camera/geolocation/payment stay denied on all routes.
 */
const PERMISSIONS_POLICY_DENY_ALL =
  'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()';

const PERMISSIONS_POLICY_STAND =
  'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(self), payment=(), usb=()';

/** Stand routes are the only ones permitted to open a microphone stream. */
function isMicrophoneAllowedPath(pathname: string): boolean {
  return (
    pathname === '/member/stand' ||
    pathname.startsWith('/member/stand/')
  );
}

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
 * Framework and public static asset prefixes.
 *
 * These are the ONLY paths that bypass the auth/setup gates. Previously the
 * bypass was `pathname.includes('.')`, which meant any path containing a dot
 * skipped every check — e.g. `/member/music.pdf`, `/admin/secret.json`, and
 * even `/admin/users/x.`. That was an authorization bypass, not a static-asset
 * rule, so it is replaced with an explicit allowlist of real asset roots.
 */
const STATIC_ASSET_PREFIXES = [
  '/_next/static',
  '/_next/image',
  '/_next/data',
  '/static',
  '/images',
  '/icons',
  '/uploads/public',
  '/Stock Images',
];

/** Exact, non-prefixed static paths. */
const STATIC_ASSET_EXACT = new Set([
  '/favicon.ico',
  '/robots.txt',
  '/sitemap.xml',
  '/manifest.json',
  '/sw.js',
  '/pdf.worker.min.mjs',
]);

/** File extensions that are unambiguously static assets. */
const STATIC_ASSET_EXTENSIONS = new Set([
  '.ico', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.avif',
  '.css', '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.txt', '.xml', '.webmanifest', '.map',
]);

function isStaticAssetPath(pathname: string): boolean {
  if (STATIC_ASSET_EXACT.has(pathname)) return true;
  if (STATIC_ASSET_PREFIXES.some(prefix => pathname.startsWith(prefix))) return true;

  // Extension check, but ONLY when the path is not an application route.
  // A dot in the final segment is a strong signal of a file, whereas a dot in
  // a directory or filename belonging to a known route is not.
  const lastSegment = pathname.split('/').pop() ?? '';
  const dot = lastSegment.lastIndexOf('.');
  if (dot <= 0) return false;
  return STATIC_ASSET_EXTENSIONS.has(lastSegment.slice(dot).toLowerCase());
}

/**
 * Check if path should skip logging.
 *
 * Logging is suppressed for high-volume static assets only — never as an
 * authorization decision.
 */
function shouldSkipLogging(pathname: string): boolean {
  return SKIP_LOGGING_PATHS.some(path => pathname.startsWith(path)) || isStaticAssetPath(pathname);
}

/**
 * Apply security headers to response.
 *
 * `pathname` selects the Permissions-Policy variant: microphone is only
 * permitted on Digital Music Stand routes.
 */
function applySecurityHeaders(response: NextResponse, pathname: string): void {
  for (const [key, value] of Object.entries(BASE_SECURITY_HEADERS)) {
    response.headers.set(key, value);
  }

  response.headers.set(
    'Permissions-Policy',
    isMicrophoneAllowedPath(pathname) ? PERMISSIONS_POLICY_STAND : PERMISSIONS_POLICY_DENY_ALL,
  );

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
  applySecurityHeaders(response, pathname);

  // Allow real static assets only. This used to be `pathname.includes('.')`,
  // which let any dot-containing path (e.g. `/admin/report.csv`) skip the
  // auth and setup gates entirely. See isStaticAssetPath().
  if (isStaticAssetPath(pathname)) {
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
  // Setup status/verify are read-only and are usable before any session exists,
  // so they stay exempt. The setup MUTATION endpoints (/api/setup itself and
  // /api/setup/repair) are deliberately NOT exempt: they perform CSRF
  // validation internally whenever a session cookie is present.
  const isSetupReadOnlyPath =
    pathname === '/api/setup/status' || pathname === '/api/setup/verify';

  if (
    pathname.startsWith('/api') &&
    !isAuthApiPath(pathname) &&
    !isSetupReadOnlyPath &&
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
      applySecurityHeaders(csrfResponse, pathname);
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
        applySecurityHeaders(redirectResponse, pathname);
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
      applySecurityHeaders(redirectResponse, pathname);
      
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
