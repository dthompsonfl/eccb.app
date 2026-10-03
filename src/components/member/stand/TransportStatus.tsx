'use client';

import React from 'react';
import { Radio, RefreshCw } from 'lucide-react';
import type { StandTransport } from '@/lib/stand/transport';

/**
 * TransportStatus — tells the musician which transport is actually carrying
 * their sync right now.
 *
 * The failure this exists to prevent: realtime mode configured, Socket.IO
 * unreachable, the hook quietly drops to polling, and the musician is told
 * nothing while waiting on a five-second poll that looks like a dead score.
 * Silent degradation is indistinguishable from a broken stand to the person
 * holding the instrument, so it is reported here.
 *
 * Renders nothing while realtime is working — no chrome for the healthy case.
 * Accessibility: icon AND text, never colour alone; `role="status"` so a
 * screen-reader user hears the downgrade without hunting for it.
 */

export interface TransportStatusProps {
  /** The transport the configuration asked for. */
  requested: StandTransport;
  /** True when the hook fell back to polling. */
  isPollingFallback: boolean;
  /** Milliseconds between polls while degraded. */
  pollingIntervalMs: number;
  className?: string;
  /** Offer a manual reconnect attempt back to realtime. */
  onReconnect?: () => void;
}

export function TransportStatus({
  requested,
  isPollingFallback,
  pollingIntervalMs,
  className,
  onReconnect,
}: TransportStatusProps): React.ReactElement | null {
  if (requested === 'polling' || !isPollingFallback) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className={className}
      data-testid="stand-transport-status"
    >
      <RefreshCw className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span>
        Live sync unavailable — following the band by polling every{' '}
        {Math.round(pollingIntervalMs / 1000)}s.
      </span>
      {onReconnect ? (
        <button
          type="button"
          onClick={onReconnect}
          className="underline underline-offset-2"
        >
          Retry live sync
        </button>
      ) : (
        <Radio className="h-4 w-4 shrink-0" aria-hidden="true" />
      )}
    </div>
  );
}