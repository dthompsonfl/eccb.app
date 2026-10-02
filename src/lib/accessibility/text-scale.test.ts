import { describe, it, expect, afterEach } from 'vitest';
import {
  DEFAULT_TEXT_SCALE,
  TEXT_SCALE_ATTRIBUTE,
  TEXT_SCALE_OPTIONS,
  TEXT_SCALE_STORAGE_KEY,
  TEXT_SCALE_VALUES,
  applyTextScale,
  isTextScale,
  normalizeTextScale,
  resolveTextScale,
  saveTextScale,
  type TextScale,
} from './text-scale';
import { TEXT_SCALE_PREPAINT_SCRIPT } from './text-scale-script';

/** Minimal in-memory Storage stand-in, so the tests never touch the real one. */
function createStorage(initial?: Record<string, string>) {
  const data = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
    clear: () => data.clear(),
    key: (index: number) => Array.from(data.keys())[index] ?? null,
    get length() {
      return data.size;
    },
    snapshot: data,
  };
}

describe('text scale options', () => {
  it('offers exactly four sizes, smallest first', () => {
    expect([...TEXT_SCALE_OPTIONS]).toEqual(['small', 'medium', 'large', 'xlarge']);
  });

  it('defaults to medium for a first-time visitor', () => {
    expect(DEFAULT_TEXT_SCALE).toBe('medium');
    expect(TEXT_SCALE_VALUES[DEFAULT_TEXT_SCALE]).toBe(1);
  });

  it('keeps the multipliers strictly increasing', () => {
    const values = TEXT_SCALE_OPTIONS.map((option) => TEXT_SCALE_VALUES[option]);
    for (let i = 1; i < values.length; i += 1) {
      expect(values[i]).toBeGreaterThan(values[i - 1]);
    }
  });

  it('caps the largest step so wide layouts stay usable', () => {
    expect(TEXT_SCALE_VALUES.xlarge).toBeLessThanOrEqual(1.3);
  });
});

describe('isTextScale', () => {
  it('accepts every declared option', () => {
    for (const option of TEXT_SCALE_OPTIONS) {
      expect(isTextScale(option)).toBe(true);
    }
  });

  it('rejects unknown values and non-strings', () => {
    expect(isTextScale('huge')).toBe(false);
    expect(isTextScale('')).toBe(false);
    expect(isTextScale(null)).toBe(false);
    expect(isTextScale(undefined)).toBe(false);
    expect(isTextScale(2)).toBe(false);
  });
});

describe('normalizeTextScale', () => {
  it('passes valid options through unchanged', () => {
    for (const option of TEXT_SCALE_OPTIONS) {
      expect(normalizeTextScale(option)).toBe(option);
    }
  });

  it('falls back to the default for unusable input', () => {
    expect(normalizeTextScale(undefined)).toBe(DEFAULT_TEXT_SCALE);
    expect(normalizeTextScale(null)).toBe(DEFAULT_TEXT_SCALE);
    expect(normalizeTextScale('')).toBe(DEFAULT_TEXT_SCALE);
    expect(normalizeTextScale('   ')).toBe(DEFAULT_TEXT_SCALE);
    expect(normalizeTextScale('enormous')).toBe(DEFAULT_TEXT_SCALE);
    expect(normalizeTextScale(Number.NaN)).toBe(DEFAULT_TEXT_SCALE);
    expect(normalizeTextScale(Number.POSITIVE_INFINITY)).toBe(DEFAULT_TEXT_SCALE);
    expect(normalizeTextScale({ size: 'large' })).toBe(DEFAULT_TEXT_SCALE);
    expect(normalizeTextScale(true)).toBe(DEFAULT_TEXT_SCALE);
    expect(normalizeTextScale([1.15])).toBe(DEFAULT_TEXT_SCALE);
  });

  it('clamps an out-of-range number up to the nearest offered size', () => {
    expect(normalizeTextScale(9)).toBe('xlarge');
    expect(normalizeTextScale(1000)).toBe('xlarge');
  });

  it('clamps an out-of-range number down to the nearest offered size', () => {
    expect(normalizeTextScale(-5)).toBe('small');
    expect(normalizeTextScale(0)).toBe('small');
  });

  it('snaps a fractional multiplier to the nearest offered size', () => {
    expect(normalizeTextScale(1.1)).toBe('large');
    expect(normalizeTextScale(1.25)).toBe('xlarge');
    // 1.2 is 0.05 from 'large' and 0.10 from 'xlarge', so it rounds down.
    expect(normalizeTextScale(1.2)).toBe('large');
    // Just past the midpoint, so it rounds up. Asserted off the exact midpoint
    // because (1.15 + 1.3) / 2 is not exactly representable in binary floating
    // point, which would make an equality assertion there flaky by construction.
    expect(normalizeTextScale(1.23)).toBe('xlarge');
  });

  it('accepts a numeric string, as could arrive from storage', () => {
    expect(normalizeTextScale('1.15')).toBe('large');
  });
});

