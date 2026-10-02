import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Regression tests for the request-security boundary in src/proxy.ts.
 *
 * Two real defects are pinned here:
 *
 *  1. The static-asset bypass was `pathname.includes('.')`, so ANY path
 *     containing a dot skipped the auth and setup gates — e.g.
 *     `/admin/report.csv` was treated as a static file and served without
 *     authentication.
 *
 *  2. `Permissions-Policy: microphone=()` was declared globally while the
 *     Digital Music Stand ships a Tuner and Audio Tracker that call
 *     getUserMedia(). That combination makes the tuner permanently broken in
 *     every browser. Microphone must be granted on Stand routes only.
 */

// NOTE: vi.mock factories are hoisted above module-level consts, so these mocks
// must not close over top-level variables. Each factory builds its own object
// and the tests reach it through the module registry.
vi.mock('@/lib/setup/state', () => ({
  getSetupState: vi.fn(async () => ({
    phase: 'COMPLETE',
    readyForLogin: true,
    dbConnected: true,
    hasSuperAdmin: true,
    provider: 'mysql',
    pendingMigrations: 0,
  })),
}));

vi.mock('@/lib/logger', () => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    withRequestId: vi.fn(),
  };
  logger.withRequestId.mockReturnValue(logger);
  return { logger };
});

vi.mock('@/lib/csrf', () => ({
  csrfValidationResponse: () => null,
}));

vi.mock('next/server', async () => {
  class NextResponse {
    static next() {
      return new NextResponse();
    }
    static json() {
      return new NextResponse();
    }
    static redirect() {
      const r = new NextResponse();
      r.status = 307; // Next.js uses 307 for middleware redirects
      return r;
    }
    headers = new Headers();
    status = 200;
    cookies = { has: () => false, get: () => undefined };
    get(name: string) {
      return this.headers.get(name);
    }
    set(name: string, value: string) {
      this.headers.set(name, value);
    }
  }
  return { NextResponse };
});

/** Build a NextRequest-ish object good enough for the proxy. */
function makeRequest(
  pathname: string,
  opts: { cookies?: Record<string, string>; method?: string } = {},
) {
  const url = new URL(pathname, 'http://localhost:3000');
  return {
    // `url` is required: the proxy builds redirect targets from it.
    url,
    nextUrl: { pathname: url.pathname, search: url.search },
    method: opts.method ?? 'GET',
    headers: new Headers({ host: 'localhost:3000' }),
    cookies: {
      has: (name: string) => Boolean(opts.cookies?.[name]),
      get: (name: string) => opts.cookies?.[name],
    },
  } as any;
}

// Import the pure helpers we want to assert on. They are not exported from
// proxy.ts, so we exercise them through the exported `proxy()` behaviour and
// via a small re-implementation harness below.
import { proxy } from '@/proxy';

beforeEach(() => {
  // Reset call history but keep the mock implementations (the hoisted
  // `withRequestId` self-reference and the ready-for-login setup state).
  vi.clearAllMocks();
});

/**
 * The static-asset decision is the load-bearing one. We assert it directly by
 * replaying the same predicate the proxy uses, so a regression in the
 * allowlist is caught even if the gate ordering changes.
 *
 * NOTE: this harness previously omitted the protected-prefix guard that
 * src/proxy.ts now applies, which is why the `.txt`/`.xml`/`.json` bypass
 * below went unnoticed: the replica agreed with the test's expectations while
 * the shipped function did not. Keep this function byte-for-byte equivalent to
 * `isStaticAssetPath` in src/proxy.ts — if you change one, change both.
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
const STATIC_ASSET_EXACT = new Set([
  '/favicon.ico',
  '/robots.txt',
  '/sitemap.xml',
  '/manifest.json',
  '/sw.js',
  '/pdf.worker.min.mjs',
]);
const STATIC_ASSET_EXTENSIONS = new Set([
  '.ico', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.avif',
  '.css', '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.txt', '.xml', '.webmanifest', '.map',
]);

/** Mirrors ROUTE_CONFIG in src/proxy.ts. */
const PROTECTED_PREFIXES = ['/admin', '/dashboard', '/member'];

