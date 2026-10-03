/**
 * Process Manager for ECCB Platform
 *
 * ONE command that launches every long-running process a real deployment
 * needs, and fails loudly and early when something is missing.
 *
 * Processes started (see `DESIRED_PROCESSES`):
 *
 *   1. `next-server`  — the Next.js application. Serves the public site, the
 *      member portal, every /api route, and proxies /api/stand/socket through
 *      to the stand socket server. That proxy hop is load-bearing for real-time
 *      sync, so it is verified with a real WebSocket upgrade rather than an HTTP
 *      probe: a polling handshake follows Next's 308 and would report success
 *      against a completely broken upgrade path. See
 *      `src/lib/websocket/__tests__/stand-socket-upgrade.test.ts`.
 *   2. `workers`      — `src/workers/index.ts`. Hosts ALL of the following in
 *      a single process, because they share one BullMQ connection and one
 *      Prisma pool:
 *        - BullMQ email worker
 *        - scheduler worker + interval loop (scheduled content, reminders,
 *          daily cleanup)
 *        - Smart Upload processor worker
 *        - OCR worker
 *        - the embedded Socket.IO stand server (src/lib/websocket/stand-socket)
 *
 * There is deliberately NO third child. `src/server/socket-worker.ts` is a
 * standalone entry point for the systemd deployment; running it here as well
 * would double-bind SOCKET_PORT and split stand presence across two servers.
 *
 * Guarantees this file provides:
 *   - Preflight validation (env, database, Redis, storage, realtime posture,
 *     baked rewrite vs runtime SOCKET_PORT) reports EVERY problem at once and
 *     exits 1 before anything spawns.
 *   - `/ready` is backed by real HTTP probes of each child, never by a
 *     non-null `ChildProcess`. A child that spawned and immediately crashed is
 *     never reported ready.
 *   - A singleton lock makes a second `start:all` a deterministic error rather
 *     than a silently duplicated worker fleet.
 *   - Crashed children are restarted with backoff and **freshly re-resolved
 *     ports**, so a restart can never inherit a dead port number.
 *   - SIGINT/SIGTERM stop workers first (letting in-flight BullMQ jobs finish)
 *     then the web server, then release the lock.
 */

import { spawn, ChildProcess } from 'child_process';
import { createServer, Server } from 'http';
import net from 'net';
import 'dotenv/config';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { prepareStandalone, PrepareStandaloneResult } from './prepare-standalone';
import { formatPreflightReport, runPreflight } from './preflight';
import {
  deriveReadiness,
  evaluateNextServerProbe,
  evaluateSocketComponent,
  evaluateWorkerProbe,
  ManagedState,
  probeHttp,
  ProbeResult,
  ReadinessVerdict,
} from './process-state';
import { acquireLock, AlreadyRunningError, DEFAULT_LOCK_DIRNAME } from './process-lock';
import { decideRestart, describeRestartReason } from './restart-policy';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, '..');

// ============================================================================
// Configuration — every value is overridable via `.env`.
// Defaults live in the 322x range to avoid the 300x / 3500x ports already
// occupied on this machine. When a preferred port is busy the manager rolls
// forward to the next free port instead of crashing (see resolveFreePort).
// ============================================================================

const DEFAULT_APP_PORT = 3225;
const DEFAULT_SOCKET_PORT = 3226;
const DEFAULT_WORKER_HEALTH_PORT = 3227;
const DEFAULT_MANAGER_HEALTH_PORT = 3228;
const MAX_PORT_ATTEMPTS = 25;

/** How often the readiness probes run. */
const PROBE_INTERVAL_MS = 5000;
/** Grace period given to a child between SIGTERM and SIGKILL. */
const SHUTDOWN_GRACE_MS = 30_000;
/** A child that stays up this long is considered healthy again (restart budget resets). */
const STABLE_UPTIME_MS = 60_000;
const MAX_RESTARTS = 5;
const RESTART_BASE_DELAY_MS = 1000;
const RESTART_MAX_DELAY_MS = 30_000;
/**
 * How long to wait for SOCKET_PORT to be released by a just-killed worker
 * before concluding another process has claimed it.
 */
const SOCKET_PORT_FREE_TIMEOUT_MS = 10_000;

function parsePort(raw: string | undefined, fallback: number): number {
  const n = raw !== undefined && raw !== '' ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 && n < 65536 ? n : fallback;
}

function isPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolveFree) => {
    const tester = net
      .createServer()
      .once('error', () => resolveFree(false))
      .once('listening', () => tester.close(() => resolveFree(true)))
      .listen(port, host);
  });
}

/**
 * Ports already claimed during this run, mapped to the consumer that claimed
 * them.
 *
 * `isPortFree()` only observes what is currently *bound*. Between resolving the
 * app port and binding the health server nothing is listening yet, so without
 * this map two roll-forwards that land on the same number are handed out twice
 * — the Next.js server and the process-manager health server then race for one
 * port and the loser silently 404s. Recording the owner lets each consumer
 * skip only the ports belonging to the *other* consumers.
 */
