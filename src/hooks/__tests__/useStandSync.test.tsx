import _React from 'react';
import { renderHook, act, waitFor } from '@testing-library/react';
import { afterEach } from 'vitest';
import { useStandSync } from '../use-stand-sync';
import { useStandStore } from '@/store/standStore';

// polyfill global WebSocket to satisfy isWebSocketAvailable() in Node
// (the hook checks for "typeof WebSocket !== 'undefined'")
// @ts-expect-error — polyfill WebSocket for Node test environment
(global as any).WebSocket = class {};

// We'll mock socket.io-client
type SocketHandler = (...args: unknown[]) => void;
let handlers: Record<string, SocketHandler> = {};
const fakeSocket = {
  on: (event: string, cb: (...args: any[]) => void) => {
    handlers[event] = cb;
  },
  emit: vi.fn(),
  disconnect: vi.fn(),
  connected: true,
};

// `socketIoFactory` lets a test decide what the client factory returns, so the
// "socket unavailable" path can be exercised without a live server.
let socketIoFactory: () => unknown = () => fakeSocket;
const socketIoSpy = vi.fn((...args: unknown[]) => {
  void args;
  return socketIoFactory();
});

vi.mock('socket.io-client', () => {
  return {
    io: (...args: unknown[]) => socketIoSpy(...args),
  };
});

/** Replace global fetch with a recorder so polling requests are observable. */
function installFetchStub(): { calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ eventId: 'evt1', activeUserList: [] }),
    });
  });
  return { calls };
}

