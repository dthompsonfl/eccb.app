/**
 * Canonical public origin for absolute URLs (sitemap, robots, OpenGraph, OG
 * images, canonical links).
 *
 * WHY THIS EXISTS
 * ---------------
 * Next.js requires `metadataBase` for any relative URL it has to absolutise
 * (OpenGraph images, canonical alternates, sitemap entries). Without it Next
 * logs a warning and emits `http://localhost:3000`, which is wrong in
 * production and actively harmful for SEO — a canonical pointing at localhost
 * tells a crawler the real site does not exist.
 *
 * RESOLUTION ORDER
 * ----------------
 *   1. `NEXT_PUBLIC_APP_URL` — the project's existing canonical origin. It is
 *      already used for OpenGraph in the root layout and by
 *      `src/lib/auth/allowed-origins.ts`, so this helper stays consistent with
 *      the value the rest of the app already trusts.
 *   2. `NEXT_PUBLIC_SITE_URL` / `NEXT_PUBLIC_BASE_URL` — honoured as overrides so
 *      a deployment can point SEO metadata at a different host (e.g. a custom
 *      marketing domain in front of the app).
 *   3. `VERCEL_URL` — supplied automatically on Vercel deployments.
 *   4. A localhost fallback — correct for `next dev`.
 *
 * The value is validated: a URL that will not parse, or that carries no host,
 * is rejected rather than propagated into every canonical tag on the site.
 */

const DEFAULT_DEV_ORIGIN = 'http://localhost:3225';

/**
 * Parse and validate a candidate origin.
 *
 * Returns the normalised origin (`scheme://host[:port]`, no trailing slash) or
 * null when the input is unusable. Rejecting is important: a malformed value
 * should degrade to the next fallback, not emit `https:///` into a canonical tag.
 */
export function normalizeOrigin(value: string | undefined | null): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  // Tolerate a bare host ("example.com") as well as a full URL, because that is
  // a very common way to get this wrong in an .env file.
  //
  // Guard against a value that LOOKS like it carries a scheme but is malformed —
  // `ht!tp://bad url` contains `://` yet is not a valid scheme. Such a value must
  // be rejected outright: prefixing it with `https://` would parse as a hostname
  // of "ht!tp" and pass validation, silently yielding a nonsense origin.
  const looksSchemed = trimmed.includes('://');
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  if (looksSchemed && !hasScheme) return null;
  if (hasScheme && !/^https?:\/\//i.test(trimmed)) return null;

  const candidate = hasScheme ? trimmed : `https://${trimmed}`;

  try {
    const url = new URL(candidate);
    if (!url.hostname) return null;
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    // A hostname with no dot and no port is almost certainly a mangled value
    // ("ht!tp", "not a url") rather than a real intranet host. Reject it instead
    // of publishing it as the site's canonical origin.
    const isLocalhost = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    const hasPort = url.port !== '';
    if (!isLocalhost && !hasPort && !url.hostname.includes('.')) return null;
    // Strip any path/query/hash: the origin is only scheme + host + port.
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * The canonical public origin. Always returns a usable absolute origin.
 */
export function getSiteUrl(): string {
  const fromEnv =
    normalizeOrigin(process.env.NEXT_PUBLIC_APP_URL) ??
    normalizeOrigin(process.env.NEXT_PUBLIC_SITE_URL) ??
    normalizeOrigin(process.env.NEXT_PUBLIC_BASE_URL) ??
    // VERCEL_URL is a bare host (e.g. "my-app.vercel.app"), so it gets https.
    normalizeOrigin(process.env.VERCEL_URL);

  return fromEnv ?? DEFAULT_DEV_ORIGIN;
}

/**
 * Absolute URL for a site-relative path.
 *
 * Always returns a leading-slash path with exactly one joining slash, so
 * `absoluteUrl('/about')` and `absoluteUrl('about')` behave identically and
 * never produce `https://example.com//about`.
 */
export function absoluteUrl(path: string): string {
  const base = getSiteUrl();
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${base}${suffix === '/' ? '' : suffix}`;
}
