/**
 * Unified production server: Next.js AND the Digital Music Stand Socket.IO
 * server on a SINGLE port.
 *
 * WHY THIS EXISTS
 * ---------------
 * A WebSocket upgrade can never be proxied by a `next.config.ts` rewrite.
 * Next's production `upgradeHandler` (node_modules/next/dist/server/lib/
 * router-server.js) only handles HMR in development; for a production server it
 * falls through to `resolveRoutes`, and an upgrade is only forwarded via
 * `proxyRequest` when the rewrite destination is an absolute URL with a
 * protocol. Any attempt to reach the socket server through the Next port
 * therefore either 308-redirects (which a WebSocket upgrade cannot follow) or
 * hangs. Polling handshakes still succeed because `fetch`/`curl` DO follow the
 * 308, which is exactly why this defect masquerades as healthy: /ready reports
 * `sockets: true` while every browser silently falls back to polling.
 *
 * The fix is architectural, not cosmetic: host both on one origin so there is no
 * cross-port hop and no redirect to follow.
 *
 * The `next-server` child spawned by scripts/start.ts runs this file. It:
 *   1. creates the HTTP server itself,
 *   2. attaches Socket.IO to it on STAND_SOCKET_PATH (taking precedence),
 *   3. delegates every other request to Next's request handler,
 *   4. listens once, on one port.
 *
 * Socket.IO attaches an `upgrade` listener, so it must be attached BEFORE the
 * server starts listening; `initializeStandSocketServer` takes the http.Server
 * directly for precisely this reason.
 */

import { createServer } from 'node:http';
// Next resolves its AsyncLocalStorage from `globalThis.AsyncLocalStorage` at
// module-load time (node_modules/next/dist/server/app-render/async-local-storage.js).
// When Next is not the process entrypoint that global is absent, so it installs a
// FakeAsyncLocalStorage whose run()/enterWith() throw
// "Invariant: AsyncLocalStorage accessed in runtime where it is not available"
// on the first request. Polyfill it BEFORE importing next so the real
// implementation is picked up. This must stay above the `import next` below.
import { AsyncLocalStorage } from 'node:async_hooks';

if (!(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage) {
  (globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;
}

const { default: next } = await import('next');
import { createRequire } from 'node:module';
import 'dotenv/config';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '@/lib/logger';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, '..');

const PORT = Number(process.env.PORT || 3225);
const HOSTNAME = process.env.HOSTNAME || process.env.BIND_HOST || '0.0.0.0';
const DEV = process.env.NODE_ENV !== 'production';

function isSocketRequest(url: string | undefined, socketPath: string): boolean {
  if (!url) return false;
  const [pathname] = url.split('?');
  if (!pathname) return false;
  return pathname === socketPath || pathname.startsWith(`${socketPath}/`);
}

async function main(): Promise<void> {
  const require = createRequire(import.meta.url);
  const app = next({
    dev: DEV,
    dir: ROOT_DIR,
    hostname: HOSTNAME,
    port: PORT,
  });

  await app.prepare();
  const handle = app.getRequestHandler();

  const { STAND_SOCKET_PATH } = await import('@/lib/websocket/stand-socket-path');

  const server = createServer((req, res) => {
    // Defensive: Socket.IO handles its own requests, but if anything ever
    // reaches here on the socket path we must not hand it to Next's renderer.
    if (isSocketRequest(req.url, STAND_SOCKET_PATH)) {
      res.statusCode = 404;
      res.end();
      return;
    }
    void handle(req, res);
  });

  // Attach the stand socket BEFORE listening so its upgrade listener is
  // registered first and wins for the socket path.
  if (process.env.ENABLE_WEBSOCKETS === 'true') {
    try {
      const { Redis } = await import('ioredis');
      const { initializeStandSocketServer } = await import('@/lib/websocket/stand-socket');
      const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
      const makeClient = (label: string) => {
        const client = new Redis(REDIS_URL, {
          maxRetriesPerRequest: null,
          lazyConnect: false,
        });
        client.on('error', (e: Error) =>
          logger.error(`[serve] Socket Redis ${label} error`, { error: e.message })
        );
        return client;
      };
      initializeStandSocketServer(
        server as never,
        makeClient('pub') as never,
        makeClient('sub') as never
      );
      logger.info('[serve] Stand socket attached to the app HTTP server', {
        path: STAND_SOCKET_PATH,
        port: PORT,
      });
    } catch (err) {
      // Fail loudly: a silently-absent socket server is the exact degradation
      // this whole arrangement exists to prevent.
      logger.error('[serve] Failed to attach the stand socket server', { error: err });
      process.exit(1);
    }
  } else {
    logger.warn('[serve] ENABLE_WEBSOCKETS is not "true" — realtime socket disabled', {
      hint: 'Stand falls back to polling. Set ENABLE_WEBSOCKETS=true to enable.',
    });
  }

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(PORT, HOSTNAME, () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });

  logger.info('[serve] Application ready', {
    url: `http://${HOSTNAME}:${PORT}`,
    next: DEV ? 'dev' : 'production',
    sockets: process.env.ENABLE_WEBSOCKETS === 'true',
  });

  const shutdown = (signal: string): void => {
    logger.info('[serve] Received shutdown signal, closing', { signal });
    server.close(() => process.exit(0));
    // Do not let a lingering keep-alive connection hold the process open.
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  void require;
}

main().catch((err) => {
  logger.error('[serve] Fatal startup error', { error: err });
  process.exit(1);
});