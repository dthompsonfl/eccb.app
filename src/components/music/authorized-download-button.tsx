'use client';

/**
 * AuthorizedDownloadButton
 *
 * The canonical download flow for sheet music. There is exactly one download
 * architecture in this application:
 *
 *   1. POST /api/files/download-url  { key, expiresIn? }
 *      -> server checks session, CSRF, rate limit, and the caller's
 *         music.download.all / music.download.assigned permissions plus
 *         assignment to the piece, then returns a short-lived signed URL.
 *   2. GET /api/files/download/<key>?token=<signed>
 *      -> verifies the signature, the key binding, and the expiry before
 *         streaming from storage.
 *
 * The storage key is never used as the sole authorization proof, and no raw
 * storage key is ever placed in a plain `href` — the old member music page
 * linked to `/api/music/download/${fileId}`, a route that does not exist and
 * which would have had no signed token even if it did.
 *
 * This component is a client component because step 1 is a POST. Rendering it
 * from a server component page is the intended usage.
 */

import { useCallback, useState } from 'react';
import { Download, Loader2, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';

interface AuthorizedDownloadButtonProps {
  /** Storage key of the file, e.g. "pieces/abc/score.pdf". */
  storageKey: string;
  /** Visible label. */
  label: string;
  /** Signed-URL lifetime in seconds (60..86400). Default 300. */
  expiresIn?: number;
  variant?: 'default' | 'outline' | 'ghost' | 'secondary';
  className?: string;
}

export function AuthorizedDownloadButton({
  storageKey,
  label,
  expiresIn = 300,
  variant = 'outline',
  className,
}: AuthorizedDownloadButtonProps) {
  const [pending, setPending] = useState(false);

  const handleDownload = useCallback(async () => {
    setPending(true);
    try {
      const res = await fetch('/api/files/download-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: storageKey, expiresIn }),
      });

      if (!res.ok) {
        let message = 'Download could not be authorized.';
        try {
          const body = await res.json();
          if (body?.error) message = body.error;
        } catch {
          // Non-JSON error body; keep the generic message.
        }
        toast.error(
          res.status === 403 || res.status === 401
            ? message
            : `${message} (${res.status})`,
        );
        return;
      }

      const { url } = (await res.json()) as { url: string };

      if (!url) {
        toast.error('The server did not return a download link.');
        return;
      }

      // Navigate in this tab so the PDF opens in the browser viewer rather
      // than being downloaded, which matches the Digital Stand handoff.
      window.location.assign(url);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? `Download failed: ${error.message}`
          : 'Download failed due to a network error.',
      );
    } finally {
      setPending(false);
    }
  }, [storageKey, expiresIn]);

  return (
    <Button
      type="button"
      variant={variant}
      className={className}
      onClick={handleDownload}
      disabled={pending}
      aria-busy={pending}
    >
      {pending ? (
        <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
      ) : (
        <Download className="mr-2 h-4 w-4" aria-hidden="true" />
      )}
      {pending ? 'Preparing…' : label}
    </Button>
  );
}

/**
 * Server-rendered variant: a plain link to a pre-authorized signed URL.
 *
 * Prefer AuthorizedDownloadButton. Use this only when the URL was generated
 * server-side during the request that rendered the page.
 */
export function AuthorizedDownloadLink({
  url,
  label,
  variant = 'outline',
  className,
}: {
  url: string;
  label: string;
  variant?: 'default' | 'outline' | 'ghost' | 'secondary';
  className?: string;
}) {
  return (
    <Button variant={variant} className={className} asChild>
      <a href={url} rel="noopener noreferrer">
        <Download className="mr-2 h-4 w-4" aria-hidden="true" />
        {label}
      </a>
    </Button>
  );
}

/**
 * Shown when a piece exists but the caller is not permitted to download it.
 * Keeps the UI honest instead of rendering a control that always fails.
 */
export function DownloadDeniedNotice({ className }: { className?: string }) {
  return (
    <p
      className={
        className ??
        'flex items-center gap-2 text-sm text-muted-foreground'
      }
    >
      <ShieldAlert className="h-4 w-4" aria-hidden="true" />
      You do not have permission to download this music.
    </p>
  );
}
