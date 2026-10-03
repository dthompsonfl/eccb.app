/**
 * Stand Socket Server — Enterprise WebSocket implementation
 *
 * Features:
 *  - Redis-backed state & presence (no in-memory Maps)
 *  - Socket.IO Redis Adapter for multi-node horizontal scaling
 *  - Better-Auth session token validation on handshake
 *  - Per-event rooms with heartbeat-based presence TTL
 *  - Zod-validated incoming messages
 *  - Graceful shutdown with adapter close
 *
 * ── ONE shared state, TWO transports ─────────────────────────────────────────
 * Shared stand state (page / piece / night mode) and the presence roster are
 * owned exclusively by `@/lib/stand/sync-state` — the SAME module the polling
 * route `/api/stand/sync` uses. This module deliberately has NO state keyspace
 * of its own.
 *
 * Previously the socket server kept a parallel `stand:room:<eventId>:state`
 * string with a different shape from the polling route's
 * `eccb:stand:sync:state:<eventId>`. A director's page turn over WebSocket was
 * therefore invisible to a polling client and vice-versa: during a rehearsal
 * half the band followed the conductor and half did not. One keyspace, one
 * shape, one TTL policy — see the sync-state module header for the rationale.
 *
 * The only key this module still owns is `stand:room:<eventId>:clients`, a
 * socketId → ConnectedClient hash. That is pure transport bookkeeping (which
 * socket is attached right now) used by the admin status endpoint; it is never
 * read as stand state and is not actorable by a client.
 *
 * ── Director-only page control ───────────────────────────────────────────────
 * Page turns, piece changes and night-mode toggles are the conductor's job.
 * The `command` and `mode` branches check `ctx.isDirector` — from
 * `buildAccessContext`, the canonical stand RBAC context, the same one the
 * polling route guards with. Without it any authenticated stand-visible member
 * could seize the conductor's page for the entire band. Presence messages and
 * each member's own heartbeat remain open to everyone, as before.
 *
 * ── Failure policy ───────────────────────────────────────────────────────────
 * There is no local fallback. A Redis failure raises
 * `StandStateUnavailableError`, which is reported to the offending socket as an
 * explicit `error` and NEVER broadcast to the room as if it had synced.
 */

