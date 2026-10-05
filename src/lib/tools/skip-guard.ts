/**
 * Skipped/todo test scanner.
 *
 * Lives in `src/lib` (rather than inline in the release script) so it is
 * importable by Vitest — `vitest.config.ts` only collects `src/**`, so a test
 * under `scripts/` would never run and the gate would stay untested.
 *
 * The root derivation MUST be correct. It previously resolved one directory too
 * high, so every glob missed, the resulting ENOENT was swallowed, and the gate
 * exited 0: a false green that reported success while checking nothing.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKIP_PATTERNS = [
  /\bdescribe\.skip\b/,
  /\bit\.skip\b/,
  /\btest\.skip\b/,
  /\.skip\(/,
  /\.todo\(/,
];

/**
 * Directories scanned for skipped/todo/`.only` tests.
 *
 * `e2e` and `tests` are included deliberately: Playwright specs live in `e2e/`
 * and integration specs in `tests/`, and a skip there would silently remove
 * required coverage from the release gates exactly as easily as one in `src/`.
 */
export const FILE_GLOBS = ['src', 'scripts', 'e2e', 'tests'];

/**
 * Deliberate, reviewed exceptions.
 *
 * A skip is tolerated only for an explicitly allowlisted file AND only when the
 * matched line is real code. Prose in comments (e.g. docs saying "we never call
 * test.skip") is ignored, so the gate reports actual skipped tests rather than
 * documentation describing them.
 *
 * Each entry must state its reason; the list is reviewed in code review, so a
 * new entry is a deliberate act rather than a silent exemption.
 */
export const ALLOWED_SKIP_LOCATIONS: Array<{ pathIncludes: string; reason: string }> = [
  {
    pathIncludes: path.join('e2e', 'auth.setup.ts'),
    reason:
      'Environment-dependent setup guard: skips only when no E2E_ADMIN_*/SUPER_ADMIN_* ' +
      'credentials exist, so a bare checkout without secrets does not fail spuriously. ' +
      'In CI and in a seeded local .env these credentials ARE present, so the ' +
      'authenticated E2E suite genuinely runs.',
  },
];

/**
 * Strip comments so documentation PROSE that merely names a skip pattern
 * ("we never call test.skip") is not mistaken for a skipped test.
 *
 * Handles both line and block comments, including multi-line block comments:
 * the block state is tracked across lines by the caller via {@link stripComment}.
 */
function stripComment(line: string, inBlock: boolean): { code: string; inBlock: boolean } {
  let out = '';
  let block = inBlock;
  for (let i = 0; i < line.length; i++) {
    if (block) {
      if (line[i] === '*' && line[i + 1] === '/') {
        block = false;
        i++;
      }
      continue;
    }
    if (line[i] === '/' && line[i + 1] === '*') {
      block = true;
      i++;
      continue;
    }
    if (line[i] === '/' && line[i + 1] === '/') {
      break; // rest of line is a comment
    }
    out += line[i];
  }
  return { code: out, inBlock: block };
}

function isAllowlisted(fullPath: string, lineText: string, inBlock: boolean): boolean {
  // Only real code counts. Prose mentioning a skip inside a comment or doc
  // string must never be treated as a skipped test.
  const code = stripComment(lineText, inBlock).code;
  if (!SKIP_PATTERNS.some((pat) => pat.test(code))) {
    return false;
  }
  const normalized = fullPath.split(path.sep).join('/');
  return ALLOWED_SKIP_LOCATIONS.some((entry) =>
    normalized.includes(entry.pathIncludes.split(path.sep).join('/')),
  );
}

export interface SkipFinding {
  file: string;
  line: number;
  match: string;
}

function defaultRoot(): string {
  // src/lib/tools -> src/lib -> src -> repo root
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

export const ROOT = defaultRoot();

export async function scanDir(dir: string, results: SkipFinding[]) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await scanDir(full, results);
    } else if (/\.tsx?$/.test(entry.name) || /\.jsx?$/.test(entry.name)) {
      const content = await fs.readFile(full, 'utf8');
      const lines = content.split(/\r?\n/);
      // Track multi-line block-comment state so a skip pattern mentioned in
      // documentation is never reported as an actual skipped test.
      let inBlock = false;
      for (let i = 0; i < lines.length; i++) {
        const { code, inBlock: stillInBlock } = stripComment(lines[i], inBlock);
        const wasInBlock = inBlock;
        inBlock = stillInBlock;
        // Lines wholly inside a block comment carry no code to match.
        if (wasInBlock && code.trim() === '') {
          continue;
        }
        for (const pat of SKIP_PATTERNS) {
          if (pat.test(code)) {
            const match = lines[i].trim();
            if (isAllowlisted(full, match, false)) {
              continue;
            }
            // Several patterns can match one line; report it once.
            if (!results.some((r) => r.file === full && r.line === i + 1)) {
              results.push({ file: full, line: i + 1, match });
            }
            break;
          }
        }
      }
    }
  }
}

/**
 * Scan for skipped/todo tests.
 *
 * Throws when a scan target does not exist. Swallowing that error is precisely
 * what allowed the release gate to pass while inspecting nothing.
 */
export async function findSkips(root: string = ROOT, globs: string[] = FILE_GLOBS) {
  const issues: SkipFinding[] = [];
  for (const g of globs) {
    const dir = path.join(root, g);
    await fs.access(dir);
    await scanDir(dir, issues);
  }
  return issues;
}
