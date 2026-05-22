'use client';

/**
 * Setup Wizard Component
 *
 * Main multi-step wizard that orchestrates the setup flow:
 * Welcome -> Database Config -> Environment -> Progress -> Completion
 */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import { ArrowLeft, ArrowRight, CheckCircle2, Database, Settings, Sparkles } from 'lucide-react';
import { SetupPhase } from '@/lib/setup/types';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { DatabaseConfigForm, type DatabaseConfig } from '@/components/setup/database-config-form';
import { ProgressIndicator } from '@/components/setup/progress-indicator';
import { StatusDisplay } from '@/components/setup/status-display';
import { cn } from '@/lib/utils';

type SetupStep = 'welcome' | 'database' | 'environment' | 'progress' | 'complete';

interface SetupStepData {
  id: SetupStep;
  name: string;
  description: string;
}

interface SetupWizardProps {
  repairMode?: boolean;
}

interface SetupStatus {
  phase: SetupPhase;
  progress: number;
  message: string;
}

const steps: SetupStepData[] = [
  { id: 'welcome', name: 'Welcome', description: 'Get started with setup' },
  { id: 'database', name: 'Database', description: 'Configure your database' },
  { id: 'environment', name: 'Environment', description: 'Set up environment' },
  { id: 'progress', name: 'Progress', description: 'Running setup tasks' },
  { id: 'complete', name: 'Complete', description: 'Setup finished' },
];

