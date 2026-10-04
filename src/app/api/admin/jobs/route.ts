/**
 * Job Queue Monitoring API
 * 
 * GET: List job queue status
 * POST: Retry failed jobs or manage jobs
 * 
 * Admin-only access.
 */

import { NextRequest, NextResponse } from 'next/server';
import { 
  getAllQueueStats, 
  getQueueStats, 
  getJobStatus, 
  getDeadLetterJobs,
  getDeadLetterCount,
  retryDeadLetterJob,
  QUEUE_NAMES,
} from '@/lib/jobs/queue';
import { auth } from '@/lib/auth/config';
import { checkUserPermission } from '@/lib/auth/permissions';
import { validateCSRF } from '@/lib/csrf';
import { logger } from '@/lib/logger';
import { z } from 'zod';
import { applyRateLimit } from '@/lib/rate-limit';

// ============================================================================
// Request Validation
// ============================================================================

const retryJobSchema = z.object({
  action: z.literal('retry'),
  jobId: z.string(),
  queueName: z.enum([
    'EMAIL',
    'NOTIFICATION',
    'SCHEDULED',
    'CLEANUP',
    'SMART_UPLOAD',
    'OCR',
    'DEAD_LETTER',
  ]),
});

const clearQueueSchema = z.object({
  action: z.literal('clear'),
  queueName: z.enum([
    'EMAIL',
    'NOTIFICATION',
    'SCHEDULED',
    'CLEANUP',
    'SMART_UPLOAD',
    'OCR',
    'DEAD_LETTER',
  ]),
});

const actionSchema = z.discriminatedUnion('action', [
  retryJobSchema,
  clearQueueSchema,
]);

// ============================================================================
// GET: List Job Queue Status
// ============================================================================

export async function GET(request: NextRequest) {
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
    const queueName = searchParams.get('queue') as keyof typeof QUEUE_NAMES | null;
    const jobId = searchParams.get('jobId');
    const includeDeadLetter = searchParams.get('dlq') === 'true';

    // Get specific job status
    if (queueName && jobId) {
      const jobStatus = await getJobStatus(queueName, jobId);
      if (!jobStatus) {
        return NextResponse.json({ error: 'Job not found' }, { status: 404 });
      }
      return NextResponse.json({ job: jobStatus });
    }

    // Get specific queue stats
    if (queueName) {
      const stats = await getQueueStats(queueName);
      return NextResponse.json({ queue: stats });
    }

    // Get all queue stats
    const stats = await getAllQueueStats();

    // Optionally include dead letter queue jobs
    let deadLetterJobs = undefined;
    let deadLetterCount = 0;
    if (includeDeadLetter) {
      deadLetterJobs = await getDeadLetterJobs(20);
      deadLetterCount = await getDeadLetterCount();
    }

    return NextResponse.json({
      queues: stats,
      deadLetterCount,
      deadLetterJobs: deadLetterJobs?.map(job => {
        // The failure reason lives in the payload WE wrote when the job was
        // dead-lettered. `job.failedReason` is BullMQ's own field and is always
        // undefined here, because the job was never actually run — it was moved
        // to the holding pen by `moveToDeadLetterQueue`. Reading it showed an
        // empty reason for every entry.
        const payload = job.data as {
          originalJobId?: string;
          originalQueue?: string;
          originalName?: string;
          failedReason?: string;
          failedAt?: string;
          attemptsMade?: number;
        };
        return {
          id: job.id,
          name: job.name,
          timestamp: job.timestamp,
          // Expose both the envelope and the fields the UI displays.
          data: job.data,
          failedReason: payload.failedReason ?? null,
          failedAt: payload.failedAt ?? null,
          attemptsMade: payload.attemptsMade ?? null,
          originalJobId: payload.originalJobId ?? null,
          originalQueue: payload.originalQueue ?? null,
          originalName: payload.originalName ?? null,
        };
      }),
    });
  } catch (error) {
    logger.error('Failed to get job queue status', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json(
      { error: 'Failed to get job queue status' },
      { status: 500 }
    );
  }
}

// ============================================================================
// POST: Manage Jobs
// ============================================================================

export async function POST(request: NextRequest) {
    // Rate limit this admin mutation. Without it a hijacked or over-
    // privileged session could hammer destructive or AI-spending
    // endpoints without bound.
    const rateLimited = await applyRateLimit(request, 'adminAction');
    if (rateLimited) return rateLimited;

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

    // Check admin permission
    const hasAdminAccess = await checkUserPermission(session.user.id, 'system.edit.all');
    if (!hasAdminAccess) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Parse and validate request body
    const body = await request.json();
    const parsed = actionSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request', details: parsed.error.issues },
        { status: 400 }
      );
    }

    const data = parsed.data;

    // Handle actions
    switch (data.action) {
      case 'retry': {
        // Retry a job from the dead letter queue
        const success = await retryDeadLetterJob(data.jobId);
        if (!success) {
          return NextResponse.json(
            { error: 'Failed to retry job' },
            { status: 500 }
          );
        }
        logger.info('Job retried from dead letter queue', {
          jobId: data.jobId,
          userId: session.user.id,
        });
        return NextResponse.json({ success: true, message: 'Job retried' });
      }

      case 'clear': {
        // Clear a specific queue (dangerous operation)
        logger.warn('Clearing queue requested', {
          queueName: data.queueName,
          userId: session.user.id,
        });
        
        // This is intentionally restrictive - only clear specific queues
        if (data.queueName === 'DEAD_LETTER') {
          return NextResponse.json(
            { error: 'Cannot clear dead letter queue directly' },
            { status: 400 }
          );
        }

        // Note: In production, you might want additional confirmation
        // For now, we'll just log and return an error
        return NextResponse.json(
          { error: 'Queue clearing is disabled for safety' },
          { status: 400 }
        );
      }

      default:
        return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
    }
  } catch (error) {
    logger.error('Failed to process job action', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json(
      { error: 'Failed to process job action' },
      { status: 500 }
    );
  }
}

// ============================================================================
// DELETE: Clear Failed Jobs
// ============================================================================

export async function DELETE(request: NextRequest) {
    // Rate limit this admin mutation. Without it a hijacked or over-
    // privileged session could hammer destructive or AI-spending
    // endpoints without bound.
    const rateLimited = await applyRateLimit(request, 'adminAction');
    if (rateLimited) return rateLimited;

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

    // Check super admin permission (only super admins can clear queues)
    const hasSuperAdminAccess = await checkUserPermission(session.user.id, 'system.delete.all');
    if (!hasSuperAdminAccess) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Get query parameters
    const { searchParams } = new URL(request.url);
    const queueName = searchParams.get('queue') as keyof typeof QUEUE_NAMES | null;

    if (!queueName) {
      return NextResponse.json(
        { error: 'Queue name required' },
        { status: 400 }
      );
    }

    logger.warn('Clearing queue', {
      queueName,
      userId: session.user.id,
    });

    // This would need to be implemented in the queue module
    // For safety, we'll return an error for now
    return NextResponse.json(
      { error: 'Queue clearing requires direct Redis access for safety' },
      { status: 400 }
    );
  } catch (error) {
    logger.error('Failed to clear queue', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json(
      { error: 'Failed to clear queue' },
      { status: 500 }
    );
  }
}
