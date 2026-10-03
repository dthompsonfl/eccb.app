import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GET, POST } from '@/app/api/stand/sync/route';
import { NextRequest } from 'next/server';

vi.mock('@/lib/rate-limit', () => ({
  applyRateLimit: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/stand/settings', () => ({
  getStandSettings: vi.fn().mockResolvedValue({
    accessPolicy: 'any_member',
  }),
}));

vi.mock('@/lib/stand/telemetry', () => ({
  recordTelemetry: vi.fn(),
}));

// Redis-backed stand state — mocked so we can drive read/write and failures.
vi.mock('@/lib/stand/sync-state', async () => {
  const actual = await vi.importActual<typeof import('@/lib/stand/sync-state')>(
    '@/lib/stand/sync-state'
  );
  return {
    ...actual,
    getStandState: vi.fn().mockResolvedValue(null),
    updateStandState: vi.fn(),
    getActivePresence: vi.fn().mockResolvedValue([]),
    touchPresence: vi.fn().mockResolvedValue(undefined),
    clearPresence: vi.fn().mockResolvedValue(undefined),
  };
});

// Mock auth
vi.mock('@/lib/auth/config', () => ({
  auth: {
    api: {
      getSession: vi.fn(),
    },
  },
}));

// Mock permissions
vi.mock('@/lib/auth/permissions', () => ({
  getUserRoles: vi.fn().mockResolvedValue(['MUSICIAN']),
}));

// Mock prisma
vi.mock('@/lib/db', () => ({
  prisma: {
    standSession: {
      count: vi.fn().mockResolvedValue(0),
      upsert: vi.fn().mockResolvedValue({}),
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    annotation: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn(),
    },
    userRole: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
    member: {
      // default to an active member; individual tests may override
      findFirst: vi.fn().mockResolvedValue({
        id: 'member-1',
        userId: 'user-1',
        firstName: 'John',
        lastName: 'Doe',
        sections: [],
      }),
      findUnique: vi.fn(),
    },
    event: {
      // default to a published event
      findFirst: vi.fn().mockResolvedValue({ id: 'test-event', isPublished: true }),
      findUnique: vi.fn(),
    },
    attendance: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
  },
}));

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db';
import { getUserRoles } from '@/lib/auth/permissions';
import {
  StandStateUnavailableError,
  getActivePresence,
  getStandState,
  touchPresence,
  updateStandState,
} from '@/lib/stand/sync-state';

const mockAuth = auth as unknown as { api: { getSession: ReturnType<typeof vi.fn> } };
const mockGetUserRoles = vi.mocked(getUserRoles);
const mockGetStandState = vi.mocked(getStandState);
const mockUpdateStandState = vi.mocked(updateStandState);
const mockGetActivePresence = vi.mocked(getActivePresence);
const mockTouchPresence = vi.mocked(touchPresence);

function authenticatedAs(userId = 'user-1'): void {
  mockAuth.api.getSession.mockResolvedValue({
    user: { id: userId, email: 'test@example.com' },
  });
}

