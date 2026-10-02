import { describe, expect, it } from 'vitest';
import {
  ACCEPTED_MEDIA_TYPES,
  bufferIsPdfOrImage,
  bufferMatchesMediaType,
  isAcceptedMediaType,
  isJpegBuffer,
  isPdfBuffer,
  isPngBuffer,
  isTiffBuffer,
  sniffContentType,
} from '../content-sniffing';

/** Minimal, real byte prefixes — no binary fixtures needed for sniffing. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const TIFF_LE = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00]);
const TIFF_BE = Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00]);
const PDF = Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'binary');

describe('format detection', () => {
  it('detects PDF', () => {
    expect(isPdfBuffer(PDF)).toBe(true);
    expect(sniffContentType(PDF)).toEqual({
      mediaType: 'application/pdf',
      imageFormat: null,
      isPdf: true,
      isImage: false,
    });
  });

  it('tolerates leading junk before %PDF', () => {
    const padded = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), PDF]);
    expect(isPdfBuffer(padded)).toBe(true);
  });

  it('detects JPEG', () => {
    expect(isJpegBuffer(JPEG)).toBe(true);
    expect(sniffContentType(JPEG)?.imageFormat).toBe('jpeg');
  });

  it('detects PNG', () => {
    expect(isPngBuffer(PNG)).toBe(true);
    expect(sniffContentType(PNG)?.imageFormat).toBe('png');
  });

  it('detects both TIFF byte orders', () => {
    expect(isTiffBuffer(TIFF_LE)).toBe(true);
    expect(isTiffBuffer(TIFF_BE)).toBe(true);
    expect(sniffContentType(TIFF_BE)?.mediaType).toBe('image/tiff');
  });

  it('rejects content it does not recognise instead of allowing it', () => {
    // The old helper returned true for any unrecognised type, which waved
    // through arbitrary payloads in a validation path.
    const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
    const text = Buffer.from('just some text, not a score');
    const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

    for (const buf of [elf, text, zip]) {
      expect(sniffContentType(buf), buf.toString('hex')).toBeNull();
    }
    expect(isPdfBuffer(text)).toBe(false);
    expect(isPngBuffer(elf)).toBe(false);
  });

  it('rejects an empty buffer', () => {
    expect(sniffContentType(Buffer.alloc(0))).toBeNull();
  });

  it('rejects a truncated signature', () => {
    expect(isPngBuffer(Buffer.from([0x89, 0x50]))).toBe(false);
    expect(isJpegBuffer(Buffer.from([0xff]))).toBe(false);
  });
});

describe('declared-type vs actual content', () => {
  it('accepts content that matches the declared type', () => {
    expect(bufferMatchesMediaType(PDF, 'application/pdf')).toBe(true);
    expect(bufferMatchesMediaType(PNG, 'image/png')).toBe(true);
    expect(bufferMatchesMediaType(JPEG, 'image/jpeg')).toBe(true);
  });

  it('rejects a PNG declared as a PDF', () => {
    // The core anti-spoofing requirement.
    expect(bufferMatchesMediaType(PNG, 'application/pdf')).toBe(false);
  });

  it('rejects a PDF declared as an image', () => {
    expect(bufferMatchesMediaType(PDF, 'image/png')).toBe(false);
  });

  it('rejects unrecognised content for any declared type', () => {
    const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02]);
    for (const type of ACCEPTED_MEDIA_TYPES) {
      expect(bufferMatchesMediaType(elf, type), type).toBe(false);
    }
  });

  it('accepts pdf-or-image for either', () => {
    expect(bufferIsPdfOrImage(PDF)).toBe(true);
    expect(bufferIsPdfOrImage(PNG)).toBe(true);
    expect(bufferIsPdfOrImage(Buffer.from('nope'))).toBe(false);
  });
});

describe('accepted media types', () => {
  it('includes PDF and the supported images', () => {
    expect([...ACCEPTED_MEDIA_TYPES]).toEqual([
      'application/pdf',
      'image/jpeg',
      'image/png',
      'image/tiff',
    ]);
  });

  it('does not accept executable or web formats', () => {
    for (const bad of ['application/x-msdownload', 'text/html', 'image/svg+xml', 'application/zip']) {
      expect(isAcceptedMediaType(bad), bad).toBe(false);
    }
    expect(isAcceptedMediaType('image/png')).toBe(true);
  });
});
