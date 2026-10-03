/**
 * Preflight validation for `npm run start:all`.
 *
 * Runs BEFORE any child process is spawned and collects **every** problem it
 * can find, so a misconfigured deployment is reported in one pass instead of
 * one-per-restart. The process manager prints the whole list and exits 1.
 *
 * Design notes:
 *  - No import of `@/lib/env`. That module validates on import and throws on
 *    the first problem, which is exactly the "one error per run" behaviour
 *    this module exists to replace. The rules below mirror `src/lib/env.ts`
 *    and `env.example` so the two cannot drift silently — `ENV_RULES` is the
 *    single statement of what a production start requires.
 *  - All I/O is injectable so the checks are unit-testable without a database,
 *    a Redis server or a writable storage mount.
 */

import { mkdir, writeFile, rm, access } from 'fs/promises';
import { constants as FS } from 'fs';
import net from 'net';
import path from 'path';

// ============================================================================
// Types
// ============================================================================

export type ProblemSeverity = 'error' | 'warning';

export interface PreflightProblem {
  /** Stable machine-readable identifier, e.g. `env.DATABASE_URL`. */
  code: string;
  severity: ProblemSeverity;
  /** One-line statement of what is wrong. */
  message: string;
  /** Actionable next step for the operator. */
  hint?: string;
}

export interface PreflightResult {
  ok: boolean;
  problems: PreflightProblem[];
  /** Non-fatal facts worth logging (resolved ports, feature posture). */
  notes: string[];
}

/** Everything the checks touch, so tests can substitute fakes. */
export interface PreflightDeps {
  env: NodeJS.ProcessEnv;
  rootDir: string;
  /** True when a TCP connect to host:port succeeds within `timeoutMs`. */
  probeTcp: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
  /** Runs `SELECT 1`. Rejects when the database is unreachable. */
  probeDatabase: (databaseUrl: string, timeoutMs: number) => Promise<void>;
  /** Runs `PING`. Rejects when Redis is unreachable. */
  probeRedis: (redisUrl: string, timeoutMs: number) => Promise<void>;
  /** Reads the `stand.*` SystemSetting rows. Resolves to `{}` when unreadable. */
  readStandSettings: () => Promise<Record<string, string>>;
  /** Reads a JSON file; resolves to null when missing or unparseable. */
  readJsonFile: (filePath: string) => Promise<unknown>;
}

export interface PreflightOptions {
  /** Ports the manager intends to bind. Reported so the operator can see them. */
  ports?: { app: number; socket: number; workerHealth: number; managerHealth: number };
  /** True when something is already listening on a port. */
  isPortBusy?: (port: number) => Promise<boolean>;
  /** Overrides for individual dependencies. */
  deps?: Partial<PreflightDeps>;
}

const PROBE_TIMEOUT_MS = 5_000;

// ============================================================================
// Environment rules
// ============================================================================

interface EnvRule {
  code: string;
  /** Variable names, any one of which satisfies the rule. */
  anyOf: string[];
  describe: string;
  hint: string;
  /** Returns null when the rule is satisfied, otherwise an error message. */
  check?: (value: string) => string | null;
}

const SECRET_MIN_LENGTH = 32;

/**
 * What a production start requires. Mirrors the zod schema in
 * `src/lib/env.ts` and the annotations in `env.example`.
 */
