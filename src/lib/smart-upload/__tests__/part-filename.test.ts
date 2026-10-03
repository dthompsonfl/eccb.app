/**
 * Filename builder tests.
 *
 * The contract under test: a musician who downloads a part and opens it outside
 * the Digital Music Stand must be able to identify it instantly, on Windows,
 * macOS, or Linux, and re-running the split must not drift the name.
 *
 * Every case here corresponds to a real defect observed against the previous
 * implementation, which:
 *   - produced `CON.pdf` / `NUL.pdf.pdf` (undeletable Windows device names)
 *   - produced `.pdf` for empty and whitespace-only input
 *   - produced `....pdf` and `.hidden.pdf` (leading dots)
 *   - produced `trailing..pdf` (trailing dot before the extension)
 *   - kept NUL and other control characters in the name
 */

import { describe, expect, it } from 'vitest';
import {
  buildPartFilename,
  sanitizePartFilenameStem,
  buildPartStorageSlug,
  resolvePartTitle,
  isCanonicalTitle,
} from '../part-naming';

/** Everything a filename must never contain to be safe on any mainstream FS. */
function assertFilesystemSafe(fileName: string): void {
  expect(fileName).not.toMatch(/[/\\:*?"<>|]/);
  // eslint-disable-next-line no-control-regex
  expect(fileName).not.toMatch(/[\u0000-\u001f\u007f]/);
  expect(fileName).not.toMatch(/^\.+/);
  expect(fileName).not.toMatch(/\s$/);
  expect(fileName).not.toMatch(/\.\./);
  expect(fileName.length).toBeGreaterThan(4); // more than just ".pdf"
}

/** Windows refuses to open these stems at all, with or without extension. */
const RESERVED_STEMS = [
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5',
];

describe('sanitizePartFilenameStem', () => {
  it('collapses whitespace to single underscores', () => {
    expect(sanitizePartFilenameStem('Lincolnshire   Posy  Flute')).toBe(
      'Lincolnshire_Posy_Flute',
    );
  });

  it('strips filesystem-unsafe characters', () => {
    const stem = sanitizePartFilenameStem('A/B\\C:D*E?F"G<H>I|J');
    expect(stem).toBe('ABCDEFGHIJ');
  });

  it('strips control characters including NUL', () => {
    const stem = sanitizePartFilenameStem('Horn\x00\x01\x1F\x7F1');
    assertFilesystemSafe(`${stem}.pdf`);
  });

  it('never returns an empty stem', () => {
    for (const input of ['', '   ', '///', '...', '.', '   .  ', '?*<>|']) {
      const stem = sanitizePartFilenameStem(input);
      expect(stem.length, JSON.stringify(input)).toBeGreaterThan(0);
    }
  });

  it('escapes every Windows reserved device name', () => {
    for (const reserved of RESERVED_STEMS) {
      expect(sanitizePartFilenameStem(reserved), reserved).not.toBe(reserved);
      // Case-insensitive on Windows, so check the mixed cases too.
      expect(sanitizePartFilenameStem(reserved.toUpperCase())).not.toBe(
        reserved.toUpperCase(),
      );
    }
  });

  it('does not escape names that merely resemble a device name', () => {
    expect(sanitizePartFilenameStem('Concerto')).toBe('Concerto');
    expect(sanitizePartFilenameStem('Pronto')).toBe('Pronto');
    expect(sanitizePartFilenameStem('Auxiliary')).toBe('Auxiliary');
  });

  it('removes leading dots so the file is not hidden', () => {
    expect(sanitizePartFilenameStem('.hidden')).toBe('hidden');
    expect(sanitizePartFilenameStem('...dots')).toBe('dots');
  });

  it('removes trailing dots and spaces that Windows would silently drop', () => {
    expect(sanitizePartFilenameStem('trailing.  ')).toBe('trailing');
    expect(sanitizePartFilenameStem('spaced   ')).toBe('spaced');
  });

  it('caps the stem at 200 characters without a dangling separator', () => {
    const stem = sanitizePartFilenameStem('A'.repeat(250));
    expect(stem).toHaveLength(200);
  });

  it('does not leave a trailing underscore after truncation', () => {
    const stem = sanitizePartFilenameStem(`${'A'.repeat(199)} tail`);
    expect(stem.endsWith('_')).toBe(false);
  });

  it('is a pure, idempotent function of its input', () => {
    const inputs = [
      'Lincolnshire Posy 1st Bb Clarinet',
      'A/B\\C:D*E?F"G<H>I|J',
      'CON',
      '  ',
      'NUL.pdf',
      'O\'Brien: March! (2)',
      '\x00\x01',
    ];
    for (const input of inputs) {
      const once = sanitizePartFilenameStem(input);
      expect(sanitizePartFilenameStem(once), input).toBe(once);
    }
  });
});

describe('buildPartFilename', () => {
  it('carries both the work title and the part name', () => {
    expect(buildPartFilename('Lincolnshire Posy 1st Bb Clarinet')).toBe(
      'Lincolnshire_Posy_1st_Bb_Clarinet.pdf',
    );
  });

  it('always ends in .pdf', () => {
    for (const input of ['Flute', '', '   ', '...', 'CON']) {
      expect(buildPartFilename(input).endsWith('.pdf'), JSON.stringify(input)).toBe(
        true,
      );
    }
  });

  it('produces a safe name for every hostile input', () => {
    const hostile = [
      '',
      '   ',
      '...',
      '.',
      '.hidden',
      'trailing.  ',
      'CON',
      'NUL',
      'PRN.pdf',
      'AUX',
      'A/B\\C:D*E?F"G<H>I|J',
      'a\x00b\x1Fc\x7Fd',
      '../../etc/passwd',
      'O\'Brien',
      'A'.repeat(500),
      'ẍ'.repeat(120),
    ];

    for (const input of hostile) {
      const name = buildPartFilename(input);
      assertFilesystemSafe(name);
    }
  });

  it('cannot escape its directory', () => {
    const name = buildPartFilename('../../etc/passwd');
    expect(name).not.toContain('..');
    expect(name).not.toContain('/');
  });

  it('is deterministic and idempotent — no "(1)" drift on re-run', () => {
    const display = 'Lincolnshire Posy 1st Bb Clarinet';
    const first = buildPartFilename(display);
    const second = buildPartFilename(display);
    expect(first).toBe(second);
    expect(first).not.toMatch(/\(\d+\)/);

    // Re-running the split on an already-named part must not accumulate
    // suffixes either.
    expect(buildPartFilename(first)).toBe(first);
  });

  it('stays within a length a filesystem and download UI will accept', () => {
    const name = buildPartFilename(`${'A'.repeat(300)} Flute`);
    expect(name.length).toBeLessThanOrEqual(204);
  });
});

describe('buildPartStorageSlug', () => {
  it('produces a safe, non-empty key for hostile input', () => {
    for (const input of ['', '   ', '...', 'CON', 'A/B\\C:D']) {
      const slug = buildPartStorageSlug(input);
      expect(slug.length, JSON.stringify(input)).toBeGreaterThan(0);
      expect(slug, JSON.stringify(input)).not.toMatch(/[/\\:*?"<>|]/);
    }
  });

  it('stays unique per part when partNumber and pageRange differ', () => {
    const a = buildPartStorageSlug('Bb Clarinet', { partNumber: 1, pageRange: [1, 4] });
    const b = buildPartStorageSlug('Bb Clarinet', { partNumber: 2, pageRange: [5, 8] });
    expect(a).not.toBe(b);
  });

  it('still appends the documented suffixes', () => {
    expect(buildPartStorageSlug('Bb Clarinet', { partNumber: 3 })).toBe(
      'Bb_Clarinet_p3',
    );
    expect(buildPartStorageSlug('Trumpet', { pageRange: [5, 8] })).toBe(
      'Trumpet_pg5-8',
    );
  });
});

describe('resolvePartTitle end-to-end naming', () => {
  const part = { instrument: '1st Bb Clarinet' };

  it('produces a findable, safe filename from a real work title', () => {
    const r = resolvePartTitle({
      extractedTitle: 'Lincolnshire Posy',
      uploadedFileName: 'scan_00482.pdf',
      part,
      partNumber: 1,
      pageRange: [1, 10],
    });

    expect(r.fileName).toBe('Lincolnshire_Posy_1st_Bb_Clarinet.pdf');
    assertFilesystemSafe(r.fileName);
  });

  it('keeps title and part both recognisable to a human', () => {
    const r = resolvePartTitle({
      extractedTitle: 'Lincolnshire Posy',
      uploadedFileName: 'scan.pdf',
      part,
    });
    // The title must survive verbatim enough to identify the work.
    expect(r.fileName).toContain('Lincolnshire');
    expect(r.fileName).toContain('Posy');
    expect(r.fileName).toContain('Clarinet');
  });

  it('yields unique storage keys but possibly shared filenames', () => {
    const args = { extractedTitle: 'Same Work', uploadedFileName: 'x.pdf', part };
    const a = resolvePartTitle({ ...args, partNumber: 1, pageRange: [1, 10] });
    const b = resolvePartTitle({ ...args, partNumber: 2, pageRange: [11, 20] });

    expect(a.slug).not.toBe(b.slug);
    expect(a.fileName).toBe(b.fileName);
  });

  it('still names a part when both title and upload name are junk', () => {
    for (const bad of ['untitled', 'Unknown', '', null]) {
      const r = resolvePartTitle({
        extractedTitle: bad,
        uploadedFileName: '.pdf',
        part,
      });
      assertFilesystemSafe(r.fileName);
    }
  });

  it('refuses placeholder titles so a fallback is visible', () => {
    expect(isCanonicalTitle('Untitled')).toBe(false);
    const r = resolvePartTitle({
      extractedTitle: 'Untitled',
      uploadedFileName: 'scan_00482.pdf',
      part,
    });
    expect(r.source).toBe('upload-filename');
    expect(r.fileName).toContain('scan_00482');
  });
});