function postRequest(body: unknown): NextRequest {
  return new NextRequest(new URL('http://localhost:3000/api/stand/sync'), {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

function getRequest(query = '?eventId=test-event'): NextRequest {
  return new NextRequest(new URL(`http://localhost:3000/api/stand/sync${query}`));
}

describe('Stand Sync API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: an ordinary musician, i.e. NOT a director.
    mockGetUserRoles.mockResolvedValue(['MUSICIAN']);
    mockGetStandState.mockResolvedValue(null);
    mockGetActivePresence.mockResolvedValue([]);
    mockUpdateStandState.mockImplementation(async (eventId, updates) => ({
      eventId,
      ...updates,
      lastUpdated: '2026-01-01T00:00:00.000Z',
    }));
  });

  describe('GET', () => {
    it('should return 401 if no session', async () => {
      mockAuth.api.getSession.mockResolvedValue(null);

      const response = await GET(getRequest());
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error).toBe('Unauthorized');
    });

    it('should return 400 if no eventId', async () => {
      authenticatedAs();

      const response = await GET(getRequest(''));
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe('eventId query parameter is required');
    });

    it('should return sync state for valid request', async () => {
      authenticatedAs();

      vi.mocked(prisma.member.findFirst).mockResolvedValueOnce({
        id: 'member-1',
        userId: 'user-1',
        firstName: 'John',
        lastName: 'Doe',
        sections: [],
      } as never);

      vi.mocked(prisma.event.findFirst).mockResolvedValueOnce({
        id: 'test-event',
        title: 'Test Event',
      } as never);

      const response = await GET(getRequest());
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.eventId).toBe('test-event');
      expect(data.activeUsers).toBe(0);
    });

    it('reads stand state from Redis, not from a process-local map', async () => {
      authenticatedAs();

      mockGetStandState.mockResolvedValueOnce({
        eventId: 'test-event',
        musicId: 'music-1',
        currentPage: 12,
        currentPieceIndex: 3,
        nightMode: true,
        lastUpdated: '2026-01-01T12:00:00.000Z',
      });

      const response = await GET(getRequest('?eventId=test-event&musicId=music-1'));
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(mockGetStandState).toHaveBeenCalledWith('test-event');
      expect(data.currentPage).toBe(12);
      expect(data.currentPieceIndex).toBe(3);
      expect(data.nightMode).toBe(true);
      expect(data.lastSyncAt).toBe('2026-01-01T12:00:00.000Z');
    });

    it('reports the Redis presence roster', async () => {
      authenticatedAs();

      mockGetActivePresence.mockResolvedValueOnce([
        {
          userId: 'user-2',
          name: 'Ada Lovelace',
          section: 'Flute',
          eventId: 'test-event',
          lastSeen: new Date().toISOString(),
        },
      ]);

      const response = await GET(getRequest());
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.activeUsers).toBe(1);
      expect(data.activeUserList[0]).toMatchObject({
        userId: 'user-2',
        name: 'Ada Lovelace',
        section: 'Flute',
      });
    });
  });

  describe('POST', () => {
    it('should return 401 if no session', async () => {
      mockAuth.api.getSession.mockResolvedValue(null);

      const response = await POST(postRequest({ eventId: 'test-event' }));
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error).toBe('Unauthorized');
    });

    it('should return 400 if no eventId', async () => {
      authenticatedAs();

      const response = await POST(postRequest({}));
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe('eventId is required');
    });

    it('should update sync state for valid command', async () => {
      authenticatedAs();
      mockGetUserRoles.mockResolvedValue(['DIRECTOR']);

      vi.mocked(prisma.member.findFirst).mockResolvedValueOnce({
        id: 'member-1',
        userId: 'user-1',
        firstName: 'John',
        lastName: 'Doe',
        sections: [],
      } as never);

      vi.mocked(prisma.event.findFirst).mockResolvedValueOnce({
        id: 'test-event',
        title: 'Test Event',
      } as never);

      const response = await POST(
        postRequest({
          eventId: 'test-event',
          command: { type: 'command', action: 'setPage', page: 5 },
        })
      );
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.command.action).toBe('setPage');
      expect(mockUpdateStandState).toHaveBeenCalledWith('test-event', { currentPage: 5 });
    });

    it('should handle presence updates', async () => {
      authenticatedAs();

      vi.mocked(prisma.member.findFirst).mockResolvedValueOnce({
        id: 'member-1',
        userId: 'user-1',
        firstName: 'John',
        lastName: 'Doe',
        sections: [],
      } as never);

      vi.mocked(prisma.event.findFirst).mockResolvedValueOnce({
        id: 'test-event',
        title: 'Test Event',
      } as never);

      const response = await POST(
        postRequest({
          eventId: 'test-event',
          presence: { type: 'presence', status: 'joined' },
        })
      );
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.presence.status).toBe('joined');
      expect(mockTouchPresence).toHaveBeenCalledWith(
        expect.objectContaining({ eventId: 'test-event', userId: 'user-1', name: 'John Doe' })
      );
    });
  });

  // ─── Command authorization ────────────────────────────────────────────────
  describe('command authorization', () => {
    it.each(['setPage', 'setPiece', 'toggleNightMode'])(
      'rejects a non-director issuing %s',
      async (action) => {
        authenticatedAs('player-1');
        mockGetUserRoles.mockResolvedValue(['MUSICIAN']);

        const command: Record<string, unknown> = { type: 'command', action };
        if (action === 'setPage') command.page = 99;
        if (action === 'setPiece') command.pieceIndex = 7;
        if (action === 'toggleNightMode') command.value = true;

        const response = await POST(postRequest({ eventId: 'test-event', command }));
        const data = await response.json();

        expect(response.status).toBe(403);
        expect(data.error).toMatch(/director/i);
        // The critical assertion: nothing was written.
        expect(mockUpdateStandState).not.toHaveBeenCalled();
      }
    );

    it('rejects a non-director hijacking the page via a bare state broadcast', async () => {
      authenticatedAs('player-1');
      mockGetUserRoles.mockResolvedValue(['MUSICIAN']);

      const response = await POST(
        postRequest({ eventId: 'test-event', musicId: 'music-1', currentPage: 99 })
      );

      expect(response.status).toBe(403);
      expect(mockUpdateStandState).not.toHaveBeenCalled();
    });

    it('rejects a non-director changing night mode through the mode channel', async () => {
      authenticatedAs('player-1');
      mockGetUserRoles.mockResolvedValue(['MUSICIAN']);

      const response = await POST(
        postRequest({
          eventId: 'test-event',
          mode: { type: 'mode', name: 'nightMode', value: true },
        })
      );

      expect(response.status).toBe(403);
      expect(mockUpdateStandState).not.toHaveBeenCalled();
    });

    it('lets a non-director send presence without touching stand state', async () => {
      authenticatedAs('player-1');
      mockGetUserRoles.mockResolvedValue(['MUSICIAN']);

      const response = await POST(
        postRequest({
          eventId: 'test-event',
          presence: { type: 'presence', status: 'joined' },
        })
      );

      expect(response.status).toBe(200);
      expect(mockTouchPresence).toHaveBeenCalled();
      expect(mockUpdateStandState).not.toHaveBeenCalled();
    });

    it('allows an admin to command the stand', async () => {
      authenticatedAs('admin-1');
      mockGetUserRoles.mockResolvedValue(['ADMIN']);

      const response = await POST(
        postRequest({
          eventId: 'test-event',
          command: { type: 'command', action: 'setPiece', pieceIndex: 2 },
        })
      );

      expect(response.status).toBe(200);
      expect(mockUpdateStandState).toHaveBeenCalledWith('test-event', { currentPieceIndex: 2 });
    });
  });

  // ─── Redis round trip ─────────────────────────────────────────────────────
  describe('redis-backed round trip', () => {
    it('persists a director page turn and reads it back through GET', async () => {
      authenticatedAs('director-1');
      mockGetUserRoles.mockResolvedValue(['DIRECTOR']);

      // Simulate Redis holding the state the director just wrote.
      const persisted: Record<string, unknown> = { eventId: 'test-event' };
      mockUpdateStandState.mockImplementationOnce(async (eventId, updates) => {
        Object.assign(persisted, updates, {
          eventId,
          lastUpdated: '2026-01-01T18:30:00.000Z',
        });
        return persisted as never;
      });
      mockGetStandState.mockImplementation(async () => ({ ...persisted }) as never);

      const write = await POST(
        postRequest({
          eventId: 'test-event',
          command: { type: 'command', action: 'setPage', page: 42 },
        })
      );
      expect(write.status).toBe(200);

      // A player on a DIFFERENT process polls and sees the director's page.
      authenticatedAs('player-1');
      mockGetUserRoles.mockResolvedValue(['MUSICIAN']);

      const read = await GET(getRequest());
      const readData = await read.json();

      expect(read.status).toBe(200);
      expect(readData.currentPage).toBe(42);
      expect(readData.lastSyncAt).toBe('2026-01-01T18:30:00.000Z');
    });

    it('toggles night mode from the persisted value when no value is supplied', async () => {
      authenticatedAs('director-1');
      mockGetUserRoles.mockResolvedValue(['DIRECTOR']);
      mockGetStandState.mockResolvedValueOnce({
        eventId: 'test-event',
        nightMode: false,
        lastUpdated: '2026-01-01T00:00:00.000Z',
      });

      const response = await POST(
        postRequest({
          eventId: 'test-event',
          command: { type: 'command', action: 'toggleNightMode' },
        })
      );

      expect(response.status).toBe(200);
      expect(mockUpdateStandState).toHaveBeenCalledWith('test-event', { nightMode: true });
    });
  });

  // ─── Degradation ──────────────────────────────────────────────────────────
  describe('degradation when Redis is unavailable', () => {
    it('returns 503 and never a fabricated success on POST', async () => {
      authenticatedAs('director-1');
      mockGetUserRoles.mockResolvedValue(['DIRECTOR']);
      mockUpdateStandState.mockRejectedValueOnce(
        new StandStateUnavailableError('updateStandState', new Error('ECONNREFUSED'))
      );

      const response = await POST(
        postRequest({
          eventId: 'test-event',
          command: { type: 'command', action: 'setPage', page: 3 },
        })
      );
      const data = await response.json();

      expect(response.status).toBe(503);
      expect(data.success).toBeUndefined();
      expect(data.code).toBe('STAND_SYNC_UNAVAILABLE');
      expect(data.error).toMatch(/unable to sync/i);
    });

    it('returns 503 on GET rather than serving stale or invented state', async () => {
      authenticatedAs();
      mockGetStandState.mockRejectedValueOnce(
        new StandStateUnavailableError('getStandState', new Error('ECONNREFUSED'))
      );

      const response = await GET(getRequest());
      const data = await response.json();

      expect(response.status).toBe(503);
      expect(data.currentPage).toBeUndefined();
      expect(data.success).toBeUndefined();
    });

    it('returns 503 when presence cannot be written', async () => {
      authenticatedAs();
      mockTouchPresence.mockRejectedValueOnce(
        new StandStateUnavailableError('touchPresence', new Error('READONLY'))
      );

      const response = await POST(
        postRequest({
          eventId: 'test-event',
          presence: { type: 'presence', status: 'joined' },
        })
      );
      const data = await response.json();

      expect(response.status).toBe(503);
      expect(data.success).toBeUndefined();
    });
  });
});