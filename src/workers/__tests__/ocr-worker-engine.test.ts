/**
 * Tests for the OCR worker's engine → OCR-enablement mapping.
 *
 * The defect this guards against: `enableTesseractOcr` was computed as
 * `cfg.ocrEngine === 'tesseract'`, but extractOcrFallbackMetadata gates its OCR
 * branch on `enableTesseractOcr && (ocrEngine === 'tesseract' || ocrEngine === 'native')`.
 * So an admin who selected `native` — the library default, documented as "use
 * native PDF text layer with fallback to tesseract" — got enableTesseractOcr
 * false, the native branch became unreachable, and the worker silently logged
 * 'OCR disabled; using filename fallback'. Zero OCR, no error.
 *
 * `ocrmypdf` must stay excluded: it is a separate binary pipeline, not the
 * in-process Tesseract path.
 *
 * The job-data override must keep winning so an operator can hard-disable OCR
 * for a single job.
 */

import { describe, expect, it } from 'vitest';

import {
  buildOcrDefaults,
  mergeOcrJobOptions,
  resolveEnableTesseractOcr,
} from '../ocr-worker';

type Cfg = Parameters<typeof buildOcrDefaults>[0];

function makeCfg(ocrEngine: 'tesseract' | 'ocrmypdf' | 'native'): Cfg {
  return {
    ocrEngine,
    ocrMode: 'both',
    textProbePages: 10,
    ocrMaxPages: 3,
    ocrConfidenceThreshold: 60,
  } as unknown as Cfg;
}

describe('buildOcrDefaults: engine → enableTesseractOcr', () => {
  it('enables OCR for the native engine (text-layer-first, then tesseract)', () => {
    // This is the regression: native must not be silently downgraded to
    // "OCR disabled; using filename fallback".
    expect(buildOcrDefaults(makeCfg('native')).enableTesseractOcr).toBe(true);
  });

  it('enables OCR for the tesseract engine', () => {
    expect(buildOcrDefaults(makeCfg('tesseract')).enableTesseractOcr).toBe(true);
  });

  it('disables the in-process Tesseract path for the ocrmypdf pipeline', () => {
    // ocrmypdf runs as its own binary pipeline; enabling the Tesseract branch
    // for it would double-process the PDF.
    expect(buildOcrDefaults(makeCfg('ocrmypdf')).enableTesseractOcr).toBe(false);
  });

  it('passes the selected engine and DB-derived limits through unchanged', () => {
    const opts = buildOcrDefaults(makeCfg('native'));
    expect(opts.ocrEngine).toBe('native');
    expect(opts.ocrMode).toBe('both');
    expect(opts.maxTextProbePages).toBe(10);
    expect(opts.maxOcrPages).toBe(3);
    expect(opts.autoAcceptConfidenceThreshold).toBe(60);
  });
});

describe('resolveEnableTesseractOcr', () => {
  it('covers exactly tesseract and native', () => {
    expect(resolveEnableTesseractOcr('tesseract')).toBe(true);
    expect(resolveEnableTesseractOcr('native')).toBe(true);
    expect(resolveEnableTesseractOcr('ocrmypdf')).toBe(false);
  });
});

describe('mergeOcrJobOptions: per-job override precedence', () => {
  it('lets a job hard-disable OCR even when the DB config enables it', () => {
    const defaults = buildOcrDefaults(makeCfg('native'));
    const merged = mergeOcrJobOptions(defaults, { enableTesseractOcr: false });
    // Operator kill-switch: must win over the DB-derived default.
    expect(merged.enableTesseractOcr).toBe(false);
  });

  it('keeps the DB-derived default when the job says nothing about OCR', () => {
    const defaults = buildOcrDefaults(makeCfg('native'));
    expect(mergeOcrJobOptions(defaults, {}).enableTesseractOcr).toBe(true);
    expect(mergeOcrJobOptions(defaults, undefined).enableTesseractOcr).toBe(true);
  });

  it('honours an explicit true from the job even for ocrmypdf', () => {
    const defaults = buildOcrDefaults(makeCfg('ocrmypdf'));
    expect(mergeOcrJobOptions(defaults, { enableTesseractOcr: true }).enableTesseractOcr).toBe(true);
  });

  it('merges non-enablement overrides over defaults without losing the rest', () => {
    const defaults = buildOcrDefaults(makeCfg('native'));
    const merged = mergeOcrJobOptions(defaults, { ocrMode: 'header', maxOcrPages: 1 });
    expect(merged.ocrMode).toBe('header');
    expect(merged.maxOcrPages).toBe(1);
    expect(merged.ocrEngine).toBe('native');
    expect(merged.enableTesseractOcr).toBe(true);
  });
});