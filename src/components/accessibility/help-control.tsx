'use client';

import * as React from 'react';
import { LifeBuoy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { OnboardingWalkthrough } from '@/components/accessibility/onboarding-walkthrough';

export interface HelpControlProps {
  /** Render as a compact icon-only button (used in the member header). */
  compact?: boolean;
}

/**
 * The persistent "Show me how" affordance.
 *
 * The tour shows itself once, then this button is how anybody gets it back —
 * which is the whole point: someone who dismissed the walkthrough, or who simply
 * forgot it existed, must never be more than one click from the help.
 */
export function HelpControl({ compact = false }: HelpControlProps): React.ReactElement {
  const [open, setOpen] = React.useState(false);

  return (
    <>
      <Button
        variant="ghost"
        size={compact ? 'icon' : 'default'}
        onClick={() => setOpen(true)}
        aria-label="Show me how this site works"
        className={compact ? undefined : 'gap-2'}
      >
        <LifeBuoy className="h-5 w-5" aria-hidden="true" />
        {compact ? null : <span>Show me how</span>}
      </Button>
      <OnboardingWalkthrough open={open} onOpenChange={setOpen} />
    </>
  );
}