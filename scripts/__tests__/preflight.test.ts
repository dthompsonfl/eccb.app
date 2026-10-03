/**
 * Tests for the `start:all` preflight gate.
 *
 * The property that matters most: EVERY problem is reported in one run. The
 * old manager exited on the first failure, so an operator fixing a broken
 * deployment restarted once per mistake.
 */

import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readdir } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import {
  collectEnvProblems,
  extractBakedSocketPort,
  formatPreflightReport,
  hasSlashlessSocketSource,
  hasSlashedSocketDestination,
  resolveRealtimePosture,
  runPreflight,
} from '../preflight';

const GOOD_ENV: NodeJS.ProcessEnv = {
  DATABASE_URL: 'mysql://user:pass@localhost:3306/eccb',
  REDIS_URL: 'redis://localhost:6379',
  AUTH_SECRET: 'a'.repeat(32),
  BETTER_AUTH_SECRET: 'b'.repeat(32),
  APP_URL: 'http://localhost:3225',
  NEXT_PUBLIC_APP_URL: 'http://localhost:3225',
  NODE_ENV: 'production',
  SUPER_ADMIN_PASSWORD: 'hunter2hunter2',
  STORAGE_DRIVER: 'LOCAL',
  LOCAL_STORAGE_PATH: './storage',
  ENABLE_WEBSOCKETS: 'true',
  SOCKET_PORT: '3226',
};

/**
 * A routes manifest whose baked stand rewrite targets `port`.
 *
 * The trailing slash on the destination mirrors what `next.config.ts` emits and
 * is load-bearing: engine.io only answers on `${path}/`.
 */
/**
 * The CORRECT build shape.
 *
 * The stand socket server is hosted on the app's own port by scripts/serve.ts,
 * so the production build must contain NO /api/stand/socket rewrite at all. A
 * rewrite cannot carry a WebSocket upgrade — Next's production `upgradeHandler`
 * only serves HMR in development — so any baked rewrite reintroduces the silent
 * fallback to polling while /ready still reports sockets healthy.
 */
function emptyManifest(): unknown {
  return { rewrites: { afterFiles: [] } };
}

/** A build that still carries a socket rewrite: now always an error. */
function manifestFor(port: number): unknown {
  return {
    rewrites: {
      afterFiles: [{ source: '/api/stand/socket', destination: `http://localhost:${port}/api/stand/socket/` }],
    },
  };
}

/** Also a rewrite — a slashless destination is just a second way to be wrong. */
function slashlessManifestFor(port: number): unknown {
  return {
    rewrites: {
      afterFiles: [{ source: '/api/stand/socket', destination: `http://localhost:${port}/api/stand/socket` }],
    },
  };
}

/** Also a rewrite — the slashed-source variant, likewise always an error. */
function slashedSourceManifestFor(port: number): unknown {
  return {
    rewrites: {
      afterFiles: [{ source: '/api/stand/socket/', destination: `http://localhost:${port}/api/stand/socket/` }],
    },
  };
}

/** Build a throwaway root containing a fake `.next` build. */
async function makeRoot(options: { routesManifest?: unknown; withBuildId?: boolean } = {}): Promise<string> {
  // Default to the CORRECT build shape: no socket rewrite. Tests that are about
  // the old rewrite contract pass a rewrite manifest explicitly.
  const root = await mkdtemp(path.join(tmpdir(), 'eccb-preflight-'));
  if (options.withBuildId !== false) {
    await mkdir(path.join(root, '.next'), { recursive: true });
    await writeFile(path.join(root, '.next/BUILD_ID'), 'test-build', 'utf8');
    if (options.routesManifest !== undefined) {
      await writeFile(
        path.join(root, '.next/routes-manifest.json'),
        JSON.stringify(options.routesManifest),
        'utf8',
      );
    }
  }
  return root;
}

/** Preflight deps that never touch the network but do read real files. */
function fakeDeps(rootDir: string, overrides: Record<string, unknown> = {}) {
  return {
    rootDir,
    probeTcp: async () => true,
    probeDatabase: async () => undefined,
    probeRedis: async () => undefined,
    readStandSettings: async () => ({}),
    readJsonFile: async (filePath: string) => {
      const { readFile } = await import('fs/promises');
      try {
        return JSON.parse(await readFile(filePath, 'utf8'));
      } catch {
        return null;
      }
    },
    ...overrides,
  };
}

