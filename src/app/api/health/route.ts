import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { redis } from '@/lib/redis';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { startTimer } from '@/lib/performance';
import { getSetupState } from '@/lib/setup/state';
import { getStandSocketState } from '@/lib/websocket/stand-socket';

export const dynamic = 'force-dynamic';

// Application version from package.json or env
const VERSION = process.env.npm_package_version || process.env.APP_VERSION || '1.0.0';

// Track application start time for uptime
const APP_START_TIME = Date.now();

interface ComponentHealth {
  status: 'healthy' | 'degraded' | 'unhealthy';
  latency?: number;
  latencyMs?: number;
  message?: string;
  driver?: string;
  error?: string;
}

interface HealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  version: string;
  uptime: number;
  uptimeSeconds: number;
  timestamp: string;
  components: {
    database: ComponentHealth;
    redis: ComponentHealth;
    storage: ComponentHealth;
    /**
     * Digital Music Stand real-time sync.
     *
     * Reported separately from `status` on purpose. When realtime is EXPECTED
     * but the socket server never attached, every browser silently falls back to
     * polling — the site still works and looks healthy, which is exactly why
     * this needs to be its own observable field rather than a detail buried in
     * a message string.
     */
    sockets: SocketComponentHealth;
  };
  setup: {
    phase: string;
    readyForLogin: boolean;
    dbConnected: boolean;
    hasSuperAdmin: boolean;
    pendingMigrations?: number;
    error?: string;
  };
}

interface SocketComponentHealth {
  status: 'healthy' | 'degraded' | 'disabled';
  /** True when this deployment is configured for real-time sync. */
  expected: boolean;
  /** True when the Socket.IO server actually attached to the HTTP server. */
  attached: boolean;
  attachedAt: string | null;
  error?: string;
}

/**
 * Report the Stand socket server's real attach state.
 *
 * Driven by `getStandSocketState()`, which is written by the attach itself — not
 * by re-reading `ENABLE_WEBSOCKETS`. Reporting the env var here would recreate
 * the defect this replaces: a socket that failed to bind would still be
 * described as healthy, and readiness would pass.
 *
 * `degraded` (rather than `unhealthy`) when realtime is expected but absent, so
 * an operator sees the fault without the whole stack being pulled from a load
 * balancer. The process manager treats this field as blocking regardless.
 */
function checkSockets(): SocketComponentHealth {
  const state = getStandSocketState();
  const expected = (process.env.ENABLE_WEBSOCKETS || '').trim() === 'true';

  if (!expected) {
    // Realtime is off by configuration. Not a fault.
    return {
      status: 'disabled',
      expected: false,
      attached: state.attached,
      attachedAt: state.attachedAt,
    };
  }

  return {
    status: state.attached ? 'healthy' : 'degraded',
    expected: true,
    attached: state.attached,
    attachedAt: state.attachedAt,
    ...(state.error ? { error: state.error } : {}),
  };
}

/**
 * Check database connectivity
 */
