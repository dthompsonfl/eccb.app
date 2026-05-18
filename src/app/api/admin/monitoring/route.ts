/**
 * Admin Monitoring Dashboard API
 * 
 * GET: Get comprehensive monitoring data
 * - System health status
 * - Recent error logs
 * - Performance metrics
 * - Database statistics
 * - Cache statistics
 * 
 * Admin-only access.
 */

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth/config';
import { checkUserPermission } from '@/lib/auth/permissions';
import { validateCSRF } from '@/lib/csrf';
import { logger } from '@/lib/logger';
import { prisma } from '@/lib/db';
import { redis } from '@/lib/redis';
import {
  getAllMetrics,
  getAggregatedErrors,
  clearAggregatedErrors,
  clearMetrics,
  trackError,
  incrementCounter,
  type RequestMetrics,
  type ErrorMetrics,
  type DatabaseMetrics,
  type CacheMetrics,
  type SystemMetrics,
} from '@/lib/monitoring';
import { startTimer } from '@/lib/performance';

export const dynamic = 'force-dynamic';

// ============================================================================
// Types
// ============================================================================

interface DatabaseStats {
  members: { total: number; active: number; pending: number };
  events: { total: number; upcoming: number; past: number };
  music: { total: number; inCatalog: number };
  users: { total: number; active: number };
  storage: { totalFiles: number; totalSize: number };
}

interface HealthStatus {
  database: 'healthy' | 'degraded' | 'unhealthy';
  redis: 'healthy' | 'degraded' | 'unhealthy';
  storage: 'healthy' | 'degraded' | 'unhealthy';
  overall: 'healthy' | 'degraded' | 'unhealthy';
}

interface MonitoringResponse {
  timestamp: string;
  health: HealthStatus;
  metrics: {
    requests: RequestMetrics;
    errors: ErrorMetrics;
    database: DatabaseMetrics;
    cache: CacheMetrics;
    system: SystemMetrics;
  };
  databaseStats: DatabaseStats;
  aggregatedErrors: ReturnType<typeof getAggregatedErrors>;
}

// ============================================================================
// Helper Functions
// ============================================================================

async function checkDatabaseHealth(): Promise<'healthy' | 'degraded' | 'unhealthy'> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return 'healthy';
  } catch {
    return 'unhealthy';
  }
}

async function checkRedisHealth(): Promise<'healthy' | 'degraded' | 'unhealthy'> {
  try {
    const result = await redis.ping();
    return result === 'PONG' ? 'healthy' : 'degraded';
  } catch {
    return 'unhealthy';
  }
}

async function getDatabaseStats(): Promise<DatabaseStats> {
  const [
    memberStats,
    eventTotalStats,
    eventUpcomingCount,
    eventPastCount,
    musicTotalStats,
    musicInCatalogCount,
    userTotalStats,
    userActiveCount,
    storageStats,
  ] = await Promise.all([
    // Member stats
    prisma.member.groupBy({
      by: ['status'],
      _count: true,
    }),
    // Event stats
    prisma.event.count(),
    prisma.event.count({
      where: { startTime: { gt: new Date() } }
    }),
    prisma.event.count({
      where: { startTime: { lte: new Date() } }
    }),
    // Music stats
    prisma.musicPiece.count(),
    prisma.musicPiece.count({
      where: { isArchived: false }
    }),
    // User stats
    prisma.user.count(),
    prisma.user.count({
      where: { emailVerified: true }
    }),
    // Storage stats
    prisma.musicFile.aggregate({
      _count: true,
      _sum: { fileSize: true },
    }),
  ]);

  const _now = new Date();
  
  // Process member stats
  const members = {
    total: memberStats.reduce((sum, m) => sum + m._count, 0),
    active: memberStats.find((m) => m.status === 'ACTIVE')?._count || 0,
    pending: memberStats.find((m) => m.status === 'PENDING')?._count || 0,
  };

  // Process event stats
  const events = {
    total: eventTotalStats,
    upcoming: eventUpcomingCount,
    past: eventPastCount,
  };

  // Process music stats
  const music = {
    total: musicTotalStats,
    inCatalog: musicInCatalogCount,
  };

  // Process user stats
  const users = {
    total: userTotalStats,
    active: userActiveCount,
  };

  // Process storage stats
  const storage = {
    totalFiles: storageStats._count,
    totalSize: storageStats._sum.fileSize || 0,
  };

  return { members, events, music, users, storage };
}

// ============================================================================
// GET: Get Monitoring Data
// ============================================================================

