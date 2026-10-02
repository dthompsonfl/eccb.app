import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getPdfSourceInfo } from '../pdf-source';
import { validatePdfBuffer } from '../pdf-splitter';

/**
 * Committed, deterministic PDF fixtures. These are version-controlled on purpose:
 * a fixture directory that is empty on a fresh clone makes this test vacuously
 * pass (it returns before asserting anything), which is how it was previously
 * parked as a permanently-skipped test.
 */
const FIXTURES_DIR = path.join(
  process.cwd(),
  'src',
  'lib',
  'services',
  '__tests__',
  'fixtures',
);

/** Optional developer drop-zone. When empty it is simply not exercised. */
const TEST_MUSIC_DIR = path.join(process.cwd(), 'storage', 'test_music');

async function collectFixturePdfs(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      return [];
    }
    throw err;
  }
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFixturePdfs(entryPath)));
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.pdf')) {
      files.push(entryPath);
    }
  }

  return files.sort();
}

/**
 * Fixtures known to be structurally valid. The intentionally-broken fixtures in
 * the same directory (truncated / damaged-xref) are exercised by the splitter's
 * own validation tests and must NOT be asserted valid here.
 */
const VALID_FIXTURES = [
  'valid-three-page.pdf',
  'valid-mixed-geometry.pdf',
  'valid-rotated.pdf',
];

describe('pdf-source fixture coverage', () => {
  it('derives non-zero page counts for committed valid fixtures', async () => {
    const committed = VALID_FIXTURES.map((name) => path.join(FIXTURES_DIR, name));
    expect(committed.length).toBeGreaterThan(0);

    for (const fixturePath of committed) {
      const pdfBuffer = await readFile(fixturePath);
      const validation = await validatePdfBuffer(pdfBuffer);
      const sourceInfo = await getPdfSourceInfo(pdfBuffer);

      expect(validation.valid, `${path.basename(fixturePath)} should be valid`).toBe(true);
      expect(validation.pageCount, `${path.basename(fixturePath)} page count`).toBeGreaterThan(0);
      expect(sourceInfo.pageCount, `${path.basename(fixturePath)} source page count`).toBeGreaterThan(0);
      expect(['pdf-lib', 'pdfjs']).toContain(sourceInfo.parser);
    }
  });

  it('agrees on page count between the validator and the source parser', async () => {
    // A disagreement between the two parsers is a real defect: the splitter and
    // the OMR/render path must not disagree about how long a score is.
    const all = (await collectFixturePdfs(FIXTURES_DIR)).filter((p) =>
      VALID_FIXTURES.includes(path.basename(p)),
    );

    expect(all.length).toBe(VALID_FIXTURES.length);

    for (const fixturePath of all) {
      const pdfBuffer = await readFile(fixturePath);
      const validation = await validatePdfBuffer(pdfBuffer);
      const sourceInfo = await getPdfSourceInfo(pdfBuffer);
      expect(sourceInfo.pageCount).toBe(validation.pageCount);
    }
  });

  it('derives non-zero page counts for developer-supplied storage/test_music PDFs', async () => {
    // Developer-only drop-zone. Unlike before, this no longer hides the real
    // coverage: the committed-fixture tests above run unconditionally.
    const fixtureFiles = (await collectFixturePdfs(TEST_MUSIC_DIR)).slice(0, 8);

    for (const fixturePath of fixtureFiles) {
      const pdfBuffer = await readFile(fixturePath);
      const validation = await validatePdfBuffer(pdfBuffer);
      const sourceInfo = await getPdfSourceInfo(pdfBuffer);

      expect(validation.valid, `${fixturePath} should be valid`).toBe(true);
      expect(validation.pageCount).toBeGreaterThan(0);
      expect(sourceInfo.pageCount).toBeGreaterThan(0);
      expect(['pdf-lib', 'pdfjs']).toContain(sourceInfo.parser);
    }
  });
});
