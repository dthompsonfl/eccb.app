import React, { Suspense } from 'react';
import Image from 'next/image';
import { redirect } from 'next/navigation';
import heroBg from '@/assets/hero_bg.jpg';
import Link from 'next/link';
import { Logo } from '@/components/icons/logo';
import { ChevronLeft } from 'lucide-react';
import { LoginForm } from '@/components/auth/login-form';
import { Button } from '@/components/ui/button';
import { getSetupState } from '@/lib/setup/state';
import { HelpControl } from '@/components/accessibility/help-control';
import { TextSizeControl } from '@/components/accessibility/text-size-control';

export const metadata = {
  title: 'Sign In',
  description: 'Sign in to see your music, your schedule, and your band details',
};

export default async function LoginPage() {
  // Guard: if system is not ready redirect to setup wizard
  const setupState = await getSetupState().catch(() => null);
  if (setupState && !setupState.readyForLogin) {
    redirect('/setup');
  }

  return (
    <div className="relative flex min-h-screen">
      {/* Left side: Dramatic Entry */}
      <div className="relative hidden w-1/2 overflow-hidden bg-[#0f172a] lg:block">
        <Image
          src={heroBg}
          alt="Emerald Coast"
          fill
          placeholder="blur"
          sizes="50vw"
          className="object-cover opacity-50"
          priority
        />
        <div className="absolute inset-0 bg-gradient-to-r from-primary/20 to-transparent" />
        
        <div className="absolute inset-0 flex flex-col justify-between p-12 text-white">
          <Link href="/" className="flex items-center gap-3 p-1.5" aria-label="Emerald Coast Community Band">
            <Logo className="h-10 w-auto text-white" />
            <span className="sr-only">Emerald Coast Community Band</span>
          </Link>
          
          <div>
            <h1 className="mb-6 font-display text-6xl font-black leading-tight">
              WELCOME <br /> <span className="text-primary italic">BACK</span>
            </h1>
            <p className="max-w-md text-lg text-gray-300">
              Find your music, check when we rehearse, and keep your details up
              to date — all in one place.
            </p>
          </div>
          
          <div className="text-sm text-gray-400">
            &copy; {new Date().getFullYear()} Emerald Coast Community Band
          </div>
        </div>
      </div>

      {/* Right side: Auth Form */}
      <div className="flex w-full flex-col items-center justify-center bg-background px-6 lg:w-1/2">
        {/* Comfort controls before signing in: someone who struggles to read the
            form should be able to enlarge the text without an account. */}
        <div className="absolute top-4 right-4 flex items-center gap-1">
          <HelpControl />
          <TextSizeControl />
        </div>
        <div className="w-full max-w-md space-y-8">
          <div className="flex flex-col items-center lg:items-start">
            <Button
              variant="ghost"
              asChild
              className="mb-8 -ml-4 text-muted-foreground hover:text-primary lg:flex hidden"
            >
              <Link href="/">
                <ChevronLeft className="mr-2 h-4 w-4" /> Back to the main website
              </Link>
            </Button>
            
            <div className="mb-8 flex flex-col items-center lg:hidden">
              <Logo className="mb-4 h-16 w-auto text-primary" />
              <h2 className="sr-only">Emerald Coast Community Band</h2>
            </div>
            
            <h3 className="font-display text-4xl font-black text-foreground uppercase tracking-tight">
              Sign in
            </h3>
            <p className="mt-2 text-muted-foreground">
              New to the band?{' '}
              <Link href="/signup" className="font-medium text-primary hover:underline">
                Create an account
              </Link>
            </p>
          </div>

          <div className="glass-morphism rounded-3xl border border-border/50 p-8 shadow-sm">
            <Suspense fallback={<div className="flex justify-center p-8">One moment...</div>}>
              <LoginForm />
            </Suspense>
          </div>
          
          <p className="px-8 text-center text-sm text-muted-foreground">
            By signing in, you agree to our{' '}
            <Link href="/terms" className="underline underline-offset-4 hover:text-primary">
              Terms of Service
            </Link>{' '}
            and{' '}
            <Link href="/privacy" className="underline underline-offset-4 hover:text-primary">
              Privacy Policy
            </Link>
            .
          </p>
        </div>
      </div>
    </div>
  );
}
