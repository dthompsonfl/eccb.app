'use client';

import * as React from 'react';
import type { TextScale } from '@/lib/accessibility/text-scale';
import { DEFAULT_TEXT_SCALE } from '@/lib/accessibility/text-scale';

export interface TextScaleContextValue {
  scale: TextScale;
  setScale: (next: TextScale) => void;
}

/**
 * Undefined by default so a component rendered outside the provider throws a
 * clear error rather than silently defaulting — a member who has chosen
 * "Extra large" must never be quietly shown "Medium" because a page forgot to
 * wrap itself in the provider.
 */
export const TextScaleContext = React.createContext<TextScaleContextValue | undefined>(undefined);

/**
 * Read the current text-size preference.
 *
 * Throws when used outside the provider, because a member who has chosen
 * "Extra large" must never be quietly shown "Medium" because a page forgot to
 * wrap itself.
 */
export function useTextScale(): TextScaleContextValue {
  const context = React.useContext(TextScaleContext);
  if (!context) {
    throw new Error('useTextScale must be used inside <TextScaleProvider>');
  }
  return context;
}

/**
 * Optional variant for components that can render outside the provider — such
 * as the music stand's PDF canvas, which is also mounted by isolated tests and
 * by the `StandViewer` story harness.
 *
 * Returns the default preference rather than throwing, so an unwrapped render
 * degrades to normal-size type instead of crashing the viewer.
 */
export function useOptionalTextScale(): TextScaleContextValue {
  const context = React.useContext(TextScaleContext);
  return (
    context ?? {
      scale: DEFAULT_TEXT_SCALE,
      setScale: () => {
        /* No provider: the preference cannot be changed from here. */
      },
    }
  );
}