describe('useStandSync', () => {
  beforeEach(() => {
    handlers = {};
    fakeSocket.emit.mockClear();
    useStandStore.getState().reset();
    socketIoFactory = () => fakeSocket;
    socketIoSpy.mockClear();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('receives roster and presence messages and updates store', async () => {
    const { result: _result } = renderHook(() =>
      useStandSync({
        eventId: 'evt1',
        userId: 'usr1',
        realtimeEnabled: true, // the hook defaults to polling unless realtime is requested
        // onAnnotation writes directly to store to avoid network calls
        onAnnotation: (msg) => {
          const d = msg.data as any;
          const key = `${d.musicId}-${d.page}`;
          type LayerKey = 'personal' | 'section' | 'director';
          const layerKey = (d.layer as string).toLowerCase() as LayerKey;
          useStandStore.setState((s) => {
            s.annotations[layerKey][key] = [
              ...(s.annotations[layerKey][key] || []),
              {
                id: d.id,
                pieceId: d.musicId,
                pageNumber: d.page,
                strokeData: { x: d.x, y: d.y, content: d.content, color: d.color },
                layer: d.layer,
                createdAt: d.createdAt,
              },
            ];
            return s;
          });
        },
      })
    );

    // ensure socket listeners registered
    await waitFor(() => {
      expect(typeof handlers['roster']).toBe('function');
    });

    // simulate initial roster message
    act(() => {
      handlers['roster']({ type: 'roster', members: [{ userId: 'a', name: 'Alpha', joinedAt: 't' }] });
    });

    expect(useStandStore.getState().roster).toEqual([{ userId: 'a', name: 'Alpha', section: undefined, joinedAt: 't' }]);

    // simulate presence join
    act(() => {
      handlers['message']({ type: 'presence', userId: 'b', name: 'Beta', status: 'joined' });
    });

    expect(useStandStore.getState().roster).toEqual([
      { userId: 'a', name: 'Alpha', section: undefined, joinedAt: 't' },
      { userId: 'b', name: 'Beta', section: undefined, joinedAt: expect.any(String) },
    ]);

    // simulate leave
    act(() => {
      handlers['message']({ type: 'presence', userId: 'a', name: 'Alpha', status: 'left' });
    });

    expect(useStandStore.getState().roster.map((m) => m.userId)).toEqual(['b']);

    // simulate receiving annotation message and ensure custom handler updates store via callback
    act(() => {
      handlers['message']({
        type: 'annotation',
        data: {
          id: 'ann1',
          musicId: 'piece-1',
          page: 1,
          x: 0.1,
          y: 0.2,
          content: 'Test',
          color: '#123456',
          layer: 'PERSONAL',
          createdAt: new Date().toISOString(),
        },
      });
    });

    // since onAnnotation provided above adds to store manually, check store now has annotation
    const key = 'piece-1-1';
    const anns = useStandStore.getState().annotations.personal[key];
    expect(anns && anns.length).toBe(1);
    expect(anns![0].id).toBe('ann1');
  });

  describe('transport selection', () => {
    it('opens a Socket.IO connection when realtime is enabled', async () => {
      const { result } = renderHook(() =>
        useStandSync({
          eventId: 'evt1',
          userId: 'usr1',
          realtimeEnabled: true,
          reconnectInterval: 10,
        }),
      );

      await waitFor(() => expect(socketIoSpy).toHaveBeenCalled());
      // The path must be the Next.js proxy, not the raw socket port: the raw
      // port is not exposed to the browser in production.
      const options = socketIoSpy.mock.calls[0]?.[1] as
        | { path?: string; addTrailingSlash?: boolean }
        | undefined;
      expect(options?.path).toBe('/api/stand/socket');
      // Load-bearing, not cosmetic. engine.io defaults to requesting
      // `${path}/`, which Next.js 308-redirects to the slashless form; a polling
      // XHR follows that redirect but a WebSocket UPGRADE CANNOT, so the socket
      // hung and every member silently dropped to polling while /health still
      // reported sockets healthy. Verified against a running start:all.
      expect(options?.addTrailingSlash).toBe(false);
      expect(result.current.isPollingFallback).toBe(false);
    });

    it('polls /api/stand/sync and never opens a socket when realtime is disabled', async () => {
      const fetchCalls = installFetchStub();
      const { result } = renderHook(() =>
        useStandSync({
          eventId: 'evt1',
          userId: 'usr1',
          realtimeEnabled: false,
          pollingInterval: 50,
        }),
      );

      await waitFor(() => expect(result.current.isPollingFallback).toBe(true));
      expect(socketIoSpy).not.toHaveBeenCalled();
      await waitFor(() =>
        expect(fetchCalls.calls.some((c) => c.url.startsWith('/api/stand/sync?'))).toBe(true),
      );
    });

    it('reports a polling fallback when the socket refuses to connect', async () => {
      // The degradation must be REPORTED, not silent: `isPollingFallback` is what
      // TransportStatus renders, so a member is told the stand stopped being live.
      const fetchCalls = installFetchStub();
      const { result } = renderHook(() =>
        useStandSync({
          eventId: 'evt1',
          userId: 'usr1',
          realtimeEnabled: true,
          reconnectInterval: 5,
          maxReconnectAttempts: 1,
          pollingInterval: 50,
        }),
      );

      await waitFor(() => expect(socketIoSpy).toHaveBeenCalled());
      expect(typeof handlers['connect_error']).toBe('function');

      await act(async () => {
        handlers['connect_error'](new Error('xhr poll error'));
      });

      await waitFor(() => expect(result.current.isPollingFallback).toBe(true));
      await waitFor(() =>
        expect(fetchCalls.calls.some((c) => c.url.startsWith('/api/stand/sync?'))).toBe(true),
      );
    });

    it('stops polling once the socket connects', async () => {
      const fetchCalls = installFetchStub();
      const { result } = renderHook(() =>
        useStandSync({
          eventId: 'evt1',
          userId: 'usr1',
          realtimeEnabled: true,
          pollingInterval: 50,
        }),
      );

      await waitFor(() => expect(typeof handlers['connect']).toBe('function'));
      await act(async () => {
        handlers['connect']();
      });

      expect(result.current.isPollingFallback).toBe(false);
      expect(result.current.isConnected).toBe(true);
      const before = fetchCalls.calls.length;
      expect(before).toBe(0);
    });

    it('routes a director command through the socket when realtime is on', async () => {
      const { result } = renderHook(() =>
        useStandSync({ eventId: 'evt1', userId: 'usr1', realtimeEnabled: true }),
      );
      await waitFor(() => expect(typeof handlers['connect']).toBe('function'));
      await act(async () => {
        handlers['connect']();
      });

      act(() => {
        result.current.sendCommand({ action: 'setPage', page: 4 });
      });

      expect(fakeSocket.emit).toHaveBeenCalledWith('message', {
        type: 'command',
        action: 'setPage',
        page: 4,
      });
    });

    it('routes a director command over HTTP when polling is the active transport', async () => {
      const fetchCalls = installFetchStub();
      const { result } = renderHook(() =>
        useStandSync({
          eventId: 'evt1',
          userId: 'usr1',
          realtimeEnabled: false,
          pollingInterval: 50,
        }),
      );
      await waitFor(() => expect(result.current.isPollingFallback).toBe(true));

      act(() => {
        result.current.sendCommand({ action: 'setPage', page: 7 });
      });

      // Several POSTs go to the same URL (presence, then the command), so match
      // on the payload rather than taking the first one.
      const call = fetchCalls.calls.find(
        (c) => c.init?.method === 'POST' && String(c.init.body).includes('"command"'),
      );
      expect(call?.url).toBe('/api/stand/sync');
      expect(JSON.parse(String(call?.init?.body)).command).toEqual({
        type: 'command',
        action: 'setPage',
        page: 7,
      });
      expect(fakeSocket.emit).not.toHaveBeenCalledWith('message', expect.objectContaining({ type: 'command' }));
    });
  });
});