/** Env with real-time sync off everywhere, so only the targeted check fires. */
function pollingEnv(): NodeJS.ProcessEnv {
  return { ...GOOD_ENV, ENABLE_WEBSOCKETS: 'false' };
}

const POLLING_SETTINGS = { 'stand.realtimeMode': 'polling' };
const WEBSOCKET_SETTINGS = { 'stand.realtimeMode': 'websocket' };

describe('collectEnvProblems', () => {
  it('reports nothing for a complete environment', () => {
    expect(collectEnvProblems(GOOD_ENV)).toEqual([]);
  });

  it('reports EVERY missing variable at once rather than the first', () => {
    const codes = collectEnvProblems({}).map((p) => p.code);
    expect(codes).toContain('env.DATABASE_URL');
    expect(codes).toContain('env.AUTH_SECRET');
    expect(codes).toContain('env.BETTER_AUTH_SECRET');
    expect(codes).toContain('env.APP_URL');
    expect(codes).toContain('env.REDIS_URL');
    expect(codes).toContain('env.SUPER_ADMIN_PASSWORD');
  });

  it('rejects a short auth secret', () => {
    const problems = collectEnvProblems({ ...GOOD_ENV, AUTH_SECRET: 'too-short' });
    expect(problems.some((p) => p.code === 'env.AUTH_SECRET')).toBe(true);
  });

  it('rejects a non-URL APP_URL', () => {
    const env = { ...GOOD_ENV, APP_URL: 'not a url', NEXT_PUBLIC_APP_URL: 'not a url' };
    expect(collectEnvProblems(env).some((p) => p.code === 'env.APP_URL')).toBe(true);
  });

  it('rejects a non-redis REDIS_URL', () => {
    const problems = collectEnvProblems({ ...GOOD_ENV, REDIS_URL: 'http://localhost:6379' });
    expect(problems.some((p) => p.code === 'env.REDIS_URL')).toBe(true);
  });

  it('requires S3 credentials when the driver is S3', () => {
    const codes = collectEnvProblems({ ...GOOD_ENV, STORAGE_DRIVER: 'S3' }).map((p) => p.code);
    expect(codes).toContain('env.S3_ENDPOINT');
    expect(codes).toContain('env.S3_BUCKET_NAME');
    expect(codes).toContain('env.S3_ACCESS_KEY_ID');
    expect(codes).toContain('env.S3_SECRET_ACCESS_KEY');
  });

  it('requires SMTP settings when the provider is smtp', () => {
    const codes = collectEnvProblems({ ...GOOD_ENV, EMAIL_PROVIDER: 'smtp' }).map((p) => p.code);
    expect(codes).toContain('env.SMTP_HOST');
    expect(codes).toContain('env.SMTP_PORT');
  });

  it('requires SUPER_ADMIN_PASSWORD regardless of NODE_ENV, because children are forced to production', () => {
    const env: NodeJS.ProcessEnv = { ...GOOD_ENV, NODE_ENV: 'development' };
    delete env.SUPER_ADMIN_PASSWORD;
    expect(collectEnvProblems(env).some((p) => p.code === 'env.SUPER_ADMIN_PASSWORD')).toBe(true);
  });

  it('gives every problem an actionable hint', () => {
    for (const problem of collectEnvProblems({})) {
      expect(problem.hint, `${problem.code} has no hint`).toBeTruthy();
    }
  });
});

describe('resolveRealtimePosture', () => {
  it('treats a database realtimeMode of websocket as the intent', () => {
    const posture = resolveRealtimePosture({ ENABLE_WEBSOCKETS: 'false' }, { 'stand.realtimeMode': 'websocket' });
    expect(posture.realtimeMode).toBe('websocket');
    expect(posture.websocketsEnabled).toBe(false);
    expect(posture.source).toContain('database');
  });

  it('reads the feature flag when the database is silent', () => {
    const env = { ENABLE_WEBSOCKETS: 'false', FEATURE_STAND_WEBSOCKET_SYNC: 'true' };
    expect(resolveRealtimePosture(env, {}).realtimeMode).toBe('websocket');
  });

  it('defaults to polling', () => {
    expect(resolveRealtimePosture({}, {}).realtimeMode).toBe('polling');
  });

  it('honours an explicit database override of polling', () => {
    const env = { ENABLE_WEBSOCKETS: 'true', FEATURE_STAND_WEBSOCKET_SYNC: 'true' };
    expect(resolveRealtimePosture(env, { 'stand.realtimeMode': 'polling' }).realtimeMode).toBe('polling');
  });
});

