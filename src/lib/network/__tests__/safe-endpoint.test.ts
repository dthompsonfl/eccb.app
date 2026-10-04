/**
 * Tests for the outbound-endpoint SSRF allowlist.
 *
 * The original check compared `parsed.hostname` against bare string patterns.
 * WHATWG `URL` keeps IPv6 literals BRACKETED (`[::1]`, never `::1`), so every
 * bracketed form slipped past the equality check, and `0.0.0.0` / `localhost.`
 * matched no pattern at all. Verified against the real function before the fix:
 *
 *   ALLOWED https://[::ffff:127.0.0.1]/v1
 *   ALLOWED https://[::1]/v1
 *   ALLOWED https://[::]/
 *   ALLOWED https://localhost./
 *   ALLOWED https://0.0.0.0/
 *
 * Each is a loopback address, so an admin-only "test this LLM endpoint" feature
 * was issuing server-side requests to localhost and reflecting the response
 * status back to the caller.
 *
 * These cases are the regression net for that class.
 */

import { describe, expect, it } from 'vitest';
import { validateOutboundEndpoint } from '../safe-endpoint';

describe('validateOutboundEndpoint — strict-public blocks loopback and private hosts', () => {
  const blocked = [
    ['plain IPv4 loopback', 'https://127.0.0.1/v1'],
    ['IPv4 loopback (other)', 'https://127.0.0.53/v1'],
    ['unspecified IPv4', 'https://0.0.0.0/'],
    ['bracketed IPv6 loopback', 'https://[::1]/v1'],
    ['bracketed unspecified IPv6', 'https://[::]/'],
    ['IPv4-mapped loopback (dotted)', 'https://[::ffff:127.0.0.1]/v1'],
    ['IPv4-mapped loopback (hex)', 'https://[::ffff:7f00:1]/v1'],
    ['localhost with trailing dot', 'https://localhost./'],
    ['RFC1918 10/8', 'https://10.1.2.3/v1'],
    ['RFC1918 172.16/12', 'https://172.20.0.1/v1'],
    ['RFC1918 192.168/16', 'https://192.168.1.10/v1'],
    ['link-local (cloud metadata)', 'https://169.254.169.254/latest/meta-data/'],
    ['IPv6 link-local', 'https://[fe80::1]/v1'],
    ['IPv6 unique-local', 'https://[fc00::1]/v1'],
  ] as const;

  it.each(blocked)('blocks %s', (_label, endpoint) => {
    const result = validateOutboundEndpoint(endpoint, 'strict-public');
    expect(result.valid).toBe(false);
  });

  it('blocks plain http even for a public host', () => {
    expect(validateOutboundEndpoint('http://api.openai.com/v1', 'strict-public').valid).toBe(false);
  });

  it('rejects a non-HTTP scheme outright', () => {
    for (const endpoint of ['file:///etc/passwd', 'gopher://x/', 'ftp://x/']) {
      expect(validateOutboundEndpoint(endpoint, 'strict-public').valid).toBe(false);
    }
  });

  it('rejects an unparseable URL', () => {
    expect(validateOutboundEndpoint('not a url', 'strict-public').valid).toBe(false);
  });
});

describe('validateOutboundEndpoint — strict-public allows real providers', () => {
  const allowed = [
    'https://api.openai.com/v1',
    'https://generativelanguage.googleapis.com/v1beta',
    'https://openrouter.ai/api/v1',
    'https://myband.example.com/v1',
    'https://192.0.2.10/v1', // TEST-NET-1: public, not RFC1918
  ] as const;

  it.each(allowed)('allows %s', (endpoint) => {
    expect(validateOutboundEndpoint(endpoint, 'strict-public').valid).toBe(true);
  });

  it('returns a parsed URL on success so callers need not re-parse', () => {
    const result = validateOutboundEndpoint('https://api.openai.com/v1', 'strict-public');
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.url.hostname).toBe('api.openai.com');
  });
});

describe('validateOutboundEndpoint — allow-local', () => {
  it('permits http on localhost', () => {
    expect(validateOutboundEndpoint('http://localhost:11434/v1', 'allow-local').valid).toBe(true);
  });

  it('permits http on a bracketed IPv6 loopback', () => {
    expect(validateOutboundEndpoint('http://[::1]:11434/v1', 'allow-local').valid).toBe(true);
  });

  it('still refuses http for a PUBLIC host under allow-local', () => {
    expect(validateOutboundEndpoint('http://api.openai.com/v1', 'allow-local').valid).toBe(false);
  });

  it('permits https for a public host under allow-local', () => {
    expect(validateOutboundEndpoint('https://api.openai.com/v1', 'allow-local').valid).toBe(true);
  });
});