export async function GET(request: NextRequest): Promise<NextResponse<MonitoringResponse | { error: string }>> {
  const timer = startTimer('admin:monitoring:get');
  
  try {
    // Check authentication
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Check admin permission
    const hasAdminAccess = await checkUserPermission(session.user.id, 'system.view.all');
    if (!hasAdminAccess) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Get query parameters
    const { searchParams } = new URL(request.url);
    const errorLimit = parseInt(searchParams.get('errorLimit') || '20', 10);
    const errorSince = searchParams.get('errorSince') 
      ? new Date(searchParams.get('errorSince')!) 
      : new Date(Date.now() - 24 * 60 * 60 * 1000); // Default: last 24 hours

    // Run health checks and data fetching in parallel
    const [
      dbHealth,
      redisHealth,
      metrics,
      databaseStats,
      aggregatedErrors,
    ] = await Promise.all([
      checkDatabaseHealth(),
      checkRedisHealth(),
      getAllMetrics(),
      getDatabaseStats(),
      getAggregatedErrors({ limit: errorLimit, since: errorSince }),
    ]);

    // Determine overall health
    const health: HealthStatus = {
      database: dbHealth,
      redis: redisHealth,
      storage: 'healthy', // Storage health is checked in the health API
      overall: dbHealth === 'unhealthy' 
        ? 'unhealthy' 
        : (dbHealth === 'degraded' || redisHealth === 'degraded')
          ? 'degraded' 
          : 'healthy',
    };

    const response: MonitoringResponse = {
      timestamp: new Date().toISOString(),
      health,
      metrics,
      databaseStats,
      aggregatedErrors,
    };

    timer.end();
    return NextResponse.json(response);
  } catch (error) {
    timer.end({ error: true });
    logger.error('Failed to get monitoring data', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json(
      { error: 'Failed to get monitoring data' },
      { status: 500 }
    );
  }
}

// ============================================================================
// POST: Track Client-Side Error
// ============================================================================

interface ClientErrorPayload {
  type: 'client_error';
  error: {
    name: string;
    message: string;
    stack?: string;
    digest?: string;
  };
  context: {
    component?: string;
    url?: string;
    timestamp?: string;
    userId?: string;
  };
}

export async function POST(request: NextRequest): Promise<NextResponse<{ success: boolean } | { error: string }>> {
  try {
    // Validate CSRF
    const csrfResult = validateCSRF(request);
    if (!csrfResult.valid) {
      return NextResponse.json(
        { error: 'CSRF validation failed', reason: csrfResult.reason },
        { status: 403 }
      );
    }

    // Parse the request body
    const body = await request.json() as ClientErrorPayload;
    
    if (body.type !== 'client_error') {
      return NextResponse.json({ error: 'Invalid payload type' }, { status: 400 });
    }
    
    // Create an error object from the payload
    const error = new Error(body.error.message);
    error.name = body.error.name;
    error.stack = body.error.stack;
    
    // Track the error
    trackError(error, {
      component: body.context.component,
      metadata: {
        url: body.context.url,
        digest: body.error.digest,
        clientTimestamp: body.context.timestamp,
      },
    });
    
    // Increment error counter
    await incrementCounter('error_client');
    
    // Log the client error
    logger.warn('Client-side error tracked', {
      error: body.error.message,
      component: body.context.component,
      url: body.context.url,
    });
    
    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('Failed to track client error', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json(
      { error: 'Failed to track error' },
      { status: 500 }
    );
  }
}

// ============================================================================
// DELETE: Clear Metrics/Errors
// ============================================================================

export async function DELETE(request: NextRequest): Promise<NextResponse<{ success: boolean } | { error: string }>> {
  try {
    // Validate CSRF
    const csrfResult = validateCSRF(request);
    if (!csrfResult.valid) {
      return NextResponse.json(
        { error: 'CSRF validation failed', reason: csrfResult.reason },
        { status: 403 }
      );
    }

    // Check authentication
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Check super admin permission (only super admins can clear metrics)
    const hasSuperAdminAccess = await checkUserPermission(session.user.id, 'system.delete.all');
    if (!hasSuperAdminAccess) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Get query parameters
    const { searchParams } = new URL(request.url);
    const clearType = searchParams.get('type'); // 'metrics' | 'errors' | 'all'

    switch (clearType) {
      case 'metrics':
        await clearMetrics();
        logger.info('Metrics cleared', { userId: session.user.id });
        break;
      
      case 'errors':
        clearAggregatedErrors();
        logger.info('Aggregated errors cleared', { userId: session.user.id });
        break;
      
      case 'all':
        await clearMetrics();
        clearAggregatedErrors();
        logger.info('All monitoring data cleared', { userId: session.user.id });
        break;
      
      default:
        return NextResponse.json(
          { error: 'Invalid clear type. Use "metrics", "errors", or "all"' },
          { status: 400 }
        );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('Failed to clear monitoring data', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json(
      { error: 'Failed to clear monitoring data' },
      { status: 500 }
    );
  }
}
