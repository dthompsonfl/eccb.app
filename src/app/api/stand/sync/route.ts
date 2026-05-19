import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { applyRateLimit } from '@/lib/rate-limit';
import { z } from 'zod';
import { annotationVisibilityFilter, requireEventStandAccess } from '@/lib/stand/access';
import { recordTelemetry } from '@/lib/stand/telemetry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Sync endpoint for stand real-time updates
 *
 * Supports two modes:
 * 1. Polling-based (default) - works with standard Next.js API routes
 * 2. WebSocket - requires custom server or external WebSocket service
 *
 * WebSocket Connection:
 * To use WebSockets, connect to /api/stand/socket with Socket.IO client.
 * The Socket.IO path is configured separately for the custom server.
 *
 * GET - Returns current sync state for a music piece (polling)
 * POST - Broadcasts a sync event (polling)
 * WebSocket Upgrade - Real-time bidirectional sync (requires custom server)
 */

const syncStateSchema = z.object({
  eventId: z.string().min(1),
  musicId: z.string().optional(),
  currentPage: z.number().int().positive().optional(),
  currentPieceIndex: z.number().int().min(0).optional(),
  nightMode: z.boolean().optional(),
  lastSyncAt: z.string().datetime().optional(),
});

const commandSchema = z.object({
  type: z.literal('command'),
  action: z.enum(['setPage', 'setPiece', 'toggleNightMode']),
  page: z.number().int().positive().optional(),
  pieceIndex: z.number().int().min(0).optional(),
  value: z.boolean().optional(),
});

const modeSchema = z.object({
  type: z.literal('mode'),
  name: z.string(),
  value: z.unknown(),
});

const presenceSchema = z.object({
  type: z.literal('presence'),
  status: z.enum(['joined', 'left']),
});

const ACTIVE_PRESENCE_WINDOW_MS = 30_000;

// In-memory sync state (for simple polling and WebSocket state sharing)
// In production with custom server, use Redis for distributed state
const standStateMap = new Map<
  string,
  {
    eventId: string;
    musicId?: string;
    currentPage?: number;
    currentPieceIndex?: number;
    nightMode?: boolean;
    lastUpdated: Date;
  }
>();

// In-memory presence tracking
const presenceMap = new Map<
  string,
  {
    userId: string;
    name: string;
    section?: string;
    eventId: string;
    lastSeen: Date;
  }
>();

function getStandState(eventId: string) {
  return standStateMap.get(eventId);
}

function updateStandState(eventId: string, updates: Partial<{
  musicId: string;
  currentPage: number;
  currentPieceIndex: number;
  nightMode: boolean;
}>) {
  let state = standStateMap.get(eventId);
  if (!state) {
    state = {
      eventId,
      lastUpdated: new Date(),
    };
  }

  state = {
    ...state,
    ...updates,
    lastUpdated: new Date(),
  };

  standStateMap.set(eventId, state);
  return state;
}

function getActiveUsers(eventId: string) {
  const cutoff = new Date(Date.now() - ACTIVE_PRESENCE_WINDOW_MS);
  return Array.from(presenceMap.values()).filter(
    (p) => p.eventId === eventId && p.lastSeen > cutoff
  );
}

/**
 * GET /api/stand/sync
 * Returns sync state for an event (polling endpoint)
 * Query params: eventId, musicId
 */
