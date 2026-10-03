import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/redis', () => ({
  redis: {
    get: vi.fn(),
    set: vi.fn(),
    hset: vi.fn(),
    hdel: vi.fn(),
    hgetall: vi.fn(),
    expire: vi.fn(),
    multi: vi.fn(),
  },
}));

import { redis } from '@/lib/redis';
import {
  ACTIVE_PRESENCE_WINDOW_MS,
  PRESENCE_TTL_SECONDS,
  STAND_STATE_TTL_SECONDS,
  StandStateUnavailableError,
  clearPresence,
  getActivePresence,
  getStandState,
  standSyncKeys,
  touchPresence,
  updateStandState,
} from '@/lib/stand/sync-state';

const mockRedis = vi.mocked(redis, true) as unknown as {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  hset: ReturnType<typeof vi.fn>;
  hdel: ReturnType<typeof vi.fn>;
  hgetall: ReturnType<typeof vi.fn>;
  expire: ReturnType<typeof vi.fn>;
  multi: ReturnType<typeof vi.fn>;
};

describe('stand sync redis state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedis.multi.mockReturnValue({
      hset: vi.fn().mockReturnThis(),
      expire: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([]),
    });
  });

  describe('key scheme and TTLs', () => {
    it('namespaces keys under eccb:stand:sync', () => {
      expect(standSyncKeys.state('event-1')).toBe('eccb:stand:sync:state:event-1');
      expect(standSyncKeys.presence('event-1')).toBe('eccb:stand:sync:presence:event-1');
    });

    it('matches the presence TTL to the 30s activity window', () => {
      expect(ACTIVE_PRESENCE_WINDOW_MS).toBe(30_000);
      expect(PRESENCE_TTL_SECONDS).toBe(30);
    });

    it('gives stand state a documented multi-hour TTL', () => {
      expect(STAND_STATE_TTL_SECONDS).toBeGreaterThan(PRESENCE_TTL_SECONDS * 60);
      expect(STAND_STATE_TTL_SECONDS).toBe(6 * 60 * 60);
    });

    it('writes presence as a hash field with a matching expiry', async () => {
      await touchPresence({
        userId: 'user-1',
        name: 'John Doe',
        section: 'Clarinet',
        eventId: 'event-1',
      });

      const execArgs = mockRedis.multi.mock.results[0].value;
      expect(execArgs.hset).toHaveBeenCalledWith(
        'eccb:stand:sync:presence:event-1',
        'user-1',
        expect.any(String)
      );
      expect(execArgs.expire).toHaveBeenCalledWith(
        'eccb:stand:sync:presence:event-1',
        PRESENCE_TTL_SECONDS
      );
    });
  });

  describe('stand state round trip', () => {
    it('returns null when nothing has been written yet', async () => {
      mockRedis.get.mockResolvedValueOnce(null);
      await expect(getStandState('event-1')).resolves.toBeNull();
    });

    it('writes JSON with the state TTL and merges over existing state', async () => {
      mockRedis.get.mockResolvedValueOnce(
        JSON.stringify({
          eventId: 'event-1',
          currentPieceIndex: 2,
          lastUpdated: '2026-01-01T00:00:00.000Z',
        })
      );

      const state = await updateStandState('event-1', { currentPage: 8 });

      expect(state.currentPieceIndex).toBe(2);
      expect(state.currentPage).toBe(8);
      expect(mockRedis.set).toHaveBeenCalledWith(
        'eccb:stand:sync:state:event-1',
        expect.any(String),
        'EX',
        STAND_STATE_TTL_SECONDS
      );
    });

    it('validates payloads read back out of Redis', async () => {
      mockRedis.get.mockResolvedValueOnce(JSON.stringify({ eventId: 'event-1', currentPage: -4 }));
      await expect(getStandState('event-1')).rejects.toBeInstanceOf(StandStateUnavailableError);
    });
  });

  describe('failure policy', () => {
    it('throws StandStateUnavailableError instead of falling back to local memory', async () => {
      mockRedis.get.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      await expect(getStandState('event-1')).rejects.toBeInstanceOf(StandStateUnavailableError);
    });

    it('propagates failures from presence writes', async () => {
      mockRedis.multi.mockImplementationOnce(() => ({
        hset: vi.fn().mockReturnThis(),
        expire: vi.fn().mockReturnThis(),
        exec: vi.fn().mockRejectedValue(new Error('READONLY')),
      }));

      await expect(
        touchPresence({ userId: 'u', name: 'N', eventId: 'event-1' })
      ).rejects.toBeInstanceOf(StandStateUnavailableError);
    });

    it('propagates failures from presence deletes', async () => {
      mockRedis.hdel.mockRejectedValueOnce(new Error('READONLY'));
      await expect(clearPresence('event-1', 'u')).rejects.toBeInstanceOf(
        StandStateUnavailableError
      );
    });
  });

  describe('presence window', () => {
    it('returns only entries seen inside the activity window and prunes the rest', async () => {
      const fresh = new Date().toISOString();
      const stale = new Date(Date.now() - ACTIVE_PRESENCE_WINDOW_MS - 5_000).toISOString();

      mockRedis.hgetall.mockResolvedValueOnce({
        'user-1': JSON.stringify({
          userId: 'user-1',
          name: 'John Doe',
          section: 'Clarinet',
          eventId: 'event-1',
          lastSeen: fresh,
        }),
        'user-stale': JSON.stringify({
          userId: 'user-stale',
          name: 'Ghost',
          eventId: 'event-1',
          lastSeen: stale,
        }),
        'user-broken': 'not json',
      });

      const active = await getActivePresence('event-1');

      expect(active).toHaveLength(1);
      expect(active[0].userId).toBe('user-1');
      expect(mockRedis.hdel).toHaveBeenCalledWith(
        'eccb:stand:sync:presence:event-1',
        'user-stale',
        'user-broken'
      );
    });
  });
});