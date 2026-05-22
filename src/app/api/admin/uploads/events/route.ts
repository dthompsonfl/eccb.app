import { NextRequest } from 'next/server';
import { initializeQueues, getQueueEvents } from '@/lib/jobs/queue';
import { logger } from '@/lib/logger';
import { getSession } from '@/lib/auth/guards';
import { checkUserPermission } from '@/lib/auth/permissions';

import { MUSIC_UPLOAD, MUSIC_VIEW_ALL } from '@/lib/auth/permission-constants';
/**
 * GET /api/admin/uploads/events
 *
 * Server-Sent Events (SSE) endpoint for real-time upload progress.
 * Clients can connect to this endpoint to receive live progress updates.
 *
 * Query parameters:
 * - sessionId: (optional) Filter events for a specific session
 */
export async function GET(request: NextRequest) {
  const sessionId = request.nextUrl.searchParams.get('sessionId');
  const encoder = new TextEncoder();

  // Auth guard: require authenticated user with music upload permission
  const session = await getSession();
  if (!session?.user?.id) {
    // Return SSE-formatted error for protocol consistency
    const errorStream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(`event: error\ndata: ${JSON.stringify({ error: 'Unauthorized', status: 401 })}\n\n`)
        );
        controller.close();
      },
    });
    return new Response(errorStream, {
      status: 401,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
      },
    });
  }
  
  const [canUploadMusic, canViewMusic] = await Promise.all([
    checkUserPermission(session.user.id, MUSIC_UPLOAD),
    checkUserPermission(session.user.id, MUSIC_VIEW_ALL),
  ]);
  if (!canUploadMusic && !canViewMusic) {
    const errorStream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(`event: error\ndata: ${JSON.stringify({ error: 'Forbidden', status: 403 })}\n\n`)
        );
        controller.close();
      },
    });
    return new Response(errorStream, {
      status: 403,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
      },
    });
  }

  initializeQueues();
  const queueEvents = getQueueEvents('SMART_UPLOAD');

  if (!queueEvents) {
    const errorStream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(`event: error\ndata: ${JSON.stringify({ error: 'Queue events not available', status: 503 })}\n\n`)
        );
        controller.close();
      },
    });
    return new Response(errorStream, {
      status: 503,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
      },
    });
  }

  const stream = new ReadableStream({
    start(controller) {
      logger.debug('SSE connection established', { sessionId });

      // Send initial connection message
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify({ type: 'connected', sessionId })}

`)
      );

      // Handler for progress events
      const progressHandler = (args: { jobId: string; data: unknown }) => {
        const { jobId, data } = args;
        const progressData = data as { sessionId?: string; step?: string; percent?: number; message?: string };

        // If sessionId is specified, only send events for that session
        if (sessionId && progressData.sessionId !== sessionId) {
          return;
        }

        const event = {
          type: 'progress',
          jobId,
          timestamp: new Date().toISOString(),
          data: {
            ...progressData,
            sessionId: progressData.sessionId ?? null,
            stage: progressData.step ?? 'processing',
            percent: progressData.percent ?? 0,
            status: 'in_progress',
            failureCode: null,
            failureStage: null,
          },
        };

        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}

`));
        } catch {
          // Client disconnected
        }
      };

      // Handler for completed events
      const completedHandler = (args: { jobId: string; returnvalue: unknown }) => {
        const { jobId, returnvalue } = args;
        const result = (returnvalue ?? {}) as {
          sessionId?: string;
          status?: string;
          partsCreated?: number;
          confidenceScore?: number;
          routingDecision?: string;
        };

        // BullMQ may emit returnvalue=undefined when the processor doesn't
        // return. Treat these as unfiltered so we never silently drop events.
        // If sessionId is specified, only send events for that session
        if (sessionId && result.sessionId && result.sessionId !== sessionId) {
          return;
        }

        const event = {
          type: 'completed',
          jobId,
          timestamp: new Date().toISOString(),
          data: {
            ...result,
            sessionId: result.sessionId ?? null,
            stage: 'complete',
            percent: 100,
            status: 'completed',
            failureCode: null,
            failureStage: null,
          },
        };

        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}

`));
        } catch {
          // Client disconnected
        }
      };

      // Handler for failed events
      const failedHandler = (args: { jobId: string; failedReason?: string }) => {
        const { jobId, failedReason } = args;

        const event = {
          type: 'failed',
          jobId,
          timestamp: new Date().toISOString(),
          data: {
            sessionId: jobId.includes('_') ? jobId.split('_').slice(-1)[0] : null,
            error: failedReason ?? 'Job failed',
            stage: 'failed',
            percent: 100,
            status: 'failed',
            failureCode: 'JOB_FAILED',
            failureStage: 'worker',
          },
        };

        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}

`));
        } catch {
          // Client disconnected
        }
      };

      // Subscribe to events
      queueEvents.on('progress', progressHandler);
      queueEvents.on('completed', completedHandler);
      queueEvents.on('failed', failedHandler);

      // Handle client disconnect
      request.signal.addEventListener('abort', () => {
        logger.debug('SSE connection closed', { sessionId });
        queueEvents.off('progress', progressHandler);
        queueEvents.off('completed', completedHandler);
        queueEvents.off('failed', failedHandler);
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      Connection: 'keep-alive',
    },
  });
}
