#!/usr/bin/env node

import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const sourcePath = require.resolve('pdfjs-dist/build/pdf.worker.min.mjs');
const targetPath = resolve(process.cwd(), 'public', 'pdf.worker.min.mjs');

/**
 * Read the PDF.js version from the worker bundle.
 *
 * The worker is minified, so the version appears in the license-header COMMENT
 * as `pdfjsVersion = 5.5.207` — with no quotes. A regex that required quotes
 * (the form used by the unminified build) never matched and this script threw,
 * which broke `predev`, `prebuild` and `prestart`.
 *
 * Falls back to the package's own package.json, which is authoritative, if the
 * banner is ever absent.
 */
async function extractPdfJsVersion(source, sourcePath) {
  const banner = source.match(/pdfjsVersion\s*=\s*["']?([0-9]+\.[0-9]+\.[0-9]+)["']?/);
  if (banner?.[1]) return banner[1];

  // Fall back to the installed package version rather than failing the build.
  try {
    const pkgPath = require.resolve('pdfjs-dist/package.json');
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
    if (pkg.version) return pkg.version;
  } catch {
    // fall through to the error below
  }

  throw new Error(`Unable to determine PDF.js worker version from ${sourcePath}`);
}

async function readIfPresent(path) {
  try {
    return await readFile(path);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function main() {
  const source = await readFile(sourcePath);
  const sourceText = source.toString('utf8');
  const sourceVersion = await extractPdfJsVersion(sourceText, sourcePath);
  const existing = await readIfPresent(targetPath);

  if (existing?.equals(source)) {
    console.log(`[pdf-worker] verified pdf.worker.min.mjs matches pdfjs-dist ${sourceVersion}`);
    return;
  }

  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, source);
  console.log(`[pdf-worker] synced pdf.worker.min.mjs to pdfjs-dist ${sourceVersion}`);
}

await main();
