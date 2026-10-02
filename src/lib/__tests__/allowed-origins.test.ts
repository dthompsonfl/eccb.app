/**
 * Tests for the allowed-origin allowlist.
 *
 * The allowlist is the single gate that decides whether login and mutating API
 * calls succeed from the LAN address, the Tailscale address and a forwarded
 * public IP. These tests pin both halves of that contract: every configured
 * origin must be accepted, and nothing outside the list may be.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setTestEnv } from './test-env-helper';

const CANONICAL = 'http://localhost:3225';
const ORIGIN_APP_URL = process.env.NEXT_PUBLIC_APP_URL;
const ORIGIN_ALLOWED = process.env.ALLOWED_ORIGINS;
const ORIGIN_COOKIE_SECURE = process.env.COOKIE_SECURE;

async function loadModule() {
  vi.resetModules();
  const mod = await import('@/lib/allowed-origins');
  mod.resetAllowedOriginsCache();
  return mod;
}

/**
 * Set the configuration this module reads.
 *
 * `allowed-origins.ts` reads from `@/lib/env`, which the global test setup
 * hard-mocks with a static object. Assigning to `process.env` alone has no
 * effect on it, so every test routes through this helper — the assertions below
 * are unchanged.
 */
function setOrigins(appUrl: string, allowed?: string) {
  setTestEnv({ NEXT_PUBLIC_APP_URL: appUrl, ALLOWED_ORIGINS: allowed });
}

/**
 * Set the session cookie flag.
 *
 * In production `env.ts` runs the raw env string through a Zod transform that
 * turns "true"/"false" into a BOOLEAN before `allowed-origins.ts` ever reads it
 * (`typeof env.COOKIE_SECURE === 'boolean'`). These tests bypass Zod, so they
 * must supply the already-transformed boolean or the override is ignored and
 * scheme detection wins.
 */
function setCookieSecure(value: boolean | undefined) {
  setTestEnv({ COOKIE_SECURE: value as unknown as string });
}

describe('allowed-origins', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    setTestEnv({
      NEXT_PUBLIC_APP_URL: ORIGIN_APP_URL,
      ALLOWED_ORIGINS: ORIGIN_ALLOWED,
    });
    setCookieSecure(ORIGIN_COOKIE_SECURE as unknown as boolean | undefined);
    vi.resetModules();
  });

  it('always trusts the canonical NEXT_PUBLIC_APP_URL', async () => {
    setOrigins('https://band.example.org', undefined);

    const { getAllowedOrigins } = await loadModule();
    expect(getAllowedOrigins()).toContain('https://band.example.org');
  });

  it('trusts LAN, Tailscale and public-IP origins supplied via ALLOWED_ORIGINS', async () => {
    setOrigins(
      CANONICAL,
      'http://192.168.1.152:3225 http://100.122.110.124:3225 http://45.30.217.57:3225',
    );

    const { getAllowedOrigins } = await loadModule();
    expect(getAllowedOrigins()).toEqual([
      CANONICAL,
      'http://192.168.1.152:3225',
      'http://100.122.110.124:3225',
      'http://45.30.217.57:3225',
    ]);
  });

  it('accepts comma-separated entries and normalises trailing slashes and paths', async () => {
    setOrigins(CANONICAL, 'http://192.168.1.10:3225/, https://band.example.org/some/path');

    const { getAllowedOrigins } = await loadModule();
    expect(getAllowedOrigins()).toContain('http://192.168.1.10:3225');
    expect(getAllowedOrigins()).toContain('https://band.example.org');
  });

  it('drops malformed entries instead of throwing', async () => {
    setOrigins(CANONICAL, 'not-a-url ftp://bad.scheme  http://10.0.0.5:3225');

    const { getAllowedOrigins } = await loadModule();
    expect(getAllowedOrigins()).toEqual([CANONICAL, 'http://10.0.0.5:3225']);
  });

  it('de-duplicates repeated origins', async () => {
    setOrigins(CANONICAL, `http://192.168.1.10:3225 ${CANONICAL} http://192.168.1.10:3225`);

    const { getAllowedOrigins } = await loadModule();
    expect(getAllowedOrigins()).toEqual([CANONICAL, 'http://192.168.1.10:3225']);
  });

  it('resolves the expected origin for a configured host', async () => {
    setOrigins(CANONICAL, 'http://100.122.110.124:3225');

    const { resolveOriginForHost } = await loadModule();
    expect(resolveOriginForHost('100.122.110.124:3225')).toBe('http://100.122.110.124:3225');
    expect(resolveOriginForHost('localhost:3225')).toBe(CANONICAL);
  });

  it('refuses to resolve an origin for an untrusted host', async () => {
    setOrigins(CANONICAL, 'http://100.122.110.124:3225');

    const { resolveOriginForHost, isAllowedHost } = await loadModule();
    // This is the CSRF bypass the allowlist exists to prevent: a spoofed Host
    // must never yield an expected origin the attacker also controls.
    expect(resolveOriginForHost('evil.com')).toBeNull();
    expect(resolveOriginForHost(null)).toBeNull();
    expect(isAllowedHost('evil.com')).toBe(false);
    expect(isAllowedHost('45.30.217.57:3225')).toBe(false);
  });

  it('reports each configured host as allowed', async () => {
    setOrigins(CANONICAL, 'http://192.168.1.152:3225 http://45.30.217.57:3225');

    const { isAllowedHost } = await loadModule();
    expect(isAllowedHost('localhost:3225')).toBe(true);
    expect(isAllowedHost('192.168.1.152:3225')).toBe(true);
    expect(isAllowedHost('45.30.217.57:3225')).toBe(true);
    expect(isAllowedHost('192.168.1.152:9999')).toBe(false);
  });

  it('hands the whole allowlist to Socket.IO CORS', async () => {
    setOrigins(CANONICAL, 'http://100.122.110.124:3225');

    const { getSocketCorsOrigins } = await loadModule();
    expect(getSocketCorsOrigins()).toEqual([CANONICAL, 'http://100.122.110.124:3225']);
  });

  it('derives the Secure cookie flag from the canonical scheme', async () => {
    setTestEnv({ NEXT_PUBLIC_APP_URL: 'https://band.example.org' });
    setCookieSecure(undefined);
    expect((await loadModule()).shouldUseSecureCookies()).toBe(true);

    setTestEnv({ NEXT_PUBLIC_APP_URL: 'http://45.30.217.57:3225' });
    setCookieSecure(undefined);
    // A Secure cookie is discarded on a plain-http origin, so it must be off.
    expect((await loadModule()).shouldUseSecureCookies()).toBe(false);
  });

  it('lets an explicit COOKIE_SECURE override scheme detection', async () => {
    setTestEnv({ NEXT_PUBLIC_APP_URL: 'https://band.example.org' });
    setCookieSecure(false);
    expect((await loadModule()).shouldUseSecureCookies()).toBe(false);
  });
});