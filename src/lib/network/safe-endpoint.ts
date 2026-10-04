type EndpointPolicy = 'strict-public' | 'allow-local';

const PRIVATE_IPV4_PATTERNS = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
 /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^192\.168\./,
];

function isPrivateOrLoopbackHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  if (!normalized) return true;

  // WHATWG URL keeps IPv6 literals bracketed in `hostname`, so `[::1]` here
  // does NOT equal `'::1'`. Comparing against the bare form silently misses
  // every bracketed literal.
  const unbracketed = normalized.startsWith('[') && normalized.endsWith(']')
    ? normalized.slice(1, -1)
    : normalized;

  // A single trailing dot is legal and resolves to the same host, so
  // `localhost.` must be treated as `localhost`.
  const withoutTrailingDot = unbracketed.endsWith('.') ? unbracketed.slice(0, -1) : unbracketed;

  if (withoutTrailingDot === 'localhost' || withoutTrailingDot === '::1') {
    return true;
  }

  // `0.0.0.0` (and its IPv6-mapped equivalent) routes to localhost on most
  // stacks. It is not covered by the 10./127./172./192. patterns below.
  if (withoutTrailingDot === '0.0.0.0' || withoutTrailingDot === '::') {
    return true;
  }

  // IPv4-mapped / IPv4-compatible IPv6 (`::ffff:127.0.0.1`) reaches loopback
  // while looking like an unrelated IPv6 address. Node normalises the dotted
  // tail to hex (`[::ffff:7f00:1]`), so match both spellings and also peel the
  // embedded IPv4 out for the patterns below.
  const mappedMatch = withoutTrailingDot.match(/^::(?:ffff:)?(?:0{0,4}:)?([\da-f]{1,4}):([\da-f]{1,4})$/i);
  if (mappedMatch) {
    const high = parseInt(mappedMatch[1] as string, 16);
    // Any address in 0.0.0.0/8 or 127.0.0.0/8 mapped into IPv6 space.
    if (high === 0) return true;
    if ((high & 0xff00) === 0x7f00) return true;
  }
  if (withoutTrailingDot.startsWith('::ffff:127.') || withoutTrailingDot.startsWith('::ffff:7f')) {
    return true;
  }

  if (PRIVATE_IPV4_PATTERNS.some((pattern) => pattern.test(withoutTrailingDot))) {
    return true;
  }

  // Unique-local (fc00::/7) and link-local (fe80::/10) IPv6.
  if (/^f[cd]/.test(withoutTrailingDot) || withoutTrailingDot.startsWith('fe80:')) {
    return true;
  }

  return false;
}

export function validateOutboundEndpoint(
  rawEndpoint: string,
  policy: EndpointPolicy = 'strict-public'
): { valid: true; url: URL } | { valid: false; error: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawEndpoint);
  } catch {
    return { valid: false, error: 'Endpoint must be a valid URL.' };
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { valid: false, error: 'Only HTTP(S) endpoints are allowed.' };
  }

  const isLocal = isPrivateOrLoopbackHost(parsed.hostname);

  if (policy === 'strict-public') {
    if (parsed.protocol !== 'https:') {
      return { valid: false, error: 'Endpoint must use HTTPS.' };
    }
    if (isLocal) {
      return { valid: false, error: 'Private, loopback, and localhost endpoints are not allowed.' };
    }
  } else if (policy === 'allow-local') {
    if (parsed.protocol === 'http:' && !isLocal) {
      return { valid: false, error: 'HTTP endpoints are only allowed for localhost or private network hosts.' };
    }
  }

  return { valid: true, url: parsed };
}
