import 'dotenv/config';
import http from 'http';
import { initializeQueues, closeQueues, addJob, getAllQueueStats, areQueuesInitialized } from '@/lib/jobs/queue';
import { startEmailWorker, stopEmailWorker, isEmailWorkerRunning } from './email-worker';
import {
  startSchedulerWorker,
  stopSchedulerWorker,
  isSchedulerWorkerRunning,
  checkScheduledContent,
  checkEventReminders,
  checkExpiringContent,
} from './scheduler';
import {
  startSmartUploadProcessorWorker,
  stopSmartUploadProcessorWorker,
  isSmartUploadProcessorWorkerRunning,
} from './smart-upload-processor-worker';
import { startOcrWorker, stopOcrWorker, isOcrWorkerRunning } from './ocr-worker';
import { logger } from '@/lib/logger';
import { Redis } from 'ioredis';
import {
  initializeStandSocketServer,
  closeStandSocketServer,
} from '@/lib/websocket/stand-socket';
import { getStandSettings } from '@/lib/stand/settings';
import { DEFAULT_PORTS, listenWithFallback } from '@/lib/ports';

/**
 * Worker Entry Point for ECCB Platform
 *
 * Starts all background workers and handles graceful shutdown.
 * This file is the main entry point for the worker process.
 */

// BullMQ emits a console.warn when the Redis server version is below 6.2.0.
// Suppress those known advisory messages (Redis 6.0.x is installed) to avoid
// flooding stderr until the system's Redis can be upgraded to ≥6.2.
const _originalWarn = console.warn.bind(console);
console.warn = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && args[0].includes('minimum Redis version')) return;
  _originalWarn(...args);
};

// ============================================================================
// Configuration
// ============================================================================

const HEALTH_CHECK_PORT = parseInt(process.env.WORKER_HEALTH_PORT || String(DEFAULT_PORTS.WORKER_HEALTH), 10);
const SCHEDULER_INTERVAL_MS = parseInt(process.env.SCHEDULER_INTERVAL_MS || '60000', 10); // 1 minute
const CLEANUP_INTERVAL_MS = parseInt(process.env.CLEANUP_INTERVAL_MS || '86400000', 10); // 24 hours
const SOCKET_PORT = parseInt(process.env.SOCKET_PORT || String(DEFAULT_PORTS.SOCKET), 10);
const ENABLE_WEBSOCKETS = process.env.ENABLE_WEBSOCKETS === 'true';

// ============================================================================
// State
// ============================================================================

let isShuttingDown = false;
let schedulerInterval: NodeJS.Timeout | null = null;
let cleanupInterval: NodeJS.Timeout | null = null;
let healthServer: http.Server | null = null;

// WebSocket state
let socketPubClient: Redis | null = null;
let socketSubClient: Redis | null = null;
let socketHttpServer: http.Server | null = null;
let socketWorkerEnabled = false;

export function isSocketWorkerRunning(): boolean {
  return socketWorkerEnabled && socketHttpServer !== null;
}

// ============================================================================
// Scheduler Loop
// ============================================================================

/**
 * Run the scheduler tick - checks for scheduled content and reminders
 */
async function runSchedulerTick(): Promise<void> {
  if (isShuttingDown) return;

  try {
    logger.debug('Running scheduler tick');
    
    // Check for scheduled content to publish
    await checkScheduledContent();
    
    // Check for event reminders
    await checkEventReminders();
    
  } catch (error) {
    logger.error('Scheduler tick failed', { error: error instanceof Error ? error.message : 'Unknown error' });
  }
}

/**
 * Run cleanup tasks
 */
async function runCleanupTick(): Promise<void> {
  if (isShuttingDown) return;

  try {
    logger.info('Running cleanup tick');
    
    // Check for expiring content
    await checkExpiringContent();
    
    // Queue session cleanup job
    await addJob('cleanup.sessions', {
      maxAgeHours: 24,
    });
    
    // Queue file cleanup job (weekly)
    const now = new Date();
    if (now.getDay() === 0) { // Sunday
      await addJob('cleanup.files', {
        maxAgeDays: 30,
      });
    }
    
  } catch (error) {
    logger.error('Cleanup tick failed', { error: error instanceof Error ? error.message : 'Unknown error' });
  }
}

/**
 * Start the scheduler intervals
 */
function startSchedulerIntervals(): void {
  // Run scheduler every minute
  schedulerInterval = setInterval(runSchedulerTick, SCHEDULER_INTERVAL_MS);
  
  // Run cleanup daily at 3 AM (or use interval for simplicity)
  cleanupInterval = setInterval(runCleanupTick, CLEANUP_INTERVAL_MS);
  
  // Run initial tick immediately
  runSchedulerTick().catch(err => logger.error('Initial scheduler tick failed', { error: err }));
  
  logger.info('Scheduler intervals started', {
    schedulerIntervalMs: SCHEDULER_INTERVAL_MS,
    cleanupIntervalMs: CLEANUP_INTERVAL_MS,
  });
}

/**
 * Stop the scheduler intervals
 */
function stopSchedulerIntervals(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
  logger.info('Scheduler intervals stopped');
}

// ============================================================================
// Health Check Server
// ============================================================================

/**
 * Start the health check HTTP server
 */
