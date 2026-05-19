/**
 * Tests for LLM provider metadata (src/lib/llm/providers.ts)
 */

import { describe, it, expect } from 'vitest';
import {
  LLM_PROVIDERS,
  LLM_PROVIDER_VALUES,
  getProviderMeta,
  getDefaultEndpointForProvider,
} from '../providers';

describe('LLM_PROVIDERS', () => {
  it('defines a non-empty array of providers', () => {
    expect(LLM_PROVIDERS.length).toBeGreaterThan(0);
  });

  it('has a provider entry for every value in LLM_PROVIDER_VALUES', () => {
    for (const val of LLM_PROVIDER_VALUES) {
      const meta = LLM_PROVIDERS.find(p => p.value === val);
      expect(meta, `Missing provider entry for "${val}"`).toBeDefined();
    }
  });

  it('each provider has required fields', () => {
    for (const p of LLM_PROVIDERS) {
      expect(p.value).toBeTruthy();
      expect(p.label).toBeTruthy();
      expect(p.description).toBeTruthy();
      expect(typeof p.requiresApiKey).toBe('boolean');
      expect(typeof p.defaultEndpoint).toBe('string');
      expect(typeof p.defaultVisionModel).toBe('string');
      expect(typeof p.defaultVerificationModel).toBe('string');
    }
  });
});

describe('getProviderMeta', () => {
  it('returns the correct meta for each provider', () => {
    expect(getProviderMeta('glm-ocr')?.value).toBe('glm-ocr');
    expect(getProviderMeta('ollama')?.value).toBe('ollama');
    expect(getProviderMeta('openai')?.value).toBe('openai');
    expect(getProviderMeta('anthropic')?.value).toBe('anthropic');
    expect(getProviderMeta('gemini')?.value).toBe('gemini');
    expect(getProviderMeta('openrouter')?.value).toBe('openrouter');
    expect(getProviderMeta('custom')?.value).toBe('custom');
  });

  it('returns undefined for unknown providers', () => {
    expect(getProviderMeta('unknown' as never)).toBeUndefined();
  });
});

describe('getDefaultEndpointForProvider', () => {
  it('returns expected defaults for each provider', () => {
    expect(getDefaultEndpointForProvider('glm-ocr')).toBe('http://glm-ocr:8090/v1');
    expect(getDefaultEndpointForProvider('ollama')).toBe('http://localhost:11434');
    expect(getDefaultEndpointForProvider('openai')).toBe('https://api.openai.com/v1');
    expect(getDefaultEndpointForProvider('anthropic')).toBe('https://api.anthropic.com');
    expect(getDefaultEndpointForProvider('gemini')).toBe('https://generativelanguage.googleapis.com/v1beta');
    expect(getDefaultEndpointForProvider('openrouter')).toBe('https://openrouter.ai/api/v1');
    expect(getDefaultEndpointForProvider('custom')).toBe('');
  });

  it('returns empty string for unknown providers', () => {
    expect(getDefaultEndpointForProvider('nonexistent' as never)).toBe('');
  });

  it('does not return values with trailing slashes', () => {
    for (const val of LLM_PROVIDER_VALUES) {
      const ep = getDefaultEndpointForProvider(val);
      expect(ep, `Provider "${val}" endpoint has trailing slash`).not.toMatch(/\/$/);
    }
  });
});

describe('maxImagesPerRequest', () => {
  it('glm-ocr has maxImagesPerRequest of 1 and no PDF input support', () => {
    const glm = getProviderMeta('glm-ocr');
    expect(glm?.maxImagesPerRequest).toBe(1);
    expect(glm?.supportsPdfInput).toBe(false);
    expect(glm?.defaultVisionModel).toBe('zai-org/GLM-OCR');
  });

  it('groq has maxImagesPerRequest of 1 (single-image vision models)', () => {
    const groq = getProviderMeta('groq');
    expect(groq?.maxImagesPerRequest).toBe(1);
  });

  it('openrouter has maxImagesPerRequest of 20 (conservative free-tier cap)', () => {
    const or = getProviderMeta('openrouter');
    expect(or?.maxImagesPerRequest).toBe(20);
  });

  it('openai has no maxImagesPerRequest (undefined = no cap)', () => {
    const openai = getProviderMeta('openai');
    expect(openai?.maxImagesPerRequest).toBeUndefined();
  });

  it('openrouter defaultVerificationModel is a vision-capable model', () => {
    const or = getProviderMeta('openrouter');
    // Must NOT be google/gemma-3-27b-it (text-only — caused the 400 failure)
    expect(or?.defaultVerificationModel).not.toBe('google/gemma-3-27b-it:free');
    // Current value is the llama vision instruct model
    expect(or?.defaultVerificationModel).toContain('vision');
  });
});
