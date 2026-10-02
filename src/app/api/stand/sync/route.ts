import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { redis } from '@/lib/redis';
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

interface StandSyncState {
  eventId: string;
  musicId?: string;
  currentPage?: number;
  currentPieceIndex?: number;
  nightMode?: boolean;
  lastUpdated: string;
}

const ACTIVE_PRESENCE_WINDOW_MS = 30_000;
const STATE_TTL_SECONDS = 12 * 60 * 60;
const STATE_KEY_PREFIX = 'stand:sync:state:';

function stateKey(eventId: string): string {
  return `${STATE_KEY_PREFIX}${eventId}`;
}

function parseInteger(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function getStandState(eventId: string): Promise<StandSyncState | undefined> {
  const raw = await redis.hgetall(stateKey(eventId));
  if (Object.keys(raw).length === 0) return undefined;

  return {
    eventId,
    musicId: raw.musicId || undefined,
    currentPage: parseInteger(raw.currentPage),
    currentPieceIndex: parseInteger(raw.currentPieceIndex),
    nightMode:
      raw.nightMode === undefined ? undefined : raw.nightMode === 'true',
    lastUpdated: raw.lastUpdated || new Date().toISOString(),
  };
}

async function updateStandState(
  eventId: string,
  updates: Partial<Pick<StandSyncState, 'musicId' | 'currentPage' | 'currentPieceIndex' | 'nightMode'>>,
): Promise<StandSyncState> {
  const now = new Date().toISOString();
  const fields: string[] = ['eventId', eventId, 'lastUpdated', now];

  if (updates.musicId !== undefined) fields.push('musicId', updates.musicId);
  if (updates.currentPage !== undefined) fields.push('currentPage', String(updates.currentPage));
  if (updates.currentPieceIndex !== undefined) {
    fields.push('currentPieceIndex', String(updates.currentPieceIndex));
  }
  if (updates.nightMode !== undefined) fields.push('nightMode', String(updates.nightMode));

  await redis
    .multi()
    .hset(stateKey(eventId), ...fields)
    .expire(stateKey(eventId), STATE_TTL_SECONDS)
    .exec();

  return (await getStandState(eventId)) ?? {
    eventId,
    ...updates,
    lastUpdated: now,
  };
}

async function getActiveUsers(eventId: string) {
  const cutoff = new Date(Date.now() - ACTIVE_PRESENCE_WINDOW_MS);
  const sessions = await prisma.standSession.findMany({
    where: {
      eventId,
      lastSeenAt: { gte: cutoff },
    },
    select: {
      userId: true,
      section: true,
      lastSeenAt: true,
    },
    orderBy: { lastSeenAt: 'desc' },
  });

  if (sessions.length === 0) return [];

  const users = await prisma.user.findMany({
    where: { id: { in: sessions.map((session) => session.userId) } },
    select: {
      id: true,
      name: true,
      member: {
        select: {
          firstName: true,
          lastName: true,
        },
      },
    },
  });

  const names = new Map(
    users.map((user) => [
      user.id,
      user.name ||
        (user.member
          ? `${user.member.firstName} ${user.member.lastName}`.trim()
          : user.id),
    ]),
  );

  return sessions.map((session) => ({
    userId: session.userId,
    name: names.get(session.userId) ?? session.userId,
    section: session.section ?? undefined,
    lastSeenAt: session.lastSeenAt,
  }));
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

    const [state, activeUsers] = await Promise.all([
      getStandState(eventId),
      getActiveUsers(eventId),
    ]);

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
      lastSyncAt: state?.lastUpdated || new Date().toISOString(),
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
    const rateLimited = await applyRateLimit(request, 'stand-sync');
    if (rateLimited) return rateLimited;

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

    const userSection = member?.sections[0]?.section.name;

    if (syncData.presence) {
      const presenceValidation = presenceSchema.safeParse(syncData.presence);
      if (!presenceValidation.success) {
        return NextResponse.json(
          { error: 'Validation error', details: presenceValidation.error.issues },
          { status: 400 },
        );
      }

      if (presenceValidation.data.status === 'joined') {
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
            section: userSection,
            lastSeenAt: new Date(),
          },
          update: {
            section: userSection,
            lastSeenAt: new Date(),
          },
        });
      } else {
        await prisma.standSession.deleteMany({
          where: { eventId, userId: ctx.userId },
        });
      }

      return NextResponse.json({
        success: true,
        presence: presenceValidation.data,
      });
    }

    // Shared page/piece/night-mode state is conductor/director control. Ordinary
    // attendees may receive it, but they must never be able to drive it.
    if (!ctx.isDirector) {
      return NextResponse.json(
        { error: 'Forbidden: stand sync control requires director access' },
        { status: 403 },
      );
    }

    if (syncData.command) {
      const commandValidation = commandSchema.safeParse(syncData.command);
      if (!commandValidation.success) {
        return NextResponse.json(
          { error: 'Validation error', details: commandValidation.error.issues },
          { status: 400 },
        );
      }

      const { action, page, pieceIndex, value } = commandValidation.data;

      if (action === 'setPage' && page) {
        await updateStandState(eventId, { currentPage: page });
      } else if (action === 'setPiece' && pieceIndex !== undefined) {
        await updateStandState(eventId, { currentPieceIndex: pieceIndex });
      } else if (action === 'toggleNightMode') {
        const currentState = await getStandState(eventId);
        await updateStandState(eventId, {
          nightMode: value ?? !currentState?.nightMode,
        });
      }

      return NextResponse.json({
        success: true,
        command: commandValidation.data,
        lastSyncAt: new Date().toISOString(),
      });
    }

    if (syncData.mode) {
      const modeValidation = modeSchema.safeParse(syncData.mode);
      if (!modeValidation.success) {
        return NextResponse.json(
          { error: 'Validation error', details: modeValidation.error.issues },
          { status: 400 },
        );
      }

      if (
        modeValidation.data.name === 'nightMode' &&
        typeof modeValidation.data.value === 'boolean'
      ) {
        await updateStandState(eventId, { nightMode: modeValidation.data.value });
      }

      return NextResponse.json({
        success: true,
        mode: modeValidation.data,
        lastSyncAt: new Date().toISOString(),
      });
    }

    const validated = syncStateSchema.parse({ eventId, ...syncData });
    const state = await updateStandState(eventId, {
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
        section: userSection,
        lastSeenAt: new Date(),
      },
      update: {
        section: userSection,
        lastSeenAt: new Date(),
      },
    });

    return NextResponse.json({
      success: true,
      lastSyncAt: state.lastUpdated,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation error', details: error.issues },
        { status: 400 },
      );
    }
    console.error('Error updating sync state:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