export const ENV_RULES: EnvRule[] = [
  {
    code: 'DATABASE_URL',
    anyOf: ['DATABASE_URL', 'DATABASE_HOST'],
    describe: 'database connection',
    hint: 'Set DATABASE_URL (mysql://user:pass@host:3306/db), or the DATABASE_HOST/PORT/USER/PASSWORD/NAME group.',
  },
  {
    code: 'AUTH_SECRET',
    anyOf: ['AUTH_SECRET'],
    describe: 'auth secret',
    hint: `Generate one with \`openssl rand -base64 32\` (minimum ${SECRET_MIN_LENGTH} characters).`,
    check: (value) =>
      value.length < SECRET_MIN_LENGTH
        ? `is ${value.length} characters, minimum is ${SECRET_MIN_LENGTH}`
        : null,
  },
  {
    code: 'BETTER_AUTH_SECRET',
    anyOf: ['BETTER_AUTH_SECRET'],
    describe: 'Better Auth secret',
    hint: `Generate one with \`openssl rand -base64 32\` (minimum ${SECRET_MIN_LENGTH} characters).`,
    check: (value) =>
      value.length < SECRET_MIN_LENGTH
        ? `is ${value.length} characters, minimum is ${SECRET_MIN_LENGTH}`
        : null,
  },
  {
    code: 'APP_URL',
    anyOf: ['APP_URL', 'NEXT_PUBLIC_APP_URL'],
    describe: 'public application URL',
    hint: 'Set APP_URL and NEXT_PUBLIC_APP_URL to the origin members actually reach (scheme + host + port).',
    check: (value) => {
      try {
        const parsed = new URL(value);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:'
          ? null
          : `must be an http(s) URL, received "${value}"`;
      } catch {
        return `must be a valid URL, received "${value}"`;
      }
    },
  },
  {
    code: 'REDIS_URL',
    anyOf: ['REDIS_URL'],
    describe: 'Redis connection string',
    hint: 'Set REDIS_URL, e.g. redis://localhost:6379. BullMQ queues and the Socket.IO adapter both require it.',
    check: (value) => {
      try {
        const parsed = new URL(value);
        return parsed.protocol === 'redis:' || parsed.protocol === 'rediss:'
          ? null
          : `must be a redis:// or rediss:// URL, received "${value}"`;
      } catch {
        return `must be a valid URL, received "${value}"`;
      }
    },
  },
];

// ============================================================================
// Small helpers
// ============================================================================

function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim() === '';
}

