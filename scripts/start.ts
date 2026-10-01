/**
 * Process Manager for ECCB Platform
 * 
 * Spawns and manages:
 * - Next.js server
 * - Background workers
 * 
 * Handles graceful shutdown and process lifecycle.
 */

import { spawn, ChildProcess } from 'child_process';
import { createServer } from 'http';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, '..');

// ============================================================================
// Configuration
// ============================================================================

const PORT = parseInt(process.env.PORT || '3000', 10);
const WORKER_HEALTH_PORT = parseInt(process.env.WORKER_HEALTH_PORT || '3001', 10);
const RESTART_CRASHED_PROCESSES = process.env.RESTART_CRASHED_PROCESSES === 'true';

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
}

const processes: Map<string, ManagedProcess> = new Map();
let isShuttingDown = false;
let healthServer: ReturnType<typeof createServer> | null = null;

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
// Process Management
// ============================================================================

/**
 * Spawn a managed process
 */
function spawnProcess(name: string, command: string, args: string[], env: Record<string, string> = {}): ChildProcess {
  log('info', `Spawning ${name}...`, { command, args });

  const proc = spawn(command, args, {
    cwd: ROOT_DIR,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
  });

  // Handle stdout
  proc.stdout?.on('data', (data: Buffer) => {
    const lines = data.toString().trim().split('\n');
    for (const line of lines) {
      console.log(`[${name}] ${line}`);
    }
  });

  // Handle stderr
  proc.stderr?.on('data', (data: Buffer) => {
    const lines = data.toString().trim().split('\n');
    for (const line of lines) {
      console.error(`[${name}] ${line}`);
    }
  });

  // Handle process exit
  proc.on('exit', (code, signal) => {
    log('warn', `Process ${name} exited`, { code, signal });

    const managed = processes.get(name);
    if (managed) {
      managed.process = null;
    }

    // Restart if not shutting down and restart is enabled
    if (!isShuttingDown && RESTART_CRASHED_PROCESSES && code !== 0) {
      const now = Date.now();
      const timeSinceLastRestart = now - (managed?.lastRestart || 0);

      // Only restart if more than 5 seconds since last restart (prevent rapid restart loop)
      if (timeSinceLastRestart > 5000 && (managed?.restartCount || 0) < 5) {
        log('info', `Restarting ${name}...`, { restartCount: (managed?.restartCount || 0) + 1 });
        setTimeout(() => {
          if (!isShuttingDown && managed) {
            managed.process = spawnProcess(name, managed.command, managed.args, managed.env);
            managed.restartCount++;
            managed.lastRestart = Date.now();
          }
        }, 1000);
      } else if ((managed?.restartCount || 0) >= 5) {
        log('error', `${name} has crashed too many times, not restarting`, { restartCount: managed?.restartCount });
      }
    }
  });

  proc.on('error', (error) => {
    log('error', `Process ${name} error`, { error: error.message });
  });

  return proc;
}

/**
 * Start the Next.js server
 */
function startNextServer(): void {
  const managed: ManagedProcess = {
    name: 'next-server',
    process: null,
    command: 'npx',
    args: ['next', 'start', '-p', String(PORT)],
    env: {},
    restartCount: 0,
    lastRestart: 0,
  };

  managed.process = spawnProcess(managed.name, managed.command, managed.args, managed.env);
  processes.set(managed.name, managed);
}

/**
 * Start the background workers
 */
function startWorkers(): void {
  const managed: ManagedProcess = {
    name: 'workers',
    process: null,
    command: 'npx',
    args: ['tsx', 'src/workers/index.ts'],
    env: {
      WORKER_HEALTH_PORT: String(WORKER_HEALTH_PORT),
    },
    restartCount: 0,
    lastRestart: 0,
  };

  managed.process = spawnProcess(managed.name, managed.command, managed.args, managed.env);
  processes.set(managed.name, managed);
}