export function SetupWizard({ repairMode = false }: SetupWizardProps): React.ReactElement {
  const router = useRouter();
  const [currentStep, setCurrentStep] = useState<SetupStep>('welcome');
  const [isLoading, setIsLoading] = useState(false);
  const [setupStatus, setSetupStatus] = useState<SetupStatus | null>(null);
  const [setupToken, setSetupToken] = useState<string>(() => {
    if (typeof window !== 'undefined') {
      return window.localStorage.getItem('setupToken') ?? '';
    }
    return '';
  });
  const [error, setError] = useState<string | null>(null);
  const [requiresSetupToken, setRequiresSetupToken] = useState(false);
  const [countdown, setCountdown] = useState(3);
  const [redirecting, setRedirecting] = useState(false);

  // Persist the setup token to localStorage so it survives refreshes
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (setupToken) {
      window.localStorage.setItem('setupToken', setupToken);
    } else {
      window.localStorage.removeItem('setupToken');
    }
  }, [setupToken]);

  const stepIndex = steps.findIndex((s) => s.id === currentStep);
  const _progress = Math.round(((stepIndex + 1) / steps.length) * 100);

  // Resolve headers for setup requests (includes token if configured)
  const getSetupHeaders = useCallback((): Record<string, string> => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    const token = setupToken.trim();
    if (token) {
      headers['x-setup-token'] = token;
    }

    return headers;
  }, [setupToken]);

  // Fetch initial status on mount
  useEffect(() => {
    async function fetchStatus() {
      try {
        const response = await fetch('/api/setup/status', {
          headers: getSetupHeaders(),
        });

        // If a setup token is required and missing/invalid, prompt the user.
        if (response.status === 401 || response.status === 403) {
          setRequiresSetupToken(true);
          setError('Setup token required. Enter the token and try again.');
          return;
        }

        const data = await response.json();
        setSetupStatus(data);
        setRequiresSetupToken(false);

        // If already completed, skip to complete
        if (data.phase === 'complete') {
          setCurrentStep('complete');
        }
      } catch {
        // Ignore - will be handled in form submission
      }
    }

    // Only query status when we have a token (if required)
    if (!requiresSetupToken || setupToken) {
      fetchStatus();
    }
  }, [getSetupHeaders, requiresSetupToken, setupToken]);

  const handleDatabaseSubmit = async (config: DatabaseConfig): Promise<void> => {
    setIsLoading(true);
    setError(null);

    try {
      // Test database connection
      // sanitize port: if user cleared the field it may be NaN which JSON
      // serializes to null and zod will reject. Remove the property in that
      // case and let the server default via env.
      const payloadConfig: any = {
        host: config.host,
        database: config.database,
        username: config.username,
        password: config.password,
      };
      if (!Number.isNaN(config.port)) {
        payloadConfig.port = config.port;
      }

      const response = await fetch('/api/setup', {
        method: 'POST',
        headers: getSetupHeaders(),
        body: JSON.stringify({
          action: 'init',
          config: payloadConfig,
        }),
      });

      // If token is required and missing/invalid, show an error
      if (response.status === 401 || response.status === 403) {
        throw new Error('Invalid setup token. Please enter the correct token.');
      }

      const data = await response.json();

      if (!data.success) {
        throw new Error(data.error || 'Failed to connect to database');
      }

      setCurrentStep('environment');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection failed');
      throw err;
    } finally {
      setIsLoading(false);
    }
  };

  const handleEnvironmentSetup = async (): Promise<void> => {
    setIsLoading(true);
    setError(null);
    setCurrentStep('progress');

    try {
      // Start the setup process
      const response = await fetch('/api/setup', {
        method: 'POST',
        headers: getSetupHeaders(),
        body: JSON.stringify({ action: 'full' }),
      });

      if (response.status === 401 || response.status === 403) {
        throw new Error('Invalid setup token. Please enter the correct token.');
      }

      const data = await response.json();

      if (!data.success) {
        throw new Error(data.error || 'Setup failed');
      }

      // Wait a moment for the database and cache to settle, then verify setup is complete.
      await new Promise((resolve) => setTimeout(resolve, 500));

      const verifyResponse = await fetch('/api/setup/verify', {
        headers: getSetupHeaders(),
      });

      const verifyData = await verifyResponse.json();

      if (!verifyData.success) {
        throw new Error(verifyData.error || 'Setup verification failed');
      }

      setCurrentStep('complete');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Setup failed');
      setCurrentStep('database');
    } finally {
      setIsLoading(false);
    }
  };

  const handleRetry = (): void => {
    setError(null);
    if (currentStep === 'database') {
      setCurrentStep('welcome');
    } else if (currentStep === 'progress') {
      handleEnvironmentSetup();
    }
  };

  const goToNextStep = (): void => {
    if (currentStep === 'welcome') {
      setCurrentStep('database');
    } else if (currentStep === 'database') {
      setCurrentStep('environment');
    } else if (currentStep === 'environment') {
      handleEnvironmentSetup();
    }
  };

  const renderSetupTokenInput = (): React.ReactElement => (
    <div className="mt-6 rounded-lg border border-slate-700 bg-slate-900 p-4">
      <p className="text-sm font-medium text-white">Setup Token (required when enabled)</p>
      <p className="text-xs text-slate-400 mb-2">
        Enter the secret setup token from your <code>.env</code> (SETUP_TOKEN). This will be sent
        with all setup API requests.
      </p>
      <input
        value={setupToken}
        onChange={(e) => {
          setError(null);
          const trimmed = e.target.value.trim();
          setSetupToken(trimmed);
        }}
        placeholder="Enter setup token"
        className="w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-white"
      />
    </div>
  );

  const goToPrevStep = (): void => {
    if (currentStep === 'database') {
      setCurrentStep('welcome');
    } else if (currentStep === 'environment') {
      setCurrentStep('database');
    } else if (currentStep === 'progress') {
      setCurrentStep('environment');
    }
  };

  // When setup finishes, auto-redirect to login after a short countdown
  useEffect(() => {
    if (currentStep !== 'complete' || redirecting) return;

    setCountdown(3);
    const interval = setInterval(() => setCountdown((prev) => Math.max(0, prev - 1)), 1000);
    const timeout = setTimeout(() => {
      setRedirecting(true);
      router.replace('/login');
    }, 3000);

    return () => {
      clearInterval(interval);
      clearTimeout(timeout);
    };
  }, [currentStep, redirecting, router]);

  const renderWelcomeStep = (): React.ReactElement => (
    <Card className="border-slate-700 bg-slate-800/50">
      <CardContent className="pt-6">
        <div className="text-center space-y-4">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-primary/20">
            <Sparkles className="h-8 w-8 text-primary-light" />
          </div>
          <h2 className="text-2xl font-bold text-white">
            {repairMode ? 'Repair Your Setup' : 'Welcome to Setup'}
          </h2>
          <p className="text-slate-400 max-w-md mx-auto">
            {repairMode
              ? "We'll diagnose and fix any issues with your database connection and configuration."
              : 'This wizard will guide you through setting up your database and getting everything running.'}
          </p>

          {renderSetupTokenInput()}

          <div className="pt-4">
            <Button
              onClick={goToNextStep}
              className="bg-primary hover:bg-primary/90 text-white gap-2"
            >
              Get Started <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );

  const renderDatabaseStep = (): React.ReactElement => (
    <div className="space-y-4">
      {renderSetupTokenInput()}
      {error && (
        <StatusDisplay
          type="error"
          title="Connection Failed"
          message={error}
          action={{
            label: 'Start over',
            onClick: handleRetry,
          }}
        />
      )}
      <DatabaseConfigForm
        onSubmit={handleDatabaseSubmit}
        isLoading={isLoading}
        disableSubmit={requiresSetupToken && !setupToken.trim()}
      />
    </div>
  );

  const renderEnvironmentStep = (): React.ReactElement => (
    <Card className="border-slate-700 bg-slate-800/50">
      <CardContent className="pt-6">
        <div className="text-center space-y-4">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-primary/20">
            <Settings className="h-8 w-8 text-primary-light" />
          </div>
          <h2 className="text-2xl font-bold text-white">Environment Ready</h2>
          <p className="text-slate-400 max-w-md mx-auto">
            Your database is connected. Click continue to run the setup tasks and seed your
            database with initial data.
          </p>

          {error && (
            <StatusDisplay type="error" title="Setup Error" message={error} className="mt-4" />
          )}

          {renderSetupTokenInput()}

          <div className="pt-4 flex gap-3 justify-center">
            <Button
              variant="outline"
              onClick={goToPrevStep}
              disabled={isLoading}
              className="border-slate-600 text-slate-300 hover:bg-slate-700"
            >
              <ArrowLeft className="h-4 w-4 mr-2" /> Back
            </Button>
            <Button
              onClick={handleEnvironmentSetup}
              disabled={isLoading}
              className="bg-primary hover:bg-primary/90 text-white gap-2"
            >
              {isLoading ? (
                <>Setting up...</>
              ) : (
                <>Continue <ArrowRight className="h-4 w-4" /></>
              )}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );

  const renderProgressStep = (): React.ReactElement => (
    <Card className="border-slate-700 bg-slate-800/50">
      <CardContent className="pt-6">
        <StatusDisplay
          type="loading"
          title="Setting up your application..."
          message="This may take a few minutes. Please don't close this page."
          className="mb-6"
        />

        <ProgressIndicator
          currentStep={3}
          totalSteps={5}
          progress={setupStatus?.progress || 50}
          steps={[
            { id: '1', name: 'Checking database connection', status: 'completed', message: 'Connected' },
            { id: '2', name: 'Configuring environment', status: 'completed', message: 'Complete' },
            { id: '3', name: 'Running migrations', status: 'running', message: 'In progress...' },
            { id: '4', name: 'Seeding database', status: 'pending' },
            { id: '5', name: 'Verifying setup', status: 'pending' },
          ]}
        />
      </CardContent>
    </Card>
  );

  const renderCompleteStep = (countdown: number): React.ReactElement => (
    <Card className="border-slate-700 bg-slate-800/50">
      <CardContent className="pt-6">
        <div className="text-center space-y-4">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-green-500/20">
            <CheckCircle2 className="h-8 w-8 text-green-500" />
          </div>
          <h2 className="text-2xl font-bold text-white">Setup Complete!</h2>
          <p className="text-slate-400 max-w-md mx-auto">
            Your database has been set up successfully. You can now sign in and manage your band
            content.
          </p>
          <p className="text-sm text-slate-500">
            Redirecting to login in {countdown} second{countdown !== 1 ? 's' : ''}...
          </p>
          <div className="pt-4">
            <Button
              onClick={() => {
                window.location.href = '/login';
              }}
              className="bg-primary hover:bg-primary/90 text-white gap-2"
            >
              Sign In Now <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );

  const renderStep = (): React.ReactElement => {
    switch (currentStep) {
      case 'welcome':
        return renderWelcomeStep();
      case 'database':
        return renderDatabaseStep();
      case 'environment':
        return renderEnvironmentStep();
      case 'progress':
        return renderProgressStep();
      case 'complete':
        return renderCompleteStep(countdown);
      default:
        return <div>Unknown step</div>;
    }
  };

  return (
    <div className="space-y-8">
      {/* Progress indicator for non-welcome steps */}
      {currentStep !== 'welcome' && currentStep !== 'complete' && (
        <div className="flex items-center justify-center gap-2">
          {steps.slice(0, -1).map((step, index) => (
            <div key={step.id} className="flex items-center">
              <button
                type="button"
                onClick={() => setCurrentStep(step.id)}
                disabled={index > stepIndex}
                className={cn(
                  'flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors',
                  index === stepIndex && 'bg-primary/20 text-primary-light',
                  index < stepIndex && 'text-green-400 hover:text-green-300',
                  index > stepIndex && 'text-slate-500 cursor-not-allowed',
                )}
              >
                {index < stepIndex ? (
                  <CheckCircle2 className="h-4 w-4" />
                ) : (
                  <Database className="h-4 w-4" />
                )}
                {step.name}
              </button>
              {index < steps.length - 2 && <span className="text-slate-600">/</span>}
            </div>
          ))}
        </div>
      )}

      {/* Current step content */}
      <div
        key={currentStep}
        className="animate-in fade-in slide-in-from-bottom-4 duration-500"
      >
        {renderStep()}
      </div>
    </div>
  );
}