describe('extractBakedSocketPort', () => {
  it('reads the port from a routes manifest rewrite', () => {
    const manifest = {
      rewrites: { afterFiles: [{ source: '/api/stand/socket', destination: 'http://localhost:3226/api/stand/socket' }] },
    };
    expect(extractBakedSocketPort(manifest)).toBe(3226);
  });

  it('reads the port from required-server-files.json', () => {
    const manifest = {
      config: {
        _originalRewrites: {
          afterFiles: [
            { source: '/api/stand/socket/:path*', destination: 'http://localhost:9999/api/stand/socket/:path*' },
          ],
        },
      },
    };
    expect(extractBakedSocketPort(manifest)).toBe(9999);
  });

  it('returns null when no stand rewrite is present', () => {
    expect(extractBakedSocketPort({ rewrites: { afterFiles: [] } })).toBeNull();
    expect(extractBakedSocketPort(null)).toBeNull();
    expect(extractBakedSocketPort({})).toBeNull();
    expect(extractBakedSocketPort('nonsense')).toBeNull();
  });

  it('ignores rewrites unrelated to the stand socket', () => {
    const manifest = {
      rewrites: { afterFiles: [{ source: '/old', destination: 'http://localhost:1234/old' }] },
    };
    expect(extractBakedSocketPort(manifest)).toBeNull();
  });
});

describe('hasSlashedSocketDestination', () => {
  it('accepts a destination with the trailing slash engine.io requires', () => {
    expect(hasSlashedSocketDestination(manifestFor(3226))).toBe(true);
  });

  it('rejects the slashless destination that hangs every proxied handshake', () => {
    expect(hasSlashedSocketDestination(slashlessManifestFor(3226))).toBe(false);
  });

  it('returns false for a manifest with no socket rewrite', () => {
    expect(hasSlashedSocketDestination({ rewrites: { afterFiles: [] } })).toBe(false);
    expect(hasSlashedSocketDestination(null)).toBe(false);
  });
});

describe('hasSlashlessSocketSource', () => {
  it('accepts the slashless source the browser client actually requests', () => {
    expect(hasSlashlessSocketSource(manifestFor(3226))).toBe(true);
  });

  it('rejects a slashed source, which Next 308s and an upgrade cannot follow', () => {
    expect(hasSlashlessSocketSource(slashedSourceManifestFor(3226))).toBe(false);
  });

  it('returns false for a manifest with no socket rewrite', () => {
    expect(hasSlashlessSocketSource({ rewrites: { afterFiles: [] } })).toBe(false);
    expect(hasSlashlessSocketSource(null)).toBe(false);
  });

  it('is independent of the destination check, so neither half can mask the other', () => {
    // A slashed source passes the destination check and fails the source check.
    // That independence is the point: the shipped defect was visible only here.
    const manifest = slashedSourceManifestFor(3226);
    expect(hasSlashedSocketDestination(manifest)).toBe(true);
    expect(hasSlashlessSocketSource(manifest)).toBe(false);

    // And a slashless destination is the mirror image.
    const mirror = slashlessManifestFor(3226);
    expect(hasSlashedSocketDestination(mirror)).toBe(false);
    expect(hasSlashlessSocketSource(mirror)).toBe(true);
  });
});

