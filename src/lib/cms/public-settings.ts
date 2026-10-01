/**
 * Canonical public contact / organisation settings.
 *
 * These values are administered at /admin/settings (General) and are stored in
 * the SystemSetting table. They are the SINGLE source of truth for the contact
 * details and social links shown on the public site.
 *
 * Before this module existed the admin General form wrote band_name,
 * contact_email, contact_phone, address, facebook_url and youtube_url to
 * SystemSetting, and NOTHING ever read them — the public footer and contact
 * page hard-coded "(850) 555-1234", "https://facebook.com" and friends. Saving
 * the form changed nothing visible, which is exactly the "decorative
 * configuration" failure mode.
 *
 * Behaviour on a fresh install: an administrator sets these values once, and
 * the public site omits any contact channel or social link that has not been
 * configured. Nothing is invented and no placeholder is rendered.
 */

import { prisma } from '@/lib/db';

/** SystemSetting keys owned by the General settings form. */
export const PUBLIC_SETTING_KEYS = [
  'band_name',
  'band_description',
  'contact_email',
  'contact_phone',
  'address',
  'website_url',
  'facebook_url',
  'youtube_url',
  'instagram_url',
] as const;

export type PublicSettingKey = (typeof PUBLIC_SETTING_KEYS)[number];

export interface PublicSettings {
  bandName: string;
  bandDescription: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  /** E.164-ish digits, or null when no phone is configured. */
  contactPhoneHref: string | null;
  address: string | null;
  websiteUrl: string | null;
  socials: Array<{ name: string; href: string }>;
}

/**
 * Fallbacks used only until an administrator configures the real values.
 *
 * The band name is a safe default (it is the organisation's actual name and
 * appears throughout the codebase). Contact details and social URLs have NO
 * fallback on purpose: a fabricated phone number or a bare
 * "https://facebook.com" link is worse than showing nothing, because it
 * misleads visitors and looks live to screen readers and link checkers.
 */
const FALLBACK_BAND_NAME = 'Emerald Coast Community Band';

const SOCIAL_LABEL_BY_KEY: Record<string, string> = {
  facebook_url: 'Facebook',
  instagram_url: 'Instagram',
  youtube_url: 'YouTube',
};

function clean(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Accept only http(s) absolute URLs; reject javascript:, data:, and junk. */
function safeExternalUrl(value: string | null | undefined): string | null {
  const raw = clean(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Build a tel: href from a human-formatted phone number.
 *
 * Returns null unless the value looks like a real dialable number, so a
 * partial or placeholder fragment is never rendered as a working link.
 * NANP numbers are 10 digits (or 11 with a leading country code); requiring
 * at least 10 prevents values like "555-1234" from becoming tel:5551234.
 */
export function toTelHref(phone: string | null | undefined): string | null {
  const raw = clean(phone);
  if (!raw) return null;
  const digits = raw.replace(/[^\d+]/g, '');
  const digitCount = digits.replace(/\D/g, '').length;
  if (digitCount < 10 || digitCount > 15) return null;
  return `tel:${digits}`;
}

export async function getPublicSettings(): Promise<PublicSettings> {
  let rows: Array<{ key: string; value: string | null }> = [];

  try {
    rows = await prisma.systemSetting.findMany({
      where: { key: { in: [...PUBLIC_SETTING_KEYS] } },
      select: { key: true, value: true },
    });
  } catch (error) {
    // A public page must not 500 because the settings table is unavailable.
    // Fall through to safe defaults and log for diagnosis.
    console.error('[public-settings] failed to read settings', error);
    return buildSettings(new Map());
  }

  const map = new Map(rows.map((r) => [r.key, r.value]));
  return buildSettings(map);
}

function buildSettings(map: Map<string, string | null>): PublicSettings {
  const socials: Array<{ name: string; href: string }> = [];
  for (const [key, label] of Object.entries(SOCIAL_LABEL_BY_KEY)) {
    const href = safeExternalUrl(map.get(key));
    if (href) socials.push({ name: label, href });
  }

  return {
    bandName: clean(map.get('band_name')) ?? FALLBACK_BAND_NAME,
    bandDescription: clean(map.get('band_description')),
    contactEmail: clean(map.get('contact_email')),
    contactPhone: clean(map.get('contact_phone')),
    contactPhoneHref: toTelHref(map.get('contact_phone')),
    address: clean(map.get('address')),
    websiteUrl: safeExternalUrl(map.get('website_url')),
    socials,
  };
}
