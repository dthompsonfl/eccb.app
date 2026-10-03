/**
 * Tests for capability classification in the Smart Upload model-discovery layer.
 *
 * The cases below are pinned to REAL provider payloads captured from live
 * APIs, so a regression here means a real admin would see the wrong dropdown.
 */

import { describe, it, expect } from 'vitest';
import {
  classifyVisionCapability,
  classifyProviderHttpStatus,
  describeImageCap,
  describeProviderIssue,
  extractCapabilities,
  extractOllamaShowCapabilities,
  matchesVisionKeyword,
  resolveMaxImagesPerRequest,
  VISION_KEYWORDS,
  type ProviderCapabilities,
} from '../model-capabilities';
import { LLM_PROVIDER_VALUES } from '../providers';

// =============================================================================
// Fixtures — shapes captured verbatim from live provider APIs
// =============================================================================

/** OpenRouter `/api/v1/models` entry (real, trimmed). */
const OPENROUTER_GEMINI_ENTRY = {
  id: 'google/gemini-3.8-flash',
  name: 'Google: Gemini 3.8 Flash',
  context_length: 1048576,
  architecture: {
    modality: 'text+image+file+audio+video->text',
    input_modalities: ['text', 'image', 'video', 'file', 'audio'],
    output_modalities: ['text'],
  },
  pricing: { prompt: '0.00000075' },
};

/** OpenRouter text-only entry. */
const OPENROUTER_TEXT_ONLY_ENTRY = {
  id: 'some-vendor/text-only-model',
  context_length: 8192,
  architecture: { modality: 'text->text', input_modalities: ['text'] },
  pricing: { prompt: '0' },
};

/** Ollama `/api/show` response for a genuinely vision-capable model. */
const OLLAMA_SHOW_VISION = {
  capabilities: ['completion', 'tools', 'vision', 'thinking'],
};

/** Ollama `/api/show` response for an embedding model. */
const OLLAMA_SHOW_EMBEDDING = { capabilities: ['embedding'] };

// =============================================================================
// Structured metadata beats keyword matching
// =============================================================================

describe('classifyVisionCapability — structured metadata', () => {
  it('uses OpenRouter input_modalities to detect vision', () => {
    const verdict = classifyVisionCapability(
      'google/gemini-3.8-flash',
      'openrouter',
      extractCapabilities(OPENROUTER_GEMINI_ENTRY),
    );
    expect(verdict).toEqual({ isVision: true, source: 'structured' });
  });

  it('treats a text-only OpenRouter model as not vision even if the id says "vl"', () => {
    const verdict = classifyVisionCapability(
      'some-vendor/vl-text-model',
      'openrouter',
      extractCapabilities(OPENROUTER_TEXT_ONLY_ENTRY),
    );
    // This is the FALSE POSITIVE the old keyword matching produced.
    expect(verdict.isVision).toBe(false);
    expect(verdict.source).toBe('structured');
  });

  it('parses OpenRouter `modality` string when input_modalities is absent', () => {
    const verdict = classifyVisionCapability(
      'legacy/model',
      'openrouter',
      extractCapabilities({ architecture: { modality: 'text+image->text' } }),
    );
    expect(verdict).toEqual({ isVision: true, source: 'structured' });
  });

  it('treats an Ollama embedding model as not vision', () => {
    const verdict = classifyVisionCapability(
      'nomic-embed-text:latest',
      'ollama',
      { ollamaCapabilities: extractOllamaShowCapabilities(OLLAMA_SHOW_EMBEDDING) ?? [] },
    );
    expect(verdict.isVision).toBe(false);
    expect(verdict.source).toBe('structured');
  });

  it('accepts an Ollama model whose capabilities include vision but whose name has no vision keyword', () => {
    // Real regression case: `gemini-3-pro-preview:latest` is vision-capable but
    // matched none of the old keyword lists.
    const modelId = 'gemini-3-pro-preview:latest';
    expect(matchesVisionKeyword(modelId, 'ollama')).toBe(false);

    const verdict = classifyVisionCapability(
      modelId,
      'ollama',
      { ollamaCapabilities: extractOllamaShowCapabilities(OLLAMA_SHOW_VISION) ?? [] },
    );
    expect(verdict).toEqual({ isVision: true, source: 'structured' });
  });

  it('reads OpenAI `modalities` when present', () => {
    const verdict = classifyVisionCapability(
      'gpt-5',
      'openai',
      extractCapabilities({ modalities: ['text', 'image'] }),
    );
    expect(verdict).toEqual({ isVision: true, source: 'structured' });
  });

  it('reads Mistral-style boolean capability flags', () => {
    const vision = classifyVisionCapability(
      'pixtral-large-latest',
      'mistral',
      extractCapabilities({ capabilities: { vision_audio: true } }),
    );
    expect(vision).toEqual({ isVision: true, source: 'structured' });

    const text = classifyVisionCapability(
      'mistral-large-latest',
      'mistral',
      extractCapabilities({ capabilities: { vision_audio: false } }),
    );
    expect(text).toEqual({ isVision: false, source: 'structured' });
  });

  it('never marks an embedding-only model as vision regardless of metadata', () => {
    const verdict = classifyVisionCapability('text-embedding-vision', 'openai', {
      ollamaCapabilities: ['embedding'],
    });
    expect(verdict.isVision).toBe(false);
  });
});

