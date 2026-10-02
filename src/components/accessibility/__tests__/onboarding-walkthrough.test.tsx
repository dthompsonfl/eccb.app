import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

import { OnboardingWalkthrough } from '../onboarding-walkthrough';
import { ONBOARDING_STEPS, ONBOARDING_STORAGE_KEY } from '@/lib/accessibility/onboarding';

/**
 * Behavioural tests for the walkthrough.
 *
 * The thing worth protecting is not the copy — it is that a member can always
 * get out of the tour, and can always get back into it. A first-run dialog that
 * traps someone who cannot work out how to dismiss it is worse than no dialog,
 * so Escape, Skip, and the persistent re-open control are all asserted here.
 */

// jsdom does not implement these, and Radix's dialog/label plumbing reaches for
// both.
beforeEach(() => {
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = vi.fn();
  }
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = vi.fn(() => false);
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = vi.fn();
  }
  // Stand in for localStorage: this environment has no working one.
  const store = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
      clear: () => store.clear(),
      key: (index: number) => Array.from(store.keys())[index] ?? null,
      get length() {
        return store.size;
      },
    },
  });
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe('OnboardingWalkthrough', () => {
  it('does not open itself for a member who has already seen the tour', () => {
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, '1');
    render(<OnboardingWalkthrough />);

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens itself for a first-time member', () => {
    render(<OnboardingWalkthrough />);

    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('opens itself for a returning member when forced', () => {
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, '1');
    render(<OnboardingWalkthrough force />);

    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('is a labelled dialog, so a screen reader announces what opened', () => {
    render(<OnboardingWalkthrough />);

    const dialog = screen.getByRole('dialog');
    // The label is the first step's title, which changes as you step through.
    expect(dialog.getAttribute('aria-labelledby')).toBe('onboarding-title');
    expect(screen.getByText(ONBOARDING_STEPS[0].title)).toBeTruthy();
  });

  it('starts on step 1 and says so', () => {
    render(<OnboardingWalkthrough />);

    expect(screen.getByText(/step 1 of 5/i)).toBeTruthy();
  });

  it('advances through the steps and lands on a closing button', () => {
    render(<OnboardingWalkthrough />);

    for (let i = 1; i < ONBOARDING_STEPS.length; i += 1) {
      fireEvent.click(screen.getByRole('button', { name: /^next$/i }));
      expect(screen.getByText(new RegExp(`step ${i + 1} of ${ONBOARDING_STEPS.length}`, 'i')))
        .toBeTruthy();
      expect(screen.getByText(ONBOARDING_STEPS[i].title)).toBeTruthy();
    }

    expect(screen.getByRole('button', { name: /got it/i })).toBeTruthy();
  });

  it('walks back again', () => {
    render(<OnboardingWalkthrough />);

    fireEvent.click(screen.getByRole('button', { name: /^next$/i }));
    expect(screen.getByText(/step 2 of 5/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /^back$/i }));
    expect(screen.getByText(/step 1 of 5/i)).toBeTruthy();
  });

  it('disables Back on the first step rather than trapping the member', () => {
    render(<OnboardingWalkthrough />);

    expect((screen.getByRole('button', { name: /^back$/i }) as HTMLButtonElement).disabled)
      .toBe(true);
  });

  it('closes on Skip and records that the tour has been seen', () => {
    render(<OnboardingWalkthrough />);

    fireEvent.click(screen.getByRole('button', { name: /^skip this$/i }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(window.localStorage.getItem(ONBOARDING_STORAGE_KEY)).not.toBeNull();
  });

  it('closes on the finishing button and records that the tour has been seen', () => {
    render(<OnboardingWalkthrough />);

    for (let i = 1; i < ONBOARDING_STEPS.length; i += 1) {
      fireEvent.click(screen.getByRole('button', { name: /^next$/i }));
    }
    fireEvent.click(screen.getByRole('button', { name: /got it/i }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(window.localStorage.getItem(ONBOARDING_STORAGE_KEY)).not.toBeNull();
  });

  it('does not reappear on the next render once skipped', () => {
    const { rerender } = render(<OnboardingWalkthrough />);
    fireEvent.click(screen.getByRole('button', { name: /^skip this$/i }));

    rerender(<OnboardingWalkthrough />);

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('starts over at step 1 when re-opened, not where the member left off', () => {
    render(<OnboardingWalkthrough />);
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }));
    expect(screen.getByText(/step 3 of 5/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^skip this$/i }));

    // Re-opening is what the persistent "Show me how" button does.
    cleanup();
    render(<OnboardingWalkthrough force />);

    expect(screen.getByText(/step 1 of 5/i)).toBeTruthy();
  });

  it('honours a controlled open prop', () => {
    const onOpenChange = vi.fn();
    render(<OnboardingWalkthrough open={true} onOpenChange={onOpenChange} />);

    expect(screen.getByRole('dialog')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /^skip this$/i }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});