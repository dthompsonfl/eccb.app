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
 */

import { Server as SocketIOServer, type Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import http from 'node:http';
import { prisma } from '@/lib/db';
import { canAccessEvent } from '@/lib/stand/access';
import { logger } from '@/lib/logger';
import { getSocketCorsOrigins } from '@/lib/allowed-origins';
import { z } from 'zod';

// =============================================================================
// CONSTANTS
// =============================================================================

/** TTL for a client's presence entry. Heartbeats must refresh before expiry. */
const PRESENCE_TTL_SECONDS = 90;
/** TTL for stand state (kept alive while any client is in the room). */
const STATE_TTL_SECONDS = 3600; // 1 hour
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

export interface StandState {
  eventId: string;
  currentPage?: number;
  currentPieceIndex?: number;
  nightMode?: boolean;
  lastUpdated: string; // ISO
}

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

const Keys = {
  /** Hash: socketId → JSON(ConnectedClient) */
  roomClients: (eventId: string) => `stand:room:${eventId}:clients`,
  /** String: JSON(StandState) */
  roomState: (eventId: string) => `stand:room:${eventId}:state`,
  /** Hash: userId → ISO timestamp of last heartbeat */
  presence: (eventId: string) => `stand:room:${eventId}:presence`,
};

// =============================================================================
// REDIS STATE HELPERS
// =============================================================================

async function redisAddClient(redis: Redis, client: ConnectedClient): Promise<void> {
  const key = Keys.roomClients(client.eventId);
  await redis.hset(key, client.socketId, JSON.stringify(client));
  await redis.expire(key, STATE_TTL_SECONDS);
  await redis.hset(Keys.presence(client.eventId), client.userId, new Date().toISOString());
  await redis.expire(Keys.presence(client.eventId), STATE_TTL_SECONDS);
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

async function redisGetState(redis: Redis, eventId: string): Promise<StandState | null> {
  const raw = await redis.get(Keys.roomState(eventId));
  if (!raw) return null;
  return JSON.parse(raw) as StandState;
}

async function redisUpdateState(
  redis: Redis,
  eventId: string,
  updates: Partial<StandState>,
): Promise<StandState> {
  const existing = await redisGetState(redis, eventId);
  const next: StandState = {
    ...(existing ?? { eventId }),
    ...updates,
    eventId,
    lastUpdated: new Date().toISOString(),
  };
  await redis.set(Keys.roomState(eventId), JSON.stringify(next), 'EX', STATE_TTL_SECONDS);
  return next;
}

async function redisHeartbeat(redis: Redis, eventId: string, userId: string): Promise<void> {
  await redis.hset(Keys.presence(eventId), userId, new Date().toISOString());
  await redis.expire(Keys.presence(eventId), STATE_TTL_SECONDS);
}

async function pruneStalePresence(redis: Redis, eventId: string): Promise<void> {
  const hash = await redis.hgetall(Keys.presence(eventId));
  if (!hash) return;
  const cutoff = Date.now() - PRESENCE_TTL_SECONDS * 1_000;
  const stale = Object.entries(hash)
    .filter(([, ts]) => new Date(ts).getTime() < cutoff)
    .map(([uid]) => uid);
  if (stale.length > 0) {
    await redis.hdel(Keys.presence(eventId), ...stale);
  }
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

    const hasAccess = await canAccessEvent(userId, eventId);
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
      await prisma.standSession.upsert({
        where: { eventId_userId: { eventId, userId } },
        create: { eventId, userId, lastSeenAt: new Date() },
        update: { lastSeenAt: new Date() },
      });
    } catch (err) {
      logger.error('[WS] standSession upsert failed', { error: err });
    }

    // Hydrate new client with current state + roster
    const [currentState, clients] = await Promise.all([
      redisGetState(pubClient, eventId),
      redisGetClients(pubClient, eventId),
    ]);
    socket.emit('state', currentState);
    socket.emit('roster', {
      type: 'roster',
      members: clients.map((c) => ({
        userId: c.userId,
        name: c.name,
        section: c.section,
        joinedAt: c.joinedAt,
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

    logger.info('[WS] Client joined', { socketId: socket.id, userId, eventId });

    // ── Message handler ───────────────────────────────────────────────────
    socket.on('message', async (data: unknown) => {
      const msg = parseMessage(data);
      if (!msg) {
        socket.emit('error', { message: 'Invalid message format' });
        return;
      }

      switch (msg.type) {
        case 'heartbeat':
          await redisHeartbeat(pubClient, eventId, userId);
          break;

        case 'command': {
          let patch: Partial<StandState> = {};
          if (msg.action === 'setPage' && msg.page !== undefined)
            patch = { currentPage: msg.page };
          else if (msg.action === 'setPiece' && msg.pieceIndex !== undefined)
            patch = { currentPieceIndex: msg.pieceIndex };
          else if (msg.action === 'toggleNightMode') {
            const cur = await redisGetState(pubClient, eventId);
            patch = { nightMode: msg.value ?? !cur?.nightMode };
          }
          await redisUpdateState(pubClient, eventId, patch);
          io!.to(eventId).emit('message', msg);
          break;
        }

        case 'mode':
          if (msg.name === 'nightMode') {
            await redisUpdateState(pubClient, eventId, { nightMode: msg.value as boolean });
          }
          io!.to(eventId).emit('message', msg);
          break;

        case 'annotation':
          io!.to(eventId).emit('message', msg);
          break;

        case 'presence':
          break;
      }
    });

    // ── Disconnect handler ────────────────────────────────────────────────
    socket.on('disconnect', async (reason) => {
      logger.info('[WS] Client disconnected', { socketId: socket.id, userId, eventId, reason });
      const removed = await redisRemoveClient(pubClient, eventId, socket.id);
      await pruneStalePresence(pubClient, eventId);
      if (removed) {
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

export async function getEventStandState(
  redis: Redis,
  eventId: string,
): Promise<StandState | null> {
  return redisGetState(redis, eventId);
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
