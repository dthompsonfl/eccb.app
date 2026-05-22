'use client';

/**
 * Progress Indicator Component
 *
 * Displays the current setup progress with steps and percentage.
 */

import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';

interface Step {
  id: string;
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  message?: string;
}

interface ProgressIndicatorProps {
  currentStep: number;
  totalSteps: number;
  steps: Step[];
  progress: number;
  className?: string;
}

const stepIcons: Record<string, string> = {
  pending: '○',
  running: '◐',
  completed: '●',
  failed: '✕',
};

export function ProgressIndicator({
  currentStep,
  totalSteps: _totalSteps,
  steps,
  progress,
  className,
}: ProgressIndicatorProps): React.ReactElement {
  return (
    <div className={cn('space-y-6', className)}>
      {/* Progress Bar */}
      <div className="space-y-2">
        <div className="flex items-center justify-between text-sm">
          <span className="text-slate-400">Progress</span>
          <span className="font-medium text-primary-light">{progress}%</span>
        </div>
        <Progress value={progress} className="h-2 bg-slate-700" />
      </div>

      {/* Steps */}
      <div className="space-y-3">
        {steps.map((step, index) => {
          const isActive = index === currentStep;
          const isCompleted = step.status === 'completed';
          const isFailed = step.status === 'failed';

          return (
            <div
              key={step.id}
              className={cn(
                'flex items-center gap-3 rounded-lg p-3 transition-all',
                isActive && 'bg-primary/10 border border-primary/30',
                isCompleted && 'bg-green-500/10',
                isFailed && 'bg-red-500/10',
                !isActive && !isCompleted && !isFailed && 'bg-slate-800/50',
              )}
            >
              {/* Step Icon */}
              <span
                className={cn(
                  'flex h-6 w-6 items-center justify-center rounded-full text-sm font-medium',
                  isCompleted && 'bg-green-500 text-white',
                  isFailed && 'bg-red-500 text-white',
                  step.status === 'running' && 'bg-primary text-white animate-pulse',
                  !isCompleted && !isFailed && step.status !== 'running' && 'bg-slate-600 text-slate-300',
                )}
              >
                {stepIcons[step.status]}
              </span>

              {/* Step Name */}
              <span
                className={cn(
                  'flex-1 text-sm',
                  isActive && 'text-white font-medium',
                  isCompleted && 'text-green-400',
                  isFailed && 'text-red-400',
                  !isActive && !isCompleted && !isFailed && 'text-slate-400',
                )}
              >
                {step.name}
              </span>

              {/* Step Status */}
              {step.status === 'running' && (
                <span className="text-xs text-primary animate-pulse">Working...</span>
              )}
              {step.message && step.status !== 'running' && (
                <span className="text-xs text-slate-500">{step.message}</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
