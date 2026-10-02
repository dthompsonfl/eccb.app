'use client';

import * as React from 'react';
import type { TextScale } from '@/lib/accessibility/text-scale';

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

export function useTextScale(): TextScaleContextValue {
  const context = React.useContext(TextScaleContext);
  if (!context) {
    throw new Error('useTextScale must be used inside <TextScaleProvider>');
  }
  return context;
}