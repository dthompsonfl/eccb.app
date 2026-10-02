import { describe, it, expect } from 'vitest';
import {
  ONBOARDING_STEPS,
  ONBOARDING_STORAGE_KEY,
  ONBOARDING_VERSION,
  hasSeenOnboarding,
  markOnboardingSeen,
} from './onboarding';

/** Minimal in-memory Storage stand-in. */
function createStorage(initial?: Record<string, string>) {
  const data = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    snapshot: data,
  };
}

describe('onboarding steps', () => {
  it('has roughly five steps — long enough to orient, short enough to sit through', () => {
    expect(ONBOARDING_STEPS.length).toBeGreaterThanOrEqual(4);
    expect(ONBOARDING_STEPS.length).toBeLessThanOrEqual(6);
  });

  it('gives every step a title and a body', () => {
    for (const step of ONBOARDING_STEPS) {
      expect(step.title.trim().length).toBeGreaterThan(0);
      expect(step.body.trim().length).toBeGreaterThan(0);
      expect(step.where.trim().length).toBeGreaterThan(0);
    }
  });

  it('uses sentences short enough to be read comfortably', () => {
    for (const step of ONBOARDING_STEPS) {
      for (const sentence of step.body.split('. ')) {
        // ~20 words is a comfortable single-breath line for a large-print UI.
        expect(sentence.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(24);
      }
    }
  });

  it('avoids the jargon this feature exists to remove', () => {
    const jargon = [
      'authenticate',
      'authentication',
      'session',
      'credentials',
      'RSVP',
      'repertoire',
      'instruments assigned',
      'dashboard',
    ];
    const copy = ONBOARDING_STEPS.map((s) => `${s.title} ${s.body} ${s.where}`).join(' ');
    for (const word of jargon) {
      expect(copy.toLowerCase()).not.toContain(word.toLowerCase());
    }
  });
});

describe('hasSeenOnboarding', () => {
  it('is false for a first-time visitor', () => {
    expect(hasSeenOnboarding(createStorage())).toBe(false);
  });

  it('is true once the tour has been seen', () => {
    const storage = createStorage();
    markOnboardingSeen(storage);
    expect(hasSeenOnboarding(storage)).toBe(true);
  });

  it('is false when there is no storage at all', () => {
    expect(hasSeenOnboarding(null)).toBe(false);
  });

  it('is false when storage throws, so the help is still offered', () => {
    const hostile = {
      getItem: () => {
        throw new Error('SecurityError');
      },
    };
    expect(hasSeenOnboarding(hostile)).toBe(false);
  });

  it('shows the tour again after the copy changes', () => {
    const storage = createStorage();
    markOnboardingSeen(storage);

    // The stored version is the old one.
    expect(hasSeenOnboarding(storage, ONBOARDING_VERSION + 1)).toBe(false);
  });

  it('re-shows when the stored value is not a number', () => {
    expect(hasSeenOnboarding(createStorage({ [ONBOARDING_STORAGE_KEY]: 'yes' }))).toBe(false);
  });
});

describe('markOnboardingSeen', () => {
  it('persists the current version under the namespaced key', () => {
    const storage = createStorage();
    markOnboardingSeen(storage);
    expect(storage.getItem(ONBOARDING_STORAGE_KEY)).toBe(String(ONBOARDING_VERSION));
  });

  it('records the tour as seen whether it was finished or skipped', () => {
    // Skipping calls the same function as finishing: both are "do not show me
    // this unprompted again", and the persistent button covers re-opening.
    const skipped = createStorage();
    markOnboardingSeen(skipped);
    expect(hasSeenOnboarding(skipped)).toBe(true);
  });

  it('does not throw when storage is unavailable', () => {
    expect(() => markOnboardingSeen(null)).not.toThrow();
  });

  it('swallows quota errors', () => {
    const hostile = {
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    expect(() => markOnboardingSeen(hostile)).not.toThrow();
  });
});