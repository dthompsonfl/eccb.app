import { describe, expect, it } from 'vitest';
import { normalizeCopyrightYear } from '../metadata-normalizer';

describe('normalizeCopyrightYear', () => {
  it('accepts a plain year as a number', () => {
    expect(normalizeCopyrightYear(1977)).toBe(1977);
  });

  it('accepts a plain year as a string', () => {
    expect(normalizeCopyrightYear('1977')).toBe(1977);
  });

  it('extracts the year from decorated strings', () => {
    expect(normalizeCopyrightYear('c. 1977')).toBe(1977);
    expect(normalizeCopyrightYear('© 1977')).toBe(1977);
    expect(normalizeCopyrightYear('1977-1980')).toBe(1977);
    expect(normalizeCopyrightYear('  1977  ')).toBe(1977);
  });

  it('rejects nonsense rather than committing a misleading value', () => {
    for (const bad of ['', '   ', 'unknown', 'n/a', '19th century', null, undefined]) {
      expect(normalizeCopyrightYear(bad as never), String(bad)).toBeNull();
    }
  });

  it('rejects out-of-range numbers', () => {
    expect(normalizeCopyrightYear(1200)).toBeNull();
    expect(normalizeCopyrightYear(3000)).toBeNull();
    expect(normalizeCopyrightYear(1977.5)).toBeNull();
    expect(normalizeCopyrightYear(Number.NaN)).toBeNull();
  });

  it('does not treat a bare scan id as a year', () => {
    // "482" must not become 482, and a 3-digit token is not matched at all.
    expect(normalizeCopyrightYear('482')).toBeNull();
  });
});