// =============================================================================
// Provider rules
// =============================================================================

describe('classifyVisionCapability — provider rules', () => {
  it('treats a Gemini model reachable via generateContent as vision-capable', () => {
    const verdict = classifyVisionCapability(
      'models/gemini-2.0-flash',
      'gemini',
      extractCapabilities({
        name: 'models/gemini-2.0-flash',
        supportedGenerationMethods: ['generateContent', 'countTokens'],
      }),
    );
    expect(verdict).toEqual({ isVision: true, source: 'providerRule' });
  });

  it('does not treat a Gemini model without generateContent as vision-capable', () => {
    const verdict = classifyVisionCapability(
      'models/text-embedding-004',
      'gemini',
      extractCapabilities({
        name: 'models/text-embedding-004',
        supportedGenerationMethods: ['embedContent'],
      }),
    );
    expect(verdict.isVision).toBe(false);
  });

  it('treats Claude 3 and newer Anthropic models as vision-capable', () => {
    for (const id of [
      'claude-3-5-sonnet-20241022',
      'claude-3-haiku-20240307',
      'claude-sonnet-4-5',
    ]) {
      expect(classifyVisionCapability(id, 'anthropic').isVision, id).toBe(true);
    }
  });

  it('returns unknown — not a guess — when no metadata and no provider rule apply', () => {
    const verdict = classifyVisionCapability('some-vendor/mystery-model', 'custom');
    expect(verdict).toEqual({ isVision: false, source: 'unknown' });
  });
});

// =============================================================================
// Keyword fallback (documented last resort)
// =============================================================================

describe('classifyVisionCapability — keyword fallback', () => {
  it('is used only when the provider returned no capability metadata', () => {
    const withMeta = classifyVisionCapability('llava', 'ollama', {
      ollamaCapabilities: ['completion'],
    });
    expect(withMeta.source).toBe('structured');

    const withoutMeta = classifyVisionCapability('llava', 'ollama');
    expect(withoutMeta.source).toBe('keyword');
  });

  it('flags a keyword match as the lower-confidence "keyword" source', () => {
    expect(classifyVisionCapability('llava:13b', 'ollama')).toEqual({
      isVision: true,
      source: 'keyword',
    });
  });

  it('has a documented keyword list for every provider that needs one', () => {
    for (const value of LLM_PROVIDER_VALUES) {
      expect(VISION_KEYWORDS[value], `no keyword list for ${value}`).toBeDefined();
    }
  });
});

// =============================================================================
// Image caps
// =============================================================================

