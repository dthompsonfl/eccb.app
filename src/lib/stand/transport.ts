/**
 * Stand transport selection.
 *
 * The Music Stand can sync over two transports: a Socket.IO WebSocket
 * connection proxied at `/api/stand/socket`, or HTTP polling of
 * `/api/stand/sync`. Which one a member's browser uses is driven ENTIRELY by
 * the admin-facing `stand.realtimeMode` / `stand.websocketEnabled` settings —
 * never by whether the browser happens to support WebSockets.
 *
 * This module exists because that decision used to be written inline in
 * `StandViewer.tsx`, where nothing could assert it. It was one refactor away
 * from regressing into "always poll regardless of the setting", which is the
 * failure mode this file makes impossible to reintroduce silently.
 *
 * Rules:
 *  - `realtimeMode` is the intent; `websocketEnabled` is the kill switch.
 *    Either one saying "no" means poll.
 *  - Unknown/missing config polls. Failing closed onto a 5s poll is visible and
 *    harmless; failing open onto a socket that will never connect looks like
 *    realtime to the musician but is not.
 *  - `socketAvailable` reflects a runtime probe (SSR, no `window`). It can only
 *    ever downgrade to polling, never upgrade.
 */

export type StandTransport = 'websocket' | 'polling';

/** The member-safe subset of settings the viewer needs to choose a transport. */
export interface StandTransportConfig {
  realtimeMode?: string | null;
  websocketEnabled?: boolean | null;
}

/**
 * True when the settings ask for realtime WebSocket sync.
 *
 * Both signals must agree: the mode must be exactly `websocket` and the switch
 * must not be off. `stand.websocketEnabled` is derived from `realtimeMode` by
 * `getStandSettings`, so requiring both also rejects a hand-edited DB row where
 * only one of the two was changed.
 */
export function isRealtimeRequested(config: StandTransportConfig | null | undefined): boolean {
  if (!config) return false;
  if (config.realtimeMode !== 'websocket') return false;
  return config.websocketEnabled !== false;
}

/**
 * The transport to use for a given configuration.
 *
 * `socketAvailable` is the caller's runtime probe. When it is false we poll even
 * if realtime was requested — the socket path needs a browser.
 */
export function selectStandTransport(
  config: StandTransportConfig | null | undefined,
  socketAvailable: boolean,
): StandTransport {
  if (!socketAvailable) return 'polling';
  return isRealtimeRequested(config) ? 'websocket' : 'polling';
}

/**
 * Whether `useStandSync` should open a Socket.IO connection.
 *
 * Thin alias over {@link selectStandTransport} so call sites read as intent
 * rather than as a comparison chain.
 */
export function shouldUseRealtimeSocket(
  config: StandTransportConfig | null | undefined,
  socketAvailable: boolean,
): boolean {
  return selectStandTransport(config, socketAvailable) === 'websocket';
}

/** Polling interval to use, falling back to the documented 5s default. */
export function resolvePollingIntervalMs(
  settings: { pollingIntervalMs?: number | null } | null | undefined,
): number {
  const raw = settings?.pollingIntervalMs;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 500) return raw;
  return 5_000;
}