'use client';

import React, { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { authClient } from '@/lib/auth/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { Loader2, Mail, Lock, ShieldCheck } from 'lucide-react';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp';
import { requiresTwoFactorChallenge } from '@/lib/auth/two-factor-client';

// Check if Google OAuth is enabled via environment variable
const isGoogleAuthEnabled = process.env.NEXT_PUBLIC_GOOGLE_AUTH_ENABLED === 'true';

export function LoginForm() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  // When Better Auth reports `twoFactorRedirect`, the password was correct but
  // the session was deliberately NOT created. The user must now clear the
  // second factor before a session exists.
  const [needsTwoFactor, setNeedsTwoFactor] = useState(false);
  const [twoFactorCode, setTwoFactorCode] = useState('');
  const [useBackupCode, setUseBackupCode] = useState(false);
  const [trustDevice, setTrustDevice] = useState(false);
  const router = useRouter();
  const searchParams = useSearchParams();
  const rawCallbackUrl = searchParams.get('callbackUrl') || '/';

  // Security enhancement: Prevent Open Redirect attacks by ensuring
  // the callback URL is a relative path to our own origin
  const callbackUrl = rawCallbackUrl.startsWith('/') && !rawCallbackUrl.startsWith('//')
    ? rawCallbackUrl
    : '/';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    const { data, error } = await authClient.signIn.email({
      email,
      password,
      callbackURL: callbackUrl,
    });

    if (error) {
      toast.error('That did not work. Check your email and password, then try again.');
      setLoading(false);
      return;
    }

    // Password accepted but a second factor is required. Better Auth has
    // already deleted the provisional session and set a short-lived
    // httpOnly `two_factor` cookie; nothing is authenticated yet.
    if (requiresTwoFactorChallenge(data)) {
      setNeedsTwoFactor(true);
      setLoading(false);
      return;
    }

    toast.success('Signed in successfully');
    router.push(callbackUrl);
    router.refresh();
  };

  const handleTwoFactorSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = twoFactorCode.trim();

    if (useBackupCode ? !value : value.length !== 6) {
      toast.error(
        useBackupCode
          ? 'Please enter one of your backup codes'
          : 'Please enter the 6-digit code',
      );
      return;
    }

    setLoading(true);
    try {
      const { error } = useBackupCode
        ? await authClient.twoFactor.verifyBackupCode({ code: value, trustDevice })
        : await authClient.twoFactor.verifyTotp({ code: value, trustDevice });

      if (error) {
        toast.error('That code was not right. Please try again.');
        setTwoFactorCode('');
        setLoading(false);
        return;
      }

      toast.success('Signed in successfully');
      // A full reload so the server re-reads the newly established session.
      window.location.href = callbackUrl;
    } catch {
      toast.error('That code was not right. Please try again.');
      setTwoFactorCode('');
      setLoading(false);
    }
  };

  const cancelTwoFactor = () => {
    setNeedsTwoFactor(false);
    setTwoFactorCode('');
    setUseBackupCode(false);
    setLoading(false);
  };

  const handleGoogleSignIn = async () => {
    setGoogleLoading(true);
    
    try {
      const { error } = await authClient.signIn.social({
        provider: 'google',
        callbackURL: callbackUrl,
      });

      if (error) {
        // Turn technical failures into something a member can act on.
        if (error.message?.includes('Failed to fetch') || error.message?.includes('NetworkError')) {
          toast.error('We could not reach the sign-in service. Please check your internet connection and try again.');
        } else if (error.message?.includes('Provider not found')) {
          toast.error('Signing in with Google is not set up. Please ask the band office for help, or sign in with your email and password.');
        } else {
          toast.error(error.message || 'We could not sign you in with Google');
        }
        setGoogleLoading(false);
      }
      // If no error, the redirect will happen automatically
    } catch (err) {
      // Catch any unexpected errors (like TypeError from fetch failures)
      if (err instanceof TypeError && err.message.includes('fetch')) {
        toast.error('Unable to connect to authentication service. Please check your internet connection and try again.');
      } else {
        toast.error('An unexpected error occurred. Please try again.');
      }
      setGoogleLoading(false);
    }
  };

  if (needsTwoFactor) {
    return (
      <form onSubmit={handleTwoFactorSubmit} className="space-y-6">
        <div className="space-y-2 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
            <ShieldCheck className="h-6 w-6 text-primary" aria-hidden="true" />
          </div>
          <h3 className="text-lg font-semibold">One more step to keep your account safe</h3>
          <p className="text-sm text-muted-foreground">
            {useBackupCode
              ? 'Enter one of the spare codes you saved when you set this up.'
              : `Open the app you use for codes and enter the 6-digit code it shows for ${email}.`}
          </p>
        </div>

        {useBackupCode ? (
          <div className="space-y-2">
            <Label htmlFor="backup-code">Spare code</Label>
            <Input
              id="backup-code"
              name="backup-code"
              value={twoFactorCode}
              onChange={(e) => setTwoFactorCode(e.target.value)}
              autoComplete="one-time-code"
              placeholder="XXXXX-XXXXX"
              className="text-center font-mono"
              required
            />
          </div>
        ) : (
          <div className="flex justify-center py-2">
            <InputOTP
              maxLength={6}
              value={twoFactorCode}
              onChange={setTwoFactorCode}
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
        )}

        <div className="flex items-center gap-2 text-sm">
          <input
            id="trust-device"
            type="checkbox"
            checked={trustDevice}
            onChange={(e) => setTrustDevice(e.target.checked)}
            className="h-4 w-4 rounded border-input"
          />
          <Label htmlFor="trust-device" className="font-normal">
            Don't ask me for this code again on this computer for 30 days
          </Label>
        </div>

        <Button
          type="submit"
          className="w-full bg-primary hover:bg-primary/90"
          disabled={loading}
        >
          {loading ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Checking...
            </>
          ) : (
            'Verify'
          )}
        </Button>

        <div className="flex justify-between text-sm">
          <button
            type="button"
            onClick={() => setUseBackupCode((v) => !v)}
            className="font-medium text-primary hover:underline"
          >
            {useBackupCode ? 'Use the code from my app' : 'Use a spare code instead'}
          </button>
          <button
            type="button"
            onClick={cancelTwoFactor}
            className="text-muted-foreground hover:underline"
          >
            Cancel
          </button>
        </div>
      </form>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="space-y-2">
        <Label htmlFor="email">Your email address</Label>
        <div className="relative">
          <Mail className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
          <Input
            id="email"
            name="email"
            type="email"
            placeholder="name@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="pl-10"
            required
          />
        </div>
      </div>
      
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="password">Password</Label>
          <Button variant="link" className="h-auto p-0 text-xs text-primary" asChild>
            <a href="/forgot-password">I forgot my password</a>
          </Button>
        </div>
        <div className="relative">
          <Lock className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
          <Input
            id="password"
            name="password"
            type="password"
            placeholder="••••••••"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="pl-10"
            required
          />
        </div>
      </div>

      <Button
        type="submit"
        className="w-full bg-primary hover:bg-primary/90"
        disabled={loading}
      >
        {loading ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Signing you in...
          </>
        ) : (
          'Sign in'
        )}
      </Button>

      {isGoogleAuthEnabled && (
        <>
          <div className="relative my-4">
            <div className="absolute inset-0 flex items-center">
              <span className="w-full border-t" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-background px-2 text-muted-foreground">
                Or sign in with
              </span>
            </div>
          </div>

          <Button
            type="button"
            variant="outline"
            className="w-full"
            onClick={handleGoogleSignIn}
            disabled={googleLoading}
          >
            {googleLoading ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <svg className="mr-2 h-4 w-4" viewBox="0 0 24 24">
                <path
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                  fill="#4285F4"
                />
                <path
                  d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                  fill="#34A853"
                />
                <path
                  d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"
                  fill="#FBBC05"
                />
                <path
                  d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                  fill="#EA4335"
                />
              </svg>
            )}
            Google
          </Button>
        </>
      )}
    </form>
  );
}