const reservedPorts = new Map<number, string>();

const HEALTH_OWNER = 'process-manager-health';

async function resolveFreePort(preferred: number, label: string): Promise<number> {
  let port = preferred;
  for (let i = 0; i < MAX_PORT_ATTEMPTS; i++, port++) {
    if (port > 65535) break;
    const owner = reservedPorts.get(port);
    if (owner !== undefined && owner !== label) continue;
    if (await isPortFree(port)) {
      reservedPorts.set(port, label);
      if (port !== preferred) {
        log('info', `${label}: preferred port ${preferred} is busy — using next available port ${port}`);
      }
      return port;
    }
  }
  throw new Error(`${label}: no free port found in range ${preferred}-${preferred + MAX_PORT_ATTEMPTS - 1}`);
}

/**
 * Claim SOCKET_PORT without rolling forward.
 *
 * `next.config.ts` evaluates `rewrites()` at BUILD time and freezes the
 * /api/stand/socket proxy target into `.next/routes-manifest.json`. A
 * roll-forward here would move the socket server to a port the built proxy
 * will never call — a silent real-time-sync outage. So this port is claimed
 * exactly or not at all; a conflict is reported by the preflight check as a
 * blocking problem with an actionable rebuild instruction.
 *
 * Note this pin exists because the browser reaches the socket through the Next
 * proxy. Both ends of that hop must agree on the path shape — the client asks
 * for the slashless path (Next 308s the slashed one, and an upgrade cannot
 * follow a redirect) and the rewrite destination re-adds the slash (engine.io
 * upstream only matches `${path}/`). See
 * `src/lib/websocket/stand-socket-path.ts`, which all three parties import.
 */
async function claimFixedPort(preferred: number, label: string): Promise<number> {
  const owner = reservedPorts.get(preferred);
  if (owner !== undefined && owner !== label) {
    throw new Error(`${label}: port ${preferred} is already reserved by ${owner} in this run.`);
  }
  if (!(await isPortFree(preferred))) {
    throw new Error(`${label}: port ${preferred} is already in use.`);
  }
  reservedPorts.set(preferred, label);
  return preferred;
}

let PORT = parsePort(process.env.PORT, DEFAULT_APP_PORT);
let SOCKET_PORT = parsePort(process.env.SOCKET_PORT, DEFAULT_SOCKET_PORT);
let WORKER_HEALTH_PORT = parsePort(process.env.WORKER_HEALTH_PORT, DEFAULT_WORKER_HEALTH_PORT);
let MANAGER_HEALTH_PORT = parsePort(process.env.PROCESS_MANAGER_HEALTH_PORT, DEFAULT_MANAGER_HEALTH_PORT);
const RESTART_CRASHED_PROCESSES = process.env.RESTART_CRASHED_PROCESSES === 'true';

/**
 * Whether to start the background worker fleet at all.
 *
 * Defaults to enabled when unset, so existing deployments are unaffected.
 *
 * This exists for the web-only case: running the Next.js server without the
 * workers is useful when a second instance should serve traffic while another
 * host owns the queues, or when diagnosing "is this a web or a worker problem?"
 * on a single box.
 *
 * It is NOT a way to run a production deployment. With no workers nothing sends
 * email, the scheduler never publishes scheduled content or fires reminders,
 * cleanup never runs, and Smart Upload sessions queue and never process. The
 * preflight check emits a prominent warning for exactly this reason, because
 * the failure mode is silent — every endpoint the operator might check reports
 * healthy.
 */
const WORKERS_ENABLED = (() => {
  const raw = (process.env.ENABLE_WORKER ?? '').trim().toLowerCase();
  if (raw === '') return true;
  return raw !== 'false' && raw !== '0' && raw !== 'no';
})();

/**
 * Interface the Next.js server binds to.
 *
 * Defaults to 0.0.0.0 so the app is reachable on this machine's LAN address,
 * its Tailscale address and (behind port forwarding) its public address — the
 * same single origin the `ALLOWED_ORIGINS` allowlist covers. Set
 * `BIND_HOST=127.0.0.1` to restrict the server to loopback.
 */
const BIND_HOST = process.env.BIND_HOST?.trim() || '0.0.0.0';

// ============================================================================
// Process State
// ============================================================================

interface ManagedProcess {
  name: string;
  process: ChildProcess | null;
  command: string;
  args: string[];
  env: Record<string, string>;
  restartCount: number;
  lastRestart: number;
  /** Pending restart timer, so shutdown can cancel it. */
  restartTimer: NodeJS.Timeout | null;
  /** Last known-good port assignment, used as the base for a re-resolve. */
  ports: { app?: number; workerHealth?: number; socket?: number };
}

const processes: Map<string, ManagedProcess> = new Map();
let isShuttingDown = false;
let healthServer: Server | null = null;
let releaseLock: (() => Promise<void>) | null = null;
let probeTimer: NodeJS.Timeout | null = null;

