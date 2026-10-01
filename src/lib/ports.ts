/**
 * Centralised port configuration + "next available port" helpers.
 *
 * Single source of truth for every port the platform binds to.
 * All values are overridable via `.env` — the code only uses these
 * defaults when the env var is unset.
 *
 * Default range 322x was chosen deliberately:
 *  - 3000-3025 and 35000-35006 are already occupied on this machine
 *    (other Next.js apps, common dev tools).
 *  - 32xx is outside the well-known dev ranges (3000, 5000, 8000, 8080,
 *    9000) and has no common-service collision.
 *
 * Every HTTP server in this repo should bind via `listenWithFallback()`
 * so an occupied default never crashes startup — it just rolls forward
 * to the next free port and logs the decision.
 */

import net from 'net';
import type { Server } from 'http';

export const DEFAULT_PORTS = {
  /** Main Next.js app (`PORT`) */
  APP: 3225,
  /** Standalone Socket.IO worker (`SOCKET_PORT`) */
  SOCKET: 3226,
  /** Background worker health endpoint (`WORKER_HEALTH_PORT`) */
  WORKER_HEALTH: 3227,
  /** Process-manager health endpoint (`PROCESS_MANAGER_HEALTH_PORT`) */
  MANAGER_HEALTH: 3228,
} as const;

/** How many consecutive ports to probe before giving up. */
export const MAX_PORT_PROBE_ATTEMPTS = 25;

function parsePortEnv(raw: string | undefined, fallback: number): number {
  const n = raw !== undefined && raw !== '' ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 && n < 65536 ? n : fallback;
}

/** Preferred ports after applying `.env` overrides. */
export interface PreferredPorts {
  APP: number;
  SOCKET: number;
  WORKER_HEALTH: number;
  MANAGER_HEALTH: number;
}

export function getPreferredPorts(): PreferredPorts {
  return {
    APP: parsePortEnv(process.env.PORT, DEFAULT_PORTS.APP),
    SOCKET: parsePortEnv(process.env.SOCKET_PORT, DEFAULT_PORTS.SOCKET),
    WORKER_HEALTH: parsePortEnv(
      process.env.WORKER_HEALTH_PORT,
      DEFAULT_PORTS.WORKER_HEALTH,
    ),
    MANAGER_HEALTH: parsePortEnv(
      process.env.PROCESS_MANAGER_HEALTH_PORT,
      DEFAULT_PORTS.MANAGER_HEALTH,
    ),
  };
}

/** True when nothing is listening on `port` (localhost). */
export function isPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = net
      .createServer()
      .once('error', () => resolve(false))
      .once('listening', () => tester.close(() => resolve(true)))
      .listen(port, host);
  });
}

/**
 * Return `preferred` when free, otherwise the next free port above it.
 * Never touches privileged (<1024) or out-of-range ports.
 */
export async function findAvailablePort(
  preferred: number,
  maxAttempts = MAX_PORT_PROBE_ATTEMPTS,
  host = '127.0.0.1',
): Promise<number> {
  let port = preferred;
  for (let i = 0; i < maxAttempts; i++, port++) {
    if (port > 65535) break;
    if (await isPortFree(port, host)) return port;
  }
  throw new Error(
    `No free port found in range ${preferred}-${preferred + maxAttempts - 1}`,
  );
}

/**
 * Bind an `http.Server` with automatic EADDRINUSE roll-forward.
 * Resolves with the port that was actually bound.
 */
export function listenWithFallback(
  server: Server,
  preferredPort: number,
  label = 'server',
  maxAttempts = MAX_PORT_PROBE_ATTEMPTS,
  log: (msg: string) => void = (m) => console.log(m),
): Promise<number> {
  return new Promise((resolve, reject) => {
    let port = preferredPort;
    let attempts = 0;

    const tryListen = (): void => {
      const onError = (err: NodeJS.ErrnoException): void => {
        server.removeListener('listening', onListening);
        if (err?.code === 'EADDRINUSE' && attempts < maxAttempts - 1) {
          log(
            `[ports] Port ${port} in use by another process — trying ${port + 1} for ${label}`,
          );
          attempts++;
          port++;
          tryListen();
        } else {
          reject(err);
        }
      };
      const onListening = (): void => {
        server.removeListener('error', onError);
        if (port !== preferredPort) {
          log(
            `[ports] ${label} bound to next available port ${port} (preferred ${preferredPort} was busy)`,
          );
        } else {
          log(`[ports] ${label} listening on port ${port}`);
        }
        resolve(port);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port);
    };

    tryListen();
  });
}
