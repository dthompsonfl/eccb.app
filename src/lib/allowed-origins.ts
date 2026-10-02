/**
 * Allowed Origin Resolution — single source of truth
 *
 * The platform is reachable on more than one network interface: loopback, the
 * LAN address, a Tailscale address, and (behind port forwarding) a public IP.
 * Browsers send `Origin: <scheme>://<host>:<port>` on every state-changing
 * request, and both Better Auth and the app's own CSRF guard reject requests
 * whose origin is not explicitly trusted. Configuring a single
 * `NEXT_PUBLIC_APP_URL` therefore locks out every interface except one — the
 * symptom being a login that submits and immediately bounces.
 *
 * This module resolves the full trusted set once so every consumer agrees:
 *
 *   - `getAllowedOrigins()`   → Better Auth `trustedOrigins`
 *   - `isAllowedHost()`       → CSRF host pinning in `lib/csrf.ts`
 *   - `getSocketCorsOrigins()`→ Socket.IO CORS
 *   - `shouldUseSecureCookies()` → cookie `Secure` flag
 *
 * Security posture is unchanged: the set is an explicit allowlist, never
 * "trust whatever the Host header claims". A request whose `Host` is not in
 * the list is still rejected.
 *
 * Cookie domain is deliberately NOT set. The reachable hosts are unrelated
 * names (localhost, a LAN IP, a Tailscale IP, a public IP) with no common
 * registrable parent, so host-only cookies are the only form that works
 * everywhere — and host-only is also the tighter default.
 */

import { env } from '@/lib/env';

/** Parsed, validated origin (always `scheme://host[:port]`, no trailing slash). */
export type AllowedOrigin = string;

function normalizeOrigin(raw: string): AllowedOrigin | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    // `URL.origin` already strips any path, query, hash and trailing slash.
    return url.origin;
  } catch {
    return null;
  }
}

let cached: readonly AllowedOrigin[] | null = null;

/**
 * Every origin this deployment answers on, most-specific first.
 *
 * Sources, in order:
 *   1. `NEXT_PUBLIC_APP_URL` — the canonical/primary origin.
 *   2. `ALLOWED_ORIGINS` — comma or whitespace separated additional origins.
 *
 * Invalid entries are dropped rather than throwing: a typo in a convenience
 * variable must not prevent the app from booting on the canonical origin.
 */
export function getAllowedOrigins(): readonly AllowedOrigin[] {
  if (cached) return cached;

  const collected: AllowedOrigin[] = [];
  const push = (value: string | undefined): void => {
    if (!value) return;
    const normalized = normalizeOrigin(value);
    if (normalized && !collected.includes(normalized)) {
      collected.push(normalized);
    }
  };

  push(env.NEXT_PUBLIC_APP_URL);

  for (const entry of (env.ALLOWED_ORIGINS ?? '').split(/[\s,]+/)) {
    push(entry);
  }

  cached = Object.freeze(collected);
  return cached;
}

/** Host (with port) of every allowed origin — the CSRF host-pinning set. */
export function getAllowedHosts(): ReadonlySet<string> {
  return new Set(getAllowedOrigins().map((origin) => new URL(origin).host));
}

/**
 * True when `host` (a `Host` header value, e.g. `100.122.110.124:3225`) is one
 * of the configured origins.
 *
 * This is what keeps the CSRF check safe while allowing several hosts: the
 * expected origin is derived from the *allowlist*, never from the request.
 */
export function isAllowedHost(host: string | null): boolean {
  if (!host) return false;
  return getAllowedHosts().has(host);
}

/**
 * Resolve the origin a request may legitimately claim, given its `Host`.
 *
 * Returns `null` for unknown hosts — callers must treat that as a rejection.
 */
export function resolveOriginForHost(host: string | null): AllowedOrigin | null {
  if (!host) return null;
  return getAllowedOrigins().find((origin) => new URL(origin).host === host) ?? null;
}

/** Origins permitted for Socket.IO CORS. */
export function getSocketCorsOrigins(): AllowedOrigin[] | '*' {
  const origins = [...getAllowedOrigins()];
  // A wildcard CORS origin combined with `credentials: true` is rejected by
  // browsers and would be unsafe anyway. Fall back to the canonical origin so
  // the handshake still succeeds for same-origin clients.
  return origins.length > 0 ? origins : [env.NEXT_PUBLIC_APP_URL];
}

/**
 * Whether session cookies should carry the `Secure` attribute.
 *
 * Derived from the canonical origin's scheme rather than `NODE_ENV`: a
 * `Secure` cookie is discarded by the browser on a plain-`http://` origin, so
 * keying off `NODE_ENV` alone silently breaks authentication for every
 * HTTP-only deployment. An explicit `COOKIE_SECURE` always wins.
 */
export function shouldUseSecureCookies(): boolean {
  if (typeof env.COOKIE_SECURE === 'boolean') return env.COOKIE_SECURE;
  try {
    return new URL(env.NEXT_PUBLIC_APP_URL).protocol === 'https:';
  } catch {
    return env.NODE_ENV === 'production';
  }
}

/** Test seam: forces the next `getAllowedOrigins()` call to re-read the env. */
export function resetAllowedOriginsCache(): void {
  cached = null;
}