describe('resolveMaxImagesPerRequest', () => {
  it('returns the provider cap from providers.ts', () => {
    expect(resolveMaxImagesPerRequest('groq', 'llama-3.2-90b-vision-preview', 1)).toBe(1);
    expect(resolveMaxImagesPerRequest('glm-ocr', 'zai-org/GLM-OCR', 1)).toBe(1);
    expect(resolveMaxImagesPerRequest('openrouter', 'any/model', 20)).toBe(20);
  });

  it('returns null when the provider has no known cap', () => {
    expect(resolveMaxImagesPerRequest('openai', 'gpt-4o', undefined)).toBeNull();
  });

  it('clamps a per-model cap to the provider cap', () => {
    expect(resolveMaxImagesPerRequest('groq', 'm', 1, 50)).toBe(1);
  });

  it('uses a per-model cap when it is tighter than the provider cap', () => {
    expect(resolveMaxImagesPerRequest('openrouter', 'm', 20, 4)).toBe(4);
  });

  it('ignores a nonsensical per-model cap', () => {
    expect(resolveMaxImagesPerRequest('openrouter', 'm', 20, 0)).toBe(20);
    expect(resolveMaxImagesPerRequest('openrouter', 'm', 20, -3)).toBe(20);
  });
});

describe('describeImageCap', () => {
  it('explains a single-image cap in plain language', () => {
    expect(describeImageCap(1, 'Groq')).toContain('only 1 page image');
  });

  it('explains a multi-image cap', () => {
    expect(describeImageCap(20, 'OpenRouter')).toContain('up to 20 page images');
  });

  it('says nothing when the cap is unknown', () => {
    expect(describeImageCap(null, 'OpenAI')).toBeNull();
  });
});

// =============================================================================
// Admin-facing messages
// =============================================================================

describe('describeProviderIssue', () => {
  it('tells the admin exactly what to do when no key is saved', () => {
    expect(describeProviderIssue('OpenAI', 'missing-api-key')).toBe(
      'No API key saved for OpenAI. Add one in Settings, then try again.',
    );
  });

  it('distinguishes a rejected key from an unreachable server', () => {
    expect(describeProviderIssue('OpenAI', 'unauthorized')).toContain('rejected the saved API key');
    expect(describeProviderIssue('Ollama (Local / Self-hosted)', 'unreachable')).toContain(
      'Could not reach',
    );
  });

  it('never leaks an endpoint, key, or stack trace', () => {
    const messages = [
      describeProviderIssue('OpenAI', 'missing-api-key'),
      describeProviderIssue('OpenAI', 'missing-endpoint'),
      describeProviderIssue('OpenAI', 'invalid-endpoint'),
      describeProviderIssue('OpenAI', 'unauthorized'),
      describeProviderIssue('OpenAI', 'unreachable'),
      describeProviderIssue('OpenAI', 'no-models'),
      describeProviderIssue('OpenAI', 'unknown'),
    ];
    for (const message of messages) {
      expect(message).not.toMatch(/sk-|Bearer|https?:\/\/|at Object|Error:/);
    }
  });

  it('has a message for every issue kind', () => {
    const kinds = [
      'missing-api-key', 'missing-endpoint', 'invalid-endpoint',
      'unauthorized', 'unreachable', 'no-models', 'unknown',
    ] as const;
    for (const kind of kinds) {
      expect(describeProviderIssue('OpenAI', kind).length).toBeGreaterThan(10);
    }
  });
});

describe('classifyProviderHttpStatus', () => {
  it('maps credential statuses to unauthorized', () => {
    expect(classifyProviderHttpStatus(401)).toBe('unauthorized');
    expect(classifyProviderHttpStatus(403)).toBe('unauthorized');
  });

  it('maps other failures to unreachable', () => {
    expect(classifyProviderHttpStatus(404)).toBe('unreachable');
    expect(classifyProviderHttpStatus(500)).toBe('unreachable');
    expect(classifyProviderHttpStatus(429)).toBe('unreachable');
  });
});

// =============================================================================
// Extraction robustness
// =============================================================================

describe('extractCapabilities', () => {
  it('returns an empty object for junk input rather than throwing', () => {
    const caps: ProviderCapabilities = extractCapabilities({ architecture: 'nope' });
    expect(caps.inputModalities).toBeUndefined();
  });

  it('lowercases modality tokens for reliable comparison', () => {
    const caps = extractCapabilities({
      architecture: { input_modalities: ['Text', 'IMAGE'] },
    });
    expect(caps.inputModalities).toEqual(['text', 'image']);
  });
});