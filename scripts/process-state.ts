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
  options: { requireSockets: boolean; probeSockets?: (result: ProbeResult) => { expected: boolean; attached: boolean } | undefined } = { requireSockets: false },
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
    // The Stand socket server is hosted by the APP SERVER process
    // (`scripts/serve.ts`), so its real attach state is reported on the
    // next-server probe's `/api/health` payload — not on the workers' `/ready`.
    //
    // The previous implementation read `sockets` from the WORKERS payload. That
    // field is derived from `ENABLE_WEBSOCKETS` in `src/workers/index.ts`, i.e.
    // from the environment rather than from what actually bound, so it was
    // `true` by construction whenever realtime was expected and the gate could
    // never fail. The check that exists specifically to prevent silent fallback
    // to polling was structurally incapable of detecting it.
    if (options.requireSockets) {
      const nextServerProbe = states.find((s) => s.name === 'next-server')?.lastProbe;
      const socketState = nextServerProbe
        ? (options.probeSockets ?? defaultProbeSockets)(nextServerProbe)
        : undefined;

      // An unknown socket state means the app server predates the `sockets`
      // health field. Treat it as NOT ready rather than assuming health: a
      // realtime deployment whose socket state cannot be observed is exactly the
      // unverifiable configuration this gate exists to reject.
      if (socketState === undefined) {
        return {
          verdict: 'not-ready',
          components,
          details: {
            ...details,
            sockets: {
              state: 'down',
              reason:
                'Real-time sync is expected but /api/health does not report socket state. Rebuild the app server so the socket attach is observable.',
            },
          },
        };
      }

      if (socketState.expected && !socketState.attached) {
        return {
          verdict: 'not-ready',
          components,
          details: {
            ...details,
            sockets: {
              state: 'down',
              reason:
                'Stand real-time sync is enabled but the Socket.IO server did not attach to the app HTTP server. Members would silently fall back to polling.',
            },
          },
        };
      }
    }
    return { verdict: 'ready', components, details };
  }

  return { verdict: anyStarting ? 'starting' : 'not-ready', components, details };
}

/**
 * Default reader for the `/api/health` socket component.
 *
 * Duplicated here rather than imported from the socket module on purpose: this
 * file is unit-tested without a running app server, and importing the real
 * module would drag in ioredis, Prisma and the auth stack.
 */
function defaultProbeSockets(result: ProbeResult): { expected: boolean; attached: boolean } | undefined {
  const components = result.body?.components;
  if (!components || typeof components !== 'object') return undefined;
  const sockets = (components as Record<string, unknown>).sockets;
  if (!sockets || typeof sockets !== 'object') return undefined;
  const record = sockets as Record<string, unknown>;
  return { expected: record.expected === true, attached: record.attached === true };
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
 * Whether `/api/health` reports a live Stand socket server.
 *
 * The socket is hosted by the app server process (`scripts/serve.ts`), NOT by
 * the workers process, so this is the only place the real attach state can be
 * observed. Three outcomes:
 *
 *  - `expected: false` — realtime is off by configuration; nothing to require.
 *  - `expected: true, attached: true` — healthy.
 *  - `expected: true, attached: false` — the silent-degradation case. Every
 *    browser falls back to polling while the site keeps working and reporting
 *    200, which is precisely the failure this gate exists to catch.
 *
 * A body with NO `sockets` field predates the check (or was served by a build
 * that lacks it) and is reported as `undefined` so the caller can distinguish
 * "unknown" from "known absent" and choose its own compatibility behaviour
 * rather than silently assuming health.
 */
export function evaluateSocketComponent(
  result: ProbeResult,
): { expected: boolean; attached: boolean } | undefined {
  const components = result.body?.components;
  if (!components || typeof components !== 'object') return undefined;
  const sockets = (components as Record<string, unknown>).sockets;
  if (!sockets || typeof sockets !== 'object') return undefined;

  const record = sockets as Record<string, unknown>;
  return {
    expected: record.expected === true,
    attached: record.attached === true,
  };
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