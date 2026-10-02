'use client';

import * as React from 'react';
import {
  DEFAULT_TEXT_SCALE,
  applyTextScale,
  resolveTextScale,
  saveTextScale,
  type TextScale,
} from '@/lib/accessibility/text-scale';
import { TextScaleContext, type TextScaleContextValue } from './text-scale-context';

/**
 * Owns the current text size and keeps `<html data-font-scale>` in sync.
 *
 * Initial state is read lazily from localStorage so the first client render
 * already matches the value the pre-paint script applied — no flash, and no
 * hydration mismatch because the DOM attribute is written from the same value.
 */
export function TextScaleProvider({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  const [scale, setScaleState] = React.useState<TextScale>(() => {
    if (typeof window === 'undefined') return DEFAULT_TEXT_SCALE;
    return resolveTextScale(window.localStorage);
  });

  const setScale = React.useCallback((next: TextScale) => {
    setScaleState(next);
    applyTextScale(next, document.documentElement);
    saveTextScale(next, window.localStorage);
  }, []);

  // Keep the attribute authoritative even if the pre-paint script was blocked
  // (e.g. by a strict CSP) and the attribute is missing.
  React.useEffect(() => {
    applyTextScale(scale, document.documentElement);
  }, [scale]);

  const value = React.useMemo<TextScaleContextValue>(
    () => ({ scale, setScale }),
    [scale, setScale],
  );

  return <TextScaleContext.Provider value={value}>{children}</TextScaleContext.Provider>;
}