/**
 * Stop a managed process
 */
async function stopProcess(name: string): Promise<void> {
  const managed = processes.get(name);
  if (!managed || !managed.process) {
    return;
  }

  log('info', `Stopping ${name}...`);

  return new Promise((resolve) => {
    const proc = managed.process!;
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        log('warn', `${name} did not exit gracefully, forcing kill`);
        proc.kill('SIGKILL');
        resolved = true;
        resolve();
      }
    }, 10000); // 10 second timeout

    proc.on('exit', () => {
      if (!resolved) {
        clearTimeout(timeout);
        resolved = true;
        resolve();
      }
    });

    // Send SIGTERM for graceful shutdown
    proc.kill('SIGTERM');
  });
}

/**
 * Stop all processes
 */
async function stopAllProcesses(): Promise<void> {
  log('info', 'Stopping all processes...');

  // Stop workers first (they need to complete in-progress jobs)
  await stopProcess('workers');

  // Then stop the Next.js server
  await stopProcess('next-server');

  log('info', 'All processes stopped');
}

// ============================================================================
// Health Check Server
// ============================================================================

/**
 * Start the process manager health check server
 */
function startHealthServer(): void {
  healthServer = createServer(async (req, res) => {
    const url = req.url || '/';

    if (url === '/health') {
      const nextServer = processes.get('next-server');
      const workers = processes.get('workers');

      const health = {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        processes: {
          'next-server': {
            running: nextServer?.process !== null,
            pid: nextServer?.process?.pid,
            restartCount: nextServer?.restartCount || 0,
          },
          workers: {
            running: workers?.process !== null,
            pid: workers?.process?.pid,
            restartCount: workers?.restartCount || 0,
          },
        },
      };

      const allRunning = nextServer?.process !== null && workers?.process !== null;
      res.writeHead(allRunning ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(health, null, 2));
    } else if (url === '/ready') {
      // Check if all processes are ready
      const nextServer = processes.get('next-server');
      const workers = processes.get('workers');
      const ready = nextServer?.process !== null && workers?.process !== null;
      res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ready }));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  });

  // Use a different port for the process manager health check
  const healthPort = parseInt(process.env.PROCESS_MANAGER_HEALTH_PORT || '3002', 10);
  healthServer.listen(healthPort, () => {
    log('info', `Process manager health check server listening on port ${healthPort}`);
  });
}

/**
 * Stop the health check server
 */
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

/**
 * Handle graceful shutdown
 */
async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    log('warn', 'Shutdown already in progress, ignoring signal', { signal });
    return;
  }

  isShuttingDown = true;
  log('info', `Received ${signal}, starting graceful shutdown...`);

  // Stop health check server
  await stopHealthServer();

  // Stop all managed processes
  await stopAllProcesses();

  log('info', 'Graceful shutdown complete');
  process.exit(0);
}

// ============================================================================
// Main Entry Point
// ============================================================================

async function main(): Promise<void> {
  log('info', 'Starting ECCB Process Manager...');
  log('info', 'Configuration', {
    port: PORT,
    workerHealthPort: WORKER_HEALTH_PORT,
    restartCrashedProcesses: RESTART_CRASHED_PROCESSES,
  });

  // Start health check server
  startHealthServer();

  // Start Next.js server
  startNextServer();

  // Wait a bit before starting workers
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Start background workers
  startWorkers();

  // Setup signal handlers
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  log('info', 'ECCB Process Manager started successfully');

  // Handle uncaught errors
  process.on('unhandledRejection', (reason, promise) => {
    log('error', 'Unhandled Rejection', { reason, promise });
  });

  process.on('uncaughtException', (error) => {
    log('error', 'Uncaught Exception', { error: error.message, stack: error.stack });
  });
}

// Run main
main().catch((error) => {
  log('error', 'Failed to start process manager', { error: error.message, stack: error.stack });
  process.exit(1);
});
