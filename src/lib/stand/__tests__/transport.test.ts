/**
 * Tests for Stand transport selection.
 *
 * The invariant under test: `stand.realtimeMode` in the database decides
 * whether members sync over the Socket.IO connection or over HTTP polling, and
 * nothing else does. A regression that made the client poll unconditionally
 * would still pass every UI test — the stand would just quietly stop being
 * realtime — so it is pinned here.
 *
 * Redis is mocked per the convention in `sync-state.test.ts`: no CI Redis needed.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/redis', () => ({
  redis: {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
  },
}));

import {
  isRealtimeRequested,
  resolvePollingIntervalMs,
  selectStandTransport,
  shouldUseRealtimeSocket,
} from '../transport';

const WEBSOCKET = { realtimeMode: 'websocket', websocketEnabled: true };
const POLLING = { realtimeMode: 'polling', websocketEnabled: false };

describe('isRealtimeRequested', () => {
  it('honours realtimeMode=websocket with the switch on', () => {
    expect(isRealtimeRequested(WEBSOCKET)).toBe(true);
  });

  it('refuses websocket when the mode says polling', () => {
    expect(isRealtimeRequested(POLLING)).toBe(false);
  });

  it('refuses websocket when the switch is off even if the mode says websocket', () => {
    // The hand-edited-DB drift: mode right, switch wrong.
    expect(isRealtimeRequested({ realtimeMode: 'websocket', websocketEnabled: false })).toBe(false);
  });

  it('tolerates a payload with no websocketEnabled field', () => {
    expect(isRealtimeRequested({ realtimeMode: 'websocket' })).toBe(true);
  });

  it('treats missing config as polling rather than guessing realtime', () => {
    expect(isRealtimeRequested(null)).toBe(false);
    expect(isRealtimeRequested(undefined)).toBe(false);
    expect(isRealtimeRequested({})).toBe(false);
  });

  it('treats an unrecognised mode as polling', () => {
    expect(isRealtimeRequested({ realtimeMode: 'off', websocketEnabled: true })).toBe(false);
    expect(isRealtimeRequested({ realtimeMode: '', websocketEnabled: true })).toBe(false);
  });
});

describe('selectStandTransport', () => {
  it('opens the socket in websocket mode', () => {
    expect(selectStandTransport(WEBSOCKET, true)).toBe('websocket');
  });

  it('polls in polling mode', () => {
    expect(selectStandTransport(POLLING, true)).toBe('polling');
  });

  it('polls when realtime was requested but no socket is available', () => {
    // SSR and any non-browser runtime: the Socket.IO path cannot be opened.
    expect(selectStandTransport(WEBSOCKET, false)).toBe('polling');
  });

  it('never upgrades to the socket when polling was configured', () => {
    expect(selectStandTransport(POLLING, true)).toBe('polling');
  });
});

describe('shouldUseRealtimeSocket', () => {
  it('mirrors selectStandTransport for the hook argument', () => {
    expect(shouldUseRealtimeSocket(WEBSOCKET, true)).toBe(true);
    expect(shouldUseRealtimeSocket(WEBSOCKET, false)).toBe(false);
    expect(shouldUseRealtimeSocket(POLLING, true)).toBe(false);
  });
});

describe('resolvePollingIntervalMs', () => {
  it('uses the configured interval when it is sane', () => {
    expect(resolvePollingIntervalMs({ pollingIntervalMs: 2000 })).toBe(2000);
  });

  it('falls back to 5s for missing, non-numeric or absurdly small values', () => {
    expect(resolvePollingIntervalMs(null)).toBe(5000);
    expect(resolvePollingIntervalMs({})).toBe(5000);
    expect(resolvePollingIntervalMs({ pollingIntervalMs: Number.NaN })).toBe(5000);
    expect(resolvePollingIntervalMs({ pollingIntervalMs: 0 })).toBe(5000);
    expect(resolvePollingIntervalMs({ pollingIntervalMs: 10 })).toBe(5000);
  });
});
