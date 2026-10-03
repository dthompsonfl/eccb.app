/**
 * Contract test for the push opt-out path.
 *
 * The regression this guards against: `disable()` used to call
 * `DELETE /api/push/unsubscribe`, a path that has never existed. The DELETE
 * handler is exported from the SUBSCRIBE route, so opting out 404'd and the
 * server kept both the stored endpoint and the consent flag — a member who
 * believed they had turned push off kept receiving alerts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePushNotifications } from '@/components/push/use-push-notifications';

const ENDPOINT = 'https://push.example.com/endpoint/abc';

const mockSubscription = {
  endpoint: ENDPOINT,
  unsubscribe: vi.fn().mockResolvedValue(true),
};

const fetchMock = vi.fn();

function jsonResponse(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => body };
}

describe('usePushNotifications.disable', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(
      jsonResponse({ enabled: true, consentedAt: '2026-01-01T00:00:00.000Z' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    mockSubscription.unsubscribe.mockClear();
    const pushManager = { getSubscription: vi.fn().mockResolvedValue(mockSubscription) };
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        onLine: true,
        serviceWorker: { ready: Promise.resolve({ pushManager }) },
      },
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function calls(method: string): [string, { body?: string }][] {
    return fetchMock.mock.calls.filter(
      (call) => (call[1] as { method?: string } | undefined)?.method === method,
    ) as [string, { body?: string }][];
  }

  it('sends DELETE to /api/push/subscribe, the route that actually handles it', async () => {
    const { result } = renderHook(() => usePushNotifications());

    await act(async () => {
      await result.current.disable();
    });

    const deletes = calls('DELETE');
    expect(deletes).toHaveLength(1);
    expect(deletes[0][0]).toBe('/api/push/subscribe');
    expect(JSON.parse(deletes[0][1].body ?? '{}')).toEqual({ endpoint: ENDPOINT });
    expect(result.current.subscribed).toBe(false);
    expect(result.current.consent).toBe(false);
  });

  it('never requests the nonexistent /api/push/unsubscribe path', async () => {
    const { result } = renderHook(() => usePushNotifications());

    await act(async () => {
      await result.current.disable();
    });

    expect(fetchMock.mock.calls.map((call) => call[0])).not.toContain(
      '/api/push/unsubscribe',
    );
  });

  it('revokes server-side consent when the endpoint DELETE fails', async () => {
    fetchMock.mockImplementation(async (_url: string, init?: { method?: string }) => {
      if (init?.method === 'DELETE') return jsonResponse({}, false);
      return jsonResponse({ enabled: true, consentedAt: '2026-01-01T00:00:00.000Z' });
    });

    const { result } = renderHook(() => usePushNotifications());

    await act(async () => {
      await result.current.disable();
    });

    const patches = calls('PATCH');
    expect(patches).toHaveLength(1);
    expect(patches[0][0]).toBe('/api/push/consent');
    expect(JSON.parse(patches[0][1].body ?? '{}')).toEqual({ enabled: false });
    expect(result.current.consent).toBe(false);
  });
});