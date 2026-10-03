import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { applyRateLimit } from '@/lib/rate-limit';
import { z } from 'zod';
import {
  annotationVisibilityFilter,
  requireEventStandAccess,
} from '@/lib/stand/access';
import {
  StandStateUnavailableError,
  clearPresence,
  getActivePresence,
  getStandState,
  touchPresence,
  updateStandState,
} from '@/lib/stand/sync-state';
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
 *
 * ── State ownership ───────────────────────────────────────────────────────────
 * Shared stand state (current page, current piece, night mode) and the presence
 * roster live in Redis, NOT in process memory — see `@/lib/stand/sync-state` for
 * the key scheme, TTLs and the rationale. Process-local Maps cannot work in a
 * multi-process deployment and are wiped on every deploy, which silently breaks
 * "the director turns the page and the whole band follows".
 *
 * Only a director (ctx.isDirector) may drive those fields, whether they arrive
 * as an explicit `command` or as a bare state broadcast. Any other stand-visible
 * member gets 403. Without this, any attendee with stand access could hijack the
 * conductor's page for the entire band.
 *
 * Degradation: if Redis is unavailable this endpoint returns 503 and never a
 * fabricated `success: true`. See the failure policy in `@/lib/stand/sync-state`.
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

/**
 * Fields that define what the whole band is looking at. Only a director may
 * write them; everyone else is limited to presence and their own session.
 */
const DIRECTOR_CONTROLLED_FIELDS = ['currentPage', 'currentPieceIndex', 'nightMode'] as const;

/** True when a bare broadcast carries any director-controlled field. */
function carriesDirectorControl(syncData: Record<string, unknown>): boolean {
  return DIRECTOR_CONTROLLED_FIELDS.some((field) => syncData[field] !== undefined);
}

function forbiddenCommand(): NextResponse {
  return NextResponse.json(
    { error: 'Only a director can control the stand for this event' },
    { status: 403 }
  );
}

function stateUnavailable(_error: StandStateUnavailableError): NextResponse {
  return NextResponse.json(
    {
      error: 'The music stand is temporarily unable to sync. Please try again in a moment.',
      code: 'STAND_SYNC_UNAVAILABLE',
    },
    { status: 503 }
  );
}

async function touchStandSession(eventId: string, userId: string): Promise<void> {
  await prisma.standSession.upsert({
    where: { eventId_userId: { eventId, userId } },
    create: { eventId, userId, lastSeenAt: new Date() },
    update: { lastSeenAt: new Date() },
  });
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

    const state = await getStandState(eventId);
    const activeUsers = await getActivePresence(eventId);

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
      lastSyncAt: state?.lastUpdated ?? new Date().toISOString(),
      activeUsers: activeUsers.length,
      activeUserList: activeUsers.map((u) => ({
        userId: u.userId,
        name: u.name,
        section: u.section,
      })),
      recentAnnotations,
    });
  } catch (error) {
    if (error instanceof StandStateUnavailableError) return stateUnavailable(error);
    console.error('Error fetching sync state:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * POST /api/stand/sync
 * Updates sync state for an event or sends commands (polling endpoint)
 * Body: { eventId, musicId?, currentPage?, currentPieceIndex?, nightMode?, command?, mode? }
 */
export async function POST(request: NextRequest) {
  try {
    // Rate limit the write path. GET (polling) was already limited but POST
    // was not, so any stand-visible member could drive the shared state and
    // the presence roster in Redis without bound.
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

    const userName = member
      ? [member.firstName, member.lastName].filter(Boolean).join(' ').trim() || ctx.userId
      : ctx.userId;
    const userSection = member?.sections[0]?.section.name;

    if (syncData.command) {
      const commandValidation = commandSchema.safeParse(syncData.command);
      if (commandValidation.success) {
        // Page turns are the conductor's job — never a player's.
        if (!ctx.isDirector) return forbiddenCommand();

        const { action, page, pieceIndex, value } = commandValidation.data;

        if (action === 'setPage' && page) {
          await updateStandState(eventId, { currentPage: page });
        } else if (action === 'setPiece' && pieceIndex !== undefined) {
          await updateStandState(eventId, { currentPieceIndex: pieceIndex });
        } else if (action === 'toggleNightMode') {
          const currentState = await getStandState(eventId);
          await updateStandState(eventId, { nightMode: value ?? !currentState?.nightMode });
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
        if (modeValidation.data.name === 'nightMode') {
          // nightMode changes what every player sees.
          if (!ctx.isDirector) return forbiddenCommand();
          if (typeof modeValidation.data.value === 'boolean') {
            await updateStandState(eventId, { nightMode: modeValidation.data.value });
          }
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
          await touchPresence({
            userId: ctx.userId,
            name: userName,
            section: userSection,
            eventId,
          });
        } else {
          await clearPresence(eventId, ctx.userId);
        }

        await touchStandSession(eventId, ctx.userId);

        return NextResponse.json({
          success: true,
          presence: presenceValidation.data,
        });
      }
    }

    // A bare state broadcast from the viewer. It carries the same
    // director-controlled fields as an explicit command, so it needs the same
    // authorization check — otherwise the guard is trivially bypassed.
    if (!ctx.isDirector && carriesDirectorControl(syncData)) {
      return forbiddenCommand();
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

    await touchStandSession(eventId, ctx.userId);

    return NextResponse.json({
      success: true,
      lastSyncAt: state.lastUpdated,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Validation error', details: error.issues }, { status: 400 });
    }
    if (error instanceof StandStateUnavailableError) return stateUnavailable(error);
    console.error('Error updating sync state:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

