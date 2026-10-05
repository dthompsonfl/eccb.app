import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  OcrEngineSchema,
  normalizeOcrEngineValue,
} from '@/lib/smart-upload/schema';

describe('OCR engine selection', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('selectable engines', () => {
    it('accepts every engine that has a working implementation', () => {
      expect(OcrEngineSchema.parse('tesseract')).toBe('tesseract');
      expect(OcrEngineSchema.parse('ocrmypdf')).toBe('ocrmypdf');
      expect(OcrEngineSchema.parse('native')).toBe('native');
    });

    it('rejects vision_api, which is selectable but not implemented', () => {
      // Regression guard: offering an engine whose runtime path returns empty
      // OCR is a selectable-feature-that-does-not-work defect.
      const result = OcrEngineSchema.safeParse('vision_api');
      expect(result.success).toBe(false);
    });
  });

  describe('normalizeOcrEngineValue', () => {
    it('passes through supported engines unchanged', () => {
      expect(normalizeOcrEngineValue('tesseract')).toBe('tesseract');
      expect(normalizeOcrEngineValue('ocrmypdf')).toBe('ocrmypdf');
      expect(normalizeOcrEngineValue('native')).toBe('native');
    });

    it('falls back to a working engine for a persisted vision_api value', () => {
      // A SystemSetting row saved by an older release must not silently
      // disable OCR for every subsequent upload.
      expect(normalizeOcrEngineValue('vision_api')).toBe('tesseract');
    });

    it('falls back for unknown, empty, and non-string values', () => {
      expect(normalizeOcrEngineValue('')).toBe('tesseract');
      expect(normalizeOcrEngineValue(undefined)).toBe('tesseract');
      expect(normalizeOcrEngineValue(null)).toBe('tesseract');
      expect(normalizeOcrEngineValue('totally-made-up')).toBe('tesseract');
      expect(normalizeOcrEngineValue(42)).toBe('tesseract');
    });

    it('tolerates surrounding whitespace from persisted config values', () => {
      expect(normalizeOcrEngineValue('  tesseract  ')).toBe('tesseract');
    });
  });
});