function startHealthServer(): void {
  healthServer = http.createServer(async (req, res) => {
    if (req.url === '/health') {
      try {
        const stats = await getAllQueueStats();
        const workersHealthy =
          areQueuesInitialized() &&
          isEmailWorkerRunning() &&
          isSchedulerWorkerRunning() &&
          isSmartUploadProcessorWorkerRunning() &&
          isOcrWorkerRunning();

        const health = {
          status: workersHealthy ? 'healthy' : 'unhealthy',
          timestamp: new Date().toISOString(),
          uptime: process.uptime(),
          workers: {
            email: isEmailWorkerRunning(),
            scheduler: isSchedulerWorkerRunning(),
            smartUpload: isSmartUploadProcessorWorkerRunning(),
            ocr: isOcrWorkerRunning(),
            sockets: isSocketWorkerRunning(),
          },
          queues: stats,
        };

        res.writeHead(workersHealthy ? 200 : 503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(health, null, 2));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'error',
          error: error instanceof Error ? error.message : 'Unknown error'
        }));
      }
    } else if (req.url === '/ready') {
      // Readiness probe - check if workers are ready to accept jobs
      const ready =
        areQueuesInitialized() &&
        isEmailWorkerRunning() &&
        isSchedulerWorkerRunning() &&
        isSmartUploadProcessorWorkerRunning() &&
        isOcrWorkerRunning();
      res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ready, ocr: isOcrWorkerRunning(), sockets: isSocketWorkerRunning() }));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  });

  // Roll forward to the next free port when the preferred health port is
  // occupied (e.g. a second copy of the workers is already running).
  void listenWithFallback(healthServer, HEALTH_CHECK_PORT, 'Worker health server', 25, (m) =>
    logger.info(m),
  ).catch((err: unknown) => {
    logger.error('Health check server failed to bind', {
      error: err instanceof Error ? err.message : String(err),
    });
    healthServer = null;
  });

  healthServer.on('error', (err: NodeJS.ErrnoException) => {
    // listenWithFallback already handles EADDRINUSE by retrying; any error
    // reaching here is unexpected.
    if (err.code !== 'EADDRINUSE') {
      logger.error('Health check server error', { error: err.message });
    }
  });
}

/**
 * Stop the health check server
 */
function stopHealthServer(): Promise<void> {
  return new Promise((resolve) => {
    if (healthServer) {
      healthServer.close(() => {
        logger.info('Health check server stopped');
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

/**
 * Handle graceful shutdown
 */
async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    logger.warn('Shutdown already in progress, ignoring signal', { signal });
    return;
  }

  isShuttingDown = true;
  logger.info(`Received ${signal}, starting graceful shutdown...`);

  // Stop accepting new scheduled jobs
  stopSchedulerIntervals();

  // Stop health check server
  await stopHealthServer();

  // Stop workers (they will complete in-progress jobs)
  logger.info('Stopping workers...');
  await Promise.all([
    stopEmailWorker(),
    stopSchedulerWorker(),
    stopSmartUploadProcessorWorker(),
    stopOcrWorker(),
  ]);

  // Stop WebSocket worker if running
  if (socketWorkerEnabled) {
    await closeStandSocketServer();
    if (socketHttpServer) {
      await new Promise<void>((r) => socketHttpServer!.close(() => r()));
      socketHttpServer = null;
    }
    await Promise.all([
      socketPubClient?.quit().catch(() => undefined),
      socketSubClient?.quit().catch(() => undefined),
    ]);
    socketWorkerEnabled = false;
    logger.info('Socket worker stopped');
  }

  // Close queues
  await closeQueues();

  logger.info('Graceful shutdown complete');
  process.exit(0);
}

// ============================================================================
// Main Entry Point
// ============================================================================

async function main(): Promise<void> {
  logger.info('Starting ECCB workers...');

  // Initialize queues
  initializeQueues();

  // Start workers
  startEmailWorker();
  startSchedulerWorker();
  await startSmartUploadProcessorWorker();
  startOcrWorker();

  // Start scheduler intervals
  startSchedulerIntervals();

  // Start health check server
  startHealthServer();

  // Optionally start embedded WebSocket worker
  if (ENABLE_WEBSOCKETS) {
    try {
      // Load websocket port from database settings, with env as fallback
      const settings = await getStandSettings();
      const socketPort = settings.websocketPort || SOCKET_PORT;
      
      const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
      const makeClient = (label: string) => {
        const c = new Redis(REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: false });
        c.on('error', (e) => logger.error(`Socket Redis ${label} error`, { error: e.message }));
        return c;
      };
      socketPubClient = makeClient('pub');
      socketSubClient = makeClient('sub');
      socketHttpServer = http.createServer();
      initializeStandSocketServer(
        socketHttpServer,
        socketPubClient,
        socketSubClient,
        process.env.NEXT_PUBLIC_APP_URL,
      );
      // Auto-roll to the next free port when SOCKET_PORT is occupied.
      await listenWithFallback(socketHttpServer, socketPort, 'Embedded socket worker', 25, (m) =>
        logger.info(m),
      );
      socketWorkerEnabled = true;
    } catch (err) {
      logger.error('Failed to start socket worker', { error: err instanceof Error ? err.message : err });
    }
  }

  // Setup signal handlers
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  logger.info('ECCB workers started successfully');

  // Keep the process alive
  process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection', { reason, promise });
  });

  process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception', { error: error.message, stack: error.stack });
    // Don't exit immediately - let the error be logged
  });
}

// Run main
main().catch((error) => {
  logger.error('Failed to start workers', { error: error.message, stack: error.stack });
  process.exit(1);
});

// ============================================================================
// Exports
// ============================================================================

export {
  startEmailWorker,
  stopEmailWorker,
  startSchedulerWorker,
  stopSchedulerWorker,
  startSchedulerIntervals,
  stopSchedulerIntervals,
  runSchedulerTick,
  runCleanupTick,
};
