/**
 * Standalone Socket.IO Worker Process
 *
 * Run with:  npm run start:sockets
 *
 * Environment variables:
 *   SOCKET_PORT          Port to listen on (default: 3005)
 *   REDIS_URL            Redis connection string
 *   NEXT_PUBLIC_APP_URL  Used for CORS origin
 *   ENABLE_WEBSOCKETS    Must be "true" for this process to start
 */

import 'dotenv/config';
import http from 'http';
import { Redis } from 'ioredis';
import {
  initializeStandSocketServer,
  closeStandSocketServer,
} from '@/lib/websocket/stand-socket';
import { logger } from '@/lib/logger';
import { getStandSettings } from '@/lib/stand/settings';
import { buildRedisOptionsFromUrl } from '@/lib/redis-options';

// ─── Config ────────────────────────────────────────────────────────────────

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

// ─── Redis clients ──────────────────────────────────────────────────────────
// The Redis adapter requires two separate clients: one for publishing and one
// for subscribing. They must not share a connection.

function makeRedisClient(url: string, label: string): Redis {
  const client = new Redis({
    ...buildRedisOptionsFromUrl(url),
    maxRetriesPerRequest: null,
    retryStrategy: (times) => Math.min(times * 500, 10_000),
    lazyConnect: false,
  });
  client.on('connect', () => logger.info(`[SocketWorker] Redis ${label} connected`));
  client.on('error', (err) =>
    logger.error(`[SocketWorker] Redis ${label} error`, { error: err.message }),
  );
  return client;
}

// ─── HTTP server ──────────────────────────────────────────────────────────

const httpServer = http.createServer((_req, res) => {
  // Health probe used by load balancers
  if (_req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

// ─── Startup ─────────────────────────────────────────────────────────────

let isShuttingDown = false;

async function start(): Promise<void> {
  // Load port from database settings, with env as fallback
  const settings = await getStandSettings();
  const PORT = settings.websocketPort || parseInt(process.env.SOCKET_PORT || '3005', 10);
  
  const pubClient = makeRedisClient(REDIS_URL, 'pub');
  const subClient = makeRedisClient(REDIS_URL, 'sub');

  const io = initializeStandSocketServer(httpServer, pubClient, subClient, APP_URL);

  httpServer.listen(PORT, () => {
    logger.info(`[SocketWorker] Socket.IO server listening on port ${PORT}`);
  });

  // ── Graceful shutdown ──────────────────────────────────────────────────

  async function shutdown(signal: string): Promise<void> {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info(`[SocketWorker] Received ${signal}, shutting down…`);

    // Stop accepting new connections
    httpServer.close();

    // Close all existing socket connections
    io.disconnectSockets(true);

    // Close Socket.IO server (flushes buffers, closes adapter)
    await closeStandSocketServer();

    // Close Redis clients
    await Promise.all([pubClient.quit(), subClient.quit()]).catch(() => undefined);

    logger.info('[SocketWorker] Graceful shutdown complete');
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('uncaughtException', (err) => {
    logger.error('[SocketWorker] Uncaught exception', { error: err.message, stack: err.stack });
  });

  process.on('unhandledRejection', (reason) => {
    logger.error('[SocketWorker] Unhandled rejection', { reason });
  });
}

start().catch((err) => {
  logger.error('[SocketWorker] Startup failed', { error: err.message, stack: err.stack });
  process.exit(1);
});
