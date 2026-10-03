/**
 * Stand Socket — director guard and cross-transport state tests.
 *
 * DEFECT (security): the socket `command` branch applied setPage / setPiece /
 * toggleNightMode from ANY authenticated socket with no director check, so any
 * member with stand access could seize the conductor's page for the whole band.
 *
 * DEFECT (consistency): the socket server kept its own Redis keys
 * `stand:room:<eventId>:state` with a different shape from the polling route's
 * `eccb:stand:sync:state:<eventId>`, so a director's page turn over one
 * transport was invisible to a client on the other.
 *
 * These tests drive the REAL socket message handler through a fake Socket.IO
 * server and the REAL `@/lib/stand/sync-state` module against an in-memory fake
 * Redis — the same keyspace the polling route reads. That makes the
 * cross-transport assertion meaningful rather than a mock-to-mock tautology.
 *
 * Nothing here touches a network socket; Redis is mocked per the convention in
 * src/lib/stand/__tests__/sync-state.test.ts, so CI needs no Redis.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── In-memory Redis fake ─────────────────────────────────────────────────────
// Implements exactly the commands sync-state and stand-socket use, so the real
// state module runs unmodified against it.

interface FakeRedis {
  strings: Map<string, string>;
  hashes: Map<string, Map<string, string>>;
}

function makeFakeRedis(): FakeRedis {
  return { strings: new Map(), hashes: new Map() };
}

const fake = makeFakeRedis();

/** The same in-memory store, exposed with the ioredis methods the socket uses. */
const pubClientFake = {
  hset: async (key: string, field: string, value: string) => {
    const hash = fake.hashes.get(key) ?? new Map<string, string>();
    hash.set(field, value);
    fake.hashes.set(key, hash);
    return 1;
  },
  hget: async (key: string, field: string) => fake.hashes.get(key)?.get(field) ?? null,
  hdel: async (key: string, ...fields: string[]) => {
    const hash = fake.hashes.get(key);
    if (!hash) return 0;
    fields.forEach((f) => hash.delete(f));
    return fields.length;
  },
  hgetall: async (key: string) =>
    Object.fromEntries(fake.hashes.get(key) ?? new Map<string, string>()),
  expire: async () => 1,
};

