'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { ShieldCheck, ShieldOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { logger } from '@/lib/logger';

/**
 * Library-administrator control over per-piece watermarking.
 *
 * Watermarking is ON by default because copyrighted sheet music must be
 * traceable to the member it was issued to. Turning it OFF is a deliberate act
 * that requires a written reason, is authorised server-side (this component only
 * ever POSTs to the admin endpoint), and is recorded in the audit log — see
 * `@/lib/music/watermark-policy`.
 */
interface WatermarkToggleProps {
  pieceId: string;
  enabled: boolean;
  disabledBy: string | null;
  disabledAt: Date | null;
  disabledReason: string | null;
}

export function WatermarkToggle({
  pieceId,
  enabled,
  disabledBy,
  disabledAt,
  disabledReason,
}: WatermarkToggleProps) {
  const router = useRouter();
  const [reason, setReason] = useState(disabledReason ?? '');
  const [showReason, setShowReason] = useState(!enabled);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  async function submit(nextEnabled: boolean): Promise<void> {
    setError(null);
    try {
      const response = await fetch('/api/admin/music/watermark', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pieceId, enabled: nextEnabled, reason }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as
          | { error?: string }
          | null;
        setError(body?.error ?? 'Could not update the watermark setting');
        return;
      }

      setShowReason(!nextEnabled);
      startTransition(() => router.refresh());
    } catch (caught) {
      logger.error('Watermark toggle request failed', { caught, pieceId });
      setError('Could not reach the server');
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          {enabled ? (
            <ShieldCheck className="h-5 w-5 text-primary" aria-hidden="true" />
          ) : (
            <ShieldOff className="h-5 w-5 text-amber-500" aria-hidden="true" />
          )}
          <div>
            <p className="text-sm font-medium">Recipient watermark</p>
            <p className="text-xs text-muted-foreground">
              {enabled
                ? 'Every delivered copy is stamped with the recipient, organisation and issue time.'
                : 'Copies are delivered clean. This is recorded in the audit log.'}
            </p>
          </div>
        </div>
        <Badge variant={enabled ? 'default' : 'secondary'}>
          {enabled ? 'On' : 'Off'}
        </Badge>
      </div>

      {!enabled && (
        <p className="text-xs text-amber-600">
          Disabled{disabledAt ? ` on ${new Date(disabledAt).toLocaleDateString()}` : ''}
          {disabledBy ? ` by ${disabledBy}` : ''}
          {disabledReason ? ` — ${disabledReason}` : ''}
        </p>
      )}

      {showReason && !enabled && (
        <div className="space-y-1">
          <label htmlFor={`watermark-reason-${pieceId}`} className="text-xs font-medium">
            Reason (required to disable)
          </label>
          <textarea
            id={`watermark-reason-${pieceId}`}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={500}
            rows={2}
            placeholder="e.g. Public-domain edition, verified against the publisher"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
        </div>
      )}

      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}

      <Button
        type="button"
        variant={enabled ? 'outline' : 'default'}
        size="sm"
        disabled={isPending}
        onClick={() => submit(!enabled)}
        className={cn(enabled && 'text-amber-600')}
      >
        {isPending
          ? 'Saving…'
          : enabled
            ? 'Disable watermarking'
            : 'Re-enable watermarking'}
      </Button>
    </div>
  );
}

export default WatermarkToggle;