import { Server as SocketIOServer, type Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import http from 'node:http';
import { prisma } from '@/lib/db';
import { buildAccessContext, canAccessEvent } from '@/lib/stand/access';
import {
  StandStateUnavailableError,
  clearPresence,
  getActivePresence,
  getStandState,
  touchPresence,
  updateStandState,
  type StandPresenceEntry,
  type StandSyncState,
} from '@/lib/stand/sync-state';
import { logger } from '@/lib/logger';
import { getSocketCorsOrigins } from '@/lib/allowed-origins';
import { z } from 'zod';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * TTL for the socket-connection bookkeeping hash. Stand state and presence TTLs
 * are owned by `@/lib/stand/sync-state` and are deliberately NOT redefined here.
 */
const CLIENTS_TTL_SECONDS = 3600; // 1 hour
/** Heartbeat interval expected from each socket client (ms). */
export const HEARTBEAT_INTERVAL_MS = 30_000;

// =============================================================================
// TYPES
// =============================================================================

export interface ConnectedClient {
  id: string;
  userId: string;
  name: string;
  section?: string;
  socketId: string;
  eventId: string;
  joinedAt: string; // ISO
}

/**
 * Stand state as seen by socket clients.
 *
 * This is an ALIAS of the canonical `StandSyncState` from
 * `@/lib/stand/sync-state`, not a second shape. Both transports read and write
 * the same Redis key, so both emit the same object to their clients.
 */
export type StandState = StandSyncState;

/** Re-exported so socket consumers need not import the sync-state module. */
export type StandPresence = StandPresenceEntry;

// =============================================================================
// ZOD SCHEMAS
// =============================================================================

const presenceSchema = z.object({
  type: z.literal('presence'),
  userId: z.string(),
  name: z.string(),
  section: z.string().optional(),
  status: z.enum(['joined', 'left']),
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

const annotationSchema = z.object({
  type: z.literal('annotation'),
  data: z.record(z.string(), z.unknown()),
});

const heartbeatSchema = z.object({
  type: z.literal('heartbeat'),
});

const baseMessageSchema = z.discriminatedUnion('type', [
  presenceSchema,
  commandSchema,
  modeSchema,
  annotationSchema,
  heartbeatSchema,
]);

export type StandMessage = z.infer<typeof baseMessageSchema>;

// =============================================================================
// REDIS KEY HELPERS
// =============================================================================

/**
 * The ONLY keyspace this module owns.
 *
 * Stand state and presence are NOT here — they belong to
 * `@/lib/stand/sync-state` (`eccb:stand:sync:*`), which the polling route also
 * uses. Keeping a second, differently-shaped state key here is what previously
 * made a director's page turn invisible across transports.
 */
const Keys = {
  /** Hash: socketId → JSON(ConnectedClient). Transport bookkeeping only. */
  roomClients: (eventId: string) => `stand:room:${eventId}:clients`,
};

// =============================================================================
// REDIS STATE HELPERS
// =============================================================================

async function redisAddClient(redis: Redis, client: ConnectedClient): Promise<void> {
  const key = Keys.roomClients(client.eventId);
  await redis.hset(key, client.socketId, JSON.stringify(client));
  await redis.expire(key, CLIENTS_TTL_SECONDS);
}

async function redisRemoveClient(
  redis: Redis,
  eventId: string,
  socketId: string,
): Promise<ConnectedClient | null> {
  const key = Keys.roomClients(eventId);
  const raw = await redis.hget(key, socketId);
  if (!raw) return null;
  await redis.hdel(key, socketId);
  return JSON.parse(raw) as ConnectedClient;
}

async function redisGetClients(redis: Redis, eventId: string): Promise<ConnectedClient[]> {
  const hash = await redis.hgetall(Keys.roomClients(eventId));
  if (!hash) return [];
  return Object.values(hash).map((v) => JSON.parse(v) as ConnectedClient);
}

/**
 * Remove a user's presence entry only when they have no other live socket in
 * the room. A member with the stand open on their laptop and their phone must
 * not be dropped from the roster when one of the two disconnects.
 */
async function clearPresenceIfLastSocket(
  redis: Redis,
  eventId: string,
  userId: string,
): Promise<void> {
  const remaining = (await redisGetClients(redis, eventId)).some((c) => c.userId === userId);
  if (!remaining) await clearPresence(eventId, userId);
}

// =============================================================================
// SESSION VALIDATION
// =============================================================================

/**
 * Validate a better-auth session token against the Session table.
 * Returns userId if valid and not expired, null otherwise.
 */
async function validateSession(token: string | undefined): Promise<string | null> {
  if (!token) return null;
  try {
    const session = await prisma.session.findFirst({
      where: { token, expiresAt: { gt: new Date() } },
      select: { userId: true },
    });
    return session?.userId ?? null;
  } catch (err) {
    logger.error('[WS] Session validation error', { error: err });
    return null;
  }
}

// =============================================================================
// USER INFO
// =============================================================================

async function getUserInfo(userId: string): Promise<{ name: string; section?: string }> {
  try {
    const member = await prisma.member.findFirst({
      where: { userId },
      include: {
        sections: {
          include: { section: true },
          where: { isLeader: true },
          take: 1,
        },
      },
    });
    if (!member) return { name: 'Unknown User' };
    return {
      name: `${member.firstName} ${member.lastName}`.trim() || 'Unknown User',
      section: member.sections[0]?.section.name,
    };
  } catch {
    return { name: 'Unknown User' };
  }
}

// =============================================================================
// MESSAGE PARSING
// =============================================================================

export function parseMessage(data: unknown): StandMessage | null {
  try {
    return baseMessageSchema.parse(data);
  } catch (err) {
    if (err instanceof z.ZodError) {
      logger.warn('[WS] Invalid message', { issues: err.issues });
    }
    return null;
  }
}

// =============================================================================
// SERVER INITIALIZATION
// =============================================================================

let io: SocketIOServer | null = null;

/**
 * Return the running Socket.IO instance (throws if not yet started).
 */
export function getStandSocketServer(): SocketIOServer {
  if (!io) {
    throw new Error('Socket.IO server not initialized. Call initializeStandSocketServer first.');
  }
  return io;
}

/**
 * Initialize the Socket.IO server, attach the Redis adapter, and wire all
 * connection/message handlers.
 *
 * @param httpServer  http.Server to attach Socket.IO to.
 * @param pubClient   ioredis publish client.
 * @param subClient   ioredis subscribe client (separate instance).
 * @param appUrl      Optional single-origin override (canonical origin).
 */
export function initializeStandSocketServer(
  httpServer: http.Server,
  pubClient: Redis,
  subClient: Redis,
  appUrl?: string,
): SocketIOServer {
  // An explicit override pins the CORS list to one origin; otherwise every
  // configured origin is allowed, so the stand works when reached over the LAN
  // address, Tailscale address or a forwarded public IP — not just loopback.
  const origin = appUrl ? [appUrl] : getSocketCorsOrigins();

  io = new SocketIOServer(httpServer, {
    path: '/api/stand/socket',
    cors: { origin, methods: ['GET', 'POST'], credentials: true },
    pingTimeout: 60_000,
    pingInterval: 25_000,
    transports: ['websocket', 'polling'],
  });

  // Redis adapter for horizontal scaling
  io.adapter(createAdapter(pubClient, subClient));
  logger.info('[WS] Redis adapter attached');

  // ── Auth middleware ───────────────────────────────────────────────────────
  io.use(async (socket, next) => {
    const token =
      (socket.handshake.auth?.token as string | undefined) ??
      (socket.handshake.query?.token as string | undefined) ??
      extractCookieValue(socket.handshake.headers?.cookie, 'better-auth.session_token');

    const userId = await validateSession(token);
    if (!userId) {
      logger.warn('[WS] Rejected handshake — invalid session', { socketId: socket.id });
      return next(new Error('Unauthorized'));
    }
    socket.data.userId = userId;
    next();
  });

  // ── Connection handler ────────────────────────────────────────────────────
  io.on('connection', async (socket: Socket) => {
    const eventId = socket.handshake.query.eventId as string | undefined;
    const userId = socket.data.userId as string;

    if (!eventId) {
      socket.emit('error', { message: 'eventId is required' });
      socket.disconnect();
      return;
    }

    const [hasAccess, accessCtx] = await Promise.all([
      canAccessEvent(userId, eventId),
      buildAccessContext(userId),
    ]);
    if (!hasAccess) {
      logger.warn('[WS] Unauthorised event access', { userId, eventId });
      socket.emit('error', { message: 'Access denied' });
      socket.disconnect();
      return;
    }

    socket.join(eventId);

    const userInfo = await getUserInfo(userId);
    const client: ConnectedClient = {
      id: socket.id,
      userId,
      name: userInfo.name,
      section: userInfo.section,
      socketId: socket.id,
      eventId,
      joinedAt: new Date().toISOString(),
    };

    await redisAddClient(pubClient, client);

    try {
      await touchPresence({
        userId,
        name: userInfo.name,
        section: userInfo.section,
        eventId,
      });
    } catch (err) {
      // Presence is best-effort onboarding: the client still gets state and can
      // heartbeat later. State reads below are NOT best-effort.
      logger.warn('[WS] Presence touch failed on join', { userId, eventId, error: err });
    }

    try {
      await prisma.standSession.upsert({
        where: { eventId_userId: { eventId, userId } },
        create: { eventId, userId, lastSeenAt: new Date() },
        update: { lastSeenAt: new Date() },
      });
    } catch (err) {
      logger.error('[WS] standSession upsert failed', { error: err });
    }

    // Hydrate new client with current state + roster. Both come from the shared
    // sync-state module, so a director's page turn over EITHER transport is what
    // this client sees here.
    const [currentState, presence] = await Promise.all([
      getStandState(eventId),
      getActivePresence(eventId),
    ]);
    socket.emit('state', currentState);
    socket.emit('roster', {
      type: 'roster',
      members: presence.map((p) => ({
        userId: p.userId,
        name: p.name,
        section: p.section,
        joinedAt: p.lastSeen,
      })),
    });

    // Announce new joiner to peers
    socket.to(eventId).emit('message', {
      type: 'presence',
      userId,
      name: userInfo.name,
      section: userInfo.section,
      status: 'joined',
    } as StandMessage);

    logger.info('[WS] Client joined', {
      socketId: socket.id,
      userId,
      eventId,
      isDirector: accessCtx.isDirector,
    });

    /** Page turns, piece changes and night mode are the conductor's job only. */
    const requireDirector = (): boolean => {
      if (accessCtx.isDirector) return true;
      logger.warn('[WS] Rejected privileged stand command', {
        socketId: socket.id,
        userId,
        eventId,
      });
      socket.emit('error', {
        message: 'Only a director can control the stand for this event',
        code: 'STAND_COMMAND_FORBIDDEN',
      });
      return false;
    };

    // ── Message handler ───────────────────────────────────────────────────
    socket.on('message', async (data: unknown) => {
      const msg = parseMessage(data);
      if (!msg) {
        socket.emit('error', { message: 'Invalid message format' });
        return;
      }

      try {
        switch (msg.type) {
          case 'heartbeat':
            // Open to everyone: it only refreshes the sender's own presence.
            await touchPresence({
              userId,
              name: userInfo.name,
              section: userInfo.section,
              eventId,
            });
            break;

          case 'command': {
            if (!requireDirector()) break;

            if (msg.action === 'setPage' && msg.page !== undefined) {
              await updateStandState(eventId, { currentPage: msg.page });
            } else if (msg.action === 'setPiece' && msg.pieceIndex !== undefined) {
              await updateStandState(eventId, { currentPieceIndex: msg.pieceIndex });
            } else if (msg.action === 'toggleNightMode') {
              const currentState = await getStandState(eventId);
              await updateStandState(eventId, {
                nightMode: msg.value ?? !currentState?.nightMode,
              });
            }
            io!.to(eventId).emit('message', msg);
            break;
          }

          case 'mode':
            if (msg.name === 'nightMode') {
              // nightMode changes what every player sees → director-only.
              if (!requireDirector()) break;
              if (typeof msg.value === 'boolean') {
                await updateStandState(eventId, { nightMode: msg.value });
              }
            }
            io!.to(eventId).emit('message', msg);
            break;

          case 'annotation':
            io!.to(eventId).emit('message', msg);
            break;

          case 'presence':
            if (msg.status === 'joined') {
              await touchPresence({
                userId,
                name: userInfo.name,
                section: userInfo.section,
                eventId,
              });
            } else {
              await clearPresence(eventId, userId);
            }
            break;
        }
      } catch (err) {
        if (err instanceof StandStateUnavailableError) {
          // Fail LOUD to the sender and broadcast NOTHING. A silent partial
          // sync is worse than an explicit error mid-rehearsal.
          logger.error('[WS] Stand state unavailable', {
            socketId: socket.id,
            eventId,
            error: err,
          });
          socket.emit('error', {
            message:
              'The music stand is temporarily unable to sync. Please try again in a moment.',
            code: 'STAND_SYNC_UNAVAILABLE',
          });
          return;
        }
        logger.error('[WS] Message handling failed', {
          socketId: socket.id,
          eventId,
          type: msg.type,
          error: err,
        });
        socket.emit('error', { message: 'Failed to process message' });
      }
    });

    // ── Disconnect handler ────────────────────────────────────────────────
    socket.on('disconnect', async (reason) => {
      logger.info('[WS] Client disconnected', { socketId: socket.id, userId, eventId, reason });
      const removed = await redisRemoveClient(pubClient, eventId, socket.id);
      if (removed) {
        try {
          await clearPresenceIfLastSocket(pubClient, eventId, removed.userId);
        } catch (err) {
          // The presence TTL (30s) reaps the entry anyway.
          logger.warn('[WS] Presence clear failed on disconnect', {
            eventId,
            userId: removed.userId,
            error: err,
          });
        }
        socket.to(eventId).emit('message', {
          type: 'presence',
          userId: removed.userId,
          name: removed.name,
          section: removed.section,
          status: 'left',
        } as StandMessage);
      }
    });

    socket.on('error', (err) => {
      logger.error('[WS] Socket error', { socketId: socket.id, error: err });
    });
  });

  logger.info('[WS] Stand socket server initialized', { path: '/api/stand/socket', origin });
  return io;
}

// =============================================================================
// GRACEFUL SHUTDOWN
// =============================================================================

export async function closeStandSocketServer(): Promise<void> {
  if (!io) return;
  return new Promise((resolve) => {
    io!.close(() => {
      logger.info('[WS] Socket.IO server closed');
      io = null;
      resolve();
    });
  });
}

// =============================================================================
// ADMIN HELPERS
// =============================================================================

export async function getActiveRooms(
  redis: Redis,
): Promise<Array<{ eventId: string; clientCount: number; clients: ConnectedClient[] }>> {
  try {
    const keys = await redis.keys('stand:room:*:clients');
    if (keys.length === 0) return [];
    const rooms = await Promise.all(
      keys.map(async (key) => {
        const parts = key.split(':');
        const eventId = parts[2];
        const clients = await redisGetClients(redis, eventId);
        return { eventId, clientCount: clients.length, clients };
      }),
    );
    return rooms.filter((r) => r.clientCount > 0);
  } catch (err) {
    logger.error('[WS] getActiveRooms error', { error: err });
    return [];
  }
}

/**
 * Current stand state for an event, read from the SAME shared key the polling
 * route reads. `redis` is accepted for call-site compatibility but deliberately
 * unused: state lives in `@/lib/stand/sync-state`, which owns its own client.
 */
export async function getEventStandState(
  _redis: Redis,
  eventId: string,
): Promise<StandState | null> {
  return getStandState(eventId);
}

// =============================================================================
// INTERNAL UTILITIES
// =============================================================================

function extractCookieValue(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  const match = cookieHeader
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : undefined;
}

// =============================================================================
// LEGACY / POLLING COMPATIBILITY
// =============================================================================

export async function handleWebSocketUpgrade(
  _req: unknown,
): Promise<{ success: boolean; error?: string }> {
  return io
    ? { success: true }
    : {
        success: false,
        error:
          'Socket.IO server not running on this process. Start socket-worker or set ENABLE_WEBSOCKETS=true.',
      };
}
