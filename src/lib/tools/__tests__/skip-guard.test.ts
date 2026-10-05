/**
 * The no-skipped-tests release gate must actually scan the repository.
 *
 * This exists because the gate was a silent no-op: its root path resolved to the
 * parent of the repo, the scan threw on the (nonexistent) directories, the error
 * was swallowed, and it exited 0 — a false green that reported success while
 * checking nothing. These tests fail if that regression returns.
 *
 * Note: the offending source snippets are assembled from fragments at runtime so
 * that this test file does not itself trip the gate it is testing.
 */
import { promises as fs, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ROOT, findSkips, FILE_GLOBS, type SkipFinding } from '@/lib/tools/skip-guard';

const TOK_SKIP = ['.', 'skip', '('].join('');
const TOK_TODO = ['.', 'todo', '('].join('');

const IT_SKIP = `it${TOK_SKIP}`;
const IT_TODO = `it${TOK_TODO}`;
const DESC_SKIP = `describe${TOK_SKIP}`;

const SKIP_SRC = `${IT_SKIP}'nope', () => {});`;
const TODO_SRC = `${IT_TODO}'later');`;
const DESC_SKIP_SRC = `${DESC_SKIP}'nope', () => {});`;

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skip-guard-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeFixture(relPath: string, contents: string) {
  const full = path.join(tmpDir, relPath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, contents, 'utf8');
  return full;
}

describe('skip-guard', () => {
  it('resolves ROOT to the repository, not its parent', () => {
    // The original bug: ROOT resolved one level too high, so every glob missed.
    expect(path.basename(ROOT)).toBe('eccb.app');
    expect(existsSync(path.join(ROOT, 'src'))).toBe(true);
    expect(existsSync(path.join(ROOT, 'package.json'))).toBe(true);
  });

  it(`finds a ${IT_SKIP} in a fixture tree`, async () => {
    await writeFixture('src/__tests__/thing.test.ts', `${SKIP_SRC}\n`);

    const found = await findSkips(tmpDir, ['src']);

    expect(found).toHaveLength(1);
    expect(found[0].match).toContain(TOK_SKIP);
    expect(found[0].file).toContain('thing.test.ts');
  });

  it(`finds a ${IT_TODO} in a fixture tree`, async () => {
    await writeFixture('src/__tests__/thing.test.ts', `${TODO_SRC}\n`);

    const found = await findSkips(tmpDir, ['src']);

    expect(found).toHaveLength(1);
    expect(found[0].match).toContain(TOK_TODO);
  });

  it(`finds a ${DESC_SKIP}`, async () => {
    await writeFixture('src/thing.test.ts', `${DESC_SKIP_SRC}\n`);

    const found = await findSkips(tmpDir, ['src']);

    expect(found).toHaveLength(1);
  });

  it('reports each offending line once, not once per matching pattern', async () => {
    // A single skipped `it` line matches two patterns; it must still be one finding.
    await writeFixture('src/__tests__/thing.test.ts', `${SKIP_SRC}\n`);

    const found = await findSkips(tmpDir, ['src']);

    expect(found).toHaveLength(1);
  });

  it('returns no findings for a clean tree', async () => {
    await writeFixture(
      'src/__tests__/thing.test.ts',
      "it('works', () => { expect(1).toBe(1); });\n",
    );

    await expect(findSkips(tmpDir, ['src'])).resolves.toEqual([]);
  });

  it('throws rather than reporting success when a scan target is missing', async () => {
    // This is the exact failure mode that produced the false green: the missing
    // directory must be a hard error, never an empty (passing) result.
    await expect(findSkips(tmpDir, ['does-not-exist'])).rejects.toThrow();
  });

  it('scans nested directories', async () => {
    await writeFixture('src/a/b/c/thing.test.ts', `${SKIP_SRC}\n`);

    const found = await findSkips(tmpDir, ['src']);

    expect(found).toHaveLength(1);
  });

  it('reports no skips in the real repository', async () => {
    // Guards against re-introducing skipped tests.
    // Scans the full release-gate surface, including e2e/ and tests/.
    const found = await findSkips(ROOT, FILE_GLOBS);
    const formatted = found.map((f: SkipFinding) => `${f.file}:${f.line} ${f.match}`);
    expect(formatted).toEqual([]);
  });

  it('covers e2e and tests directories, not just src', () => {
    // Playwright specs live in e2e/ and integration specs in tests/. Omitting
    // them previously let a skip there escape the release gate entirely.
    expect(FILE_GLOBS).toContain('e2e');
    expect(FILE_GLOBS).toContain('tests');
  });

  it('detects a real skip inside an e2e fixture directory', async () => {
    await writeFixture('e2e/flows/checkout.spec.ts', `${SKIP_SRC}\n`);

    const found = await findSkips(tmpDir, ['e2e']);

    expect(found).toHaveLength(1);
    expect(found[0].file).toContain('checkout.spec.ts');
  });

  it('ignores skip patterns that appear only inside comments', async () => {
    // Documentation legitimately says things like "we never call test.skip".
    // Treating prose as a skipped test would make the gate unusable.
    await writeFixture(
      'src/notes.ts',
      [
        '/**',
        ' * We never call test.skip / test.fixme here.',
        ' * describe.skip is also avoided.',
        ' */',
        'export const ok = true;',
        '',
      ].join('\n'),
    );

    await expect(findSkips(tmpDir, ['src'])).resolves.toEqual([]);
  });

  it('still detects a real skip on a line that also carries a comment', async () => {
    // Build the token at runtime so this test file does not itself trip the gate.
    const skipCall = ['test', 'skip'].join('.');
    await writeFixture('src/real.test.ts', `${skipCall}('x', () => {}); // because reasons\n`);

    const found = await findSkips(tmpDir, ['src']);

    expect(found).toHaveLength(1);
  });

  it('allows the documented environment-dependent auth setup skip', async () => {
    await writeFixture('e2e/auth.setup.ts', `${SKIP_SRC}\n`);

    await expect(findSkips(tmpDir, ['e2e'])).resolves.toEqual([]);
  });
});
