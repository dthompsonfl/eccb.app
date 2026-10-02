'use client';

/**
 * usePushNotifications — browser push registration.
 *
 * The ordering here is the whole privacy story, so it is worth stating:
 *
 *   1. Ask the SERVER for consent state, never assume it.
 *   2. Only if the member has granted consent, and only in response to an
 *      explicit user action, request Notification permission and call
 *      `pushManager.subscribe()`.
 *   3. Register the resulting subscription with the server, which independently
 *      re-checks consent and will reject the write if consent is absent.
 *
 * There is no effect that subscribes on mount. Push is opt-in, so subscribing
 * on load would be a silent enrolment — and a Notification permission prompt on
 * page load is exactly the pattern browsers and privacy reviewers reject.
 */

import { useCallback, useEffect, useState } from 'react';

export type PushSupportState =
  | 'loading'
  | 'unsupported'
  | 'off'
  | 'denied'
  | 'default'
  | 'enabled'
  | 'error';

export interface PushState {
  support: PushSupportState;
  /** True when this browser holds a live subscription. */
  subscribed: boolean;
  /** Server-recorded consent, mirrored for display only. */
  consent: boolean;
  message: string;
}

interface PushSubscriptionJson {
  endpoint: string;
  keys?: { p256dh?: string; auth?: string };
}

function isPushSubscription(value: unknown): value is PushSubscriptionJson {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as PushSubscriptionJson;
  return typeof candidate.endpoint === 'string' && typeof candidate.keys === 'object';
}

function toBase64Url(input: ArrayBuffer): string {
  const bytes = new Uint8Array(input);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Read the current subscription without triggering a permission prompt.
 *
 * Returns the live PushSubscription (needed for .unsubscribe()) rather than its
 * JSON projection — the object also carries the plain-object shape via toJSON()
 * when it needs to be sent to the server.
 */
async function readExistingSubscription(): Promise<PushSubscription | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  const registration = await navigator.serviceWorker.ready;
  return registration.pushManager.getSubscription();
}

async function fetchVapidConfig(): Promise<{ enabled: boolean; publicKey: string | null }> {
  const res = await fetch('/api/push/vapid-key');
  if (!res.ok) throw new Error('Could not load push configuration');
  return (await res.json()) as { enabled: boolean; publicKey: string | null };
}

