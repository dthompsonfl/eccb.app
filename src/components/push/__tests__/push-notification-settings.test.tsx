/**
 * @vitest-environment jsdom
 *
 * Client-side registration tests.
 *
 * Two properties are asserted that no amount of server-side gating can supply:
 *
 *  1. NO SILENT ENROLMENT. On mount the component probes state with
 *     getSubscription() and reads consent from the server, but it must never
 *     call pushManager.subscribe() or Notification.requestPermission(). A
 *     browser that prompts, or registers, on page load is exactly the
 *     default-on behaviour this feature must not have.
 *  2. The on/off state is exposed to assistive tech (role="status" live region,
 *     a labelled switch) and the "off" state is stated in words.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { PushNotificationSettings } from '../push-notification-settings';

const requestPermission = vi.fn();
const getSubscription = vi.fn();
const subscribe = vi.fn();
const localUnsubscribe = vi.fn();
const ready = Promise.resolve({ pushManager: { getSubscription, subscribe } });

interface FetchCall {
  url: string;
  init?: RequestInit;
}

let fetchCalls: FetchCall[] = [];

/** Minimal fetch stub: records calls, answers the two endpoints we use. */
function installFetch(overrides: { consent?: unknown; vapid?: unknown } = {}) {
  const consent = 'consent' in overrides ? overrides.consent : { pushEnabled: false };
  const vapid =
    'vapid' in overrides
      ? overrides.vapid
      : { enabled: true, publicKey: 'BEl62iUYgUivxIvc69QViNQFiQs', subject: 'mailto:a@b.c' };

  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    fetchCalls.push({ url, init });
    if (url.includes('/api/push/consent')) {
      return new Response(JSON.stringify(consent), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/api/push/vapid-key')) {
      return new Response(JSON.stringify(vapid), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

function installBrowser(supported = true) {
  if (!supported) {
    // Delete rather than set to undefined: the component guards with
    // `'serviceWorker' in navigator`, which is true for an
    // undefined-valued property and would fall through to the error path.
    delete (navigator as unknown as Record<string, unknown>).serviceWorker;
    Reflect.deleteProperty(globalThis, 'Notification');
    Reflect.deleteProperty(globalThis, 'PushManager');
    return;
  }
  Object.defineProperty(globalThis, 'Notification', {
    configurable: true,
    writable: true,
    value: { permission: 'default', requestPermission },
  });
  Object.defineProperty(globalThis, 'PushManager', {
    configurable: true,
    writable: true,
    value: function PushManager() {},
  });
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    writable: true,
    value: { ready },
  });
}

const subscription = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
  toJSON: () => ({
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
    keys: { p256dh: 'p', auth: 'a' },
  }),
  unsubscribe: localUnsubscribe,
};

describe('PushNotificationSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchCalls = [];
    requestPermission.mockResolvedValue('granted');
    getSubscription.mockResolvedValue(null);
    subscribe.mockResolvedValue(subscription);
    localUnsubscribe.mockResolvedValue(true);
    installBrowser(true);
    installFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // -------------------------------------------------------------------------
  // No silent enrolment
  // -------------------------------------------------------------------------

  describe('on mount', () => {
    it('does NOT request permission', async () => {
      render(<PushNotificationSettings />);

      await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());

      expect(requestPermission).not.toHaveBeenCalled();
    });

    it('does NOT register a push subscription', async () => {
      render(<PushNotificationSettings />);

      await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());

      expect(subscribe).not.toHaveBeenCalled();
    });

    it('does NOT write consent', async () => {
      render(<PushNotificationSettings />);

      await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());

      expect(
        fetchCalls.filter((c) => c.init?.method === 'PATCH'),
      ).toHaveLength(0);
    });

    it('reads consent from the server rather than assuming it', async () => {
      render(<PushNotificationSettings />);

      await waitFor(() => {
        expect(fetchCalls.some((c) => c.url.includes('/api/push/consent'))).toBe(true);
      });
    });
  });

  // -------------------------------------------------------------------------
  // Off state is communicated
  // -------------------------------------------------------------------------

  describe('when push is off', () => {
    it('renders the switch unchecked', async () => {
      render(<PushNotificationSettings />);

      const toggle = await screen.findByRole('switch');
      await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'));
    });

    it('states in text that notifications are off', async () => {
      render(<PushNotificationSettings />);

      await waitFor(() => {
        expect(screen.getByRole('status')).toHaveTextContent(
          /only receive alerts on this device if you turn them on/i,
        );
      });
    });

    it('gives the switch an accessible name', async () => {
      render(<PushNotificationSettings />);

      const toggle = await screen.findByRole('switch');
      const label = document.getElementById(toggle.getAttribute('aria-labelledby') ?? '');

      expect(label).not.toBeNull();
      expect(label?.textContent).toMatch(/push notifications/i);
    });

    it('describes the switch with both the explanation and the status', async () => {
      render(<PushNotificationSettings />);

      const toggle = await screen.findByRole('switch');
      const describedBy = (toggle.getAttribute('aria-describedby') ?? '').split(' ');

      expect(describedBy).toHaveLength(2);
      for (const id of describedBy) {
        expect(document.getElementById(id)).not.toBeNull();
      }
    });
  });

  // -------------------------------------------------------------------------
  // Explicit opt-in / opt-out
  // -------------------------------------------------------------------------

  describe('enabling push', () => {
    it('requests permission and registers only in response to the toggle', async () => {
      render(<PushNotificationSettings />);

      const toggle = await screen.findByRole('switch');
      await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'));
      await fireEvent.click(toggle);

      await waitFor(() => expect(requestPermission).toHaveBeenCalled());
      expect(subscribe).toHaveBeenCalledWith(
        expect.objectContaining({ userVisibleOnly: true }),
      );
    });

    it('records consent before prompting', async () => {
      render(<PushNotificationSettings />);

      const toggle = await screen.findByRole('switch');
      await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'));
      await fireEvent.click(toggle);

      await waitFor(() => expect(requestPermission).toHaveBeenCalled());
      const patchIndex = fetchCalls.findIndex(
        (c) => c.init?.method === 'PATCH' && c.url.includes('/api/push/consent'),
      );
      const consentIndex = fetchCalls.findIndex((c) => c.url.includes('/api/push/consent'));
      expect(patchIndex).toBeGreaterThanOrEqual(0);
      expect(patchIndex).toBeGreaterThan(consentIndex - 1);
      expect(JSON.parse(String(fetchCalls[patchIndex].init?.body))).toEqual({
        enabled: true,
      });
    });

    it('announces the on state and flips the switch', async () => {
      render(<PushNotificationSettings />);

      const toggle = await screen.findByRole('switch');
      await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'));
      await fireEvent.click(toggle);

      await waitFor(() => {
        expect(screen.getByRole('status')).toHaveTextContent(/are on for this device/i);
      });
      expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    });

    it('reports that push stayed off when the member refuses the prompt', async () => {
      requestPermission.mockResolvedValue('denied');
      render(<PushNotificationSettings />);

      const toggle = await screen.findByRole('switch');
      await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'));
      await fireEvent.click(toggle);

      await waitFor(() => {
        expect(screen.getByRole('status')).toHaveTextContent(/blocking notifications/i);
      });
      expect(subscribe).not.toHaveBeenCalled();
    });
  });

  describe('disabling push', () => {
    it('unsubscribes locally and revokes server consent', async () => {
      getSubscription.mockResolvedValue(subscription);
      render(<PushNotificationSettings />);

      const toggle = await screen.findByRole('switch');
      await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
      await fireEvent.click(toggle);

      await waitFor(() => expect(localUnsubscribe).toHaveBeenCalled());
      const del = fetchCalls.find(
        (c) => c.init?.method === 'DELETE' && c.url.includes('/api/push/unsubscribe'),
      );
      expect(del).toBeDefined();
      expect(JSON.parse(String(del?.init?.body))).toEqual({
        endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
      });
      await waitFor(() => {
        expect(screen.getByRole('status')).toHaveTextContent(
          /Push notifications are off\. You will not receive alerts/i,
        );
      });
    });
  });

  // -------------------------------------------------------------------------
  // Unsupported / blocked browsers
  // -------------------------------------------------------------------------

  describe('when the browser cannot do push', () => {
    beforeEach(() => installBrowser(false));

    it('disables the switch and explains why', async () => {
      render(<PushNotificationSettings />);

      await waitFor(() => {
        expect(screen.getByRole('status')).toHaveTextContent(
          /not supported by this browser/i,
        );
      });
      expect(screen.getByRole('switch')).toBeDisabled();
    });
  });
});
