'use client';

/**
 * PracticeTimer — start/stop practice sessions, manual entry, history summary.
 * Gated by config.practiceTrackingEnabled from /api/stand/config.
 *
 * Features:
 *   - Auto-timer: count-up from start
 *   - Save session to /api/stand/practice-logs on stop
 *   - Manual entry override (minutes input + notes)
 *   - History list with per-piece totals
 *   - Delete past sessions
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  TimerIcon,
  PlayIcon,
  StopCircleIcon,
  Trash2Icon,
  PlusIcon,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { cn } from '@/lib/utils';

export interface PracticeLog {
  id: string;
  pieceId: string;
  pieceTitle?: string;
  durationMinutes: number;
  notes: string | null;
  practicedAt: string;
}

export interface PracticeTimerProps {
  className?: string;
  /** The piece being practiced */
  pieceId?: string;
  pieceTitle?: string;
}

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60)
    .toString()
    .padStart(2, '0');
  const s = (seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function formatRelative(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diff = Math.floor((now - then) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

function normalizePracticeLog(entry: any): PracticeLog {
  const durationSeconds =
    typeof entry?.durationSeconds === 'number'
      ? entry.durationSeconds
      : typeof entry?.durationMinutes === 'number'
        ? entry.durationMinutes * 60
        : 0;

  return {
    id: entry.id,
    pieceId: entry.pieceId,
    pieceTitle: entry.piece?.title ?? entry.pieceTitle,
    durationMinutes: Math.max(1, Math.round(durationSeconds / 60)),
    notes: entry.notes ?? null,
    practicedAt: entry.practicedAt,
  };
}

export function PracticeTimer({ className, pieceId, pieceTitle }: PracticeTimerProps) {
  const [isRunning, setIsRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0); // seconds
  const [logs, setLogs] = useState<PracticeLog[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Manual entry
  const [showManual, setShowManual] = useState(false);
  const [manualMinutes, setManualMinutes] = useState('');
  const [manualNotes, setManualNotes] = useState('');
  const [isManualSaving, setIsManualSaving] = useState(false);

  const startTimeRef = useRef<number | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchLogs = useCallback(async () => {
    if (!pieceId) {
      setLogs([]);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const res = await fetch(
        `/api/stand/practice-logs?pieceId=${encodeURIComponent(pieceId)}&limit=20`
      );
      if (!res.ok) throw new Error(`Status ${res.status}`);

      const data = await res.json();
      const rawLogs = Array.isArray(data)
        ? data
        : Array.isArray(data.logs)
          ? data.logs
          : [];

      setLogs(rawLogs.map(normalizePracticeLog));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load logs');
    } finally {
      setIsLoading(false);
    }
  }, [pieceId]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  useEffect(() => {
    if (isRunning) {
      startTimeRef.current = Date.now() - elapsed * 1000;
      intervalRef.current = setInterval(() => {
        if (startTimeRef.current !== null) {
          setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000));
        }
      }, 500);
    } else if (intervalRef.current) {
      clearInterval(intervalRef.current);
    }

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [isRunning, elapsed]);

  const handleStart = () => {
    setElapsed(0);
    setIsRunning(true);
  };

  const handleStop = async () => {
    setIsRunning(false);
    if (!pieceId) return;

    setIsSaving(true);
    try {
      const res = await fetch('/api/stand/practice-logs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pieceId,
          durationSeconds: Math.max(60, elapsed),
        }),
      });
      if (!res.ok) throw new Error('Failed to save session');

      setElapsed(0);
      await fetchLogs();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setIsSaving(false);
    }
  };

  const handleManualSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const mins = parseInt(manualMinutes, 10);
    if (!pieceId || isNaN(mins) || mins <= 0) return;

    setIsManualSaving(true);
    try {
      const res = await fetch('/api/stand/practice-logs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pieceId,
          durationSeconds: mins * 60,
          notes: manualNotes.trim() || null,
        }),
      });
      if (!res.ok) throw new Error('Failed to save');

      setManualMinutes('');
      setManualNotes('');
      setShowManual(false);
      await fetchLogs();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setIsManualSaving(false);
    }
  };

  const handleDelete = async (logId: string) => {
    setDeletingId(logId);
    try {
      const res = await fetch(`/api/stand/practice-logs/${logId}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error('Delete failed');
      setLogs((prev) => prev.filter((l) => l.id !== logId));
    } catch (err) {
      console.error('Delete log failed:', err);
    } finally {
      setDeletingId(null);
    }
  };

  const totalMinutes = logs.reduce((sum, l) => sum + l.durationMinutes, 0);
  const totalHours = (totalMinutes / 60).toFixed(1);

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold flex items-center gap-1.5">
          <TimerIcon className="h-4 w-4" />
          Practice Timer
        </h3>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={fetchLogs}
            disabled={isLoading}
            aria-label="Refresh logs"
            title="Refresh logs"
            className="h-7 w-7"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', isLoading && 'animate-spin')} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setShowManual((v) => !v)}
            aria-label="Log time manually"
            title="Log time manually"
            className="h-7 w-7"
          >
            <PlusIcon className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {pieceTitle && (
        <p className="text-xs text-muted-foreground">
          Piece: <span className="font-medium text-foreground">{pieceTitle}</span>
        </p>
      )}
      {!pieceId && (
        <p className="text-xs text-muted-foreground">
          Select a piece to track practice time.
        </p>
      )}

      {pieceId && (
        <div className="flex items-center gap-3 p-3 rounded-lg border bg-muted/30">
          <span
            className={cn(
              'text-2xl font-mono tabular-nums tracking-wider',
              isRunning && 'text-primary'
            )}
            aria-live="polite"
            aria-label={`Elapsed time: ${formatElapsed(elapsed)}`}
          >
            {formatElapsed(elapsed)}
          </span>
          <div className="flex items-center gap-2 ml-auto">
            {!isRunning ? (
              <Button size="sm" onClick={handleStart} disabled={isSaving}>
                <PlayIcon className="h-3.5 w-3.5 mr-1.5" />
                Start
              </Button>
            ) : (
              <Button
                size="sm"
                variant="destructive"
                onClick={handleStop}
                disabled={isSaving}
              >
                {isSaving ? (
                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                ) : (
                  <StopCircleIcon className="h-3.5 w-3.5 mr-1.5" />
                )}
                Stop & Save
              </Button>
            )}
          </div>
        </div>
      )}

      {showManual && pieceId && (
        <form
          onSubmit={handleManualSave}
          className="space-y-2 p-3 rounded-lg border bg-muted/20"
        >
          <p className="text-xs font-medium">Log time manually</p>
          <div className="flex items-center gap-2">
            <div className="flex-1">
              <Label htmlFor="manual-mins" className="sr-only">
                Minutes
              </Label>
              <Input
                id="manual-mins"
                type="number"
                min={1}
                max={999}
                placeholder="Minutes"
                value={manualMinutes}
                onChange={(e) => setManualMinutes(e.target.value)}
                className="h-8 text-sm"
                required
              />
            </div>
            <Button
              type="submit"
              size="sm"
              disabled={isManualSaving || !manualMinutes}
              className="h-8"
            >
              {isManualSaving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                'Log'
              )}
            </Button>
          </div>
          <Textarea
            placeholder="Notes (optional)"
            value={manualNotes}
            onChange={(e) => setManualNotes(e.target.value)}
            rows={2}
            maxLength={500}
            className="text-sm"
          />
        </form>
      )}

      {error && <p className="text-xs text-destructive">{error}</p>}

      {logs.length > 0 && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>Total logged:</span>
          <Badge variant="outline">{totalHours} hrs</Badge>
          <span>
            across {logs.length} session{logs.length !== 1 ? 's' : ''}
          </span>
        </div>
      )}

      {isLoading && (
        <div className="flex items-center justify-center py-4 text-muted-foreground text-sm">
          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          Loading…
        </div>
      )}

      {!isLoading && logs.length > 0 && (
        <ul className="space-y-1" aria-label="Practice history">
          {logs.map((log) => (
            <li
              key={log.id}
              className="flex items-start gap-2 p-2 rounded-md border bg-card text-xs"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="font-semibold">{log.durationMinutes} min</span>
                  <span className="text-muted-foreground">
                    {formatRelative(log.practicedAt)}
                  </span>
                </div>
                {log.notes && (
                  <p className="text-muted-foreground mt-0.5 truncate">
                    {log.notes}
                  </p>
                )}
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 text-muted-foreground hover:text-destructive shrink-0 mt-0.5"
                onClick={() => handleDelete(log.id)}
                disabled={deletingId === log.id}
                aria-label="Delete session"
                title="Delete session"
              >
                {deletingId === log.id ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Trash2Icon className="h-3 w-3" />
                )}
              </Button>
            </li>
          ))}
        </ul>
      )}

      {!isLoading && pieceId && logs.length === 0 && !isRunning && (
        <p className="text-xs text-muted-foreground text-center py-3">
          No sessions logged yet. Start the timer or log time manually.
        </p>
      )}
    </div>
  );
}
