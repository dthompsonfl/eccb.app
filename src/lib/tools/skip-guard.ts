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

export const FILE_GLOBS = ['src', 'scripts'];

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
      for (let i = 0; i < lines.length; i++) {
        for (const pat of SKIP_PATTERNS) {
          if (pat.test(lines[i])) {
            const match = lines[i].trim();
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
