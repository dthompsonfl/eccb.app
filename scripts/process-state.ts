/**
 * Runtime process state for the ECCB process manager.
 *
 * Separated from `scripts/start.ts` so the state machine can be unit-tested
 * without spawning children or binding ports.
 *
 * The central invariant: **a live `ChildProcess` object is not readiness.**
 * A process that spawned and immediately exited has a non-null handle for the
 * duration of the `exit` event, and a process that spawned and is wedged
 * (DB unreachable, port lost in a race) keeps a live handle forever. Readiness
 * is therefore defined by an actual probe of the process's HTTP endpoint.
 */

import http from 'http';

export type ComponentState = 'starting' | 'ready' | 'degraded' | 'down';

export interface ProbeResult {
  ok: boolean;
  statusCode?: number;
  /** Parsed JSON body when the endpoint returned one. */
  body?: Record<string, unknown>;
  error?: string;
  latencyMs: number;
}

export interface ManagedState {
  name: string;
  /** Whether a child handle currently exists. Necessary but not sufficient. */
  spawned: boolean;
  /** PID of the live child, or null when nothing is running. */
  pid: number | null;
  /** Result of the most recent probe. `null` until the first probe runs. */
  lastProbe: ProbeResult | null;
  /** Consecutive probe failures. */
  failureCount: number;
  restartCount: number;
  lastExit: { code: number | null; signal: NodeJS.Signals | null; at: number } | null;
  startedAt: number | null;
}

export type ReadinessVerdict = 'ready' | 'starting' | 'not-ready';

/**
 * Roll the probe outcome into component state.
 *
 * `degraded` is distinct from `down`: an endpoint that answers 200 but reports
 * an unhealthy payload is up-but-wrong, which must not read as ready while
 * also not being indistinguishable from a dead process.
 */
export function deriveComponentState(state: ManagedState): ComponentState {
  if (!state.spawned) return 'down';
  if (!state.lastProbe) return 'starting';
  if (state.lastProbe.ok) return 'ready';
  if (state.lastProbe.statusCode !== undefined) return 'degraded';
  return 'down';
}

/**
 * Decide overall readiness.
 *
 * Every managed component must be `ready`. A single `degraded` component makes
 * the whole stack not ready — a half-working deployment must not be advertised
 * to a load balancer.
 */
export function deriveReadiness(
  states: ManagedState[],
  options: { requireSockets: boolean } = { requireSockets: false },
): { verdict: ReadinessVerdict; components: Record<string, ComponentState>; details: Record<string, unknown> } {
  const components: Record<string, ComponentState> = {};
  const details: Record<string, unknown> = {};

  for (const state of states) {
    const componentState = deriveComponentState(state);
    components[state.name] = componentState;
    details[state.name] = {
      state: componentState,
      pid: state.pid,
      restartCount: state.restartCount,
      lastExit: state.lastExit,
      probe: state.lastProbe
        ? {
            ok: state.lastProbe.ok,
            statusCode: state.lastProbe.statusCode ?? null,
            error: state.lastProbe.error ?? null,
            latencyMs: state.lastProbe.latencyMs,
            body: state.lastProbe.body ?? null,
          }
        : null,
    };
  }

  if (states.length === 0) {
    return { verdict: 'not-ready', components, details };
  }

  const anyStarting = Object.values(components).some((s) => s === 'starting');
  const allReady = Object.values(components).every((s) => s === 'ready');

  if (allReady) {
    // The worker process hosts the embedded Socket.IO stand server. When the
    // deployment expects real-time sync, a worker that reports
    // `sockets: false` is a silent downgrade to polling and must not pass.
    const socketsExpected = options.requireSockets;
    const workerBody = socketsExpected ? findWorkerBody(states) : undefined;
    if (socketsExpected && workerBody !== undefined && workerBody.sockets !== true) {
      return {
        verdict: 'not-ready',
        components,
        details: {
          ...details,
          sockets: {
            state: 'down',
            reason: 'Stand real-time sync is enabled but the embedded Socket.IO server is not running in the worker process.',
          },
        },
      };
    }
    return { verdict: 'ready', components, details };
  }

  return { verdict: anyStarting ? 'starting' : 'not-ready', components, details };
}

function findWorkerBody(states: ManagedState[]): Record<string, unknown> | undefined {
  const worker = states.find((s) => s.name === 'workers');
  const body = worker?.lastProbe?.body;
  return body && typeof body === 'object' ? (body as Record<string, unknown>) : undefined;
}

// ============================================================================
// HTTP probe
// ============================================================================

export interface HttpProbeOptions {
  host?: string;
  timeoutMs?: number;
  /** Status codes treated as a healthy endpoint. Default: 200-399. */
  accept?: (statusCode: number) => boolean;
}

/**
 * GET a local HTTP endpoint and classify the response.
 *
 * Any HTTP response at all — including 503 — proves the process is listening
 * and serving, which is the question `/ready` is asking. The distinction
 * between "up" and "up but unhealthy" is carried in the result rather than
 * collapsed into a boolean.
 */
export function probeHttp(
  port: number,
  requestPath: string,
  options: HttpProbeOptions = {},
): Promise<ProbeResult> {
  const { host = '127.0.0.1', timeoutMs = 4000 } = options;
  const accept = options.accept ?? ((code: number) => code >= 200 && code < 400);
  const startedAt = Date.now();

  return new Promise<ProbeResult>((resolve) => {
    let settled = false;
    const finish = (result: Omit<ProbeResult, 'latencyMs'>): void => {
      if (settled) return;
      settled = true;
      resolve({ ...result, latencyMs: Date.now() - startedAt });
    };

    const request = http.request(
      { host, port, path: requestPath, method: 'GET', timeout: timeoutMs },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          // Cap the read so an unexpectedly chatty endpoint cannot stall the
          // probe. Health payloads are a few hundred bytes.
          if (size > 64 * 1024) return;
          size += chunk.length;
          chunks.push(chunk);
        });
        response.on('end', () => {
          const statusCode = response.statusCode ?? 0;
          let body: Record<string, unknown> | undefined;
          try {
            const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              body = parsed as Record<string, unknown>;
            }
          } catch {
            body = undefined;
          }
          finish({ ok: accept(statusCode), statusCode, body });
        });
        response.on('error', (error: Error) => finish({ ok: false, error: error.message }));
      },
    );

    request.on('timeout', () => {
      request.destroy();
      finish({ ok: false, error: `timeout after ${timeoutMs}ms` });
    });
    request.on('error', (error: Error) => finish({ ok: false, error: error.message }));
    request.end();
  });
}

/**
 * Readiness for the Next.js server.
 *
 * `/api/health` reports database and Redis connectivity, so a server that is
 * listening but cannot reach its dependencies is correctly reported as not
 * ready rather than ready-and-broken.
 */
export function evaluateNextServerProbe(result: ProbeResult): boolean {
  if (!result.ok || result.statusCode === undefined) return false;
  if (result.statusCode >= 500) return false;
  const body = result.body;
  if (!body) return true;
  const status = body.status;
  return status !== 'unhealthy';
}

/**
 * Readiness for the worker process.
 *
 * The worker exposes `/ready`, which already aggregates queue initialisation
 * and each individual worker. `ready: false` in the payload means the process
 * is listening but the queues are not usable.
 */
export function evaluateWorkerProbe(result: ProbeResult): boolean {
  if (!result.ok || result.statusCode === undefined) return false;
  const body = result.body;
  if (!body) return result.statusCode < 400;
  return body.ready === true;
}