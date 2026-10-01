'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Check, Copy, KeyRound, Loader2, ShieldCheck, Smartphone } from 'lucide-react';
import { authClient } from '@/lib/auth/client';
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
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
} from '@/components/ui/input-otp';

/**
 * Two-factor enrolment and removal.
 *
 * Drives Better Auth's two-factor plugin through its supported endpoints:
 *   enable -> totpURI + backupCodes   (user has NOT enabled it yet)
 *   verifyTOTP                        (user proves the app works; enables it)
 *   disable                           (requires password)
 *
 * Enrolment is deliberately two-step. `enable` alone only writes the pending
 * TOTP secret — `User.twoFactorEnabled` stays false until `verifyTOTP`
 * succeeds, so a user who abandons the dialog is not locked out by a
 * authenticator they never finished setting up.
 *
 * The password is sent to Better Auth and never stored, logged, or kept in
 * component state after the request resolves. The TOTP secret and backup codes
 * are held only for as long as the enrolment dialog is open; Better Auth
 * returns them exactly once and encrypts them at rest.
 */

type Step = 'idle' | 'enrolling' | 'verifying';

interface PendingEnrollment {
  totpURI: string;
  backupCodes: string[];
}

export function TwoFactorSettings({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const [twoFactorEnabled, setTwoFactorEnabled] = useState(enabled);
  const [step, setStep] = useState<Step>('idle');
  const [pending, setPending] = useState<PendingEnrollment | null>(null);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const reset = () => {
    setStep('idle');
    setPending(null);
    setPassword('');
    setCode('');
    setCopied(false);
  };

  const beginEnroll = async () => {
    if (!password) {
      toast.error('Enter your password to continue');
      return;
    }
    setBusy(true);
    try {
      const { data, error } = await authClient.twoFactor.enable({ password });
      // Clear the password from state the moment it has been used.
      setPassword('');

      if (error) {
        toast.error(error.message || 'Could not start two-factor setup');
        return;
      }
      if (!data?.totpURI || !data?.backupCodes?.length) {
        toast.error('Setup did not return the expected enrolment details');
        return;
      }

      setPending({ totpURI: data.totpURI, backupCodes: data.backupCodes });
      setStep('verifying');
    } catch {
      toast.error('Could not start two-factor setup');
    } finally {
      setBusy(false);
    }
  };

  const confirmEnroll = async () => {
    if (code.length !== 6) {
      toast.error('Enter the 6-digit code from your authenticator app');
      return;
    }
    setBusy(true);
    try {
      const { error } = await authClient.twoFactor.verifyTotp({ code });
      if (error) {
        toast.error(error.message || 'That code was not accepted');
        return;
      }
      setTwoFactorEnabled(true);
      reset();
      toast.success('Two-factor authentication enabled');
      router.refresh();
    } catch {
      toast.error('That code was not accepted');
    } finally {
      setBusy(false);
    }
  };

  const disable2fa = async () => {
    if (!password) {
      toast.error('Enter your password to continue');
      return;
    }
    setBusy(true);
    try {
      const { error } = await authClient.twoFactor.disable({ password });
      setPassword('');
      if (error) {
        toast.error(error.message || 'Could not disable two-factor authentication');
        return;
      }
      setTwoFactorEnabled(false);
      reset();
      toast.success('Two-factor authentication disabled');
      router.refresh();
    } catch {
      toast.error('Could not disable two-factor authentication');
    } finally {
      setBusy(false);
    }
  };

  const copyBackupCodes = async () => {
    if (!pending) return;
    try {
      await navigator.clipboard.writeText(pending.backupCodes.join('\n'));
      setCopied(true);
      toast.success('Backup codes copied');
    } catch {
      toast.error('Could not copy to clipboard');
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5" aria-hidden="true" />
          <CardTitle>Two-Factor Authentication</CardTitle>
        </div>
        <CardDescription>
          Require a code from your authenticator app in addition to your
          password when signing in.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5">
            <div className="flex items-center gap-2">
              <Smartphone className="h-4 w-4" aria-hidden="true" />
              <span className="font-medium">
                {twoFactorEnabled ? 'Enabled' : 'Not enabled'}
              </span>
            </div>
            <p className="text-sm text-muted-foreground">
              {twoFactorEnabled
                ? 'Your account asks for an authenticator code at sign-in.'
                : 'Add an extra layer of security to your account.'}
            </p>
          </div>
          <Switch
            checked={twoFactorEnabled}
            // The switch is a request, not the state itself: flipping it opens
            // the password confirmation rather than changing anything. This must
            // handle both directions, otherwise an enrolled user cannot turn 2FA
            // off at all.
            onCheckedChange={() => setStep('enrolling')}
            disabled={step === 'verifying' || busy}
            aria-label="Toggle two-factor authentication"
          />
        </div>

        {step !== 'idle' && !pending ? (
          <div className="space-y-3 rounded-lg border border-border/60 p-4">
            <p className="text-sm text-muted-foreground">
              {twoFactorEnabled
                ? 'Confirm your password to turn two-factor authentication off.'
                : 'Confirm your password to begin setup.'}
            </p>
            <div className="space-y-2">
              <Label htmlFor="2fa-password">Password</Label>
              <Input
                id="2fa-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Your account password"
              />
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                onClick={twoFactorEnabled ? disable2fa : beginEnroll}
                disabled={busy || !password}
              >
                {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                {twoFactorEnabled ? 'Turn off' : 'Continue'}
              </Button>
              <Button type="button" variant="ghost" onClick={reset} disabled={busy}>
                Cancel
              </Button>
            </div>
          </div>
        ) : null}

        {step === 'verifying' && pending ? (
          <div className="space-y-4 rounded-lg border border-border/60 p-4">
            <ol className="list-decimal space-y-2 pl-5 text-sm text-muted-foreground">
              <li>
                Open your authenticator app and add a new entry.
              </li>
              <li>
                Enter this setup key if your app offers manual entry:
                <code className="mt-1 block break-all rounded bg-muted px-2 py-1 font-mono text-xs text-foreground">
                  {new URL(pending.totpURI).searchParams.get('secret')}
                </code>
              </li>
              <li>Enter the 6-digit code it shows below.</li>
            </ol>

            <Separator />

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>6-digit code</Label>
              </div>
              <InputOTP
                maxLength={6}
                value={code}
                onChange={setCode}
                inputMode="numeric"
                autoComplete="one-time-code"
              >
                <InputOTPGroup>
                  {[0, 1, 2, 3, 4, 5].map((i) => (
                    <InputOTPSlot key={i} index={i} />
                  ))}
                </InputOTPGroup>
              </InputOTP>
            </div>

            <div className="flex gap-2">
              <Button type="button" onClick={confirmEnroll} disabled={busy || code.length !== 6}>
                {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Verify and enable
              </Button>
              <Button type="button" variant="ghost" onClick={reset} disabled={busy}>
                Cancel
              </Button>
            </div>

            <Separator />

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <div className="flex items-center gap-2">
                    <KeyRound className="h-4 w-4" aria-hidden="true" />
                    <span className="text-sm font-medium">Backup codes</span>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Each code works once, if you lose your authenticator. Save
                    them somewhere safe — they are shown only now.
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={copyBackupCodes}
                  disabled={!pending.backupCodes.length}
                >
                  {copied ? (
                    <Check className="mr-2 h-4 w-4" aria-hidden="true" />
                  ) : (
                    <Copy className="mr-2 h-4 w-4" aria-hidden="true" />
                  )}
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              </div>
              <ul className="grid grid-cols-2 gap-1 rounded bg-muted p-3 font-mono text-xs">
                {pending.backupCodes.map((backupCode) => (
                  <li key={backupCode}>{backupCode}</li>
                ))}
              </ul>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}