describe('runPreflight', () => {
  it('BLOCKS a build that still contains a socket rewrite', async () => {
    // The socket server is hosted on the app port by scripts/serve.ts. A rewrite
    // cannot carry a WebSocket upgrade: Next's production upgradeHandler only
    // serves HMR in development, so the browser gets a 308 it cannot follow and
    // silently falls back to polling while /ready reports sockets healthy.
    const root = await makeRoot({ routesManifest: slashedSourceManifestFor(3226) });
    try {
      const result = await runPreflight({
        deps: fakeDeps(root, {
          env: GOOD_ENV,
          readStandSettings: async () => WEBSOCKET_SETTINGS,
        }),
      });
      const problem = result.problems.find((p) => p.code === 'rewrite.unexpected');
      expect(problem).toBeDefined();
      expect(problem?.severity).toBe('error');
      expect(result.ok).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('BLOCKS a build whose socket rewrite points at a port', async () => {
    // Same failure mode, reached from the other direction: any baked rewrite is
    // wrong now, whether or not its path shape happens to be right.
    const root = await makeRoot({ routesManifest: manifestFor(3226) });
    try {
      const result = await runPreflight({
        deps: fakeDeps(root, {
          env: GOOD_ENV,
          readStandSettings: async () => WEBSOCKET_SETTINGS,
        }),
      });
      expect(result.problems.some((p) => p.code === 'rewrite.unexpected')).toBe(true);
      expect(result.ok).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('passes when the build has NO socket rewrite (socket served on the app port)', async () => {
    const root = await makeRoot({ routesManifest: emptyManifest() });
    try {
      const result = await runPreflight({
        deps: fakeDeps(root, {
          env: GOOD_ENV,
          readStandSettings: async () => WEBSOCKET_SETTINGS,
        }),
      });
      expect(result.problems.some((p) => p.code.startsWith('rewrite.'))).toBe(false);
      expect(result.ok).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('WARNS but does not block when ENABLE_WORKER=false', async () => {
    // A web-only deployment is legitimate (another host owns the queues), but
    // the consequences are entirely silent: no email, no scheduler, no cleanup,
    // Smart Upload queues forever. Every health endpoint still reports healthy,
    // so the operator has to be told at startup.
    const root = await makeRoot({ routesManifest: emptyManifest() });
    try {
      const result = await runPreflight({
        deps: fakeDeps(root, {
          env: { ...GOOD_ENV, ENABLE_WORKER: 'false' },
          readStandSettings: async () => WEBSOCKET_SETTINGS,
        }),
      });
      const problem = result.problems.find((p) => p.code === 'workers.disabled');
      expect(problem).toBeDefined();
      // A warning, not an error — it must not block a legitimate topology.
      expect(problem?.severity).toBe('warning');
      expect(result.ok).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('WARNS but does not block when ENABLE_OCR_WORKER=false', async () => {
    const root = await makeRoot({ routesManifest: emptyManifest() });
    try {
      const result = await runPreflight({
        deps: fakeDeps(root, {
          env: { ...GOOD_ENV, ENABLE_OCR_WORKER: 'false' },
          readStandSettings: async () => WEBSOCKET_SETTINGS,
        }),
      });
      const problem = result.problems.find((p) => p.code === 'ocr.disabled');
      expect(problem).toBeDefined();
      expect(problem?.severity).toBe('warning');
      expect(result.ok).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('says nothing about either switch when they are unset or enabled', async () => {
    // Unset must mean enabled: an operator who has never heard of these flags
    // gets the full stack and no spurious warnings.
    for (const value of [undefined, 'true', '1']) {
      const root = await makeRoot({ routesManifest: emptyManifest() });
      try {
        const env = { ...GOOD_ENV } as NodeJS.ProcessEnv;
        if (value !== undefined) {
          env.ENABLE_WORKER = value;
          env.ENABLE_OCR_WORKER = value;
        }
        const result = await runPreflight({
          deps: fakeDeps(root, { env, readStandSettings: async () => WEBSOCKET_SETTINGS }),
        });
        expect(result.problems.some((p) => p.code === 'workers.disabled')).toBe(false);
        expect(result.problems.some((p) => p.code === 'ocr.disabled')).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  it('passes with a valid environment and build', async () => {
    const root = await makeRoot();
    try {
      const result = await runPreflight({ deps: fakeDeps(root, { env: GOOD_ENV }) });
      expect(result.problems).toEqual([]);
      expect(result.ok).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('surfaces an unreachable database and an unusable Redis in the same run', async () => {
    const root = await makeRoot();
    try {
      const result = await runPreflight({
        deps: fakeDeps(root, {
          env: GOOD_ENV,
          probeDatabase: async () => {
            throw new Error('ER_ACCESS_DENIED_ERROR');
          },
          probeRedis: async () => {
            throw new Error('NOAUTH Authentication required');
          },
        }),
      });
      const codes = result.problems.map((p) => p.code);
      expect(codes).toContain('database.unusable');
      expect(codes).toContain('redis.unusable');
      expect(result.ok).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('flags an unreachable TCP host separately from an unusable handshake', async () => {
    const root = await makeRoot();
    try {
      const result = await runPreflight({ deps: fakeDeps(root, { env: GOOD_ENV, probeTcp: async () => false }) });
      const codes = result.problems.map((p) => p.code);
      expect(codes).toContain('database.unreachable');
      expect(codes).toContain('redis.unreachable');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('BLOCKS when the Stand wants real-time sync but ENABLE_WEBSOCKETS is off', async () => {
    // The headline defect: previously start:all came up "healthy" with real-time
    // sync silently disabled and no error anywhere.
    const root = await makeRoot();
    try {
      const result = await runPreflight({
        deps: fakeDeps(root, {
          env: { ...GOOD_ENV, ENABLE_WEBSOCKETS: 'false' },
          readStandSettings: async () => ({ 'stand.realtimeMode': 'websocket' }),
        }),
      });
      expect(result.ok).toBe(false);
      const problem = result.problems.find((p) => p.code === 'realtime.disabled');
      expect(problem).toBeDefined();
      expect(problem?.message).toContain('silently fall back to polling');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('warns when the socket server would start with no client using it', async () => {
    const root = await makeRoot();
    try {
      const result = await runPreflight({
        deps: fakeDeps(root, {
          env: GOOD_ENV,
          readStandSettings: async () => POLLING_SETTINGS,
        }),
      });
      const warning = result.problems.find((p) => p.code === 'realtime.orphan');
      expect(warning?.severity).toBe('warning');
      // A warning must not block the start.
      expect(result.ok).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('raises NO realtime warning when env and the database agree on websocket', async () => {
    // The reconciled posture. Neither the blocking check nor the orphan warning
    // may fire, otherwise the guard is either dead or over-firing.
    const root = await makeRoot();
    try {
      const result = await runPreflight({
        deps: fakeDeps(root, {
          env: GOOD_ENV,
          readStandSettings: async () => WEBSOCKET_SETTINGS,
        }),
      });
      const realtimeCodes = result.problems.filter((p) => p.code.startsWith('realtime.'));
      expect(realtimeCodes).toEqual([]);
      expect(result.ok).toBe(true);
      expect(result.notes.join(' ')).toContain('Stand realtime posture: websocket (source: database');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('raises NO realtime warning when env and the database agree on polling', async () => {
    // The symmetric agreement case: ENABLE_WEBSOCKETS=false with the database
    // on polling is a coherent polling-only deployment, not an orphan.
    const root = await makeRoot();
    try {
      const result = await runPreflight({
        deps: fakeDeps(root, {
          env: pollingEnv(),
          readStandSettings: async () => POLLING_SETTINGS,
        }),
      });
      expect(result.problems.filter((p) => p.code.startsWith('realtime.'))).toEqual([]);
      expect(result.ok).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('still catches a hand-edited websocketEnabled=false alongside realtimeMode=websocket', async () => {
    // The exact drift that shipped: the mode says websocket, the switch says off.
    // `resolveRealtimePosture` reads the mode as the intent, so the mismatch must
    // still be surfaced rather than passing because the mode happens to be right.
    const root = await makeRoot();
    const posture = resolveRealtimePosture(GOOD_ENV, {
      'stand.realtimeMode': 'websocket',
      'stand.websocketEnabled': 'false',
    });
    expect(posture.realtimeMode).toBe('websocket');
    expect(posture.websocketsEnabled).toBe(true);
    // With ENABLE_WEBSOCKETS also off, the blocking check fires on the mode.
    const result = await runPreflight({
      deps: fakeDeps(root, {
        env: { ...GOOD_ENV, ENABLE_WEBSOCKETS: 'false' },
        readStandSettings: async () => ({
          'stand.realtimeMode': 'websocket',
          'stand.websocketEnabled': 'false',
        }),
      }),
    });
    expect(result.problems.some((p) => p.code === 'realtime.disabled')).toBe(true);
    await rm(root, { recursive: true, force: true });
  });


  it('PASSES when websockets are enabled and the build has no rewrite (socket on app port)', async () => {
    // The correct production shape: scripts/serve.ts hosts the socket on the app
    // port, so nothing is baked into the build and there is no rewrite to check.
    const root = await makeRoot();
    try {
      const result = await runPreflight({
        deps: fakeDeps(root, {
          env: GOOD_ENV,
          readStandSettings: async () => WEBSOCKET_SETTINGS,
        }),
      });
      expect(result.problems.some((p) => p.code.startsWith('rewrite.'))).toBe(false);
      expect(result.ok).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('skips the rewrite checks entirely when websockets are off', async () => {
    const root = await makeRoot();
    try {
      const result = await runPreflight({
        deps: fakeDeps(root, {
          env: pollingEnv(),
          readStandSettings: async () => POLLING_SETTINGS,
        }),
      });
      expect(result.problems.some((p) => p.code.startsWith('rewrite.'))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports a missing production build', async () => {
    const root = await makeRoot({ withBuildId: false });
    try {
      const result = await runPreflight({
        deps: fakeDeps(root, {
          env: pollingEnv(),
          readStandSettings: async () => POLLING_SETTINGS,
        }),
      });
      expect(result.problems.some((p) => p.code === 'build.missing')).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('flags an unwritable LOCAL_STORAGE_PATH', async () => {
    const root = await makeRoot();
    // A regular file where a directory is required: mkdir fails with ENOTDIR
    // deterministically, for any uid.
    await writeFile(path.join(root, 'not-a-directory'), 'x', 'utf8');
    try {
      const result = await runPreflight({
        deps: fakeDeps(root, {
          env: { ...pollingEnv(), LOCAL_STORAGE_PATH: './not-a-directory/uploads' },
          readStandSettings: async () => POLLING_SETTINGS,
        }),
      });
      expect(result.problems.some((p) => p.code === 'storage.unwritable')).toBe(true);
      expect(result.ok).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('creates LOCAL_STORAGE_PATH when it does not exist yet', async () => {
    const root = await makeRoot();
    try {
      const result = await runPreflight({
        deps: fakeDeps(root, {
          env: { ...pollingEnv(), LOCAL_STORAGE_PATH: './fresh-storage' },
          readStandSettings: async () => POLLING_SETTINGS,
        }),
      });
      expect(result.problems.some((p) => p.code === 'storage.unwritable')).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('leaves no probe file behind in the storage directory', async () => {
    const root = await makeRoot();
    try {
      await runPreflight({
        deps: fakeDeps(root, {
          env: { ...pollingEnv(), LOCAL_STORAGE_PATH: './storage' },
          readStandSettings: async () => POLLING_SETTINGS,
        }),
      });
      const entries = await readdir(path.join(root, 'storage'));
      expect(entries.filter((e) => e.includes('eccb-preflight'))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('BLOCKS when SOCKET_PORT is occupied, because the rewrite cannot follow a roll-forward', async () => {
    const root = await makeRoot();
    try {
      const result = await runPreflight({
        deps: fakeDeps(root, { env: GOOD_ENV }),
        ports: { app: 3225, socket: 3226, workerHealth: 3227, managerHealth: 3228 },
        isPortBusy: async (port: number) => port === 3226,
      });
      expect(result.problems.some((p) => p.code === 'socket.port-busy')).toBe(true);
      expect(result.ok).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('only notes — never blocks — when a roll-forward-capable port is occupied', async () => {
    const root = await makeRoot();
    try {
      const result = await runPreflight({
        deps: fakeDeps(root, { env: GOOD_ENV }),
        ports: { app: 3225, socket: 3226, workerHealth: 3227, managerHealth: 3228 },
        isPortBusy: async (port: number) => port === 3225,
      });
      expect(result.problems.filter((p) => p.severity === 'error')).toEqual([]);
      expect(result.notes.join(' ')).toContain('roll forward');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('records the resolved realtime posture as a note', async () => {
    const root = await makeRoot();
    try {
      const result = await runPreflight({ deps: fakeDeps(root, { env: GOOD_ENV }) });
      expect(result.notes.join(' ')).toContain('Stand realtime posture: websocket');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('formatPreflightReport', () => {
  it('lists every blocking problem with an actionable hint', () => {
    const output = formatPreflightReport({
      ok: false,
      notes: [],
      problems: [
        { code: 'env.DATABASE_URL', severity: 'error', message: 'Missing database connection.', hint: 'Set DATABASE_URL.' },
        { code: 'redis.unreachable', severity: 'error', message: 'Cannot reach Redis.', hint: 'Start Redis.' },
        { code: 'realtime.orphan', severity: 'warning', message: 'Socket server idle.', hint: 'Switch to polling.' },
      ],
    });
    expect(output).toContain('Preflight failed: 2 blocking problems');
    expect(output).toContain('1. [env.DATABASE_URL]');
    expect(output).toContain('→ Set DATABASE_URL.');
    expect(output).toContain('2. [redis.unreachable]');
    expect(output).toContain('Preflight warnings (1)');
  });

  it('renders nothing when there are no problems', () => {
    expect(formatPreflightReport({ ok: true, notes: [], problems: [] }).trim()).toBe('');
  });
});