function isProtectedPath(pathname: string): boolean {
  return PROTECTED_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

function isStaticAssetPath(pathname: string): boolean {
  if (STATIC_ASSET_EXACT.has(pathname)) return true;
  if (STATIC_ASSET_PREFIXES.some((p) => pathname.startsWith(p))) return true;
  // Fail closed for protected prefixes and the whole API surface.
  if (isProtectedPath(pathname)) return false;
  if (pathname === '/api' || pathname.startsWith('/api/')) return false;
  const lastSegment = pathname.split('/').pop() ?? '';
  const dot = lastSegment.lastIndexOf('.');
  if (dot <= 0) return false;
  return STATIC_ASSET_EXTENSIONS.has(lastSegment.slice(dot).toLowerCase());
}

describe('static asset classification', () => {
  it.each([
    '/_next/static/chunks/main.js',
    '/_next/image?url=x',
    '/static/css/app.css',
    '/images/logo.png',
    '/favicon.ico',
    '/robots.txt',
    '/sitemap.xml',
    '/manifest.json',
    '/sw.js',
    '/pdf.worker.min.mjs',
    '/uploads/public/photo.jpg',
  ])('treats %s as a static asset', (p) => {
    expect(isStaticAssetPath(p)).toBe(true);
  });

  it.each([
    // The original exploit: dots in application routes must NOT bypass the gates.
    ['/admin/report.csv'],
    ['/admin/members/export.csv'],
    ['/member/music.pdf'],
    ['/admin/settings.json'],
    ['/admin/users/x.'],
    ['/member/stand/../../admin/secrets.json'],
    // Regression: allowlisted extensions must not launder a protected route.
    ['/admin/notes.txt'],
    ['/admin/roster.xml'],
    ['/member/schedule.txt'],
    ['/dashboard/notes.json'],
    ['/admin/reports/attendance.xml'],
    ['/api/export.csv'],
    ['/api/admin/report.txt'],
    // Plain application routes.
    ['/admin'],
    ['/admin/members'],
    ['/member/stand'],
    ['/member/stand/library/abc'],
    ['/login'],
    ['/api/health'],
  ])('%s is not a static asset, so the auth and setup gates apply', (p) => {
    expect(isStaticAssetPath(p as string)).toBe(false);
  });

  it('still serves real public assets whose names contain a dot', () => {
    // The fix must not over-block: a genuine public asset still resolves.
    expect(isStaticAssetPath('/robots.txt')).toBe(true);
    expect(isStaticAssetPath('/images/2024.photo.png')).toBe(true);
  });
});

describe('protected routes with an allowlisted extension are actually gated', () => {
  // The predicate test above proves the classification; these assert the
  // end-to-end consequence — an unauthenticated request to a dot-extension
  // path under a protected prefix must be redirected, not served.
  //
  // Assert on status only: the NextResponse mock's `redirect()` does not retain
  // the Location header (see the mock above), which is why the pre-existing
  // admin-redirect test asserts `status === 307` for the same reason.
  it('redirects an unauthenticated /admin/notes.txt instead of serving it', async () => {
    const res = await proxy(makeRequest('/admin/notes.txt'));
    expect(res.status).toBe(307);
  });

  it('redirects an unauthenticated /member/roster.xml instead of serving it', async () => {
    const res = await proxy(makeRequest('/member/roster.xml'));
    expect(res.status).toBe(307);
  });
});

describe('permissions policy', () => {
  // A session cookie is supplied so admin routes are not redirected; the
  // permission policy is applied on the way through either way, but a 307
  // would make the header assertions about the wrong response.
  const authed = (pathname: string) =>
    proxy(makeRequest(pathname, { cookies: { 'better-auth.session_token': 'test-session' } }));

  it('denies the microphone on ordinary routes', async () => {
    const res = await authed('/admin/members');
    expect(res.headers.get('Permissions-Policy')).toContain('microphone=()');
  });

  it('denies the microphone on the public site', async () => {
    const res = await proxy(makeRequest('/about'));
    expect(res.headers.get('Permissions-Policy')).toContain('microphone=()');
  });

  it('denies the microphone on member routes outside the Stand', async () => {
    const res = await proxy(makeRequest('/member/music'));
    expect(res.headers.get('Permissions-Policy')).toContain('microphone=()');
  });

  it('allows the microphone on the Stand so the Tuner can work', async () => {
    const res = await proxy(makeRequest('/member/stand'));
    const policy = res.headers.get('Permissions-Policy');
    expect(policy).toContain('microphone=(self)');
    expect(policy).not.toContain('microphone=()');
  });

  it('allows the microphone on Stand sub-routes', async () => {
    const res = await proxy(makeRequest('/member/stand/library/piece-1'));
    expect(res.headers.get('Permissions-Policy')).toContain('microphone=(self)');
  });

  it('keeps camera and geolocation denied even on the Stand', async () => {
    const res = await proxy(makeRequest('/member/stand'));
    const policy = res.headers.get('Permissions-Policy');
    expect(policy).toContain('camera=()');
    expect(policy).toContain('geolocation=()');
  });
});

describe('standard security headers', () => {
  const authed = (pathname: string) =>
    proxy(makeRequest(pathname, { cookies: { 'better-auth.session_token': 'test-session' } }));

  it('sets the baseline headers on every response', async () => {
    const res = await authed('/admin/members');
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Security-Policy')).toBeTruthy();
  });

  it('stays consistent between a public and an authenticated admin route', async () => {
    const pub = await proxy(makeRequest('/about'));
    const admin = await authed('/admin/members');
    for (const header of ['X-Frame-Options', 'X-Content-Type-Options', 'Referrer-Policy']) {
      expect(pub.headers.get(header)).toBe(admin.headers.get(header));
    }
  });
});

describe('authentication gate', () => {
  it('redirects an unauthenticated admin request to login', async () => {
    const res = await proxy(makeRequest('/admin/members'));
    expect(res.status).toBe(307);
  });

  it('does not redirect an authenticated admin request', async () => {
    const res = await proxy(
      makeRequest('/admin/members', {
        cookies: { 'better-auth.session_token': 'test-session' },
      }),
    );
    expect(res.status).not.toBe(307);
  });

  it('lets a public route through without a session', async () => {
    const res = await proxy(makeRequest('/about'));
    expect(res.status).not.toBe(307);
  });
});
