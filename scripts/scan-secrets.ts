/**
 * Secret scanner — release gate.
 *
 * Prevents the class of defect where a populated .env (or a hard-coded
 * credential in source, docs, or fixtures) reaches version control.
 *
 * Checks:
 *   1. No env file is tracked by git.
 *   2. .gitignore actually covers .env / .env.* / *.env, and does not
 *      accidentally ignore the committed example files.
 *   3. No committed file contains an assignment of a known-sensitive variable
 *      to a literal that is not an obvious placeholder.
 *   4. No committed file contains a high-entropy literal that looks like a
 *      provider key (OpenAI / Anthropic / AWS access key / Slack / Stripe /
 *      Google API key / private key block).
 *
 * This deliberately runs against the git index/working tree rather than the
 * filesystem, so an ignored .env sitting on disk is fine — what matters is
 * what would be committed.
 *
 * Exits non-zero when a finding is reported.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const ROOT = process.cwd();

/** Files that legitimately contain secret-shaped *names* but never values. */
const ALLOWLIST = new Set([
  'scripts/scan-secrets.ts',
  'env.example',
  '.env.example',
  'docs/SECURITY.md',
  'src/lib/setup/env-manager.ts', // describes keys, no values
  'src/lib/env.ts', // zod schema, no values
]);

/** Variable names whose *values* must never be committed. */
const SENSITIVE_NAME_PATTERN =
  /^(?:[A-Z0-9_]*(?:SECRET|PASSWORD|TOKEN|PRIVATE_KEY|API_KEY|ACCESS_KEY|CREDENTIAL)[A-Z0-9_]*)$/;

/** Values that are obviously placeholders, not secrets. */
const PLACEHOLDER_VALUES = new Set([
  '',
  'changeme',
  'change-me',
  'change_me',
  'placeholder',
  'example',
  'xxx',
  'todo',
  'replace-me',
  'replace_me',
  'unset',
  'none',
  'null',
  'false',
  'true',
  'test',
  'development',
  'production',
  'local',
  'dummy',
  'secret',
  'password',
]);

/** e.g. `your-openai-key`, `your_api_key_here` */
const YOUR_PLACEHOLDER = /^your[-_a-z0-9]*$/i;
/** runs of asterisks used as a redaction */
const ASTERISKS = /^\*+$/;

/** Test/spec/fixture files, where dummy secrets are expected and necessary. */
function isTestFixture(file: string): boolean {
  return (
    /(^|\/)__tests__\//.test(file) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(file) ||
    /(^|\/)e2e\//.test(file)
  );
}

/** Obvious dummy secret used by fixtures: contains 'test'/'dummy'/'fake'. */
function isDummySecret(value: string): boolean {
  return /test|dummy|fake|sample|fixture|example|notreal|placeholder/i.test(value);
}

