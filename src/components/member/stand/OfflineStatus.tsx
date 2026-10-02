'use client';

import React from 'react';
import { cn } from '@/lib/utils';
import { CloudOff, RefreshCw, Check, CloudUpload, AlertCircle } from 'lucide-react';
import type { SyncState } from '@/lib/stand/offline';
import {
  useOnlineStatus,
  useServiceWorkerUpdate,
} from '@/components/providers/service-worker-provider';

const LABELS: Record<SyncState, string> = {
  offline: 'Offline — your work is saved on this device',
  pending: 'Not yet synced',
  syncing: 'Syncing…',
  synced: 'All work saved',
  error: 'Sync failed — will retry',
};

const ICONS: Record<SyncState, React.ComponentType<{ className?: string }>> = {
  offline: CloudOff,
  pending: CloudUpload,
  syncing: RefreshCw,
  synced: Check,
  error: AlertCircle,
};

export interface OfflineStatusProps {
  state: SyncState;
  /** Number of annotations waiting to sync. */
  pendingCount?: number;
  className?: string;
  /** Offer a manual retry. */
  onRetry?: () => void;
}

/**
 * OfflineStatus — tells a musician, in plain language, whether their marks are
 * safe.
 *
 * Before a performance the single most important question is "is my work saved?".
 * This answers it without requiring the user to understand sync at all.
 *
 * Accessibility: the state is conveyed by an icon AND text, never colour alone,
 * and the region is announced politely so a screen-reader user learns about a
 * dropped connection without hunting for it.
 */
export function OfflineStatus({
  state,
  pendingCount = 0,
  className,
  onRetry,
}: OfflineStatusProps) {
  const Icon = ICONS[state];
  const isSyncing = state === 'syncing';

  return (
    <div
      className={cn('flex items-center gap-2 text-xs', className)}
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <Icon
        className={cn('h-4 w-4 shrink-0', isSyncing && 'animate-spin')}
        aria-hidden="true"
      />
      <span>
        {LABELS[state]}
        {state === 'pending' && pendingCount > 0 ? ` (${pendingCount})` : ''}
      </span>

      {onRetry && (state === 'error' || state === 'offline') && (
        <button
          type="button"
          onClick={onRetry}
          aria-label="Retry syncing your annotations"
          className="min-h-[44px] px-2 underline"
        >
          Retry
        </button>
      )}
    </div>
  );
}

/**
 * ServiceWorkerUpdatePrompt — lets the user take a new build when they choose.
 *
 * Deliberately not automatic: swapping the app out from under someone mid-piece
 * would lose their place.
 */
export function ServiceWorkerUpdatePrompt({ className }: { className?: string }) {
  const { available, apply } = useServiceWorkerUpdate();
  if (!available) return null;

  return (
    <div className={cn('flex items-center gap-2 text-xs', className)}>
      <button
        type="button"
        onClick={apply}
        className="min-h-[44px] px-3 rounded border"
        aria-label="Reload to use the new version of the band app"
      >
        New version available — reload
      </button>
    </div>
  );
}

/**
 * StandOfflineStatus — the stand's own connection indicator.
 *
 * Reads live browser connectivity rather than any stored queue, so it stays
 * truthful even when IndexedDB is unavailable (private browsing) and no
 * annotation is queued.
 */
export function StandOfflineStatus({ className }: { className?: string }) {
  const isOnline = useOnlineStatus();
  // Only surface a problem: a constant "online" badge is noise on every screen.
  if (isOnline) return null;

  return <OfflineStatus state="offline" className={className} />;
}
