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

/** A routes manifest whose baked stand rewrite targets `port`. */
function manifestFor(port: number): unknown {
  return {
    rewrites: {
      afterFiles: [{ source: '/api/stand/socket', destination: `http://localhost:${port}/api/stand/socket` }],
    },
  };
}

/** Build a throwaway root containing a fake `.next` build. */
async function makeRoot(options: { routesManifest?: unknown; withBuildId?: boolean } = {}): Promise<string> {
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

describe('runPreflight', () => {
  it('passes with a valid environment and build', async () => {
    const root = await makeRoot({ routesManifest: manifestFor(3226) });
    try {
      const result = await runPreflight({ deps: fakeDeps(root, { env: GOOD_ENV }) });
      expect(result.problems).toEqual([]);
      expect(result.ok).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('surfaces an unreachable database and an unusable Redis in the same run', async () => {
    const root = await makeRoot({ routesManifest: manifestFor(3226) });
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
    const root = await makeRoot({ routesManifest: manifestFor(3226) });
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

  it('BLOCKS when the build rewrite port disagrees with SOCKET_PORT', async () => {
    const root = await makeRoot({ routesManifest: manifestFor(3226) });
    try {
      const result = await runPreflight({ deps: fakeDeps(root, { env: { ...GOOD_ENV, SOCKET_PORT: '3229' } }) });
      const problem = result.problems.find((p) => p.code === 'rewrite.port-mismatch');
      expect(problem).toBeDefined();
      expect(problem?.message).toContain('3226');
      expect(problem?.message).toContain('3229');
      expect(result.ok).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('BLOCKS when websockets are enabled but the build has no rewrite at all', async () => {
    const root = await makeRoot();
    try {
      const result = await runPreflight({ deps: fakeDeps(root, { env: GOOD_ENV }) });
      expect(result.problems.some((p) => p.code === 'rewrite.missing')).toBe(true);
      expect(result.ok).toBe(false);
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
    const root = await makeRoot({ routesManifest: manifestFor(3226) });
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
    const root = await makeRoot({ routesManifest: manifestFor(3226) });
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
    const root = await makeRoot({ routesManifest: manifestFor(3226) });
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