vi.mock('@/lib/redis', () => ({
  redis: {
    get: vi.fn(async (key: string) => fake.strings.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      fake.strings.set(key, value);
      return 'OK';
    }),
    hset: vi.fn(async (key: string, field: string, value: string) => {
      const hash = fake.hashes.get(key) ?? new Map<string, string>();
      hash.set(field, value);
      fake.hashes.set(key, hash);
      return 1;
    }),
    hget: vi.fn(async (key: string, field: string) => fake.hashes.get(key)?.get(field) ?? null),
    hdel: vi.fn(async (key: string, ...fields: string[]) => {
      const hash = fake.hashes.get(key);
      if (!hash) return 0;
      fields.forEach((f) => hash.delete(f));
      return fields.length;
    }),
    hgetall: vi.fn(async (key: string) =>
      Object.fromEntries(fake.hashes.get(key) ?? new Map<string, string>())
    ),
    expire: vi.fn(async () => 1),
    // Faithful multi(): chained hset().expire().exec(), applying the queued
    // hset to the shared store so presence written via touchPresence is
    // actually readable back.
    multi: vi.fn(() => {
      const queued: Array<[string, string, string]> = [];
      const chain = {
        hset: (key: string, field: string, value: string) => {
          queued.push([key, field, value]);
          return chain;
        },
        expire: () => chain,
        exec: async () => {
          queued.forEach(([key, field, value]) => {
            const hash = fake.hashes.get(key) ?? new Map<string, string>();
            hash.set(field, value);
            fake.hashes.set(key, hash);
          });
          return [];
        },
      };
      return chain;
    }),
  },
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    session: { findFirst: vi.fn() },
    member: { findFirst: vi.fn() },
    standSession: { upsert: vi.fn() },
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@socket.io/redis-adapter', () => ({ createAdapter: vi.fn().mockReturnValue({}) }));

// Canonical stand RBAC: the socket guard must read `isDirector` from here, never
// from a free-form permission string.
const accessState = { isDirector: false };

vi.mock('@/lib/stand/access', () => ({
  canAccessEvent: vi.fn(async () => true),
  buildAccessContext: vi.fn(async (userId: string) => ({
    userId,
    roles: accessState.isDirector ? ['DIRECTOR'] : ['MEMBER'],
    isPrivileged: accessState.isDirector,
    isDirector: accessState.isDirector,
    isLibrarian: false,
    isSectionLeader: false,
    userSectionIds: [],
    memberId: `member-${userId}`,
  })),
}));

import { prisma } from '@/lib/db';
import { initializeStandSocketServer } from '../stand-socket';
import { getStandState, StandStateUnavailableError, standSyncKeys } from '@/lib/stand/sync-state';

// ── Fake Socket.IO server plumbing ───────────────────────────────────────────

type Handler = (...args: unknown[]) => unknown;

interface FakeSocket {
  id: string;
  data: Record<string, unknown>;
  handshake: { query: Record<string, string>; auth: Record<string, string>; headers: Record<string, string> };
  handlers: Map<string, Handler>;
  emitted: Array<{ event: string; payload: unknown }>;
  joined: string[];
  disconnected: boolean;
  emit: (event: string, payload?: unknown) => void;
  on: (event: string, handler: Handler) => void;
  join: (room: string) => void;
  disconnect: () => void;
  to: (room: string) => { emit: (event: string, payload?: unknown) => void };
}

interface FakeIo {
  server: {
    adapter: () => void;
    use: (fn: unknown) => void;
    on: (event: string, fn: Handler) => void;
    close: (cb: () => void) => void;
    to: (room: string) => { emit: (event: string, payload?: unknown) => void };
  };
  connectionHandler: Handler;
  roomBroadcasts: Array<{ room: string; event: string; payload: unknown }>;
}

const fakeIo: FakeIo = {
  server: null as unknown as FakeIo['server'],
  connectionHandler: null as unknown as Handler,
  roomBroadcasts: [],
};

vi.mock('socket.io', () => ({
  // Must be a real constructable function — `new SocketIOServer(...)` is used.
  Server: vi.fn(function Server(this: unknown) {
    fakeIo.server = {
      adapter: vi.fn(),
      use: vi.fn(),
      on: vi.fn((event: string, fn: Handler) => {
        if (event === 'connection') fakeIo.connectionHandler = fn;
      }),
      close: vi.fn((cb: () => void) => cb()),
      to: vi.fn((room: string) => ({
        emit: (event: string, payload?: unknown) => {
          fakeIo.roomBroadcasts.push({ room, event, payload });
        },
      })),
    };
    return fakeIo.server;
  }),
}));

function makeSocket(id: string, eventId: string): FakeSocket {
  const emitted: FakeSocket['emitted'] = [];
  const socket: FakeSocket = {
    id,
    data: {},
    handshake: { query: { eventId }, auth: { token: 'tok' }, headers: {} },
    handlers: new Map(),
    emitted,
    joined: [],
    disconnected: false,
    emit: (event, payload) => {
      emitted.push({ event, payload });
    },
    on: (event, handler) => {
      socket.handlers.set(event, handler);
    },
    join: (room) => {
      socket.joined.push(room);
    },
    disconnect: () => {
      socket.disconnected = true;
    },
    to: () => ({ emit: () => undefined }),
  };
  return socket;
}

/** Drive a real connection + return a sender for the socket's message handler. */
async function connect(userId: string, eventId = 'event-1'): Promise<FakeSocket> {
  const socket = makeSocket(`sock-${userId}`, eventId);
  socket.data.userId = userId;
  await fakeIo.connectionHandler(socket);
  return socket;
}

/** Send a message through the REAL registered handler and await its async work. */
async function send(socket: FakeSocket, payload: unknown): Promise<void> {
  const handler = socket.handlers.get('message');
  expect(handler).toBeDefined();
  await (handler as (data: unknown) => Promise<void>)(payload);
}

const errors = (socket: FakeSocket): Array<{ message: string; code?: string }> =>
  socket.emitted.filter((e) => e.event === 'error').map((e) => e.payload as { message: string });

// ── Suite ────────────────────────────────────────────────────────────────────

describe('stand socket — director guard on the command path', () => {
  beforeEach(async () => {
    fake.strings.clear();
    fake.hashes.clear();
    fakeIo.roomBroadcasts = [];
    vi.clearAllMocks();
    fakeIo.server = null as unknown as FakeIo['server'];
    fakeIo.connectionHandler = null as unknown as Handler;

    vi.mocked(prisma.session.findFirst).mockResolvedValue({ userId: 'u' } as never);
    vi.mocked(prisma.member.findFirst).mockResolvedValue({
      firstName: 'Pat',
      lastName: 'Member',
      sections: [],
    } as never);
    vi.mocked(prisma.standSession.upsert).mockResolvedValue({} as never);

    // The pubClient used for socket bookkeeping. Backed by the SAME in-memory
    // store so `clearPresenceIfLastSocket` sees real client rows.
    await initializeStandSocketServer({} as never, pubClientFake as never, {} as never);
  });

  describe('as a NON-director member', () => {
    beforeEach(() => {
      accessState.isDirector = false;
    });

    it('rejects setPage and does not mutate shared state', async () => {
      const socket = await connect('player-1');

      await send(socket, { type: 'command', action: 'setPage', page: 42 });

      expect(errors(socket)).toContainEqual({
        message: 'Only a director can control the stand for this event',
        code: 'STAND_COMMAND_FORBIDDEN',
      });
      await expect(getStandState('event-1')).resolves.toBeNull();
      expect(fake.strings.has(standSyncKeys.state('event-1'))).toBe(false);
    });

    it('rejects setPiece and does not mutate shared state', async () => {
      const socket = await connect('player-1');

      await send(socket, { type: 'command', action: 'setPiece', pieceIndex: 7 });

      expect(errors(socket)[0]?.code).toBe('STAND_COMMAND_FORBIDDEN');
      await expect(getStandState('event-1')).resolves.toBeNull();
    });

    it('rejects toggleNightMode and does not mutate shared state', async () => {
      const socket = await connect('player-1');

      await send(socket, { type: 'command', action: 'toggleNightMode', value: true });

      expect(errors(socket)[0]?.code).toBe('STAND_COMMAND_FORBIDDEN');
      await expect(getStandState('event-1')).resolves.toBeNull();
    });

    it('rejects a nightMode mode broadcast, the unguarded bypass of the command guard', async () => {
      const socket = await connect('player-1');

      await send(socket, { type: 'mode', name: 'nightMode', value: true });

      expect(errors(socket)[0]?.code).toBe('STAND_COMMAND_FORBIDDEN');
      await expect(getStandState('event-1')).resolves.toBeNull();
      // Nothing may be broadcast to the room on a rejected privileged write.
      expect(
        fakeIo.roomBroadcasts.filter((b) => b.payload && (b.payload as { type: string }).type === 'mode')
      ).toHaveLength(0);
    });

    it('does not broadcast a rejected command to the room', async () => {
      const socket = await connect('player-1');

      await send(socket, { type: 'command', action: 'setPage', page: 3 });

      const commandBroadcasts = fakeIo.roomBroadcasts.filter(
        (b) => b.payload && (b.payload as { type: string }).type === 'command'
      );
      expect(commandBroadcasts).toHaveLength(0);
    });

    it('still allows the member to send their own presence and heartbeat', async () => {
      const socket = await connect('player-1');

      await send(socket, { type: 'presence', userId: 'player-1', name: 'Pat Member', status: 'joined' });
      await send(socket, { type: 'heartbeat' });

      expect(errors(socket)).toHaveLength(0);
      const presence = fake.hashes.get(standSyncKeys.presence('event-1'));
      expect(presence?.has('player-1')).toBe(true);
    });
  });

  describe('as a DIRECTOR', () => {
    beforeEach(() => {
      accessState.isDirector = true;
    });

    it('applies setPage to the shared sync-state key', async () => {
      const socket = await connect('director-1');

      await send(socket, { type: 'command', action: 'setPage', page: 12 });

      expect(errors(socket)).toHaveLength(0);
      const state = await getStandState('event-1');
      expect(state?.currentPage).toBe(12);
      expect(fakeIo.roomBroadcasts.some((b) => b.room === 'event-1')).toBe(true);
    });

    it('applies setPiece', async () => {
      const socket = await connect('director-1');

      await send(socket, { type: 'command', action: 'setPiece', pieceIndex: 4 });

      await expect(getStandState('event-1')).resolves.toMatchObject({ currentPieceIndex: 4 });
    });

    it('applies toggleNightMode, defaulting to the inverse of current state', async () => {
      const socket = await connect('director-1');

      await send(socket, { type: 'command', action: 'toggleNightMode' });
      await expect(getStandState('event-1')).resolves.toMatchObject({ nightMode: true });

      await send(socket, { type: 'command', action: 'toggleNightMode' });
      await expect(getStandState('event-1')).resolves.toMatchObject({ nightMode: false });
    });
  });

  // ── Cross-transport visibility ────────────────────────────────────────────

  it('a director page turn over WebSocket is readable via the polling sync-state path', async () => {
    // Transport 1: WebSocket command.
    accessState.isDirector = true;
    const director = await connect('director-1', 'event-rehearsal');
    await send(director, { type: 'command', action: 'setPage', page: 17 });

    // Transport 2: the polling route reads `getStandState` on the same key.
    // No socket, no socket keyspace — exactly what GET /api/stand/sync returns.
    const polled = await getStandState('event-rehearsal');

    expect(polled).not.toBeNull();
    expect(polled?.currentPage).toBe(17);
    expect(polled?.eventId).toBe('event-rehearsal');

    // And a later socket join hydrates from that same shared state.
    const joining = await connect('player-2', 'event-rehearsal');
    const stateEvent = joining.emitted.find((e) => e.event === 'state');
    expect((stateEvent?.payload as { currentPage: number }).currentPage).toBe(17);
  });

  it('writes only to the canonical eccb:stand:sync keyspace — no parallel socket state key', async () => {
    accessState.isDirector = true;
    const socket = await connect('director-1', 'event-keys');

    await send(socket, { type: 'command', action: 'setPage', page: 5 });

    expect([...fake.strings.keys()]).toEqual(['eccb:stand:sync:state:event-keys']);
    // The old divergent keyspace must not exist anywhere.
    expect([...fake.strings.keys()]).not.toContain('stand:room:event-keys:state');
  });

  // ── Failure policy ────────────────────────────────────────────────────────

  it('fails loudly when Redis is unavailable and never fabricates a synced state', async () => {
    accessState.isDirector = true;
    const socket = await connect('director-1', 'event-down');

    const { redis } = await import('@/lib/redis');
    vi.mocked(redis.get).mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await send(socket, { type: 'command', action: 'setPage', page: 9 });

    // Loud, explicit error to the offending socket…
    expect(errors(socket)).toContainEqual({
      message: 'The music stand is temporarily unable to sync. Please try again in a moment.',
      code: 'STAND_SYNC_UNAVAILABLE',
    });
    // …and nothing broadcast that would read as "the band is now on page 9".
    const commandBroadcasts = fakeIo.roomBroadcasts.filter(
      (b) => b.payload && (b.payload as { type: string }).type === 'command'
    );
    expect(commandBroadcasts).toHaveLength(0);
  });

  it('surfaces a Redis outage as StandStateUnavailableError to the polling reader too', async () => {
    const { redis } = await import('@/lib/redis');
    vi.mocked(redis.get).mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await expect(getStandState('event-down')).rejects.toBeInstanceOf(StandStateUnavailableError);
  });
});