describe('resolveTextScale', () => {
  it('returns the default when there is no storage at all', () => {
    expect(resolveTextScale(null)).toBe(DEFAULT_TEXT_SCALE);
    expect(resolveTextScale(undefined)).toBe(DEFAULT_TEXT_SCALE);
  });

  it('returns the default when nothing has been stored yet', () => {
    expect(resolveTextScale(createStorage())).toBe(DEFAULT_TEXT_SCALE);
  });

  it('returns the stored preference', () => {
    const storage = createStorage({ [TEXT_SCALE_STORAGE_KEY]: 'large' });
    expect(resolveTextScale(storage)).toBe('large');
  });

  it('falls back to the default for a corrupted stored value', () => {
    const storage = createStorage({ [TEXT_SCALE_STORAGE_KEY]: 'gigantic' });
    expect(resolveTextScale(storage)).toBe(DEFAULT_TEXT_SCALE);
  });

  it('survives storage that throws, as private browsing does', () => {
    const hostile = {
      getItem: () => {
        throw new Error('SecurityError');
      },
    };
    expect(resolveTextScale(hostile)).toBe(DEFAULT_TEXT_SCALE);
  });
});

describe('saveTextScale', () => {
  it('persists the choice under the namespaced key', () => {
    const storage = createStorage();
    saveTextScale('xlarge', storage);
    expect(storage.getItem(TEXT_SCALE_STORAGE_KEY)).toBe('xlarge');
    expect(resolveTextScale(storage)).toBe('xlarge');
  });

  it('round-trips every option', () => {
    for (const option of TEXT_SCALE_OPTIONS) {
      const storage = createStorage();
      saveTextScale(option, storage);
      expect(resolveTextScale(storage)).toBe(option);
    }
  });

  it('overwrites a previous choice rather than accumulating', () => {
    const storage = createStorage();
    saveTextScale('small', storage);
    saveTextScale('large', storage);
    expect(resolveTextScale(storage)).toBe('large');
    expect(storage.length).toBe(1);
  });

  it('is a no-op without storage', () => {
    expect(() => saveTextScale('large', null)).not.toThrow();
  });

  it('swallows quota errors rather than breaking the page', () => {
    const hostile = {
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    expect(() => saveTextScale('large', hostile)).not.toThrow();
  });
});

describe('applyTextScale', () => {
  it('writes the attribute the stylesheet keys off', () => {
    const root = document.createElement('html');
    applyTextScale('large', root);
    expect(root.getAttribute(TEXT_SCALE_ATTRIBUTE)).toBe('large');
  });

  it('replaces a previous value', () => {
    const root = document.createElement('html');
    applyTextScale('small', root);
    applyTextScale('xlarge', root);
    expect(root.getAttribute(TEXT_SCALE_ATTRIBUTE)).toBe('xlarge');
  });

  it('is a no-op when there is no root element', () => {
    expect(() => applyTextScale('large', null)).not.toThrow();
  });
});

/**
 * Execute the real pre-paint script against a detached root, with a stubbed
 * `localStorage`, so we assert what the browser will actually do at first paint
 * rather than that the string merely mentions the right words.
 */
function runPrePaintScript(storedValue: string | null): HTMLElement {
  const root = document.createElement('html');
  const stub = {
    getItem: (key: string) => (key === TEXT_SCALE_STORAGE_KEY ? storedValue : null),
  };
  const run = new Function(
    'localStorage',
    'document',
    TEXT_SCALE_PREPAINT_SCRIPT,
  ) as (ls: unknown, doc: unknown) => void;
  run(stub, { documentElement: root });
  return root;
}

describe('pre-paint script', () => {
  it('accepts every option the UI can produce', () => {
    for (const option of TEXT_SCALE_OPTIONS) {
      expect(TEXT_SCALE_PREPAINT_SCRIPT).toContain(`'${option}'`);
    }
  });

  it('agrees with the canonical storage key', () => {
    expect(TEXT_SCALE_PREPAINT_SCRIPT).toContain(TEXT_SCALE_STORAGE_KEY);
  });

  it('agrees with the canonical attribute name', () => {
    expect(TEXT_SCALE_PREPAINT_SCRIPT).toContain(TEXT_SCALE_ATTRIBUTE);
  });

  it('defaults an unknown stored value to medium', () => {
    expect(TEXT_SCALE_PREPAINT_SCRIPT).toContain(`v='${DEFAULT_TEXT_SCALE}'`);
  });

  it('sets the attribute to the stored size when one exists', () => {
    const root = runPrePaintScript('large');
    expect(root.getAttribute(TEXT_SCALE_ATTRIBUTE)).toBe('large');
  });

  it('sets the attribute to medium for a first-time visitor', () => {
    const root = runPrePaintScript(null);
    expect(root.getAttribute(TEXT_SCALE_ATTRIBUTE)).toBe(DEFAULT_TEXT_SCALE);
  });

  it('sets the attribute to medium for a corrupted stored value', () => {
    const root = runPrePaintScript('gigantic');
    expect(root.getAttribute(TEXT_SCALE_ATTRIBUTE)).toBe(DEFAULT_TEXT_SCALE);
  });
});

describe('integration: storage and DOM together', () => {
  afterEach(() => {
    document.documentElement.removeAttribute(TEXT_SCALE_ATTRIBUTE);
  });

  it('reads back what it wrote to storage and to the document root', () => {
    // jsdom in this environment does not expose a working `localStorage`
    // (`--localstorage-file` is unset), so exercise the same code path against
    // the in-memory double the provider is handed in a browser.
    const storage = createStorage();
    const chosen: TextScale = 'xlarge';
    saveTextScale(chosen, storage);
    applyTextScale(chosen, document.documentElement);

    expect(resolveTextScale(storage)).toBe('xlarge');
    expect(document.documentElement.getAttribute(TEXT_SCALE_ATTRIBUTE)).toBe('xlarge');
  });

  it('lands on medium when the visitor has never chosen a size', () => {
    const storage = createStorage();
    applyTextScale(resolveTextScale(storage), document.documentElement);

    expect(document.documentElement.getAttribute(TEXT_SCALE_ATTRIBUTE)).toBe('medium');
  });

  it('agrees with what the pre-paint script would have set at first paint', () => {
    for (const option of TEXT_SCALE_OPTIONS) {
      const storage = createStorage();
      saveTextScale(option, storage);

      const painted = runPrePaintScript(option).getAttribute(TEXT_SCALE_ATTRIBUTE);
      const hydrated = resolveTextScale(storage);

      expect(hydrated).toBe(option);
      expect(painted).toBe(hydrated);
    }
  });
});