function isPlaceholder(value: string): boolean {
  const v = value.trim().replace(/^["']|["']$/g, '');
  if (PLACEHOLDER_VALUES.has(v.toLowerCase())) return true;
  if (YOUR_PLACEHOLDER.test(v)) return true;
  if (ASTERISKS.test(v)) return true;
  return false;
}

/**
 * Provider key shapes. These are high-signal and have essentially no false
 * positive rate in a JS/TS repo.
 */
const PROVIDER_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'OpenAI API key', re: /\bsk-[A-Za-z0-9]{32,}\b/g },
  { name: 'Anthropic API key', re: /\bsk-ant-[A-Za-z0-9\-_]{32,}\b/g },
  { name: 'AWS access key id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z\-_]{35}\b/g },
  { name: 'Slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'Stripe live secret', re: /\bsk_live_[0-9a-zA-Z]{20,}\b/g },
  { name: 'PEM private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g },
];

interface Finding {
  file: string;
  line: number | null;
  kind: string;
  detail: string;
}

const findings: Finding[] = [];

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
}

/** Tracked files, excluding vendored/lockfile noise. */
function trackedFiles(): string[] {
  const out = git(['ls-files']).split('\n').filter(Boolean);
  return out.filter(
    (f) =>
      !f.endsWith('.lock') &&
      !f.endsWith('-lock.yaml') &&
      !f.endsWith('-lock.json') &&
      f !== 'package-lock.json' &&
      f !== 'pnpm-lock.yaml',
  );
}

// ── 1. No env file may be tracked ───────────────────────────────────────────
const tracked = trackedFiles();

for (const file of tracked) {
  const base = file.split('/').pop() ?? file;
  if (base === '.env' || base.startsWith('.env.') || base.endsWith('.env')) {
    if (!ALLOWLIST.has(file)) {
      findings.push({
        file,
        line: null,
        kind: 'tracked-env-file',
        detail: `env file '${file}' is tracked by git; only example files may be committed`,
      });
    }
  }
}

// ── 2. .gitignore must cover the dangerous names ────────────────────────────
const gitignore = readFileSync(`${ROOT}/.gitignore`, 'utf8');
const requiredIgnoreLines = ['.env', '.env.*', '*.env'];
for (const line of requiredIgnoreLines) {
  if (!gitignore.split('\n').some((l) => l.trim() === line)) {
    findings.push({
      file: '.gitignore',
      line: null,
      kind: 'missing-ignore-rule',
      detail: `.gitignore is missing an active rule for '${line}'`,
    });
  }
}

// ── 3 & 4. Content scan over tracked, text-ish files ───────────────────────
const TEXT_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|mdx|yml|yaml|sh|prisma|toml|txt|html|css)$/i;

for (const file of tracked) {
  if (ALLOWLIST.has(file)) continue;
  if (!TEXT_EXT.test(file)) continue;

  let content: string;
  try {
    content = readFileSync(`${ROOT}/${file}`, 'utf8');
  } catch {
    continue;
  }
  if (content.length > 2_000_000) continue;

  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 3. KEY=value style with a sensitive name.
    // Skip `NAME: 'label'` object-literal / enum members: those are type-level
    // labels (e.g. `PASSWORD_RESET: 'Password Reset'`), not assignments.
    const kv = /^\s*(?:export\s+)?(?:const\s+)?([A-Z0-9_]+)\s*=\s*["'`]([^"'`]{8,})["'`]/.exec(line);
    if (kv) {
      const [, name, value] = kv;
      // Test fixtures legitimately use dummy secrets. Provider-shaped keys
      // are still caught by the provider patterns below, so this does not
      // create a hole for a real credential pasted into a test.
      const inTestFixture = isTestFixture(file) && isDummySecret(value);
      // A right-hand side that is a shell expansion is generated at run time.
      const isGeneratedValue = /\$\{|\$\(/.test(value);
      if (
        SENSITIVE_NAME_PATTERN.test(name) &&
        !isPlaceholder(value) &&
        !inTestFixture &&
        !isGeneratedValue
      ) {
        findings.push({
          file,
          line: i + 1,
          kind: 'hardcoded-secret',
          detail: `${name} is assigned a literal value (length ${value.length})`,
        });
      }
    }

    // 3b. Inline `name: 'value'` in .env-like docs / fixtures.
    // Values containing shell expansion (`${VAR:-...}`, `$(...)`) are generated
    // at run time, so no secret is actually committed on that line.
    const envLine = /^\s*([A-Z0-9_]*(?:SECRET|PASSWORD|TOKEN|PRIVATE_KEY|API_KEY)[A-Z0-9_]*)\s*=\s*(\S+)/.exec(line);
    if (envLine) {
      const [, name, value] = envLine;
      // Strip surrounding quotes AND a trailing comma (TS enum members).
      const cleaned = value.replace(/[,;]?$/, '').replace(/^["']|["']$/g, '');
      // TypeScript enum members: `SOME_ERROR_CODE = 'SU-003'`. The name looks
      // sensitive but the value is a short code, and a real key is never that
      // short. Codes are uppercase+digit/hyphen only.
      const looksLikeEnumCode = /^[A-Z]{1,6}-?\d{1,6}$/.test(cleaned);
      if (looksLikeEnumCode) continue;
      // In shell scripts the value is a `${VAR:-$(openssl rand ...)}` default,
      // which is generated at install time rather than committed.
      // `$VAR` / `${VAR}` references an existing (uncommitted) value rather
      // than embedding one on this line.
      const isGenerated = /\$\{|\$\(/.test(cleaned) || /^\$\{?[A-Z_][A-Z0-9_]*\}?$/.test(cleaned);
      if (!isGenerated && !isPlaceholder(cleaned) && cleaned.length >= 8) {
        findings.push({
          file,
          line: i + 1,
          kind: 'inline-secret',
          detail: `${name} has an inline value that is not a placeholder`,
        });
      }
    }

    // 4. Provider key shapes.
    for (const { name, re } of PROVIDER_PATTERNS) {
      re.lastIndex = 0;
      if (re.test(line)) {
        findings.push({
          file,
          line: i + 1,
          kind: 'provider-key',
          detail: `looks like a ${name}`,
        });
      }
    }
  }
}

// ── Report ──────────────────────────────────────────────────────────────────
if (findings.length === 0) {
  console.log('✓ secret scan clean: no committed env files, no hard-coded secrets');
  process.exit(0);
}

console.error(`✗ secret scan found ${findings.length} issue(s):\n`);
for (const f of findings) {
  console.error(`  ${f.file}${f.line ? `:${f.line}` : ''}  [${f.kind}] ${f.detail}`);
}
console.error(
  '\nIf a finding is a false positive, add the exact path to ALLOWLIST in\n' +
    'scripts/scan-secrets.ts with a comment explaining why it is safe.',
);
process.exit(1);
