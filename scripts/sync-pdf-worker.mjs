#!/usr/bin/env node

import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const sourcePath = require.resolve('pdfjs-dist/build/pdf.worker.min.mjs');
const targetPath = resolve(process.cwd(), 'public', 'pdf.worker.min.mjs');

function extractPdfJsVersion(source) {
  const match = source.match(/pdfjsVersion\s*=\s*["']([^"']+)["']/);
  if (!match?.[1]) {
    throw new Error(`Unable to determine PDF.js worker version from ${sourcePath}`);
  }
  return match[1];
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
  const sourceVersion = extractPdfJsVersion(sourceText);
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
