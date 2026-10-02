import { describe, expect, it } from 'vitest';
import {
  isCanonicalTitle,
  resolvePartTitle,
  buildPartFilename,
  type NormalisedInstrument,
} from '../part-naming';

const part: Pick<NormalisedInstrument, 'instrument'> = {
  instrument: '1st Bb Clarinet',
};

describe('isCanonicalTitle', () => {
  it('accepts a real extracted title', () => {
    expect(isCanonicalTitle('Lincolnshire Posy')).toBe(true);
  });

  it('rejects placeholder titles that OCR emits when it fails', () => {
    for (const bad of [
      'untitled',
      'Untitled',
      'UNKNOWN',
      'none',
      'null',
      'N/A',
      'scan',
      'scanned',
      'page',
      'Untitled Piece',
    ]) {
      expect(isCanonicalTitle(bad), bad).toBe(false);
    }
  });

  it('rejects empty, non-string, and absurdly long titles', () => {
    expect(isCanonicalTitle('')).toBe(false);
    expect(isCanonicalTitle('   ')).toBe(false);
    expect(isCanonicalTitle(null)).toBe(false);
    expect(isCanonicalTitle(undefined)).toBe(false);
    expect(isCanonicalTitle(123)).toBe(false);
    expect(isCanonicalTitle('x'.repeat(201))).toBe(false);
  });

  it('rejects a bare scan id, which is a filename not a work name', () => {
    expect(isCanonicalTitle('00482')).toBe(false);
    expect(isCanonicalTitle('scan_00482')).toBe(true); // has words, acceptable
  });
});

describe('resolvePartTitle', () => {
  it('names a part from the extracted title, not the uploaded filename', () => {
    // The core requirement: uploading scan_00482.pdf for "Lincolnshire Posy"
    // must not yield scan_00482_1st_Bb_Clarinet.pdf
    const r = resolvePartTitle({
      extractedTitle: 'Lincolnshire Posy',
      uploadedFileName: 'scan_00482.pdf',
      part,
    });

    expect(r.source).toBe('extracted');
    expect(r.title).toBe('Lincolnshire Posy');
    expect(r.displayName).toBe('Lincolnshire Posy 1st Bb Clarinet');
    expect(r.fileName).toBe('Lincolnshire_Posy_1st_Bb_Clarinet.pdf');
    expect(r.fileName).not.toContain('scan_00482');
  });

  it('falls back to the uploaded filename when no title was extracted', () => {
    const r = resolvePartTitle({
      extractedTitle: undefined,
      uploadedFileName: 'scan_00482.pdf',
      part,
    });

    expect(r.source).toBe('upload-filename');
    expect(r.title).toBe('scan_00482');
    expect(r.fileName).toBe('scan_00482_1st_Bb_Clarinet.pdf');
  });

  it('falls back — and says so — when the extracted title is a placeholder', () => {
    for (const bad of ['untitled', 'Unknown', '', null]) {
      const r = resolvePartTitle({
        extractedTitle: bad,
        uploadedFileName: 'scan_00482.pdf',
        part,
      });
      expect(r.source, String(bad)).toBe('upload-filename');
      expect(r.title, String(bad)).toBe('scan_00482');
    }
  });

  it('strips image extensions too, not just .pdf', () => {
    for (const [name, expected] of [
      ['score.png', 'score'],
      ['score.jpg', 'score'],
      ['score.jpeg', 'score'],
      ['score.tiff', 'score'],
      ['score.PDF', 'score'],
    ] as const) {
      const r = resolvePartTitle({ uploadedFileName: name, part });
      expect(r.title, name).toBe(expected);
    }
  });

  it('collapses whitespace in the title', () => {
    const r = resolvePartTitle({
      extractedTitle: '  Lincolnshire   Posy  ',
      uploadedFileName: 'x.pdf',
      part,
    });
    expect(r.displayName).toBe('Lincolnshire Posy 1st Bb Clarinet');
  });

  it('produces a unique slug per part so uploads cannot overwrite each other', () => {
    const a = resolvePartTitle({
      extractedTitle: 'Same Work',
      uploadedFileName: 'x.pdf',
      part,
      partNumber: 1,
      pageRange: [1, 10],
    });
    const b = resolvePartTitle({
      extractedTitle: 'Same Work',
      uploadedFileName: 'x.pdf',
      part,
      partNumber: 2,
      pageRange: [11, 20],
    });

    expect(a.slug).not.toBe(b.slug);
    // Display names may legitimately match; the storage key must not.
    expect(a.fileName).toBe(b.fileName);
  });

  it('sanitises filesystem-unsafe characters from the title', () => {
    const r = resolvePartTitle({
      extractedTitle: 'Song: "A/B" & Dance?',
      uploadedFileName: 'x.pdf',
      part,
    });
    expect(r.fileName).not.toMatch(/[/\\:*?"<>|]/);
    expect(r.fileName.endsWith('.pdf')).toBe(true);
  });

  it('is deterministic', () => {
    const args = {
      extractedTitle: 'Lincolnshire Posy',
      uploadedFileName: 'scan_00482.pdf',
      part,
      partNumber: 1,
      pageRange: [1, 5] as [number, number],
    };
    expect(resolvePartTitle(args)).toEqual(resolvePartTitle(args));
  });

  it('still produces a valid filename when the title is empty and the upload name is bare', () => {
    const r = resolvePartTitle({ uploadedFileName: '.pdf', part });
    expect(r.fileName).toBe(buildPartFilename(r.displayName));
    expect(r.fileName.endsWith('.pdf')).toBe(true);
  });
});
