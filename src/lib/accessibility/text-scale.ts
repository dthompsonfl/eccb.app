/**
 * Guided mode — text size.
 *
 * The band is largely made up of retired volunteers, so the single most
 * requested comfort setting is "make the words bigger". A CSS class toggle
 * cannot do that: most of the UI is sized in `rem` (Tailwind's default), so the
 * correct lever is the root font size. We therefore express the preference as a
 * `<html data-font-scale="…">` attribute and let `globals.css` map it to a root
 * font-size. Everything downstream (padding, line-height, icon sizing in `rem`)
 * then scales for free and still composes with Tailwind rather than fighting it.
 *
 * This module is deliberately dependency-free and pure so it can be unit tested
 * without a DOM, and so the same values can be used by the pre-paint inline
 * script (which must not import React).
 */

/** The four choices offered in the UI, in order from smallest to largest. */
export const TEXT_SCALE_OPTIONS = ['small', 'medium', 'large', 'xlarge'] as const;

export type TextScale = (typeof TEXT_SCALE_OPTIONS)[number];

/** localStorage key. Namespaced so it cannot collide with anything else. */
export const TEXT_SCALE_STORAGE_KEY = 'eccb:text-scale';

/** The attribute written to `<html>`; `globals.css` keys its rules off this. */
export const TEXT_SCALE_ATTRIBUTE = 'data-font-scale';

/**
 * First-time visitors get 'medium' (i.e. the browser default). Defaulting
 * *large* would surprise people who never asked for it; defaulting *small*
 * would be actively hostile.
 */
export const DEFAULT_TEXT_SCALE: TextScale = 'medium';

/**
 * Multipliers, kept in sync with the `:root` rules in `globals.css`. Exported
 * so tests can assert the CSS contract without parsing the stylesheet.
 */
export const TEXT_SCALE_VALUES: Record<TextScale, number> = {
  small: 0.875,
  medium: 1,
  large: 1.15,
  xlarge: 1.3,
};

/** Human labels. Deliberately words, not sizes: "14pt" means nothing here. */
export const TEXT_SCALE_LABELS: Record<TextScale, string> = {
  small: 'Small',
  medium: 'Medium',
  large: 'Large',
  xlarge: 'Extra large',
};

/** Type guard for values coming from localStorage or the DOM. */
export function isTextScale(value: unknown): value is TextScale {
  return typeof value === 'string' && (TEXT_SCALE_OPTIONS as readonly string[]).includes(value);
}

/**
 * Coerce anything into a valid `TextScale`.
 *
 * - a known option is returned unchanged;
 * - a number (or numeric string) is *clamped* to the nearest offered option —
 *   this is what makes `resolveTextScale(0.9)` and a stale
 *   `eccb:text-scale:1.35` value behave sensibly instead of being discarded;
 * - anything else falls back to the default.
 */
export function normalizeTextScale(value: unknown): TextScale {
  if (isTextScale(value)) return value;

  // Guard the null/undefined cases before any numeric coercion: `Number(null)`
  // is 0, which would otherwise clamp all the way down to 'small' instead of
  // falling back to the default. This is the path taken by a missing
  // localStorage entry, so getting it wrong makes every first-time visitor
  // land on the smallest text.
  if (value === null || value === undefined) return DEFAULT_TEXT_SCALE;
  if (typeof value === 'boolean') return DEFAULT_TEXT_SCALE;
  if (typeof value === 'string' && value.trim() === '') return DEFAULT_TEXT_SCALE;
  // Only accept a real number or a numeric string. `Number([1.15])` is 1.15 and
  // `Number(['large'])` is NaN, so an array would otherwise be silently treated
  // as a size — accept only primitives and let everything else take the default.
  if (typeof value !== 'number' && typeof value !== 'string') {
    return DEFAULT_TEXT_SCALE;
  }

  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_TEXT_SCALE;

  let closest: TextScale = DEFAULT_TEXT_SCALE;
  let closestDistance = Number.POSITIVE_INFINITY;
  for (const option of TEXT_SCALE_OPTIONS) {
    const distance = Math.abs(TEXT_SCALE_VALUES[option] - parsed);
    if (distance < closestDistance) {
      closest = option;
      closestDistance = distance;
    }
  }
  return closest;
}

/**
 * Resolve the scale to use on first render / before the client has hydrated.
 *
 * `storage` is injected (rather than reaching for `window.localStorage`) so the
 * function stays testable and so a caller in a non-browser context can pass
 * `null` instead of guarding every access.
 */
export function resolveTextScale(storage?: Pick<Storage, 'getItem'> | null): TextScale {
  if (!storage) return DEFAULT_TEXT_SCALE;
  try {
    return normalizeTextScale(storage.getItem(TEXT_SCALE_STORAGE_KEY));
  } catch {
    // Private browsing modes and blocked third-party storage both throw here.
    return DEFAULT_TEXT_SCALE;
  }
}

/** Persist a scale. Silently gives up if storage is unavailable or full. */
export function saveTextScale(
  scale: TextScale,
  storage?: Pick<Storage, 'setItem'> | null,
): void {
  if (!storage) return;
  try {
    storage.setItem(TEXT_SCALE_STORAGE_KEY, scale);
  } catch {
    /* Preference is a nicety; never let it break the page. */
  }
}

/**
 * Apply a scale to a document root. Writes the attribute (what the CSS keys
 * off) rather than an inline `style.fontSize`, so `globals.css` stays the single
 * source of truth and a user stylesheet can still win.
 */
export function applyTextScale(scale: TextScale, root?: Element | null): void {
  if (!root) return;
  root.setAttribute(TEXT_SCALE_ATTRIBUTE, scale);
}