/**
 * True when the deployment expects the embedded Socket.IO stand server.
 *
 * Read once at startup from the same resolution the preflight check uses, so
 * readiness gating and the preflight error can never disagree.
 */
let websocketsExpected = false;

// ============================================================================
// Logging
// ============================================================================

function log(level: 'info' | 'warn' | 'error' | 'debug', message: string, data?: Record<string, unknown>): void {
  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [${level.toUpperCase()}] [ProcessManager]`;
  const dataStr = data ? ` ${JSON.stringify(data)}` : '';
  console.log(`${prefix} ${message}${dataStr}`);
}

// ============================================================================
// Readiness state
// ============================================================================

function stateFor(name: string): ManagedState {
  const managed = processes.get(name);
  return {
    name,
    spawned: managed?.process !== null && managed !== undefined,
    pid: managed?.process?.pid ?? null,
    lastProbe: null,
    failureCount: 0,
    restartCount: managed?.restartCount ?? 0,
    lastExit: null,
    startedAt: null,
  };
}

/** Last probe result per component, refreshed by the probe loop. */
const lastProbes = new Map<string, ProbeResult>();

function currentStates(): ManagedState[] {
  return [...processes.keys()].map((name) => {
    const base = stateFor(name);
    return { ...base, lastProbe: lastProbes.get(name) ?? null };
  });
}

/**
 * Probe every child and cache the result.
 *
 * Next.js is probed on `/api/health`, which reports database and Redis
 * connectivity, so "listening but unable to reach its dependencies" is
 * reported as not ready. The worker is probed on `/ready`, which already
 * aggregates queue initialisation and each individual worker.
 */
async function runProbes(): Promise<void> {
  const tasks: Array<Promise<void>> = [];

  if (processes.has('next-server')) {
    tasks.push(
      probeHttp(PORT, '/api/health').then((result) => {
        lastProbes.set('next-server', {
          ...result,
          ok: evaluateNextServerProbe(result),
        });
      }),
    );
  }

  if (processes.has('workers')) {
    tasks.push(
      probeHttp(WORKER_HEALTH_PORT, '/ready').then((result) => {
        lastProbes.set('workers', {
          ...result,
          ok: evaluateWorkerProbe(result),
        });
      }),
    );
  }

  await Promise.allSettled(tasks);
}

function readinessSnapshot(): {
  verdict: ReadinessVerdict;
  components: Record<string, string>;
  details: Record<string, unknown>;
} {
  const states = currentStates();
  if (states.length === 0) {
    return { verdict: 'not-ready', components: {}, details: {} };
  }
  const result = deriveReadiness(states, {
    requireSockets: websocketsExpected,
    probeSockets: evaluateSocketComponent,
  });
  return {
    verdict: result.verdict,
    components: result.components as Record<string, string>,
    details: result.details,
  };
}

// ============================================================================
// Process Management
// ============================================================================

/**
 * Build the command line that runs `src/workers/index.ts` in-process.
 *
 * `src/workers/index.ts` is TypeScript and is not compiled, so it needs a
 * loader. The obvious `npx tsx src/workers/index.ts` is unusable here because
 * it inserts THREE processes (`npx` → `sh -c tsx` → `node --import tsx`).
 * The manager would then supervise the outermost one: any kill orphaned the
 * real worker, which kept its BullMQ connections and held SOCKET_PORT and the
 * worker health port forever — so a restart could never rebind them and the
 * worker stayed dead.
 *
 * `node --import tsx <entry>` runs the worker in the SAME process, so the
 * supervised PID is the worker itself: signals reach it, `exit` fires for it,
 * and its ports are released before the manager probes them.
 */
function workerCommandLine(): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: ['--import', 'tsx', resolve(ROOT_DIR, 'src/workers/index.ts')],
  };
}

/**
 * Spawn a managed process.
 *
 * `env` is captured on the ManagedProcess so a restart rebuilds an identical
 * command line — see `restartProcess` for the port re-resolution that must
 * happen first.
 */
function spawnProcess(name: string, command: string, args: string[], env: Record<string, string> = {}): ChildProcess {
  log('info', `Spawning ${name}...`, { command, args });

  const proc = spawn(command, args, {
    cwd: ROOT_DIR,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    // Never use shell:true with an args array: arguments are concatenated
    // unescaped (security risk, DEP0190). execvp resolves npx via PATH.
    shell: false,
  });

  const forward = (stream: NodeJS.ReadableStream | null, write: (line: string) => void): void => {
    let buffer = '';
    stream?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      // Chunk boundaries do not align with line boundaries; hold the partial
      // tail so interleaved output from two children stays readable.
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) write(line);
    });
  };

  forward(proc.stdout, (line) => console.log(`[${name}] ${line}`));
  forward(proc.stderr, (line) => console.error(`[${name}] ${line}`));

  proc.on('exit', (code, signal) => {
    log(code === 0 ? 'info' : 'warn', `Process ${name} exited`, { code, signal });

    const managed = processes.get(name);
    if (managed) {
      // Clear the cached probe: a probe result from the previous incarnation
      // must never make a just-crashed child look healthy.
      lastProbes.delete(name);
      if (managed.process === proc) managed.process = null;
    }

    if (!isShuttingDown && RESTART_CRASHED_PROCESSES && (code !== 0 || signal !== null)) {
      scheduleRestart(name, code, signal);
    } else if (!isShuttingDown && (code !== 0 || signal !== null)) {
      log(
        'error',
        `Process ${name} crashed and RESTART_CRASHED_PROCESSES is disabled — the stack is now degraded.`,
        { code, signal, hint: 'Set RESTART_CRASHED_PROCESSES=true to have the supervisor restart it.' },
      );
    }
  });

  proc.on('error', (error) => {
    log('error', `Process ${name} error`, { error: error.message });
  });

  return proc;
}

/**
 * Restart a crashed child.
 *
 * Two defects this replaces:
 *
 *  - **Restart storm.** The previous logic re-read `lastRestart` before the
 *    1s delay and compared against a value only mutated inside the timer, so a
 *    process failing instantly in a loop consumed its whole restart budget in
 *    under a second and then gave up silently. Now the delay is exponential,
 *    the budget resets after `STABLE_UPTIME_MS` of healthy uptime, and giving
 *    up is logged at error level with the exit code.
 *
 *  - **Inherited dead port.** A restart reused the ORIGINAL env, including the
 *    original `PORT`. If the crash was EADDRINUSE — precisely the reason a
 *    port gets rolled forward — the restarted child was handed the same dead
 *    port and crashed identically, five times. Ports are now re-resolved from
 *    the preferred base before every restart.
 */
function scheduleRestart(name: string, exitCode: number | null, exitSignal: NodeJS.Signals | null): void {
  const managed = processes.get(name);
  if (!managed) return;

  const decision = decideRestart({
    enabled: RESTART_CRASHED_PROCESSES,
    isShuttingDown,
    exitCode,
    exitSignal,
    restartCount: managed.restartCount,
    lastRestart: managed.lastRestart,
    now: Date.now(),
    maxRestarts: MAX_RESTARTS,
    stableUptimeMs: STABLE_UPTIME_MS,
    baseDelayMs: RESTART_BASE_DELAY_MS,
    maxDelayMs: RESTART_MAX_DELAY_MS,
  });

  if (!decision.shouldRestart) {
    if (decision.reason === 'budget-exhausted') {
      log('error', `${name} has crashed ${decision.attempt} times without staying up — not restarting`, {
        restartCount: decision.attempt,
        exitCode,
        exitSignal,
        hint: 'Fix the underlying failure, then restart the process manager.',
      });
    } else if (decision.reason === 'restart-disabled') {
      log('error', `${name} crashed and the stack is now degraded`, {
        exitCode,
        exitSignal,
        reason: describeRestartReason(decision.reason),
        hint: 'Set RESTART_CRASHED_PROCESSES=true to have the supervisor restart it.',
      });
    }
    return;
  }

  managed.restartCount = decision.attempt;
  // Stamp the ATTEMPT time, not just the last successful spawn. `lastRestart`
  // doubles as the stability marker, and leaving it at the original boot time
  // meant the stability window kept expiring during a crash loop — resetting
  // the budget on every attempt and retrying forever at ~11s intervals.
  managed.lastRestart = Date.now();
  log('warn', `Restarting ${name} in ${decision.delayMs}ms`, {
    attempt: decision.attempt,
    of: MAX_RESTARTS,
    exitCode,
    exitSignal,
  });

  managed.restartTimer = setTimeout(() => {
    managed.restartTimer = null;
    void restartProcess(managed);
  }, decision.delayMs);
}

async function restartProcess(managed: ManagedProcess): Promise<void> {
  if (isShuttingDown) return;
  try {
    await refreshPorts(managed);
    managed.process = spawnProcess(managed.name, managed.command, managed.args, managed.env);
    managed.lastRestart = Date.now();
    lastProbes.delete(managed.name);
  } catch (error) {
    log('error', `Failed to restart ${managed.name}`, { error: (error as Error).message });
    // A failed restart must NOT be terminal. Re-enter the policy so the
    // backoff and the restart budget govern the retries. Without this the
    // manager would log one error and then sit with the child down forever,
    // reporting "not ready" without ever trying again.
    scheduleRestart(managed.name, 1, null);
  }
}

/**
 * Wait for SOCKET_PORT to be released.
 *
 * A SIGKILLed child can keep the port bound for a short window (TIME_WAIT on
 * the listening socket, and the OS reclaiming it asynchronously). Probing
 * once and giving up turned a transient condition into a permanently dead
 * worker, so the probe is retried over a bounded window.
 */
async function waitForSocketPortFree(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await isPortFree(port)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 500));
  }
}

/**
 * Re-resolve the ports a child owns, and rebuild its env/args.
 *
 * Called before every restart. `next-server` uses `PORT`; `workers` uses
 * `WORKER_HEALTH_PORT` and `SOCKET_PORT`.
 *
 * SOCKET_PORT is special: `next.config.ts` freezes the /api/stand/socket
 * rewrite into the build manifest at BUILD time, so the proxy target cannot
 * follow a roll-forward. The manager therefore re-checks SOCKET_PORT and, if
 * it is occupied, refuses the restart with an explanation instead of letting
 * the worker bind somewhere the proxy will never reach.
 */
async function refreshPorts(managed: ManagedProcess): Promise<void> {
  if (managed.name === 'next-server') {
    const next = await resolveFreePort(parsePort(process.env.PORT, DEFAULT_APP_PORT), 'Next.js server');
    managed.ports.app = next;
    PORT = next;
    managed.env = { ...managed.env, PORT: String(next) };
    // In `next start` mode the port is also on the command line, so the args
    // array has to follow the re-resolved value. Detect the flag rather than
    // the launcher: the child is now `node <next-bin> start -p <port>`.
    const idx = managed.args.indexOf('-p');
    if (idx !== -1 && idx + 1 < managed.args.length) managed.args[idx + 1] = String(next);
    return;
  }

  if (managed.name === 'workers') {
    // SOCKET_PORT cannot move, but it is usually only transiently held by the
    // process that just died. Give the OS a bounded window to release it before
    // concluding that something else has genuinely claimed the port.
    if (websocketsExpected && !(await waitForSocketPortFree(SOCKET_PORT, SOCKET_PORT_FREE_TIMEOUT_MS))) {
      throw new Error(
        `SOCKET_PORT ${SOCKET_PORT} is still occupied after ${SOCKET_PORT_FREE_TIMEOUT_MS}ms. The production ` +
          'build proxies /api/stand/socket to that exact port, so the worker cannot move it. Something other ' +
          'than the previous worker is holding it — stop that, or rebuild against a different SOCKET_PORT.',
      );
    }
    const workerHealth = await resolveFreePort(
      parsePort(process.env.WORKER_HEALTH_PORT, DEFAULT_WORKER_HEALTH_PORT),
      'Worker health server',
    );
    WORKER_HEALTH_PORT = workerHealth;
    managed.ports.workerHealth = workerHealth;
    managed.env = { ...managed.env, WORKER_HEALTH_PORT: String(workerHealth) };
  }
}

/**
 * Start the Next.js server on the already-resolved PORT.
 *
 * `prepareStandalone()` has already synchronised `.next/static` and `public/`
 * into `.next/standalone/`, so the standalone bundle serves a fully styled app.
 * When standalone output is missing or stale the preparation step reports
 * `next-start` and this function falls back to `next start`, which serves the
 * full `.next` directory and needs no asset copy.
 *
 * NOTE: `src/server/socket-worker.ts` is deliberately NOT started here. The
 * workers process already hosts the embedded Socket.IO stand server
 * (src/workers/index.ts); a second bind would collide on SOCKET_PORT.
 *
 * NODE_ENV is forced to production for children because `.env` ships
 * NODE_ENV=development, which makes Next warn and workers behave differently
 * from a release build.
 */
function startNextServer(prepared: PrepareStandaloneResult): void {
  if (prepared.mode === 'missing') {
    throw new Error('No production build available — run `npm run build` before `npm run start:all`');
  }

  // Run the server entry directly rather than through `npx`, for the same
  // reason the workers do: npx inserts a wrapper process, so the supervised
  // PID would not be the server and a kill would orphan it with the app port
  // still bound.
  // The app server is `scripts/serve.ts`, which hosts Next AND the stand
  // Socket.IO server on this single port. It must NOT be the standalone
  // bundle: that bundle calls Next's startServer, whose `upgradeHandler`
  // only serves HMR in development and never forwards an upgrade to a
  // rewrite, so a socket reached through it can never complete a handshake.
  // Running serve.ts under tsx keeps a single supervised PID (no npx wrapper
  // to orphan) while giving the socket a real upgrade path.
  const managed: ManagedProcess = {
    name: 'next-server',
    process: null,
    command: process.execPath,
    args: ['--import', 'tsx', resolve(ROOT_DIR, 'scripts/serve.ts')],
    env: {
      PORT: String(PORT),
      HOSTNAME: BIND_HOST,
      BIND_HOST,
      NODE_ENV: 'production',
    },
    restartCount: 0,
    lastRestart: 0,
    restartTimer: null,
    ports: { app: PORT },
  };

  log('info', 'Unified app server (scripts/serve.ts): Next + stand socket on one port', {
    bindHost: BIND_HOST,
    socketsAttachedToAppPort: process.env.ENABLE_WEBSOCKETS === 'true',
    // Retained for diagnostics: assets are still synced into .next/standalone
    // by prepareStandalone(), and serve.ts serves from the same .next output.
    preparedMode: prepared.mode,
    copied: prepared.copied,
  });

  managed.process = spawnProcess(managed.name, managed.command, managed.args, managed.env);
  managed.lastRestart = Date.now();
  processes.set(managed.name, managed);
}

/**
 * Start the background workers.
 *
 * The env passed here is explicit rather than inherited, because two of these
 * values must match what the preflight check validated and what the Next.js
 * rewrite was compiled against:
 *
 *   ENABLE_WEBSOCKETS  — whether to start the embedded Socket.IO stand server.
 *   SOCKET_PORT        — must equal the port baked into the build manifest, or
 *                        the /api/stand/socket proxy 404s.
 *   WORKER_HEALTH_PORT — must match the port the manager probes for readiness.
 *
 * Skipped entirely when `ENABLE_WORKER=false`. Because the probe loop and
 * `stopAllProcesses()` are both keyed on the `processes` map, a fleet that was
 * never spawned is never probed, never waited on during shutdown, and never
 * contributes a not-ready verdict — the readiness model stays honest about
 * "disabled" instead of reporting a component that will never answer.
 */
function startWorkers(): void {
  if (!WORKERS_ENABLED) {
    log('warn', 'Background workers DISABLED (ENABLE_WORKER=false) — not starting', {
      consequence:
        'No email, no scheduler, no cleanup, and Smart Upload sessions will queue without ever being processed.',
      hint: 'Set ENABLE_WORKER=true, or run the workers on another host via `npm run start:workers`.',
    });
    return;
  }

  const worker = workerCommandLine();
  const managed: ManagedProcess = {
    name: 'workers',
    process: null,
    command: worker.command,
    args: worker.args,
    env: {
      WORKER_HEALTH_PORT: String(WORKER_HEALTH_PORT),
      NODE_ENV: 'production',
      ENABLE_WEBSOCKETS: websocketsExpected ? 'true' : 'false',
      SOCKET_PORT: String(SOCKET_PORT),
    },
    restartCount: 0,
    lastRestart: 0,
    restartTimer: null,
    ports: { workerHealth: WORKER_HEALTH_PORT, socket: SOCKET_PORT },
  };

  managed.process = spawnProcess(managed.name, managed.command, managed.args, managed.env);
  managed.lastRestart = Date.now();
  processes.set(managed.name, managed);
}

/**
 * Stop a managed process.
 *
 * SIGTERM first so the worker can drain in-flight BullMQ jobs, then SIGKILL
 * after `SHUTDOWN_GRACE_MS`. The grace period is generous on purpose:
 * `DEPLOYMENT.md` documents that aborting a Smart Upload job mid-transaction
 * leaves sessions stuck in `IN_PROGRESS`, which requires manual repair.
 */
async function stopProcess(name: string): Promise<void> {
  const managed = processes.get(name);
  if (!managed) return;

  if (managed.restartTimer) {
    clearTimeout(managed.restartTimer);
    managed.restartTimer = null;
  }
  if (!managed.process) {
    log('info', `${name} is not running`);
    return;
  }

  log('info', `Stopping ${name} (pid ${managed.process.pid})...`);

  return new Promise((resolve) => {
    const proc = managed.process as ChildProcess;
    let resolved = false;

    // Deliberately NOT unref'd: this timer is the backstop that guarantees a
    // wedged child is killed. If the event loop were otherwise empty it must
    // still be able to fire.
    const timeout = setTimeout(() => {
      if (!resolved) {
        log('warn', `${name} did not exit gracefully after ${SHUTDOWN_GRACE_MS}ms, forcing kill`);
        proc.kill('SIGKILL');
        resolved = true;
        resolve();
      }
    }, SHUTDOWN_GRACE_MS);

    proc.once('exit', () => {
      if (!resolved) {
        clearTimeout(timeout);
        resolved = true;
        resolve();
      }
    });

    proc.kill('SIGTERM');
  });
}

/**
 * Stop all processes.
 *
 * Workers first: they own the BullMQ queues and the Socket.IO adapter, and
 * they must be allowed to finish in-flight jobs while the web server is still
 * accepting traffic. Then the web server, so no request arrives for a
 * dependency that has already gone away.
 */
async function stopAllProcesses(): Promise<void> {
  log('info', 'Stopping all processes...');
  await stopProcess('workers');
  await stopProcess('next-server');
  log('info', 'All processes stopped');
}

// ============================================================================
// Health Check Server
// ============================================================================

/**
 * Start the process manager health check server, rolling forward when the
 * preferred port is already taken.
 */
function startHealthServer(): void {
  healthServer = createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    const snapshot = readinessSnapshot();

    const send = (statusCode: number, payload: unknown): void => {
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload, null, url === '/ready' ? 0 : 2));
    };

    if (url === '/health') {
      // Liveness: is the manager itself up? Always 200 — a 503 here from a
      // supervisor would restart the manager while its children are draining.
      send(200, {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        verdict: snapshot.verdict,
        workersEnabled: WORKERS_ENABLED,
        processes: snapshot.components,
      });
      return;
    }

    if (url === '/ready') {
      // Readiness: every child must answer its probe. Never derived from a
      // non-null ChildProcess.
      //
      // `workersEnabled` is reported so a caller can tell "the worker fleet is
      // deliberately off" from "the worker fleet is down". Without it a web-only
      // deployment is indistinguishable from a healthy full one, and an operator
      // has no way to discover that email and the scheduler are not running.
      send(snapshot.verdict === 'ready' ? 200 : 503, {
        ready: snapshot.verdict === 'ready',
        verdict: snapshot.verdict,
        timestamp: new Date().toISOString(),
        workersEnabled: WORKERS_ENABLED,
        processes: snapshot.components,
        details: snapshot.details,
      });
      return;
    }

    send(404, { error: 'Not found' });
  });

  const preferred = MANAGER_HEALTH_PORT;
  let port = preferred;
  const tryBind = (): void => {
    healthServer?.removeAllListeners('error');
    healthServer?.once('error', (err: NodeJS.ErrnoException) => {
      if (err?.code === 'EADDRINUSE' && port - preferred < MAX_PORT_ATTEMPTS - 1) {
        log('info', `Process manager health port ${port} is busy — trying ${port + 1}`);
        reservedPorts.set(port, HEALTH_OWNER);
        port++;
        tryBind();
      } else {
        log('error', 'Process manager health server failed to bind', { error: err.message });
      }
    });
    healthServer?.listen(port, () => {
      MANAGER_HEALTH_PORT = port;
      log(
        'info',
        port !== preferred
          ? `Process manager health server listening on ${port} (preferred ${preferred} was busy)`
          : `Process manager health server listening on ${port}`,
      );
    });
  };
  tryBind();
}

function stopHealthServer(): Promise<void> {
  return new Promise((resolve) => {
    if (healthServer) {
      healthServer.close(() => {
        log('info', 'Health check server stopped');
        resolve();
      });
      healthServer = null;
    } else {
      resolve();
    }
  });
}

// ============================================================================
// Graceful Shutdown
// ============================================================================

async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    log('warn', 'Shutdown already in progress, ignoring signal', { signal });
    return;
  }

  isShuttingDown = true;
  log('info', `Received ${signal}, starting graceful shutdown...`);

  if (probeTimer) {
    clearInterval(probeTimer);
    probeTimer = null;
  }

  // Stop the health check server first so nothing new is routed here while the
  // children are draining.
  await stopHealthServer();

  // Workers first (in-flight BullMQ jobs finish), then the web server.
  await stopAllProcesses();

  if (releaseLock) {
    await releaseLock();
    releaseLock = null;
  }

  log('info', 'Graceful shutdown complete');
  process.exit(0);
}

// ============================================================================
// Main Entry Point
// ============================================================================

async function main(): Promise<void> {
  log('info', 'Starting ECCB Process Manager...');

  // ------------------------------------------------------------------------
  // Singleton guard. Before anything else, so a second `start:all` fails with
  // a clear message instead of starting a duplicate worker fleet.
  // ------------------------------------------------------------------------
  const lock = await acquireLock(
    {
      pid: process.pid,
      appPort: PORT,
      workerHealthPort: WORKER_HEALTH_PORT,
      managerHealthPort: MANAGER_HEALTH_PORT,
      socketPort: SOCKET_PORT,
    },
    { lockDir: resolve(ROOT_DIR, DEFAULT_LOCK_DIRNAME) },
  ).catch((error: unknown) => {
    if (error instanceof AlreadyRunningError) throw error;
    // A lock that cannot be written (read-only .next) must not block a start.
    log('warn', 'Could not acquire the process-manager lock', { error: (error as Error).message });
    return null;
  });
  if (lock) {
    releaseLock = lock.release;
    log('info', 'Acquired process manager lock', { pid: process.pid, lockDir: DEFAULT_LOCK_DIRNAME });
  }

  // ------------------------------------------------------------------------
  // Build preparation. Without this the standalone server 404s on every
  // stylesheet and the site renders unstyled.
  // ------------------------------------------------------------------------
  const prepared = await prepareStandalone();
  log('info', 'Build preparation complete', { mode: prepared.mode, copied: prepared.copied });
  for (const warning of prepared.warnings) log('warn', warning);

  if (prepared.mode === 'missing') {
    log('error', 'Aborting: no production build found. Run `npm run build`, then `npm run start:all`.');
    process.exit(1);
  }

  // ------------------------------------------------------------------------
  // Resolve every port BEFORE spawning children so `next start -p` never hits
  // EADDRINUSE.
  //
  // SOCKET_PORT is deliberately NOT rolled forward. `next.config.ts` freezes
  // the /api/stand/socket proxy target into the build manifest, so moving the
  // socket server would leave the proxy calling a port nothing listens on. It
  // is claimed exactly or not at all; a conflict becomes the preflight
  // `socket.port-busy` error with the rebuild command, which is far more
  // useful than a silent real-time-sync outage.
  PORT = await resolveFreePort(PORT, 'Next.js server');
  SOCKET_PORT = await claimFixedPort(SOCKET_PORT, 'Embedded socket server').catch(() => {
    // Deliberately not fatal here: preflight turns this into a
    // `socket.port-busy` problem carrying the rebuild command, which is a far
    // better operator experience than a bare "port in use" throw.
    return SOCKET_PORT;
  });
  WORKER_HEALTH_PORT = await resolveFreePort(WORKER_HEALTH_PORT, 'Worker health server');
  MANAGER_HEALTH_PORT = await resolveFreePort(MANAGER_HEALTH_PORT, HEALTH_OWNER);
  process.env.PORT = String(PORT);
  process.env.SOCKET_PORT = String(SOCKET_PORT);
  process.env.WORKER_HEALTH_PORT = String(WORKER_HEALTH_PORT);
  process.env.PROCESS_MANAGER_HEALTH_PORT = String(MANAGER_HEALTH_PORT);

  // ------------------------------------------------------------------------
  // Preflight. Reports every problem at once and exits 1 before spawning.
  // ------------------------------------------------------------------------
  const preflight = await runPreflight({
    ports: { app: PORT, socket: SOCKET_PORT, workerHealth: WORKER_HEALTH_PORT, managerHealth: MANAGER_HEALTH_PORT },
    isPortBusy: async (port: number) => !(await isPortFree(port)),
  });

  for (const note of preflight.notes) log('info', `Preflight: ${note}`);

  if (!preflight.ok) {
    console.error(formatPreflightReport(preflight));
    log('error', `Aborting: preflight found ${preflight.problems.filter((p) => p.severity === 'error').length} blocking problem(s). No processes were started.`);
    if (releaseLock) {
      await releaseLock();
      releaseLock = null;
    }
    process.exit(1);
  }

  const report = formatPreflightReport(preflight);
  if (report.trim().length > 0) console.warn(report);

  // The same ENABLE_WEBSOCKETS value the preflight validated is what the
  // worker child receives, and what gates readiness.
  websocketsExpected = process.env.ENABLE_WEBSOCKETS === 'true';

  log('info', 'Configuration', {
    mode: prepared.mode,
    port: PORT,
    bindHost: BIND_HOST,
    socketPort: SOCKET_PORT,
    workerHealthPort: WORKER_HEALTH_PORT,
    managerHealthPort: MANAGER_HEALTH_PORT,
    standSocketServer: websocketsExpected ? 'enabled' : 'disabled',
    workers: WORKERS_ENABLED ? 'enabled' : 'DISABLED',
    restartCrashedProcesses: RESTART_CRASHED_PROCESSES,
  });

  // Signal handlers are registered BEFORE the first spawn. Previously they
  // were attached after a 2s sleep following the spawn, so a Ctrl-C in that
  // window killed the manager with no handler at all, orphaning the children.
  process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => void gracefulShutdown('SIGINT'));

  // Start health check server
  startHealthServer();

  // Start Next.js server
  startNextServer(prepared);

  if (WORKERS_ENABLED) {
    // Wait a bit before starting workers. The web server owns the
    // schema-facing instrumentation bootstrap; workers can connect to the same
    // database independently, so this is a courtesy stagger rather than a
    // dependency. Skipped when workers are disabled — there is nothing to wait
    // for, and the delay would be pure dead time on every boot.
    await new Promise((r) => setTimeout(r, 2000));
  }

  // Start background workers (also hosts the Socket.IO stand server)
  startWorkers();

  // Begin readiness probing. The first probe runs immediately so a child that
  // spawned and crashed is visible within one tick rather than one interval.
  await runProbes();
  probeTimer = setInterval(() => {
    void runProbes().then(() => {
      const snapshot = readinessSnapshot();
      if (snapshot.verdict === 'not-ready') {
        log('warn', 'Stack is not ready', { processes: snapshot.components });
      }
    });
  }, PROBE_INTERVAL_MS);
  probeTimer.unref?.();

  const snapshot = readinessSnapshot();
  log('info', 'ECCB Process Manager started', {
    readiness: snapshot.verdict,
    processes: snapshot.components,
    healthEndpoint: `http://127.0.0.1:${MANAGER_HEALTH_PORT}/health`,
  });

  // Handle uncaught errors. The previous handler only logged, leaving a
  // process manager running in an unknown state while still answering
  // /health with 200 — the worst possible outcome for a supervisor.
  process.on('unhandledRejection', (reason) => {
    log('error', 'Unhandled Rejection', { reason: reason instanceof Error ? reason.message : String(reason) });
  });

  process.on('uncaughtException', (error) => {
    log('error', 'Uncaught Exception', { error: error.message, stack: error.stack });
    void gracefulShutdown('uncaughtException');
  });
}

// Run main
main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  log('error', 'Failed to start process manager', {
    error: message,
    ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
  });
  if (releaseLock) {
    void releaseLock();
  }
  process.exit(1);
});