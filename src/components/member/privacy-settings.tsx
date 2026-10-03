'use client';

/**
 * "Your information" — the member-facing GDPR self-service panel.
 *
 * Written for the actual audience: elderly, non-technical band members who are
 * explicitly prone to mis-taps. That drives every decision here:
 *
 *   - No legalese and no field names. Every sentence is what a person would say
 *     out loud. No cuid ids appear anywhere in the copy.
 *   - Nothing irreversible happens on a single press. The flow is
 *     request → 7-day undo window → confirm. "I've changed my mind" is a
 *     first-class button that is as prominent as the destructive one.
 *   - The confirmation is typing your own name, checked server-side.
 *   - What is KEPT, and why, is stated before anything is deleted — not in a
 *     footnote afterwards.
 *   - Errors are text next to the control that caused them, plus an aria-live
 *     region. Never colour alone (WCAG 1.4.1).
 */

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Download, FileSpreadsheet, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

type ErasureStep = 'idle' | 'requesting' | 'pending' | 'confirming' | 'done';

interface PendingRequest {
  executesAt: string;
  requestedAt: string;
}

interface RetentionItem {
  record: string;
  basis: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function formatRemaining(executesAt: string): string {
  const remaining = new Date(executesAt).getTime() - Date.now();
  if (remaining <= 0) return 'any moment now';
  const days = Math.ceil(remaining / DAY_MS);
  if (days >= 2) return `in about ${days} days`;
  const hours = Math.max(1, Math.round(remaining / (60 * 60 * 1000)));
  return `in about ${hours} hour${hours === 1 ? '' : 's'}`;
}

export function PrivacySettings({ memberName }: { memberName: string }) {
  const [step, setStep] = useState<ErasureStep>('idle');
  const [pending, setPending] = useState<PendingRequest | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string | null>(null);
  // Download failures are kept separate from erasure failures so the two panels
  // cannot render the same sentence at once (which would have a screen reader
  // announce it twice).
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [retention, setRetention] = useState<RetentionItem[]>([]);
  const [downloading, setDownloading] = useState<'json' | 'csv' | null>(null);

  // Ask the server what (if anything) is pending rather than tracking dates in
  // the client — the request lives in Redis, so a page reload or a different
  // device still shows the true state.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const response = await fetch('/api/privacy/erasure', { cache: 'no-store' });
        if (!response.ok) return;
        const data = (await response.json()) as {
          pending: boolean;
          request: PendingRequest | null;
          retentionBasis: RetentionItem[];
        };
        if (cancelled) return;
        setRetention(data.retentionBasis ?? []);
        if (data.pending && data.request) {
          setPending(data.request);
          setStep('pending');
        }
      } catch {
        // A failed status poll must not block the panel; the member can still
        // use the download button and request erasure.
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const download = useCallback(async (format: 'json' | 'csv') => {
    setDownloadError(null);
    setStatus(null);
    setDownloading(format);
    try {
      const response = await fetch(`/api/privacy/export?format=${format}`, {
        cache: 'no-store',
      });
      if (!response.ok) {
        setDownloadError(
          response.status === 429
            ? 'You have asked for this several times already. Please wait an hour and try again.'
            : 'We could not prepare your file just now. Please try again in a moment.',
        );
        return;
      }
      const blob = await response.blob();
      const disposition = response.headers.get('Content-Disposition') ?? '';
      const match = /filename="([^"]+)"/.exec(disposition);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = match?.[1] ?? `eccb-my-information.${format}`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setStatus(
        format === 'csv'
          ? 'Your spreadsheet has been saved to your downloads folder.'
          : 'Your file has been saved to your downloads folder.',
      );
    } catch {
      setDownloadError('We could not prepare your file just now. Please try again in a moment.');
    } finally {
      setDownloading(null);
    }
  }, []);

  async function requestDeletion() {
    setError(null);
    setStatus(null);
    setStep('requesting');
    try {
      const response = await fetch('/api/privacy/erasure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'request' }),
      });
      const data = (await response.json()) as {
        request?: PendingRequest;
        retentionBasis?: RetentionItem[];
        error?: string;
      };
      if (!response.ok || !data.request) {
        setError(data.error ?? 'We could not start that just now. Please try again.');
        setStep('idle');
        return;
      }
      setPending(data.request);
      if (data.retentionBasis) setRetention(data.retentionBasis);
      setStep('pending');
    } catch {
      setError('We could not start that just now. Please try again.');
      setStep('idle');
    }
  }

  async function cancelDeletion() {
    setError(null);
    setStatus(null);
    try {
      const response = await fetch('/api/privacy/erasure', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!response.ok) {
        setError('We could not undo that just now. Please try again, or call the director.');
        return;
      }
      setPending(null);
      setConfirmation('');
      setStep('idle');
      setStatus('Good news — nothing was deleted, and your request has been taken back.');
    } catch {
      setError('We could not undo that just now. Please try again, or call the director.');
    }
  }

  async function confirmDeletion() {
    setError(null);
    setStatus(null);
    if (confirmation.trim().length === 0) {
      // Adjacent, specific error text rather than a generic "invalid form".
      setError('Please type your name in the box before you continue.');
      return;
    }
    setStep('confirming');
    try {
      const response = await fetch('/api/privacy/erasure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'confirm', confirmation }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        setError(
          data.error ?? 'We could not finish that just now. Nothing was deleted — please try again.',
        );
        setStep('pending');
        return;
      }
      setConfirmation('');
      setStep('done');
    } catch {
      setError('We could not finish that just now. Nothing was deleted — please try again.');
      setStep('pending');
    }
  }

  const busy = step === 'requesting' || step === 'confirming';

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Your information</h2>
        <p className="text-muted-foreground">
          Ask for a copy of everything we hold about you, or ask us to delete it. You are always
          welcome to ask — it is your information.
        </p>
      </div>

      {/* Announcements: the visible status/error paragraphs below carry
          role="status"/"alert" and are mounted only when they have content, so
          a screen reader announces them on insertion. Duplicating them into
          sr-only live regions would make every message read out TWICE, which
          is worse than silence for this audience. */}
      {/* ─── Download ─────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Download className="h-5 w-5" aria-hidden="true" />
            Download my information
          </CardTitle>
          <CardDescription>
            Get a copy of everything the band keeps about you — your details, the music assigned to
            you, which rehearsals you attended, and a list of everything recorded about your
            account.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            We will save the file straight to your computer&rsquo;s downloads folder. If you would
            rather not keep it, you can simply delete the file afterwards — we cannot see it.
          </p>

          <div className="flex flex-wrap gap-3">
            <Button
              onClick={() => void download('json')}
              disabled={downloading !== null}
              className="min-h-11"
            >
              <Download className="mr-2 h-4 w-4" aria-hidden="true" />
              {downloading === 'json' ? 'Preparing your file…' : 'Download my information'}
            </Button>
            <Button
              onClick={() => void download('csv')}
              variant="outline"
              disabled={downloading !== null}
              className="min-h-11"
            >
              <FileSpreadsheet className="mr-2 h-4 w-4" aria-hidden="true" />
              {downloading === 'csv'
                ? 'Preparing your file…'
                : 'Download as a spreadsheet (for Excel)'}
            </Button>
          </div>

          {/* `role="note"`, not the ui/alert default of "alert": this is static
              reference text, and an assertive live region would interrupt a
              screen reader every time it re-rendered. */}
          <Alert role="note">
            <Info className="h-4 w-4" aria-hidden="true" />
            <AlertDescription>
              Your password and your security codes are never included. We cannot read them
              ourselves, so we could not send them even if we wanted to.
            </AlertDescription>
          </Alert>

          {status && (
            <p
              role="status"
              aria-live="polite"
              className="flex items-start gap-2 text-sm text-foreground"
            >
              <CheckCircle2
                className="mt-0.5 h-4 w-4 shrink-0 text-primary"
                aria-hidden="true"
              />
              {status}
            </p>
          )}
          {downloadError && (
            <p
              role="alert"
              aria-live="assertive"
              className="flex items-start gap-2 text-sm font-medium text-destructive"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              {downloadError}
            </p>
          )}
        </CardContent>
      </Card>

      {/* ─── Erasure ──────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-amber-600" aria-hidden="true" />
            Ask us to delete my information
          </CardTitle>
          <CardDescription>
            This removes your login, your settings, your marks on the music and your messages. You
            will be able to undo it for seven days.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-5">
          {/* What we keep — stated up front, every time, not buried. */}
          {retention.length > 0 && (
            <Alert role="note">
              <Info className="h-4 w-4" aria-hidden="true" />
              <AlertTitle>What we would keep, and why</AlertTitle>
              <AlertDescription>
                <ul className="mt-2 list-disc space-y-2 pl-5">
                  {retention.map((item) => (
                    <li key={item.record}>
                      <span className="font-medium">{item.record}.</span> {item.basis}
                    </li>
                  ))}
                </ul>
                <p className="mt-3">
                  In every one of those cases your name, email address and phone number are removed.
                  What is left cannot be traced back to you.
                </p>
              </AlertDescription>
            </Alert>
          )}

          {step === 'idle' && (
            <>
              <p className="text-sm text-muted-foreground">
                Nothing is deleted straight away. If you press the button, we will hold your request
                for seven days so you have time to change your mind. After that, nothing will happen
                unless you confirm it yourself.
              </p>
              <Button
                variant="destructive"
                onClick={() => void requestDeletion()}
                disabled={busy}
                className="min-h-11"
              >
                {busy ? 'Starting…' : 'Ask us to delete my information'}
              </Button>
              {error && (
                <p
                  role="alert"
                  aria-live="assertive"
                  className="flex items-start gap-2 text-sm font-medium text-destructive"
                >
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  {error}
                </p>
              )}
            </>
          )}

          {step === 'pending' && pending && (
            <div className="space-y-5 rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-700 dark:bg-amber-950/30">
              <p className="font-medium">Your request is waiting. Nothing has been deleted yet.</p>
              <p className="text-sm text-muted-foreground">
                We will not delete anything until {formatRemaining(pending.executesAt)}. Until then,
                you can change your mind with one button — there is no penalty and nobody is told.
              </p>

              <div className="flex flex-wrap gap-3">
                <Button
                  onClick={() => void cancelDeletion()}
                  variant="outline"
                  disabled={busy}
                  className="min-h-11"
                >
                  Actually, I&rsquo;ve changed my mind — keep my information
                </Button>
              </div>

              <div className="space-y-2 border-t border-amber-300 pt-4 dark:border-amber-700">
                <p className="text-sm font-medium">
                  Would you like to go ahead now instead of waiting? You can.
                </p>
                <Label htmlFor="erasure-confirmation" className="text-sm">
                  Type your name to confirm
                </Label>
                <Input
                  id="erasure-confirmation"
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                  autoComplete="off"
                  placeholder={memberName}
                  aria-describedby="erasure-confirmation-help erasure-confirmation-error"
                  className="min-h-11 max-w-sm"
                />
                <p id="erasure-confirmation-help" className="text-sm text-muted-foreground">
                  Type <span className="font-medium">{memberName}</span> exactly as it appears above,
                  then press the button. This is to make sure it really is you.
                </p>
                <p
                  id="erasure-confirmation-error"
                  className="text-sm font-medium text-destructive"
                >
                  {busy ? 'Deleting your information…' : (error ?? '')}
                </p>
                <Button
                  variant="destructive"
                  onClick={() => void confirmDeletion()}
                  disabled={busy}
                  className="min-h-11"
                >
                  {busy ? 'Deleting…' : 'Yes, delete my information now'}
                </Button>
              </div>
            </div>
          )}

          {step === 'done' && (
            <div className="space-y-3 rounded-lg border border-primary bg-primary/5 p-4">
              <p className="flex items-center gap-2 font-medium">
                <CheckCircle2 className="h-5 w-5 text-primary" aria-hidden="true" />
                Your information has been deleted.
              </p>
              <p className="text-sm text-muted-foreground">
                Your login no longer works, and your name, contact details and notes are gone. The
                anonymous records described above have been kept. You are welcome to make a new
                account at any time.
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}