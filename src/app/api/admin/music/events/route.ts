import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/guards';
import { checkUserPermission } from '@/lib/auth/permissions';
import { logger } from '@/lib/logger';

import { MUSIC_VIEW_ALL } from '@/lib/auth/permission-constants';
/**
 * GET /api/admin/music/events
 * 
 * Server-Sent Events endpoint for real-time music library updates.
 * Clients can connect to this endpoint to receive live updates when music pieces
 * are created, modified, archived, or deleted.
 */
export async function GET(request: NextRequest) {
  try {
    // Auth guard: require authenticated user with music read permission
    const session = await getSession();
    if (!session?.user?.id) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const hasPermission = await checkUserPermission(session.user.id, MUSIC_VIEW_ALL);
    if (!hasPermission) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      start(controller) {
        logger.debug('Music events SSE connection established', {
          userId: session.user.id,
        });

        // Send initial connection message
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() })}\n\n`)
        );

        // Simulate real-time updates by sending a heartbeat every 30 seconds
        // In production, this would be driven by actual database events or a message queue
        const heartbeatInterval = setInterval(() => {
          try {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ type: 'heartbeat', timestamp: new Date().toISOString() })}\n\n`)
            );
          } catch {
            // Client disconnected
            clearInterval(heartbeatInterval);
          }
        }, 30000);

        // Handle client disconnect
        request.signal.addEventListener('abort', () => {
          logger.debug('Music events SSE connection closed', {
            userId: session.user.id,
          });
          clearInterval(heartbeatInterval);
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
  } catch (error) {
    logger.error('Music events SSE error', { error });
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