export async function GET(request: NextRequest) {
  try {
    const rateLimited = await applyRateLimit(request, 'stand-sync');
    if (rateLimited) return rateLimited;

    const { searchParams } = new URL(request.url);
    const eventId = searchParams.get('eventId');
    const musicId = searchParams.get('musicId');

    if (!eventId) {
      return NextResponse.json({ error: 'eventId query parameter is required' }, { status: 400 });
    }

    const ctx = await requireEventStandAccess(eventId);
    if (ctx instanceof NextResponse) return ctx;

    recordTelemetry({ event: 'stand.sync.poll', userId: ctx.userId, eventId });

    const state = getStandState(eventId);
    const activeUsers = getActiveUsers(eventId);

    let recentAnnotations: unknown[] = [];
    if (musicId) {
      const visibilityFilter = annotationVisibilityFilter(ctx, musicId);
      recentAnnotations = await prisma.annotation.findMany({
        where: {
          ...visibilityFilter,
          updatedAt: {
            gte: new Date(Date.now() - 5 * 60 * 1000),
          },
        },
        orderBy: { updatedAt: 'desc' },
        take: 10,
      });
    }

    return NextResponse.json({
      eventId,
      musicId: state?.musicId ?? musicId ?? undefined,
      currentPage: state?.currentPage,
      currentPieceIndex: state?.currentPieceIndex,
      nightMode: state?.nightMode,
      lastSyncAt: state?.lastUpdated?.toISOString() || new Date().toISOString(),
      activeUsers: activeUsers.length,
      activeUserList: activeUsers.map((u) => ({
        userId: u.userId,
        name: u.name,
        section: u.section,
      })),
      recentAnnotations,
    });
  } catch (error) {
    console.error('Error fetching sync state:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/stand/sync
 * Updates sync state for an event or sends commands (polling endpoint)
 * Body: { eventId, musicId?, currentPage?, currentPieceIndex?, nightMode?, command?, mode? }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { eventId, ...syncData } = body;

    if (!eventId) {
      return NextResponse.json({ error: 'eventId is required' }, { status: 400 });
    }

    const ctx = await requireEventStandAccess(eventId);
    if (ctx instanceof NextResponse) return ctx;

    const member = await prisma.member.findFirst({
      where: { userId: ctx.userId },
      include: { sections: { where: { isLeader: true }, include: { section: true } } },
    });

    const userName = member
      ? [member.firstName, member.lastName].filter(Boolean).join(' ').trim() || ctx.userId
      : ctx.userId;
    const userSection = member?.sections[0]?.section.name;

    if (syncData.command) {
      const commandValidation = commandSchema.safeParse(syncData.command);
      if (commandValidation.success) {
        const { action, page, pieceIndex, value } = commandValidation.data;

        if (action === 'setPage' && page) {
          updateStandState(eventId, { currentPage: page });
        } else if (action === 'setPiece' && pieceIndex !== undefined) {
          updateStandState(eventId, { currentPieceIndex: pieceIndex });
        } else if (action === 'toggleNightMode') {
          const currentState = getStandState(eventId);
          updateStandState(eventId, { nightMode: value ?? !currentState?.nightMode });
        }

        return NextResponse.json({
          success: true,
          command: commandValidation.data,
          lastSyncAt: new Date().toISOString(),
        });
      }
    }

    if (syncData.mode) {
      const modeValidation = modeSchema.safeParse(syncData.mode);
      if (modeValidation.success) {
        if (
          modeValidation.data.name === 'nightMode' &&
          typeof modeValidation.data.value === 'boolean'
        ) {
          updateStandState(eventId, { nightMode: modeValidation.data.value });
        }

        return NextResponse.json({
          success: true,
          mode: modeValidation.data,
          lastSyncAt: new Date().toISOString(),
        });
      }
    }

    if (syncData.presence) {
      const presenceValidation = presenceSchema.safeParse(syncData.presence);
      if (presenceValidation.success) {
        const { status } = presenceValidation.data;

        if (status === 'joined') {
          presenceMap.set(`${eventId}:${ctx.userId}`, {
            userId: ctx.userId,
            name: userName,
            section: userSection,
            eventId,
            lastSeen: new Date(),
          });
        } else {
          presenceMap.delete(`${eventId}:${ctx.userId}`);
        }

        await prisma.standSession.upsert({
          where: {
            eventId_userId: {
              eventId,
              userId: ctx.userId,
            },
          },
          create: {
            eventId,
            userId: ctx.userId,
            lastSeenAt: new Date(),
          },
          update: {
            lastSeenAt: new Date(),
          },
        });

        return NextResponse.json({
          success: true,
          presence: presenceValidation.data,
        });
      }
    }

    const validated = syncStateSchema.parse({ eventId, ...syncData });

    const state = updateStandState(eventId, {
      ...(validated.musicId !== undefined ? { musicId: validated.musicId } : {}),
      ...(validated.currentPage !== undefined ? { currentPage: validated.currentPage } : {}),
      ...(validated.currentPieceIndex !== undefined
        ? { currentPieceIndex: validated.currentPieceIndex }
        : {}),
      ...(validated.nightMode !== undefined ? { nightMode: validated.nightMode } : {}),
    });

    await prisma.standSession.upsert({
      where: {
        eventId_userId: {
          eventId: validated.eventId,
          userId: ctx.userId,
        },
      },
      create: {
        eventId: validated.eventId,
        userId: ctx.userId,
        lastSeenAt: new Date(),
      },
      update: {
        lastSeenAt: new Date(),
      },
    });

    return NextResponse.json({
      success: true,
      lastSyncAt: state.lastUpdated.toISOString(),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation error', details: error.issues },
        { status: 400 }
      );
    }
    console.error('Error updating sync state:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
