/**
 * Redaction primitives for the GDPR data subject flows.
 *
 * Two distinct jobs live here, and conflating them is the classic mistake:
 *
 *   1. SECRET REDACTION (`SECRET_FIELD_DENYLIST` / `redactSecrets`)
 *      A credential is NEVER the data subject's data. Nobody has a right under
 *      Art. 15/20 to receive their own password hash, a live session token, a
 *      TOTP seed or a push-subscription auth key: handing those back converts
 *      an access request into a credential-disclosure vulnerability. These are
 *      dropped unconditionally, keyed by field NAME, because a value-based
 *      heuristic cannot tell a hash from a name.
 *
 *   2. THIRD-PARTY SCRUBBING (`scrubSerializedPii` / `scrubText`)
 *      Some of our rows legitimately mix the subject's data with somebody
 *      else's — an audit-log payload recording an admin editing a different
 *      member contains that other member's email. The subject has no right to
 *      the other person's contact details, so embedded emails/phones are
 *      masked while the subject's own identifiers survive.
 *
 * Both run as defence in depth: the export builders use explicit `select`
 * clauses that never fetch a secret at all, and the redactor then scrubs the
 * assembled document so a future `include:` added in a hurry cannot silently
 * start shipping credentials.
 */

/**
 * Field names that must never appear in a data export, matched
 * case-insensitively against the KEY of any object in the document.
 *
 * Kept as a flat list (not a prefix/substring match) so that adding a field
 * called `authorisedBy` does not accidentally get redacted, and so a reviewer
 * can read at a glance exactly what is withheld.
 */
export const SECRET_FIELD_DENYLIST: readonly string[] = [
  // Credentials
  'password',
  'passwordhash',
  'passwordhashvalue',
  'newpassword',
  'currentpassword',
  'salt',
  'hash',
  // Session / bearer credentials
  'token',
  'sessiontoken',
  'refreshtoken',
  'accesstoken',
  'idtoken',
  'bearertoken',
  'impersonatetoken',
  // Two-factor material
  'secret',
  'twofactorsecret',
  'backupcodes',
  'totpsecret',
  'otp',
  // Key material
  'apikey',
  'apisecret',
  'secretkey',
  'encryptionkey',
  'privatekey',
  'signingkey',
  // Web push subscription credentials (the browser's addressing + auth secret)
  'p256dh',
  'auth',
  'endpoint',
] as const;

/** Placeholder substituted for any denylisted field. */
export const REDACTED_PLACEHOLDER = '[REDACTED — never disclosed]';

/** True when a field name is on the secret denylist. */
export function isSecretField(key: string): boolean {
  return SECRET_FIELD_DENYLIST.includes(key.toLowerCase());
}

/**
 * Recursively replace every denylisted field with {@link REDACTED_PLACEHOLDER}.
 *
 * Handles plain objects, arrays and primitives. Cycles are impossible in a
 * Prisma result set but are guarded anyway so this is safe to call on any
 * `unknown` — a hostile payload must not hang the export route.
 */
export function redactSecrets(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value as object)) return REDACTED_PLACEHOLDER;
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((entry) => redactSecrets(entry, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSecretField(key) ? REDACTED_PLACEHOLDER : redactSecrets(entry, seen);
  }
  return out;
}

/** Collect every denylisted key present anywhere in a structure (for tests). */
export function findSecretFieldPaths(value: unknown, path = '$'): string[] {
  if (value === null || typeof value !== 'object') return [];
  const hits: string[] = [];
  if (Array.isArray(value)) {
    value.forEach((entry, index) => hits.push(...findSecretFieldPaths(entry, `${path}[${index}]`)));
    return hits;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (isSecretField(key)) {
      hits.push(`${path}.${key}`);
      continue;
    }
    hits.push(...findSecretFieldPaths(entry, `${path}.${key}`));
  }
  return hits;
}

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Deliberately conservative: 7+ digits with optional separators. Matches the
// shapes we actually store (555-123-4567, (555) 123 4567, +15551234567) without
// eating every integer in a payload.
const PHONE_PATTERN = /(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}\b/g;

export const REDACTED_EMAIL_PLACEHOLDER = '[redacted — another person’s email]';
export const REDACTED_PHONE_PLACEHOLDER = '[redacted — another person’s phone]';

/**
 * Mask third-party contact details inside a free-text string, keeping any
 * identifier that belongs to the data subject themselves.
 *
 * Used for `AuditLog.oldValues` / `newValues`, which are serialised JSON blobs
 * that can embed arbitrary PII from whatever record the admin was editing.
 */
export function scrubText(text: string, subjectEmails: readonly (string | null | undefined)[]): string {
  const mine = new Set(
    subjectEmails
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .map((value) => value.toLowerCase()),
  );

  return text
    .replace(EMAIL_PATTERN, (match) => (mine.has(match.toLowerCase()) ? match : REDACTED_EMAIL_PLACEHOLDER))
    .replace(PHONE_PATTERN, (match) => {
      const digits = match.replace(/\D/g, '');
      // Only mask if the number is not the subject's own (11+ digits, incl. CC).
      return mine.has(digits) ? match : REDACTED_PHONE_PLACEHOLDER;
    });
}

/**
 * Scrub a serialised-JSON column (`AuditLog.oldValues` / `newValues`).
 *
 * Masking is applied to the raw string rather than a parsed object on purpose:
 * these columns are `LongText` and may hold JSON that no longer parses after
 * years of schema drift, and a partially-parseable blob still has to be
 * scrubbed. The substitution only removes characters, so valid JSON stays valid.
 */
export function scrubSerializedPii(
  raw: string | null | undefined,
  subjectEmails: readonly (string | null | undefined)[],
): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  return scrubText(raw, subjectEmails);
}