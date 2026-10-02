/**
 * Standalone Build Preparation
 *
 * `next build` with `output: 'standalone'` emits a minimal server bundle in
 * `.next/standalone/` containing only the traced server code and its runtime
 * dependencies. It deliberately does NOT copy the client assets:
 *
 *   - `.next/static`  (JS/CSS chunks under /_next/static/*)
 *   - `public/`       (favicon, images, manifest.json, uploads/…)
 *
 * A server started straight out of `.next/standalone/server.js` therefore
 * renders HTML successfully but returns 404 for every stylesheet and script,
 * which shows up as a completely unstyled page. `scripts/deploy.sh` performs
 * this copy for releases; this module does the same work for every other
 * consumer (`npm run build`, `npm run build:production`, `npm run start:all`)
 * so the copy can never be forgotten.
 *
 * It also validates that the standalone output actually matches the current
 * build, so a stale `.next/standalone/` from an older `next build` is never
 * served silently.
 *
 * Usage:
 *   tsx scripts/prepare-standalone.ts
 */

import { existsSync } from 'fs';
import { cp, mkdir, readFile, rm } from 'fs/promises';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Which server entry point `start.ts` should launch after preparation. */
export type StandaloneMode = 'standalone' | 'next-start' | 'missing';

export interface PrepareStandaloneResult {
  /** Absolute path to `.next/standalone/server.js`, or null when unusable. */
  standaloneServerPath: string | null;
  /** Recommended server entry point. */
  mode: StandaloneMode;
  /** Non-fatal problems worth surfacing to the operator. */
  warnings: string[];
  /** Human-readable list of assets synchronised into standalone output. */
  copied: string[];
}

interface CopyStep {
  label: string;
  source: string;
  destination: string;
  /** Directory creation is required when the destination parent is absent. */
  ensureParent?: boolean;
}

function getRootDir(): string {
  return resolve(__dirname, '..');
}

async function readBuildId(path: string): Promise<string | null> {
  try {
    return (await readFile(path, 'utf8')).trim();
  } catch {
    return null;
  }
}

/**
 * Replace `destination` with a fresh recursive copy of `source`.
 *
 * The destination is always removed first: a plain `cp -r source dest/`
 * nests directories (public/public) and leaves orphaned chunks behind when a
 * hash changes, so a remove-then-copy is the only safe idempotent form.
 */
async function syncDirectory(step: CopyStep, warnings: string[]): Promise<void> {
  if (!existsSync(step.source)) {
    warnings.push(`Skipped ${step.label}: source not found at ${step.source}`);
    return;
  }

  if (step.ensureParent) {
    await mkdir(dirname(step.destination), { recursive: true });
  }

  await rm(step.destination, { recursive: true, force: true });
  await cp(step.source, step.destination, { recursive: true });
}

/**
 * Validate the production build and synchronise client assets into the
 * standalone bundle.
 *
 * Never throws: callers decide what to do with an unusable build by inspecting
 * the returned `mode`.
 */
export async function prepareStandalone(
  options: { rootDir?: string } = {},
): Promise<PrepareStandaloneResult> {
  const rootDir = options.rootDir ?? getRootDir();
  const nextDir = resolve(rootDir, '.next');
  const standaloneDir = resolve(nextDir, 'standalone');
  const standaloneServerPath = resolve(standaloneDir, 'server.js');
  const warnings: string[] = [];
  const copied: string[] = [];

  const rootBuildIdPath = resolve(nextDir, 'BUILD_ID');
  if (!existsSync(rootBuildIdPath)) {
    return {
      standaloneServerPath: null,
      mode: 'missing',
      warnings: ['No production build found at .next/BUILD_ID — run `npm run build` first.'],
      copied,
    };
  }

  if (!existsSync(standaloneServerPath)) {
    return {
      standaloneServerPath: null,
      mode: 'next-start',
      warnings: [
        'Standalone output not found at .next/standalone/server.js — falling back to `next start`.',
      ],
      copied,
    };
  }

  const [rootBuildId, standaloneBuildId] = await Promise.all([
    readBuildId(rootBuildIdPath),
    readBuildId(resolve(standaloneDir, '.next/BUILD_ID')),
  ]);

  if (rootBuildId !== standaloneBuildId) {
    return {
      standaloneServerPath: null,
      mode: 'next-start',
      warnings: [
        `Standalone output is stale (build ${standaloneBuildId ?? 'unknown'} != ${rootBuildId ?? 'unknown'}) — ` +
          'falling back to `next start`. Re-run `npm run build` to restore the standalone bundle.',
      ],
      copied,
    };
  }

  const steps: CopyStep[] = [
    {
      label: 'client assets (.next/static)',
      source: resolve(nextDir, 'static'),
      destination: resolve(standaloneDir, '.next/static'),
      ensureParent: true,
    },
    {
      label: 'public assets (public/)',
      source: resolve(rootDir, 'public'),
      destination: resolve(standaloneDir, 'public'),
    },
  ];

  for (const step of steps) {
    await syncDirectory(step, warnings);
    if (existsSync(step.destination)) {
      copied.push(step.label);
    }
  }

  return { standaloneServerPath, mode: 'standalone', warnings, copied };
}

/**
 * Entry point for `npm run prepare:standalone`.
 */
async function main(): Promise<void> {
  const result = await prepareStandalone();

  for (const warning of result.warnings) {
    console.log(`[prepare-standalone] WARNING: ${warning}`);
  }

  if (result.copied.length > 0) {
    console.log(`[prepare-standalone] Synchronised: ${result.copied.join(', ')}`);
  } else {
    console.log('[prepare-standalone] Nothing to synchronise.');
  }

  switch (result.mode) {
    case 'standalone':
      console.log(`[prepare-standalone] Ready: ${result.standaloneServerPath}`);
      break;
    case 'next-start':
      console.log('[prepare-standalone] Ready: use `next start` (standalone output unusable).');
      break;
    case 'missing':
      console.error('[prepare-standalone] ERROR: no production build. Run `npm run build`.');
      process.exitCode = 1;
      break;
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[prepare-standalone] ERROR: ${message}`);
    process.exitCode = 1;
  });
}