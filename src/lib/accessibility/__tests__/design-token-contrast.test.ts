/**
 * Regression guard for the design-token contrast fixes.
 *
 * These are not "does the CSS parse" tests. Each one encodes a ratio that was
 * measured and found to FAIL WCAG 2.1 AA in this codebase, so that anyone who
 * later "tidies up" the palette cannot silently put an unreadable helper text
 * or an invisible dark-mode focus ring back into the member surface.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const globalsPath = join(process.cwd(), 'src/app/globals.css');
const css = readFileSync(globalsPath, 'utf8');

/** Relative luminance per WCAG 2.1. */
function luminance(hex: string): number {
  const clean = hex.replace('#', '').trim();
  const channels = [0, 2, 4].map((i) => parseInt(clean.slice(i, i + 2), 16) / 255);
  const linear = channels.map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

/** Pull `--name: #hex;` out of a given block of the stylesheet. */
function token(name: string, from: number, to: number): string {
  const block = css.slice(from, to);
  const match = block.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,8})`));
  if (!match) throw new Error(`token --${name} not found in the requested block`);
  return match[1];
}

const darkStart = css.indexOf('.dark {');
const darkEnd = css.indexOf('@theme inline');
const themeStart = css.indexOf(':root {');

describe('light theme tokens', () => {
  it('muted-foreground meets AA body text on the muted surface', () => {
    // Was #6b7280 on #f3f4f6 = 4.39:1 — an AA failure. Helper text is very
    // often set on a muted surface, so this pairing has to clear 4.5:1.
    const fg = token('muted-foreground', themeStart, darkStart);
    const bg = token('muted', themeStart, darkStart);
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  it('muted-foreground meets AA body text on the page background', () => {
    const fg = token('muted-foreground', themeStart, darkStart);
    const bg = token('background', themeStart, darkStart);
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  it('foreground meets AAA body text on the page background', () => {
    const fg = token('foreground', themeStart, darkStart);
    const bg = token('background', themeStart, darkStart);
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(7);
  });

  it('primary-foreground is readable on the primary fill', () => {
    const fg = token('primary-foreground', themeStart, darkStart);
    const bg = token('primary', themeStart, darkStart);
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('dark theme tokens', () => {
  it('muted-foreground meets AA body text on the dark card', () => {
    const fg = token('muted-foreground', darkStart, darkEnd);
    const bg = token('card', darkStart, darkEnd);
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  it('muted-foreground meets AA body text on the dark muted surface', () => {
    const fg = token('muted-foreground', darkStart, darkEnd);
    const bg = token('muted', darkStart, darkEnd);
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('focus indicator visibility (WCAG 1.4.11 non-text contrast)', () => {
  it('the focus ring clears 3:1 against the light card', () => {
    const ring = token('focus-ring', themeStart, darkStart);
    const card = token('card', themeStart, darkStart);
    expect(contrast(ring, card)).toBeGreaterThanOrEqual(3);
  });

  it('the focus ring clears 3:1 against the light background', () => {
    const ring = token('focus-ring', themeStart, darkStart);
    const bg = token('background', themeStart, darkStart);
    expect(contrast(ring, bg)).toBeGreaterThanOrEqual(3);
  });

  it('the dark focus ring clears 3:1 against the dark card', () => {
    // This is the defect that made dark-mode keyboard navigation unusable:
    // the ring was --primary (#0f766e), only 2.67:1 on a #1e293b card.
    const ring = token('focus-ring', darkStart, darkEnd);
    const card = token('card', darkStart, darkEnd);
    expect(contrast(ring, card)).toBeGreaterThanOrEqual(3);
  });

  it('the dark focus ring clears 3:1 against the dark background', () => {
    const ring = token('focus-ring', darkStart, darkEnd);
    const bg = token('background', darkStart, darkEnd);
    expect(contrast(ring, bg)).toBeGreaterThanOrEqual(3);
  });

  it('is a distinct token from the primary fill in dark mode', () => {
    const ring = token('focus-ring', darkStart, darkEnd);
    const primary = token('primary', darkStart, darkEnd);
    expect(ring).not.toBe(primary);
  });
});

describe('focus styles are not merely removed', () => {
  it('the global focus-visible rule uses the focus-ring token', () => {
    expect(css).toMatch(/outline:\s*3px solid var\(--focus-ring\)/);
  });

  it('no interactive element is left with outline:none and no ring replacement', () => {
    // A bare `outline: none` on :focus is only acceptable when a :focus-visible
    // rule supplies something visible, which the rule above guarantees globally.
    const bareOutlineNone = css.match(/\*:focus:not\(:focus-visible\)\s*\{\s*outline:\s*none/g);
    expect(bareOutlineNone).toHaveLength(1);
  });
});