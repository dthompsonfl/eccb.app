'use client';

import * as React from 'react';
import { BookOpen, CalendarDays, CircleHelp, Hand, Music4 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';
import {
  ONBOARDING_STEPS,
  hasSeenOnboarding,
  markOnboardingSeen,
  type OnboardingStep,
} from '@/lib/accessibility/onboarding';

const STEP_ICONS: Record<OnboardingStep['icon'], React.ComponentType<{ className?: string }>> = {
  welcome: Hand,
  menu: CircleHelp,
  music: Music4,
  schedule: CalendarDays,
  help: BookOpen,
};

export interface OnboardingWalkthroughProps {
  /** Controlled visibility. Omit to let the walkthrough run itself. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Start at step 1 even if the visitor has seen the tour before. */
  force?: boolean;
}

/**
 * The first-run walkthrough, and the same dialog behind the persistent
 * "Show me how" button.
 *
 * Escape dismisses (Radix handles it), the dialog traps focus, and every step
 * announces itself through `DialogTitle` / `DialogDescription` so a screen
 * reader reads the step out rather than just "dialog". Buttons are in DOM order
 * Skip → Previous → Next so Tab runs left-to-right through the footer.
 */
export function OnboardingWalkthrough({
  open,
  onOpenChange,
  force = false,
}: OnboardingWalkthroughProps): React.ReactElement | null {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(false);
  const [checked, setChecked] = React.useState(false);
  const [stepIndex, setStepIndex] = React.useState(0);

  const isControlled = open !== undefined;
  const isOpen = isControlled ? open : uncontrolledOpen;

  // Decide whether to auto-show the tour, but only after mount: reading
  // localStorage during render would break hydration.
  React.useEffect(() => {
    if (isControlled) return;
    const shouldShow = force || !hasSeenOnboarding(window.localStorage);
    setChecked(true);
    if (shouldShow) {
      setStepIndex(0);
      setUncontrolledOpen(true);
    }
  }, [isControlled, force]);

  const setOpen = React.useCallback(
    (next: boolean) => {
      if (!next) {
        markOnboardingSeen(window.localStorage);
      }
      setStepIndex(0);
      if (isControlled) {
        onOpenChange?.(next);
      } else {
        setUncontrolledOpen(next);
      }
    },
    [isControlled, onOpenChange],
  );

  if (!checked && !isControlled) return null;

  const step = ONBOARDING_STEPS[stepIndex];
  const total = ONBOARDING_STEPS.length;
  const isFirst = stepIndex === 0;
  const isLast = stepIndex === total - 1;
  const Icon = STEP_ICONS[step.icon];

  return (
    <Dialog open={isOpen} onOpenChange={setOpen}>
      <DialogContent
        showCloseButton={false}
        className="sm:max-w-lg"
        aria-labelledby="onboarding-title"
      >
        <div className="space-y-6">
          <div className="flex items-start gap-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-primary/10">
              <Icon className="h-6 w-6 text-primary" aria-hidden="true" />
            </div>
            <div className="space-y-2">
              <DialogTitle id="onboarding-title" className="text-xl">
                {step.title}
              </DialogTitle>
              <DialogDescription className="text-base leading-relaxed">
                {step.body}
              </DialogDescription>
              <p className="text-sm font-medium text-primary">{step.where}</p>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>
                Step {stepIndex + 1} of {total}
              </span>
            </div>
            <Progress
              value={((stepIndex + 1) / total) * 100}
              aria-label={`Step ${stepIndex + 1} of ${total}`}
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Skip this
            </Button>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                onClick={() => setStepIndex((i) => Math.max(0, i - 1))}
                disabled={isFirst}
              >
                Back
              </Button>
              {isLast ? (
                <Button onClick={() => setOpen(false)}>Got it — let me try</Button>
              ) : (
                <Button onClick={() => setStepIndex((i) => Math.min(total - 1, i + 1))}>
                  Next
                </Button>
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}