export function usePushNotifications(): PushState & {
  enable: () => Promise<void>;
  disable: () => Promise<void>;
  refreshing: boolean;
} {
  const [state, setState] = useState<PushState>({
    support: 'loading',
    subscribed: false,
    consent: false,
    message: 'Checking notification support…',
  });
  const [refreshing, setRefreshing] = useState(false);

  // Read-only status probe. Safe to run on mount: getSubscription() never
  // prompts, so this reports state without changing it.
  useEffect(() => {
    let cancelled = false;

    async function probe() {
      if (typeof window === 'undefined') return;

      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
        if (!cancelled) {
          setState({
            support: 'unsupported',
            subscribed: false,
            consent: false,
            message: 'Push notifications are not supported by this browser.',
          });
        }
        return;
      }

      try {
        const [consentRes, config] = await Promise.all([
          fetch('/api/push/consent'),
          fetchVapidConfig(),
        ]);
        const consentBody = consentRes.ok
          ? ((await consentRes.json()) as { pushEnabled?: boolean })
          : {};

        const subscription = await readExistingSubscription();
        const permission = Notification.permission;

        if (cancelled) return;

        if (!config.enabled) {
          setState({
            support: 'off',
            subscribed: false,
            consent: consentBody.pushEnabled === true,
            message: 'Push notifications are currently turned off for this site.',
          });
          return;
        }

        if (permission === 'denied') {
          setState({
            support: 'denied',
            subscribed: subscription !== null,
            consent: consentBody.pushEnabled === true,
            message:
              'Your browser is blocking notifications for this site. You will need to allow them in your browser settings.',
          });
          return;
        }

        setState({
          support: subscription ? 'enabled' : 'default',
          subscribed: subscription !== null,
          consent: consentBody.pushEnabled === true,
          message: subscription
            ? 'Push notifications are on for this device.'
            : 'Push notifications are off. You will only receive alerts on this device if you turn them on.',
        });
      } catch {
        if (!cancelled) {
          setState({
            support: 'error',
            subscribed: false,
            consent: false,
            message: 'Could not determine your notification settings. Please try again.',
          });
        }
      }
    }

    void probe();
    return () => {
      cancelled = true;
    };
  }, []);

  /** Explicit opt-in. Called only from a user gesture. */
  const enable = useCallback(async () => {
    setRefreshing(true);
    try {
      // Step 1: record consent server-side BEFORE touching the browser prompt.
      // If the browser then refuses, consent is already recorded but harmless —
      // no endpoint exists, so nothing can be delivered. The reverse order
      // would risk holding an endpoint we are not allowed to use.
      const consentRes = await fetch('/api/push/consent', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      });
      if (!consentRes.ok) {
        setState((prev) => ({
          ...prev,
          support: 'error',
          message: 'Could not save your notification preference. Nothing was changed.',
        }));
        return;
      }

      // Step 2: only now ask the browser.
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setState((prev) => ({
          ...prev,
          consent: true,
          support: permission === 'denied' ? 'denied' : 'default',
          subscribed: false,
          message:
            permission === 'denied'
              ? 'Your browser is blocking notifications for this site. You will need to allow them in your browser settings.'
              : 'Notifications were not enabled. Push remains off.',
        }));
        return;
      }

      const config = await fetchVapidConfig();
      if (!config.enabled || !config.publicKey) {
        setState((prev) => ({
          ...prev,
          consent: true,
          support: 'off',
          message: 'Push notifications are currently turned off for this site.',
        }));
        return;
      }

      const applicationServerKey = toBase64Url(
        Uint8Array.from(
          atob(config.publicKey.replace(/-/g, '+').replace(/_/g, '/')),
          (c) => c.charCodeAt(0),
        ).buffer,
      );

      const registration = await navigator.serviceWorker.ready;
      const subscription =
        (await registration.pushManager.getSubscription()) ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey,
        }));

      const json = subscription.toJSON() as unknown;
      if (!isPushSubscription(json) || !json.keys?.p256dh || !json.keys?.auth) {
        setState((prev) => ({
          ...prev,
          support: 'error',
          message: 'This browser returned an unusable push subscription. Push remains off.',
        }));
        return;
      }

      const res = await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: json }),
      });

      if (!res.ok) {
        // Roll the local registration back so a rejected subscription does not
        // linger in the browser pointing at a server that refused it.
        await subscription.unsubscribe().catch(() => undefined);
        await fetch('/api/push/consent', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: false }),
        });
        setState((prev) => ({
          ...prev,
          support: 'error',
          consent: false,
          subscribed: false,
          message: 'Push notifications could not be enabled. Nothing was changed.',
        }));
        return;
      }

      setState({
        support: 'enabled',
        subscribed: true,
        consent: true,
        message: 'Push notifications are on for this device.',
      });
    } finally {
      setRefreshing(false);
    }
  }, []);

  /** Explicit opt-out. Unsubscribes the browser AND revokes server consent. */
  const disable = useCallback(async () => {
    setRefreshing(true);
    try {
      const subscription = await readExistingSubscription();
      await fetch('/api/push/unsubscribe', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          subscription ? { endpoint: subscription.endpoint } : { all: true },
        ),
      });
      if (subscription) {
        await subscription.unsubscribe().catch(() => undefined);
      }

      setState({
        support: 'default',
        subscribed: false,
        consent: false,
        message: 'Push notifications are off. You will not receive alerts on this device.',
      });
    } finally {
      setRefreshing(false);
    }
  }, []);

  return { ...state, enable, disable, refreshing };
}
