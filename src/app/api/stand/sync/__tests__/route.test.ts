import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GET, POST } from '@/app/api/stand/sync/route';
import { NextRequest } from 'next/server';

const redisMocks = vi.hoisted(() => {
  const multi = {
    hset: vi.fn(),
    expire: vi.fn(),
    exec: vi.fn().mockResolvedValue([]),
  };
  multi.hset.mockReturnValue(multi);
  multi.expire.mockReturnValue(multi);

  return {
    hgetall: vi.fn().mockResolvedValue({}),
    multiFactory: vi.fn(() => multi),
    multi,
  };
});

vi.mock('@/lib/rate-limit', () => ({
  applyRateLimit: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/stand/settings', () => ({
  getStandSettings: vi.fn().mockResolvedValue({ accessPolicy: 'any_member' }),
}));

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('@/lib/auth/permissions', () => ({
  getUserRoles: vi.fn().mockResolvedValue(['MUSICIAN']),
}));

vi.mock('@/lib/redis', () => ({
  redis: {
    hgetall: redisMocks.hgetall,
    multi: redisMocks.multiFactory,
  },
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    standSession: {
      upsert: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    annotation: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn(),
    },
    userRole: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
    user: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    member: {
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
      findFirst: vi.fn().mockResolvedValue({ id: 'test-event', isPublished: true }),
      findUnique: vi.fn(),
    },
    attendance: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
  },
}));

import { auth } from '@/lib/auth/config';
import { getUserRoles } from '@/lib/auth/permissions';
import { prisma } from '@/lib/db';

const mockAuth = auth as unknown as { api: { getSession: ReturnType<typeof vi.fn> } };

describe('Stand Sync API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getUserRoles).mockResolvedValue(['MUSICIAN']);
    vi.mocked(prisma.member.findFirst).mockResolvedValue({
      id: 'member-1',
      userId: 'user-1',
      firstName: 'John',
      lastName: 'Doe',
      sections: [],
    } as never);
    vi.mocked(prisma.event.findFirst).mockResolvedValue({
      id: 'test-event',
      isPublished: true,
    } as never);
    vi.mocked(prisma.standSession.findMany).mockResolvedValue([]);
    redisMocks.hgetall.mockResolvedValue({});
    redisMocks.multi.hset.mockReturnValue(redisMocks.multi);
    redisMocks.multi.expire.mockReturnValue(redisMocks.multi);
    redisMocks.multi.exec.mockResolvedValue([]);
  });

  it('returns 401 without a session', async () => {
    mockAuth.api.getSession.mockResolvedValue(null);
    const response = await GET(
      new NextRequest('http://localhost:3000/api/stand/sync?eventId=test-event'),
    );
    expect(response.status).toBe(401);
  });

  it('returns persisted distributed sync state', async () => {
    mockAuth.api.getSession.mockResolvedValue({ user: { id: 'user-1' } });
    redisMocks.hgetall.mockResolvedValue({
      eventId: 'test-event',
      currentPage: '4',
      currentPieceIndex: '2',
      nightMode: 'true',
      lastUpdated: '2026-10-01T00:00:00.000Z',
    });

    const response = await GET(
      new NextRequest('http://localhost:3000/api/stand/sync?eventId=test-event'),
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.currentPage).toBe(4);
    expect(data.currentPieceIndex).toBe(2);
    expect(data.nightMode).toBe(true);
  });

  it('rejects shared stand control from ordinary members', async () => {
    mockAuth.api.getSession.mockResolvedValue({ user: { id: 'user-1' } });

    const response = await POST(
      new NextRequest('http://localhost:3000/api/stand/sync', {
        method: 'POST',
        body: JSON.stringify({
          eventId: 'test-event',
          command: { type: 'command', action: 'setPage', page: 5 },
        }),
      }),
    );

    expect(response.status).toBe(403);
  });

  it('allows director shared stand control', async () => {
    mockAuth.api.getSession.mockResolvedValue({ user: { id: 'user-1' } });
    vi.mocked(getUserRoles).mockResolvedValue(['DIRECTOR']);
    redisMocks.hgetall.mockResolvedValue({
      eventId: 'test-event',
      currentPage: '5',
      lastUpdated: '2026-10-01T00:00:00.000Z',
    });

    const response = await POST(
      new NextRequest('http://localhost:3000/api/stand/sync', {
        method: 'POST',
        body: JSON.stringify({
          eventId: 'test-event',
          command: { type: 'command', action: 'setPage', page: 5 },
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(redisMocks.multiFactory).toHaveBeenCalled();
  });

  it('allows ordinary members to update presence', async () => {
    mockAuth.api.getSession.mockResolvedValue({ user: { id: 'user-1' } });

    const response = await POST(
      new NextRequest('http://localhost:3000/api/stand/sync', {
        method: 'POST',
        body: JSON.stringify({
          eventId: 'test-event',
          presence: { type: 'presence', status: 'joined' },
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(prisma.standSession.upsert).toHaveBeenCalled();
  });

  it('removes presence immediately on leave', async () => {
    mockAuth.api.getSession.mockResolvedValue({ user: { id: 'user-1' } });

    const response = await POST(
      new NextRequest('http://localhost:3000/api/stand/sync', {
        method: 'POST',
        body: JSON.stringify({
          eventId: 'test-event',
          presence: { type: 'presence', status: 'left' },
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(prisma.standSession.deleteMany).toHaveBeenCalledWith({
      where: { eventId: 'test-event', userId: 'user-1' },
    });
  });
});
