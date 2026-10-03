/**
 * Tests for the canonical-origin resolver.
 *
 * The behaviour that matters here is FAILURE: an unparseable or hostless
 * `NEXT_PUBLIC_APP_URL` must degrade to the dev origin rather than propagate
 * into every canonical tag, OpenGraph URL and sitemap entry on the site. A
 * `metadataBase` of `https:///` or a literal `undefined` string is worse than
 * no metadataBase at all, because it looks configured and is silently wrong.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { absoluteUrl, getSiteUrl, normalizeOrigin } from '@/lib/seo/site-url';

const ORIGIN_KEYS = [
  'NEXT_PUBLIC_APP_URL',
  'NEXT_PUBLIC_SITE_URL',
  'NEXT_PUBLIC_BASE_URL',
  'VERCEL_URL',
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ORIGIN_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ORIGIN_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('normalizeOrigin', () => {
  it('keeps a well-formed origin', () => {
    expect(normalizeOrigin('https://eccb.org')).toBe('https://eccb.org');
  });

  it('strips trailing slashes and any path', () => {
    // A path on the origin is a common .env mistake; the origin is only
    // scheme + host + port.
    expect(normalizeOrigin('https://eccb.org/')).toBe('https://eccb.org');
    expect(normalizeOrigin('https://eccb.org/some/path')).toBe('https://eccb.org');
  });

  it('preserves an explicit port', () => {
    expect(normalizeOrigin('http://localhost:3225')).toBe('http://localhost:3225');
  });

  it('assumes https for a bare host', () => {
    // VERCEL_URL arrives as a bare host, so this path is not hypothetical.
    expect(normalizeOrigin('my-app.vercel.app')).toBe('https://my-app.vercel.app');
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['empty string', ''],
    ['whitespace only', '   '],
    ['not a url at all', 'not a url'],
    ['a bare slash', '/'],
  ])('rejects %s', (_label, value) => {
    expect(normalizeOrigin(value as string | undefined | null)).toBeNull();
  });

  it('rejects a non-http protocol', () => {
    expect(normalizeOrigin('javascript:alert(1)')).toBeNull();
    expect(normalizeOrigin('ftp://example.com')).toBeNull();
  });
});

describe('getSiteUrl', () => {
  it('prefers NEXT_PUBLIC_APP_URL, the value the rest of the app already uses', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://eccb.org';
    process.env.NEXT_PUBLIC_SITE_URL = 'https://other.example';
    expect(getSiteUrl()).toBe('https://eccb.org');
  });

  it('falls through to the next source when the preferred one is malformed', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'ht!tp://bad url';
    process.env.NEXT_PUBLIC_SITE_URL = 'https://fallback.example';
    expect(getSiteUrl()).toBe('https://fallback.example');
  });

  it('falls back to the dev origin when nothing is configured', () => {
    expect(getSiteUrl()).toBe('http://localhost:3225');
  });

  it('never returns a non-absolute value, whatever the env says', () => {
    // The invariant the whole module exists to protect: no consumer ever has to
    // defend against a relative or unparseable base.
    for (const bad of ['', '   ', 'nope', '//']) {
      process.env.NEXT_PUBLIC_APP_URL = bad;
      const result = getSiteUrl();
      expect(() => new URL(result)).not.toThrow();
    }
  });
});

describe('absoluteUrl', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://eccb.org';
  });

  it('joins with exactly one slash', () => {
    expect(absoluteUrl('/about')).toBe('https://eccb.org/about');
    expect(absoluteUrl('about')).toBe('https://eccb.org/about');
  });

  it('does not double the slash for the root path', () => {
    expect(absoluteUrl('/')).toBe('https://eccb.org');
  });

  it('produces a parseable absolute URL for every input shape', () => {
    for (const p of ['/', '/about', 'about', '/events/abc']) {
      expect(() => new URL(absoluteUrl(p))).not.toThrow();
    }
  });
});
