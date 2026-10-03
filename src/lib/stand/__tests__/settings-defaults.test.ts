/**
 * Tests for the stand settings defaults and the realtime-mode derivation.
 *
 * Two properties are pinned here:
 *  1. A FRESH deployment (no `stand.*` rows) comes up in websocket mode, not
 *     polling. That was the original defect: ENABLE_WEBSOCKETS=true with a
 *     `polling` default meant a correct deployment started a Socket.IO server
 *     nobody connected to.
 *  2. The derived `websocketEnabled` follows `realtimeMode` whenever the mode is
 *     present in the database, so a stale `websocketEnabled=false` row cannot
 *     override a mode the admin just switched.
 *
 * Redis is mocked per the convention in `sync-state.test.ts` — CI needs no
 * Redis, and the tests exercise the cache-miss path so the derivation runs.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@/lib/redis', () => ({
  redis: {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
  },
}));

const systemSettingFindMany = vi.fn();
vi.mock('@/lib/db', () => ({
  prisma: {
    systemSetting: {
      findMany: (...args: unknown[]) => systemSettingFindMany(...args),
      upsert: vi.fn(),
    },
  },
}));

import { redis } from '@/lib/redis';
import { getStandSettings } from '../settings';

const mockRedis = vi.mocked(redis, true) as unknown as {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
};

function rows(entries: Record<string, string>): Array<{ key: string; value: string }> {
  return Object.entries(entries).map(([key, value]) => ({ key, value }));
}

describe('stand settings defaults', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Cache miss, so every assertion exercises the real merge path.
    mockRedis.get.mockResolvedValue(null);
    mockRedis.set.mockResolvedValue('OK');
    systemSettingFindMany.mockResolvedValue([]);
  });

  it('defaults to websocket mode when the database has no stand rows', async () => {
    const settings = await getStandSettings();
    expect(settings.realtimeMode).toBe('websocket');
    expect(settings.websocketEnabled).toBe(true);
  });

  it('reads realtimeMode=websocket from the database and enables the socket', async () => {
    systemSettingFindMany.mockResolvedValue(
      rows({ 'stand.realtimeMode': 'websocket', 'stand.websocketEnabled': 'false' }),
    );
    const settings = await getStandSettings();
    expect(settings.realtimeMode).toBe('websocket');
    // Derived, not taken from the stale row.
    expect(settings.websocketEnabled).toBe(true);
  });

  it('reads realtimeMode=polling from the database and disables the socket', async () => {
    systemSettingFindMany.mockResolvedValue(
      rows({ 'stand.realtimeMode': 'polling', 'stand.websocketEnabled': 'true' }),
    );
    const settings = await getStandSettings();
    expect(settings.realtimeMode).toBe('polling');
    expect(settings.websocketEnabled).toBe(false);
  });

  it('caches the merged result so a later read does not hit the database', async () => {
    systemSettingFindMany.mockResolvedValue(rows({ 'stand.realtimeMode': 'websocket' }));
    await getStandSettings();
    expect(mockRedis.set).toHaveBeenCalledWith(
      'stand:global-settings:v2',
      expect.stringContaining('"realtimeMode":"websocket"'),
      'EX',
      300,
    );
  });

  it('honours a cached realtimeMode without consulting the database', async () => {
    mockRedis.get.mockResolvedValue(JSON.stringify({ realtimeMode: 'polling' }));
    systemSettingFindMany.mockResolvedValue(rows({ 'stand.realtimeMode': 'websocket' }));
    const settings = await getStandSettings();
    expect(settings.realtimeMode).toBe('polling');
    expect(systemSettingFindMany).not.toHaveBeenCalled();
  });
});