async function checkDatabase(): Promise<ComponentHealth> {
  const timer = startTimer('health:database', undefined, 5000);
  
  try {
    await prisma.$queryRaw`SELECT 1`;
    const metrics = timer.end();
    
    return {
      status: 'healthy',
      latency: metrics.duration,
      latencyMs: metrics.duration,
    };
  } catch (error) {
    timer.end({ error: true });
    logger.error('Database health check failed', error instanceof Error ? error : new Error(String(error)));
    
    return {
      status: 'unhealthy',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Check Redis connectivity
 */
async function checkRedis(): Promise<ComponentHealth> {
  const timer = startTimer('health:redis', undefined, 5000);
  
  try {
    const result = await redis.ping();
    const metrics = timer.end();
    
    if (result !== 'PONG') {
      return {
        status: 'degraded',
        latency: metrics.duration,
        latencyMs: metrics.duration,
        message: 'Unexpected ping response',
      };
    }
    
    return {
      status: 'healthy',
      latency: metrics.duration,
      latencyMs: metrics.duration,
    };
  } catch (error) {
    timer.end({ error: true });
    logger.error('Redis health check failed', error instanceof Error ? error : new Error(String(error)));
    
    return {
      status: 'unhealthy',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Check storage driver status
 */
async function checkStorage(): Promise<ComponentHealth> {
  const timer = startTimer('health:storage', undefined, 5000);
  
  try {
    const driver = env.STORAGE_DRIVER;
    
    if (driver === 'S3') {
      // Check if S3 configuration is present
      if (!env.S3_ENDPOINT || !env.S3_BUCKET_NAME || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY) {
        timer.end({ error: true });
        return {
          status: 'unhealthy',
          driver: 'S3',
          error: 'Missing S3 configuration',
        };
      }
      
      // For S3, we could do a bucket check, but for now just verify config
      const metrics = timer.end();
      
      return {
        status: 'healthy',
        driver: 'S3',
        latency: metrics.duration,
        latencyMs: metrics.duration,
      };
    } else {
      // LOCAL storage - always healthy if we get here
      const metrics = timer.end();
      
      return {
        status: 'healthy',
        driver: 'LOCAL',
        latency: metrics.duration,
        latencyMs: metrics.duration,
      };
    }
  } catch (error) {
    timer.end({ error: true });
    logger.error('Storage health check failed', error instanceof Error ? error : new Error(String(error)));
    
    return {
      status: 'unhealthy',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Determine overall health status from component statuses
 */
function determineOverallStatus(components: HealthResponse['components']): 'healthy' | 'degraded' | 'unhealthy' {
  const statuses = Object.entries(components)
    .filter(([name]) => name !== 'sockets')
    .map(([, c]) => c.status);
  
  if (statuses.includes('unhealthy')) {
    // If any critical component is unhealthy, overall is unhealthy
    // Redis is not critical for basic operation
    const criticalUnhealthy = ['database'].some(
      (name) => components[name as keyof typeof components]?.status === 'unhealthy'
    );
    
    if (criticalUnhealthy) {
      return 'unhealthy';
    }
    
    return 'degraded';
  }
  
  if (statuses.includes('degraded')) {
    return 'degraded';
  }

  // Realtime is expected but the socket server never attached: report the stack
  // as degraded so the fault is visible on the dashboard, without failing the
  // whole process (polling still serves the Stand correctly). The process
  // manager's readiness gate treats this as blocking — see
  // `evaluateNextServerProbe`.
  if (components.sockets.status === 'degraded') {
    return 'degraded';
  }

  return 'healthy';
}

/**
 * GET /api/health
 * Health check endpoint for monitoring and load balancers
 */
export async function GET(): Promise<NextResponse<HealthResponse>> {
  const requestTimer = startTimer('health:check');
  
  // Run all health checks in parallel
  const [database, redisHealth, storage, setupState, sockets] = await Promise.all([
    checkDatabase(),
    checkRedis(),
    checkStorage(),
    getSetupState().catch(() => null),
    Promise.resolve(checkSockets()),
  ]);
  
  const components = { database, redis: redisHealth, storage, sockets };
  const status = determineOverallStatus(components);
  
  const uptime = Math.floor((Date.now() - APP_START_TIME) / 1000);
  
  const response: HealthResponse = {
    status,
    version: VERSION,
    uptime,
    uptimeSeconds: uptime,
    timestamp: new Date().toISOString(),
    components,
    setup: {
      phase: setupState?.phase ?? 'unknown',
      readyForLogin: setupState?.readyForLogin ?? false,
      dbConnected: setupState?.dbConnected ?? false,
      hasSuperAdmin: setupState?.hasSuperAdmin ?? false,
      pendingMigrations: setupState?.pendingMigrations,
      error: setupState?.error,
    },
  };
  
  // Log health check result
  const metrics = requestTimer.end({
    status,
    databaseStatus: database.status,
    redisStatus: redisHealth.status,
    storageStatus: storage.status,
  });
  
  if (status === 'unhealthy') {
    logger.error('Health check failed', undefined, {
      status,
      databaseStatus: database.status,
      redisStatus: redisHealth.status,
      storageStatus: storage.status,
    });
  } else if (status === 'degraded') {
    logger.warn('Health check degraded', {
      status,
      databaseStatus: database.status,
      redisStatus: redisHealth.status,
      storageStatus: storage.status,
    });
  } else {
    logger.debug('Health check passed', { duration: metrics.duration });
  }
  
  // Return appropriate HTTP status
  const httpStatus = status === 'healthy' ? 200 : status === 'degraded' ? 200 : 503;
  
  return NextResponse.json(response, { status: httpStatus });
}
