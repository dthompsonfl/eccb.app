import { describe, expect, it } from 'vitest';

import { getModelCapabilities, validateCapabilities } from '../capabilities';

describe('GLM-OCR capabilities', () => {
  it('treats glm-ocr provider as vision-capable and not PDF-native', () => {
    const caps = getModelCapabilities('glm-ocr', 'zai-org/GLM-OCR');
    expect(caps.vision).toBe(true);
    expect(caps.pdfNative).toBe(false);
    expect(caps.jsonMode).toBe(false);
    expect(caps.maxImages).toBe(1);
    expect(caps.supportsDataUrls).toBe(true);
  });

  it('detects common GLM-OCR model aliases as vision-capable', () => {
    expect(getModelCapabilities('custom', 'glm-ocr').vision).toBe(true);
    expect(getModelCapabilities('custom', 'glm_ocr').vision).toBe(true);
    expect(getModelCapabilities('custom', 'GLM-OCR').vision).toBe(true);
  });

  it('warns instead of allowing PDF-native assumptions for GLM-OCR', () => {
    const result = validateCapabilities('glm-ocr', 'zai-org/GLM-OCR', 'pdf');
    expect(result.valid).toBe(true);
    expect(result.warnings[0]).toMatch(/does not support native PDF input/i);
  });

  it('rejects image batches larger than the provider cap', () => {
    const result = validateCapabilities('glm-ocr', 'zai-org/GLM-OCR', 'vision', {
      imageCount: 2,
    });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/supports max 1/i);
  });
});
