'use client';

import { useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';

/**
 * Persistent banner shown while an admin is signed in as another user.
 *
 * Impersonation gives the actor the target's full authority, so it has to be
 * impossible to forget you are in it. This renders server-side in the member
 * layout whenever `session.impersonatedBy` is set on the session.
 */
export function ImpersonationBanner({ targetEmail }: { targetEmail: string }) {
  const [loading, setLoading] = useState(false);

  const handleStop = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/admin/users/impersonate/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await response.json();

      if (!response.ok || !data.success) {
        toast.error(data.error || 'Failed to end impersonation');
        setLoading(false);
        return;
      }

      // The response carried fresh Set-Cookie headers restoring the admin
      // session, so a full reload is required — a client-side navigation would
      // keep rendering the impersonated identity.
      window.location.href = '/admin';
    } catch {
      toast.error('Failed to end impersonation');
      setLoading(false);
    }
  };

  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-3 border-b border-amber-500/40 bg-amber-500/10 px-6 py-3"
    >
      <div className="flex items-center gap-2 text-sm text-amber-900 dark:text-amber-200">
        <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span>
          <span className="font-semibold">Impersonating {targetEmail}.</span>{' '}
          You are seeing this account with their permissions, and every action
          is recorded.
        </span>
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={handleStop}
        disabled={loading}
      >
        {loading ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Ending…
          </>
        ) : (
          'Return to my account'
        )}
      </Button>
      <span className="sr-only" aria-live="polite">
        {loading ? 'Ending impersonation session' : ''}
      </span>
    </div>
  );
}