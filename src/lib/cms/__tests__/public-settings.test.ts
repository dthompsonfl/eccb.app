import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for canonical public settings.
 *
 * The defect being pinned: the admin General settings form wrote band_name,
 * contact_email, contact_phone, address and the social URLs to SystemSetting,
 * and nothing ever read them. The public site hard-coded "(850) 555-1234" and
 * bare https://facebook.com links. These tests assert that a configured value
 * is actually used, and — more importantly — that an UNCONFIGURED value
 * produces nothing rather than a fabricated placeholder.
 */

const mockFindMany = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    systemSetting: { findMany: (...a: any[]) => mockFindMany(...a) },
  },
}));

import { getPublicSettings, toTelHref, PUBLIC_SETTING_KEYS } from '../public-settings';

function rows(values: Record<string, string>) {
  return Object.entries(values).map(([key, value]) => ({ key, value }));
}

describe('toTelHref', () => {
  it('builds a dialable href from a formatted number', () => {
    expect(toTelHref('(850) 555-1234')).toBe('tel:8505551234');
  });

  it('preserves a leading country code', () => {
    expect(toTelHref('+1 850 555 1234')).toBe('tel:+18505551234');
  });

  it('returns null for an empty value', () => {
    expect(toTelHref('')).toBeNull();
    expect(toTelHref(null)).toBeNull();
    expect(toTelHref(undefined)).toBeNull();
  });

  it('returns null for a too-short fragment', () => {
    // Guards against rendering "555-1234" as a dialable number.
    expect(toTelHref('555-1234')).toBeNull();
  });

  it('returns null when there are no digits at all', () => {
    expect(toTelHref('call us')).toBeNull();
  });
});

describe('getPublicSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindMany.mockResolvedValue([]);
  });

  it('exposes the allowlist of setting keys it owns', () => {
    expect(PUBLIC_SETTING_KEYS).toContain('band_name');
    expect(PUBLIC_SETTING_KEYS).toContain('contact_phone');
    expect(PUBLIC_SETTING_KEYS).toContain('facebook_url');
  });

  it('reads only the keys it owns', async () => {
    await getPublicSettings();
    const arg = mockFindMany.mock.calls[0][0];
    expect(arg.where.key.in).toEqual(expect.arrayContaining([...PUBLIC_SETTING_KEYS]));
  });

  it('returns configured values', async () => {
    mockFindMany.mockResolvedValue(
      rows({
        band_name: 'Niceville Community Band',
        band_description: 'A friendly band.',
        contact_email: 'hello@example.org',
        contact_phone: '(850) 555-1234',
        address: '123 Main St\nNiceville, FL',
        facebook_url: 'https://facebook.com/nicevilleband',
      }),
    );

    const s = await getPublicSettings();
    expect(s.bandName).toBe('Niceville Community Band');
    expect(s.bandDescription).toBe('A friendly band.');
    expect(s.contactEmail).toBe('hello@example.org');
    expect(s.contactPhone).toBe('(850) 555-1234');
    expect(s.contactPhoneHref).toBe('tel:8505551234');
    expect(s.address).toContain('Niceville');
    expect(s.socials).toEqual([
      { name: 'Facebook', href: 'https://facebook.com/nicevilleband' },
    ]);
  });

  // ── The core of the defect ──────────────────────────────────────────────
  it('invents NO contact details when nothing is configured', async () => {
    const s = await getPublicSettings();
    expect(s.contactPhone).toBeNull();
    expect(s.contactPhoneHref).toBeNull();
    expect(s.contactEmail).toBeNull();
    expect(s.address).toBeNull();
  });

  it('invents NO social links when nothing is configured', async () => {
    const s = await getPublicSettings();
    // Critically: not "https://facebook.com".
    expect(s.socials).toEqual([]);
    expect(JSON.stringify(s)).not.toContain('facebook.com');
  });

  it('falls back to the real band name so the site still renders', async () => {
    const s = await getPublicSettings();
    expect(s.bandName).toBe('Emerald Coast Community Band');
  });

  it('treats empty-string settings as unset', async () => {
    mockFindMany.mockResolvedValue(
      rows({ band_name: '', contact_email: '  ', facebook_url: '' }),
    );
    const s = await getPublicSettings();
    expect(s.bandName).toBe('Emerald Coast Community Band');
    expect(s.contactEmail).toBeNull();
    expect(s.socials).toEqual([]);
  });

  // ── Unsafe input is rejected rather than rendered ───────────────────────
  it('rejects a javascript: social URL', async () => {
    mockFindMany.mockResolvedValue(
      rows({ facebook_url: 'javascript:alert(1)' }),
    );
    const s = await getPublicSettings();
    expect(s.socials).toEqual([]);
  });

  it('rejects a data: social URL', async () => {
    mockFindMany.mockResolvedValue(rows({ facebook_url: 'data:text/html,<script>' }));
    const s = await getPublicSettings();
    expect(s.socials).toEqual([]);
  });

  it('rejects a malformed social URL', async () => {
    mockFindMany.mockResolvedValue(rows({ youtube_url: 'not a url' }));
    const s = await getPublicSettings();
    expect(s.socials).toEqual([]);
  });

  it('still returns the real band name when the DB read fails', async () => {
    mockFindMany.mockRejectedValue(new Error('db down'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = await getPublicSettings();
    expect(s.bandName).toBe('Emerald Coast Community Band');
    expect(s.contactPhone).toBeNull();
    expect(s.socials).toEqual([]);
    consoleSpy.mockRestore();
  });
});