export function collectEnvProblems(env: NodeJS.ProcessEnv): PreflightProblem[] {
  const problems: PreflightProblem[] = [];

  for (const rule of ENV_RULES) {
    const present = rule.anyOf.filter((name) => !isBlank(env[name]));
    if (present.length === 0) {
      problems.push({
        code: `env.${rule.code}`,
        severity: 'error',
        message: `Missing ${rule.describe} (${rule.anyOf.join(' or ')}).`,
        hint: rule.hint,
      });
      continue;
    }
    for (const name of present) {
      const failure = rule.check?.(env[name] as string);
      if (failure) {
        problems.push({
          code: `env.${name}`,
          severity: 'error',
          message: `${name} ${failure}.`,
          hint: rule.hint,
        });
      }
    }
  }

  // Mirrors src/lib/env.ts: S3 credentials are mandatory for the S3 driver.
  if ((env.STORAGE_DRIVER ?? '').trim().toUpperCase() === 'S3') {
    for (const name of ['S3_ENDPOINT', 'S3_BUCKET_NAME', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']) {
      if (isBlank(env[name])) {
        problems.push({
          code: `env.${name}`,
          severity: 'error',
          message: `${name} is required when STORAGE_DRIVER=S3.`,
          hint: 'Populate the S3 block in .env, or set STORAGE_DRIVER=LOCAL.',
        });
      }
    }
  }

  // Mirrors src/lib/env.ts: an SMTP driver needs a host and a port.
  if ((env.EMAIL_PROVIDER ?? '').trim().toLowerCase() === 'smtp') {
    for (const name of ['SMTP_HOST', 'SMTP_PORT']) {
      if (isBlank(env[name])) {
        problems.push({
          code: `env.${name}`,
          severity: 'error',
          message: `${name} is required when EMAIL_PROVIDER=smtp.`,
          hint: 'Populate the SMTP block in .env, or set EMAIL_PROVIDER=log.',
        });
      }
    }
  }

  // The children are started with NODE_ENV=production regardless of what
  // `.env` says, and `src/lib/env.ts` refuses to boot in production without
  // this. Checking unconditionally turns a confusing mid-boot crash in the
  // worker process into a preflight line the operator can act on.
  if (isBlank(env.SUPER_ADMIN_PASSWORD)) {
    problems.push({
      code: 'env.SUPER_ADMIN_PASSWORD',
      severity: 'error',
      message: 'SUPER_ADMIN_PASSWORD is required — the server processes are started with NODE_ENV=production, which refuses to boot without it.',
      hint: 'Set SUPER_ADMIN_PASSWORD in .env. Generate one with `openssl rand -base64 24`.',
    });
  }

  return problems;
}

// ============================================================================
// Socket / realtime consistency
// ============================================================================

export interface RealtimePosture {
  /** What the application is configured to offer members. */
  realtimeMode: 'polling' | 'websocket';
  /** What the supervisor will actually start. */
  websocketsEnabled: boolean;
  source: string;
}

function isFeatureOn(env: NodeJS.ProcessEnv, flag: string, fallback: boolean): boolean {
  const raw = env[flag];
  if (raw === undefined) return fallback;
  return raw !== 'false' && raw !== '0';
}

/**
 * True when a boolean switch is explicitly turned OFF.
 *
 * Inverts {@link isFeatureOn} with a default of ON, matching how these switches
 * are actually consumed: unset means enabled, so an operator who has never heard
 * of the flag gets the full stack. Accepts `false`/`0`/`no` as off.
 */
function isFeatureOff(env: NodeJS.ProcessEnv, flag: string): boolean {
  const raw = (env[flag] ?? '').trim().toLowerCase();
  if (raw === '') return false;
  return raw === 'false' || raw === '0' || raw === 'no';
}

/**
 * Resolve whether the Stand is *meant* to run in real-time mode.
 *
 * Three independent inputs can each request it, and all three are read here so
 * a disagreement surfaces as a preflight error instead of a silent downgrade
 * to polling:
 *   1. `ENABLE_WEBSOCKETS` — the process-level switch.
 *   2. `FEATURE_STAND_WEBSOCKET_SYNC` — the feature flag (default off).
 *   3. `stand.realtimeMode` in the database — the admin-facing setting, which
 *      is the documented source of truth (`src/lib/stand/settings.ts`).
 */
export function resolveRealtimePosture(
  env: NodeJS.ProcessEnv,
  standSettings: Record<string, string>,
): RealtimePosture {
  const websocketsEnabled = (env.ENABLE_WEBSOCKETS ?? '').trim().toLowerCase() === 'true';

  const dbMode = standSettings['stand.realtimeMode'];
  if (dbMode === 'websocket') {
    return { realtimeMode: 'websocket', websocketsEnabled, source: 'database (stand.realtimeMode)' };
  }
  if (dbMode === 'polling') {
    return { realtimeMode: 'polling', websocketsEnabled, source: 'database (stand.realtimeMode)' };
  }

  if (isFeatureOn(env, 'FEATURE_STAND_WEBSOCKET_SYNC', false)) {
    return { realtimeMode: 'websocket', websocketsEnabled, source: 'FEATURE_STAND_WEBSOCKET_SYNC' };
  }
  if (isFeatureOn(env, 'ENABLE_WEBSOCKETS', false)) {
    return { realtimeMode: 'websocket', websocketsEnabled, source: 'ENABLE_WEBSOCKETS' };
  }
  return { realtimeMode: 'polling', websocketsEnabled, source: 'defaults' };
}

/**
 * Every rewrite in a baked Next.js manifest that targets the stand socket.
 *
 * Shared by the port and shape checks so they can never disagree about which
 * entries they are talking about.
 */
function collectSocketRewrites(manifest: unknown): Array<Record<string, unknown>> {
  if (!manifest || typeof manifest !== 'object') return [];
  const record = manifest as Record<string, unknown>;
  const rewrites = record.rewrites ?? (record.config as Record<string, unknown> | undefined)?._originalRewrites;
  if (!rewrites || typeof rewrites !== 'object') return [];

  const entries: Array<Record<string, unknown>> = [];
  const groups = rewrites as Record<string, unknown>;
  for (const key of ['beforeFiles', 'afterFiles', 'fallback']) {
    const group = groups[key];
    if (!Array.isArray(group)) continue;
    for (const entry of group) {
      if (!entry || typeof entry !== 'object') continue;
      const destination = (entry as Record<string, unknown>).destination;
      if (typeof destination === 'string' && destination.includes('/api/stand/socket')) {
        entries.push(entry as Record<string, unknown>);
      }
    }
  }
  return entries;
}

/**
 * Extract the socket port from a baked Next.js rewrite manifest.
 *
 * `next.config.ts` evaluates `rewrites()` at BUILD time and freezes the result
 * into `.next/routes-manifest.json` / `required-server-files.json`. A runtime
 * `SOCKET_PORT` therefore cannot change where `/api/stand/socket` proxies to.
 * Returns null when no such rewrite is present.
 */
export function extractBakedSocketPort(manifest: unknown): number | null {
  if (!manifest || typeof manifest !== 'object') return null;
  const candidates: unknown[] = [];

  const record = manifest as Record<string, unknown>;
  const rewrites = record.rewrites ?? (record.config as Record<string, unknown> | undefined)?._originalRewrites;
  if (rewrites && typeof rewrites === 'object') {
    const groups = rewrites as Record<string, unknown>;
    for (const key of ['beforeFiles', 'afterFiles', 'fallback']) {
      const group = groups[key];
      if (Array.isArray(group)) candidates.push(...group);
    }
  }

  for (const entry of candidates) {
    if (!entry || typeof entry !== 'object') continue;
    const destination = (entry as Record<string, unknown>).destination;
    if (typeof destination !== 'string') continue;
    if (!destination.includes('/api/stand/socket')) continue;
    try {
      const port = new URL(destination).port;
      if (port) return Number(port);
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * True when the manifest's socket rewrite destination ends in the trailing
 * slash engine.io requires.
 *
 * Kept separate from {@link extractBakedSocketPort} because port extraction and
 * path shape are different invariants: a manifest can name the right port and
 * still break every proxied handshake.
 */
export function hasSlashedSocketDestination(manifest: unknown): boolean {
  return collectSocketRewrites(manifest).some((entry) => {
    const destination = entry.destination as string;
    return new URL(destination).pathname.endsWith('/api/stand/socket/');
  });
}

/**
 * True when the manifest carries a slashless `/api/stand/socket` rewrite source.
 *
 * The SOURCE must be slashless. The browser client requests the slashless path
 * because Next.js answers `/api/stand/socket/` with a 308, and a WebSocket
 * UPGRADE CANNOT FOLLOW A REDIRECT: the connection dies silently while every
 * health endpoint still reports the sockets healthy.
 *
 * This is the half of the contract {@link hasSlashedSocketDestination} cannot
 * see. That one only inspects the destination, so a build whose source had
 * drifted to the slashed form passed preflight while the upgrade hung. Both are
 * checked, because a rewrite needs BOTH shapes: slashless in, slashed out.
 */
export function hasSlashlessSocketSource(manifest: unknown): boolean {
  return collectSocketRewrites(manifest).some((entry) => entry.source === '/api/stand/socket');
}

// ============================================================================
// Storage
// ============================================================================

/**
 * Verify LOCAL_STORAGE_PATH exists (creating it when absent) and accepts a
 * write. Music PDFs are the largest objects the platform stores; a read-only
 * or missing mount fails at upload time, which is far later and far less
 * obvious than failing at start.
 */
async function checkLocalStorage(
  rootDir: string,
  configuredPath: string,
): Promise<PreflightProblem[]> {
  const problems: PreflightProblem[] = [];
  const absolute = path.resolve(rootDir, configuredPath);
  const probeFile = path.join(absolute, `.eccb-preflight-${process.pid}`);

  try {
    await mkdir(absolute, { recursive: true });
  } catch (_error) {
    problems.push({
      code: 'storage.unwritable',
      severity: 'error',
      message: `Cannot create LOCAL_STORAGE_PATH at ${absolute}.`,
      hint: `Create it and grant the service user write access: sudo mkdir -p ${absolute} && sudo chown -R "$USER" ${absolute}`,
    });
    return problems;
  }

  try {
    await writeFile(probeFile, 'eccb preflight write probe');
    await rm(probeFile, { force: true });
  } catch (error) {
    problems.push({
      code: 'storage.unwritable',
      severity: 'error',
      message: `LOCAL_STORAGE_PATH at ${absolute} is not writable (${(error as Error).message}).`,
      hint: 'Music uploads, generated audio and PDF renders all write here. Fix ownership before starting.',
    });
  }
  return problems;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target, FS.F_OK);
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Default probes (real I/O)
// ============================================================================

export function defaultProbeTcp(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const finish = (result: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

/**
 * `SELECT 1` against MariaDB/MySQL via mysql2.
 *
 * Deliberately does not use `@/lib/db`: importing the Prisma singleton would
 * pull in `@/lib/env`, which throws on the first missing variable and would
 * defeat the aggregate-report behaviour of this module.
 */
export async function defaultProbeDatabase(databaseUrl: string, timeoutMs: number): Promise<void> {
  const normalised = databaseUrl.replace(/^mariadb:\/\//, 'mysql://');
  const parsed = new URL(normalised);
  if (parsed.protocol !== 'mysql:') {
    throw new Error(`Unsupported DATABASE_URL scheme "${parsed.protocol}" — this deployment targets MariaDB/MySQL.`);
  }
  const mysql = await import('mysql2/promise');
  const connection = await mysql.createConnection({
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 3306,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.replace(/^\//, ''),
    connectTimeout: timeoutMs,
  });
  try {
    await connection.query('SELECT 1');
  } finally {
    await connection.end();
  }
}

/** `PING` via ioredis. */
export async function defaultProbeRedis(redisUrl: string, timeoutMs: number): Promise<void> {
  const { default: Redis } = await import('ioredis');
  const client = new Redis(redisUrl, {
    lazyConnect: true,
    connectTimeout: timeoutMs,
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
    retryStrategy: () => null,
  });
  client.on('error', () => {
    /* surfaced through the rejected ping below */
  });
  try {
    await client.connect();
    const reply = await client.ping();
    if (reply !== 'PONG') throw new Error(`Unexpected PING reply: ${String(reply)}`);
  } finally {
    client.disconnect();
  }
}

async function defaultReadJsonFile(filePath: string): Promise<unknown> {
  const { readFile } = await import('fs/promises');
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

async function defaultReadStandSettings(): Promise<Record<string, string>> {
  try {
    const mysql = await import('mysql2/promise');
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) return {};
    const parsed = new URL(databaseUrl.replace(/^mariadb:\/\//, 'mysql://'));
    const connection = await mysql.createConnection({
      host: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : 3306,
      user: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
      database: parsed.pathname.replace(/^\//, ''),
      connectTimeout: PROBE_TIMEOUT_MS,
    });
    try {
      const [rows] = await connection.query(
        "SELECT `key`, `value` FROM `SystemSetting` WHERE `key` LIKE 'stand.%'",
      );
      const out: Record<string, string> = {};
      for (const row of rows as Array<{ key: string; value: string }>) out[row.key] = row.value;
      return out;
    } finally {
      await connection.end();
    }
  } catch {
    return {};
  }
}

// ============================================================================
// Entry point
// ============================================================================

export async function runPreflight(options: PreflightOptions = {}): Promise<PreflightResult> {
  const rootDir = options.deps?.rootDir ?? process.cwd();
  const deps: PreflightDeps = {
    env: process.env,
    rootDir,
    probeTcp: defaultProbeTcp,
    probeDatabase: defaultProbeDatabase,
    probeRedis: defaultProbeRedis,
    readStandSettings: defaultReadStandSettings,
    readJsonFile: defaultReadJsonFile,
    ...options.deps,
  };

  const problems: PreflightProblem[] = [];
  const notes: string[] = [];
  const { env } = deps;

  // ---- 1. Environment ------------------------------------------------------
  problems.push(...collectEnvProblems(env));

  // ---- 2. Storage ----------------------------------------------------------
  const storageDriver = (env.STORAGE_DRIVER ?? 'LOCAL').trim().toUpperCase();
  if (storageDriver === 'LOCAL') {
    problems.push(...(await checkLocalStorage(rootDir, env.LOCAL_STORAGE_PATH ?? './storage')));
  } else {
    notes.push(`Storage driver is ${storageDriver} — local write probe skipped.`);
  }

  // ---- 3. Database ---------------------------------------------------------
  // The TCP probe runs even when DATABASE_URL is malformed: it still tells the
  // operator whether the host is up, which separates "wrong credentials" from
  // "server is down".
  const databaseUrl = env.DATABASE_URL ?? '';
  if (databaseUrl) {
    try {
      const parsed = new URL(databaseUrl.replace(/^mariadb:\/\//, 'mysql://'));
      const reachable = await deps.probeTcp(parsed.hostname, parsed.port ? Number(parsed.port) : 3306, PROBE_TIMEOUT_MS);
      if (!reachable) {
        problems.push({
          code: 'database.unreachable',
          severity: 'error',
          message: `Cannot reach the database at ${parsed.hostname}:${parsed.port || 3306}.`,
          hint: 'Start MariaDB/MySQL, or correct DATABASE_URL. Every page and every queue job depends on it.',
        });
      }
    } catch {
      problems.push({
        code: 'database.malformed',
        severity: 'error',
        message: 'DATABASE_URL is not a parseable URL.',
        hint: 'Expected mysql://user:password@host:3306/database_name',
      });
    }
  }

  if (databaseUrl && !problems.some((p) => p.code.startsWith('database.'))) {
    try {
      await deps.probeDatabase(databaseUrl, PROBE_TIMEOUT_MS);
      notes.push('Database reachable (SELECT 1 succeeded).');
    } catch (error) {
      problems.push({
        code: 'database.unusable',
        severity: 'error',
        message: `Database handshake failed: ${(error as Error).message}`,
        hint: 'Verify the credentials in DATABASE_URL and that the schema is migrated (`npm run db:migrate:deploy`).',
      });
    }
  }

  // ---- 4. Redis ------------------------------------------------------------
  const redisUrl = env.REDIS_URL ?? '';
  if (redisUrl) {
    try {
      const parsed = new URL(redisUrl);
      const reachable = await deps.probeTcp(parsed.hostname, parsed.port ? Number(parsed.port) : 6379, PROBE_TIMEOUT_MS);
      if (!reachable) {
        problems.push({
          code: 'redis.unreachable',
          severity: 'error',
          message: `Cannot reach Redis at ${parsed.hostname}:${parsed.port || 6379}.`,
          hint: 'Start Redis, or correct REDIS_URL. BullMQ queues, rate limiting and the Socket.IO adapter all require it.',
        });
      }
    } catch {
      problems.push({
        code: 'redis.malformed',
        severity: 'error',
        message: 'REDIS_URL is not a parseable URL.',
        hint: 'Expected redis://[password@]host[:port][/db]',
      });
    }
  }

  if (redisUrl && !problems.some((p) => p.code.startsWith('redis.'))) {
    try {
      await deps.probeRedis(redisUrl, PROBE_TIMEOUT_MS);
      notes.push('Redis reachable (PING succeeded).');
    } catch (error) {
      problems.push({
        code: 'redis.unusable',
        severity: 'error',
        message: `Redis handshake failed: ${(error as Error).message}`,
        hint: 'Verify Redis is running and reachable at REDIS_URL (check bind/protected-mode and any password).',
      });
    }
  }

  // ---- 5. Realtime posture (the silent-degradation guard) ------------------
  const standSettings = await deps.readStandSettings();
  const posture = resolveRealtimePosture(env, standSettings);
  notes.push(`Stand realtime posture: ${posture.realtimeMode} (source: ${posture.source}); ENABLE_WEBSOCKETS=${env.ENABLE_WEBSOCKETS ?? '<unset>'}`);

  if (posture.realtimeMode === 'websocket' && !posture.websocketsEnabled) {
    problems.push({
      code: 'realtime.disabled',
      severity: 'error',
      message: `The Stand is configured for real-time sync (${posture.source}) but ENABLE_WEBSOCKETS is not "true", so no Socket.IO server would be started. Members would silently fall back to polling while every health endpoint still reported healthy.`,
      hint: 'Set ENABLE_WEBSOCKETS=true in .env, or switch the Stand to polling mode in Admin → Music Stand Settings.',
    });
  }
  if (posture.realtimeMode === 'polling' && posture.websocketsEnabled) {
    problems.push({
      code: 'realtime.orphan',
      severity: 'warning',
      message: 'ENABLE_WEBSOCKETS=true but the Stand is configured for polling, so the Socket.IO server would start with no client using it.',
      hint: 'Set stand.realtimeMode=websocket in Admin → Music Stand Settings, or set ENABLE_WEBSOCKETS=false.',
    });
  }

  // ---- 6. No baked socket rewrite in the build ------------------------------
  // scripts/serve.ts hosts the socket on the APP port, so nothing about the
  // socket should be frozen into the build. A baked rewrite is an error: it
  // cannot carry a WebSocket upgrade and reintroduces the silent fallback.
  void (env.SOCKET_PORT ?? '').trim();
  if (posture.websocketsEnabled) {
    const manifests = await Promise.all([
      deps.readJsonFile(path.join(rootDir, '.next/routes-manifest.json')),
      deps.readJsonFile(path.join(rootDir, '.next/standalone/.next/routes-manifest.json')),
      deps.readJsonFile(path.join(rootDir, '.next/required-server-files.json')),
    ]);
    const bakedPorts = manifests
      .map((manifest) => extractBakedSocketPort(manifest))
      .filter((port): port is number => port !== null);

    // Both halves of the path contract, because a WebSocket upgrade fails on
    // either one and a polling request succeeds on both:
    //
    //   destination must be SLASHED   — engine.io upstream matches `${path}/`
    //   source      must be SLASHLESS — Next 308s the slashed form and an
    //                                   upgrade cannot follow a redirect
    //
    // Checking only the destination is what let the source drift and hang every
    // upgrade while /ready still reported the sockets healthy.
    const slashed = manifests.some((manifest) => manifest && hasSlashedSocketDestination(manifest));
    const slashlessSource = manifests.some((manifest) => manifest && hasSlashlessSocketSource(manifest));

    // The socket server is now hosted on the SAME port as the app by
    // scripts/serve.ts, so there is no rewrite and no cross-port hop at all.
    // A rewrite cannot work for a WebSocket upgrade regardless of its path
    // shape: Next's production `upgradeHandler` only serves HMR in development
    // and never forwards an upgrade to a rewrite destination, so the browser
    // got a 308 it cannot follow and silently fell back to polling.
    //
    // The guard below therefore asserts the OPPOSITE of the old one: that no
    // socket rewrite is baked into the build. If someone re-adds one, the socket
    // will 308 and every member drops to polling while /ready still reports
    // sockets healthy — precisely the silent degradation this replaced.
    if (slashed || slashlessSource) {
      problems.push({
        code: 'rewrite.unexpected',
        severity: 'error',
        message:
          'The build contains an /api/stand/socket rewrite, but the socket server is hosted on the app port by scripts/serve.ts. A rewrite cannot carry a WebSocket upgrade, so this reintroduces the silent fallback to polling.',
        hint: 'Remove the rewrite from next.config.ts and rebuild. The socket needs no proxy.',
      });
    }

    if (bakedPorts.length > 0) {
      problems.push({
        code: 'rewrite.stale',
        severity: 'warning',
        message: `The build still bakes an /api/stand/socket proxy target (port ${bakedPorts[0]}), which is now unused.`,
        hint: 'Rebuild so the stale rewrite is dropped from the manifest.',
      });
    } else {
      notes.push('No socket rewrite in the build; the socket is served on the app port.');
    }
  }

  // ---- 7. Optional components ----------------------------------------------
  // Both switches below default to ON when unset. They are surfaced as warnings
  // rather than errors because a web-only deployment is a legitimate topology
  // (a second instance serving traffic while another host owns the queues) —
  // but the consequences are entirely silent otherwise: no email is sent, the
  // scheduler never runs, cleanup never happens, and Smart Upload sessions queue
  // forever. Every health endpoint would still report healthy.
  if (isFeatureOff(env, 'ENABLE_WORKER')) {
    problems.push({
      code: 'workers.disabled',
      severity: 'warning',
      message:
        'ENABLE_WORKER=false — the background worker fleet will NOT be started. No email will be sent, the scheduler will not publish scheduled content or fire event reminders, cleanup will not run, and Smart Upload sessions will queue without ever being processed.',
      hint: 'This is a warning, not an error: it is valid when another host runs `npm run start:workers`. If this is meant to be the full stack, set ENABLE_WORKER=true.',
    });
  }

  if (isFeatureOff(env, 'ENABLE_OCR_WORKER')) {
    problems.push({
      code: 'ocr.disabled',
      severity: 'warning',
      message:
        'ENABLE_OCR_WORKER=false — the dedicated OCR fallback worker will NOT be started. Smart Upload still OCRs inline, but the operator-triggered re-run (POST /api/admin/uploads/review/[id]/reocr) will be refused rather than queueing jobs nothing consumes.',
      hint: 'Set ENABLE_OCR_WORKER=true if you use the re-OCR endpoint.',
    });
  }

  // ---- 8. Ports about to be claimed ---------------------------------------
  if (options.ports && options.isPortBusy) {
    const claims: Array<[string, number]> = [
      ['app', options.ports.app],
      ['socket', options.ports.socket],
      ['workerHealth', options.ports.workerHealth],
      ['managerHealth', options.ports.managerHealth],
    ];
    for (const [label, port] of claims) {
      // The socket port is the one that cannot roll forward: the Next rewrite
      // is pinned to it. Everything else rolls forward harmlessly.
      if (label !== 'socket' || !posture.websocketsEnabled) continue;
      if (await options.isPortBusy(port)) {
        problems.push({
          code: 'socket.port-busy',
          severity: 'error',
          message: `SOCKET_PORT ${port} is already in use, and the built rewrite is pinned to it.`,
          hint: `Stop whatever holds ${port} (a previous run, or src/server/socket-worker.ts), or rebuild against a free port.`,
        });
      }
    }
    const busyNotes: string[] = [];
    for (const [label, port] of claims) {
      if (label === 'socket' && posture.websocketsEnabled) continue;
      if (await options.isPortBusy(port)) busyNotes.push(`${label}=${port}`);
    }
    if (busyNotes.length > 0) {
      notes.push(`Ports already in use and will roll forward: ${busyNotes.join(', ')}`);
    }
  }

  if (!(await pathExists(path.join(rootDir, '.next')))) {
    problems.push({
      code: 'build.missing',
      severity: 'error',
      message: 'No production build found at .next/BUILD_ID.',
      hint: 'Run `npm run build` before `npm run start:all`.',
    });
  }

  const errors = problems.filter((p) => p.severity === 'error');
  return { ok: errors.length === 0, problems, notes };
}

/** Render a preflight result as an operator-facing report. */
export function formatPreflightReport(result: PreflightResult): string {
  const lines: string[] = [];
  const errors = result.problems.filter((p) => p.severity === 'error');
  const warnings = result.problems.filter((p) => p.severity === 'warning');

  if (errors.length > 0) {
    lines.push('');
    lines.push(`Preflight failed: ${errors.length} blocking problem${errors.length === 1 ? '' : 's'}:`);
    lines.push('');
    errors.forEach((problem, index) => {
      lines.push(`  ${index + 1}. [${problem.code}] ${problem.message}`);
      if (problem.hint) lines.push(`     → ${problem.hint}`);
    });
  }

  if (warnings.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(`Preflight warnings (${warnings.length}):`);
    warnings.forEach((problem, index) => {
      lines.push(`  ${index + 1}. [${problem.code}] ${problem.message}`);
      if (problem.hint) lines.push(`     → ${problem.hint}`);
    });
  }

  if (lines.length > 0) lines.push('');
  return lines.join('\n');
}