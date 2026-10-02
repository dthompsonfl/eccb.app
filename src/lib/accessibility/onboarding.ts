/**
 * Guided mode — first-run walkthrough.
 *
 * A dependency-free, five-step tour of the member portal. Each step names one
 * thing the member can actually *do*, in plain words. No tour library: the whole
 * thing is a dialog with a step index, and a tour engine would cost more bundle
 * than the feature is worth.
 */

export const ONBOARDING_STORAGE_KEY = 'eccb:onboarding-seen';
export const ONBOARDING_VERSION = 1;

export interface OnboardingStep {
  /** Short heading, sentence case, no jargon. */
  readonly title: string;
  /** One or two short sentences. Read aloud well. */
  readonly body: string;
  /** Icon name from `lucide-react`, resolved by the component. */
  readonly icon: 'welcome' | 'menu' | 'music' | 'schedule' | 'help';
  /** Where to point the member, in their words. */
  readonly where: string;
}

export const ONBOARDING_STEPS: readonly OnboardingStep[] = [
  {
    title: 'Welcome to your band page',
    body:
      'This is where you find your music, your rehearsal dates, and your own details. ' +
      'You can close this box at any time — nothing here is required to use the site.',
    icon: 'welcome',
    where: 'You are signed in.',
  },
  {
    title: 'Everything lives in the menu on the left',
    body:
      'The dark menu on the left has a page for each thing you might need. ' +
      'On a small screen, tap the menu button in the top-left corner instead.',
    icon: 'menu',
    where: 'Look for the menu down the left-hand side.',
  },
  {
    title: 'Your music is in "My Music"',
    body:
      'This shows the music the librarian has given you. Tap any piece to open it, ' +
      'and you can zoom in so the notes are big enough to read from your chair.',
    icon: 'music',
    where: 'Find "My Music" in the menu.',
  },
  {
    title: 'Dates, times, and who is playing',
    body:
      '"Calendar" lists every rehearsal and concert. When you see a date you cannot make, ' +
      'open it and tell us — it only takes one tap and it helps us plan.',
    icon: 'schedule',
    where: 'Find "Calendar" in the menu.',
  },
  {
    title: 'Two buttons worth remembering',
    body:
      '"Show me how" brings this tour back any time you like. ' +
      'The "A" with arrows beside it makes the words on the whole site bigger or smaller. ' +
      'That is everything — you are ready.',
    icon: 'help',
    where: 'Both are at the top right of the page.',
  },
] as const;

/** Has this visitor already seen the current version of the tour? */
export function hasSeenOnboarding(
  storage?: Pick<Storage, 'getItem'> | null,
  version: number = ONBOARDING_VERSION,
): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(ONBOARDING_STORAGE_KEY) === String(version);
  } catch {
    // Storage blocked: show the tour rather than silently skipping it.
    return false;
  }
}

/** Record that the tour has been seen (or explicitly skipped). */
export function markOnboardingSeen(
  storage?: Pick<Storage, 'setItem'> | null,
  version: number = ONBOARDING_VERSION,
): void {
  if (!storage) return;
  try {
    storage.setItem(ONBOARDING_STORAGE_KEY, String(version));
  } catch {
    /* Nothing to do; the tour simply shows again next visit. */
  }
}