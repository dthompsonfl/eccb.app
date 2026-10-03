// src/app/api/admin/uploads/models/__tests__/route.test.ts
//
// Coverage guarantees for the model-discovery layer:
//  - every provider in LLM_PROVIDER_VALUES is accepted (no silent fall-through)
//  - missing credentials produce a plain-language message, not a raw error
//  - one provider failing does not affect any other
//  - API keys are never echoed back in the response
//
// Provider payload fixtures are trimmed from real live API responses.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockGetSession = vi.hoisted(() => vi.fn());
const mockCheckUserPermission = vi.hoisted(() => vi.fn());
const mockGetPrimaryApiKey = vi.hoisted(() => vi.fn());
const mockPrismaFindUnique = vi.hoisted(() => vi.fn());
const mockLoggerInfo = vi.hoisted(() => vi.fn());
const mockLoggerError = vi.hoisted(() => vi.fn());
const mockLoggerWarn = vi.hoisted(() => vi.fn());
const mockFetch = vi.hoisted(() => vi.fn());

vi.mock('@/lib/auth/guards', () => ({ getSession: mockGetSession }));
vi.mock('@/lib/auth/permissions', () => ({ checkUserPermission: mockCheckUserPermission }));
vi.mock('@/lib/llm/api-key-service', () => ({ getPrimaryApiKey: mockGetPrimaryApiKey }));
vi.mock('@/lib/db', () => ({
  prisma: { systemSetting: { findUnique: mockPrismaFindUnique } },
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: mockLoggerInfo, error: mockLoggerError, warn: mockLoggerWarn },
}));

import { GET } from '../route';
import { LLM_PROVIDER_VALUES } from '@/lib/llm/providers';

const TEST_USER = { user: { id: 'u1' } };

function req(provider: string, endpoint?: string) {
  const url = new URL('http://localhost/api/admin/uploads/models');
  url.searchParams.set('provider', provider);
  if (endpoint) url.searchParams.set('endpoint', endpoint);
  return new NextRequest(url);
}

/** Builds a fetch stub that dispatches on URL substring. */
function stubFetch(routes: Array<[RegExp, unknown]>) {
  mockFetch.mockImplementation((url: string) => {
    for (const [pattern, body] of routes) {
      if (pattern.test(url)) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(body),
        });
      }
    }
    return Promise.reject(new Error(`unstubbed fetch: ${url}`));
  });
}

/** Real Ollama `/api/tags` + `/api/show` shapes, trimmed. */
const OLLAMA_TAGS = {
  models: [
    { name: 'gemini-3-pro-preview:latest', model: 'gemini-3-pro-preview:latest' },
    { name: 'nomic-embed-text:latest', model: 'nomic-embed-text:latest' },
  ],
};
const OLLAMA_SHOW_VISION = { capabilities: ['completion', 'tools', 'vision'] };
const OLLAMA_SHOW_EMBED = { capabilities: ['embedding'] };

/** Real OpenRouter entry — note the string price and the multi-modal `modality`. */
const OPENROUTER_PAYLOAD = {
  data: [
    {
      id: 'vendor/multimodal',
      name: 'Multimodal',
      context_length: 128000,
      architecture: {
        modality: 'text+image+file+audio+video->text',
        input_modalities: ['text', 'image', 'video', 'file', 'audio'],
      },
      pricing: { prompt: '0.00000075' },
    },
    {
      id: 'vendor/vl-text-only',
      context_length: 8192,
      architecture: { modality: 'text->text', input_modalities: ['text'] },
      pricing: { prompt: '0' },
    },
  ],
};

describe('GET /api/admin/uploads/models', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(TEST_USER);
    mockCheckUserPermission.mockResolvedValue(true);
    mockGetPrimaryApiKey.mockResolvedValue('');
    mockPrismaFindUnique.mockResolvedValue(null);
    global.fetch = mockFetch;
  });

  it('rejects unauthenticated requests', async () => {
    mockGetSession.mockResolvedValue(null);
    const res = await GET(req('openai'));
    expect(res.status).toBe(401);
  });

  it('rejects a request without permission', async () => {
    mockCheckUserPermission.mockResolvedValue(false);
    const res = await GET(req('openai'));
    expect(res.status).toBe(403);
  });

  it('rejects an unknown provider with a plain-language message', async () => {
    const res = await GET(req('not-a-provider'));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('not supported');
  });

  // ------------------------------------------------------------------
  // Coverage: every configured provider must be handled
  // ------------------------------------------------------------------

  it('accepts every provider in LLM_PROVIDER_VALUES (no silent fall-through)', async () => {
    for (const provider of LLM_PROVIDER_VALUES) {
      mockGetPrimaryApiKey.mockResolvedValue('');
      const res = await GET(req(provider));
      const body = await res.json();

      // The old bug: glm-ocr was rejected with "Invalid provider" because the
      // route carried a hand-maintained list that had drifted from providers.ts.
      expect(body.error ?? '', `provider ${provider}`).not.toContain('Invalid provider');
    }
  });

  it('serves glm-ocr from local metadata without any upstream call', async () => {
    const res = await GET(req('glm-ocr'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.totalCount).toBe(1);
    expect(body.models[0].id).toBe('zai-org/GLM-OCR');
    expect(body.models[0].isVision).toBe(true);
    // GLM-OCR accepts a single page image; the cap must be surfaced so the UI
    // cannot configure a request the provider will reject.
    expect(body.models[0].maxImagesPerRequest).toBe(1);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('serves the curated Anthropic list when no key is saved, with a notice', async () => {
    mockGetPrimaryApiKey.mockResolvedValue('');
    const res = await GET(req('anthropic'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.totalCount).toBeGreaterThan(0);
    expect(body.notice).toContain('No API key saved for Anthropic');
  });

  it('merges Anthropic live models with the curated list when a key exists', async () => {
    mockGetPrimaryApiKey.mockResolvedValue('sk-ant-test');
    stubFetch([[/\/v1\/models/, { data: [{ id: 'claude-sonnet-4-5' }] }]]);

    const res = await GET(req('anthropic'));
    const body = await res.json();

    const ids = body.models.map((m: { id: string }) => m.id);
    expect(ids).toContain('claude-sonnet-4-5');
    expect(ids).toContain('claude-3-5-sonnet-20241022');
    expect(body.notice).toBeUndefined();
  });

  it('keeps the curated Anthropic list when the live listing fails', async () => {
    mockGetPrimaryApiKey.mockResolvedValue('sk-ant-test');
    mockFetch.mockRejectedValue(new Error('network down'));

    const res = await GET(req('anthropic'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.totalCount).toBeGreaterThan(0);
  });

  // ------------------------------------------------------------------
  // Plain-language admin UX
  // ------------------------------------------------------------------

  it.each(['openai', 'gemini', 'openrouter', 'mistral', 'groq'])(
    'tells the admin plainly when no API key is saved for %s',
    async (provider) => {
      mockGetPrimaryApiKey.mockResolvedValue('');
      const res = await GET(req(provider));
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.kind).toBe('missing-api-key');
      expect(body.error).toContain('No API key saved');
      expect(body.error).toContain('Settings');
      // Never the raw developer string the old code returned.
      expect(body.error).not.toContain('Missing required parameter');
      expect(body.models).toEqual([]);
    },
  );

  it('reports a rejected key as unauthorized without echoing it', async () => {
    mockGetPrimaryApiKey.mockResolvedValue('sk-secret-value');
    mockFetch.mockResolvedValue({ ok: false, status: 401, json: () => Promise.resolve({}) });

    const res = await GET(req('openai'));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.kind).toBe('unauthorized');
    expect(body.error).toContain('rejected the saved API key');
    expect(JSON.stringify(body)).not.toContain('sk-secret-value');
  });

  it('reports an unreachable provider without a raw fetch error', async () => {
    mockGetPrimaryApiKey.mockResolvedValue('sk-test');
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED 10.0.0.1:443'));

    const res = await GET(req('openai'));
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.error).toContain('Could not reach');
    expect(body.error).not.toContain('ECONNREFUSED');
  });

  it('asks for a server address when the custom provider has none', async () => {
    mockGetPrimaryApiKey.mockResolvedValue('');
    const res = await GET(req('custom'));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.kind).toBe('missing-endpoint');
    expect(body.error).toContain('server address');
  });

  it('explains an empty result rather than returning a blank dropdown', async () => {
    stubFetch([[/\/v1\/models/, { data: [] }]]);
    mockGetPrimaryApiKey.mockResolvedValue('sk-or-test');

    const res = await GET(req('openrouter'));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.kind).toBe('no-models');
    expect(body.error).toContain('page images');
  });

  it('never logs or returns the API key', async () => {
    mockGetPrimaryApiKey.mockResolvedValue('sk-super-secret');
    stubFetch([[/\/v1\/models/, OPENROUTER_PAYLOAD]]);

    const res = await GET(req('openrouter'));
    const text = JSON.stringify(await res.json());

    const logged = [
      ...mockLoggerInfo.mock.calls,
      ...mockLoggerError.mock.calls,
      ...mockLoggerWarn.mock.calls,
    ]
      .map((call) => JSON.stringify(call))
      .join(' ');

    expect(text).not.toContain('sk-super-secret');
    expect(logged).not.toContain('sk-super-secret');
  });

  // ------------------------------------------------------------------
  // Capability correctness
  // ------------------------------------------------------------------

  it('uses OpenRouter input_modalities, not a single modality string', async () => {
    stubFetch([[/\/v1\/models/, OPENROUTER_PAYLOAD]]);
    mockGetPrimaryApiKey.mockResolvedValue('sk-or-test');

    const res = await GET(req('openrouter'));
    const body = await res.json();
    const ids = body.models.map((m: { id: string }) => m.id);

    // The dropped-model bug: 'text+image+file+audio+video->text' was NOT equal to
    // 'text+image->text', so this genuinely vision-capable model was hidden.
    expect(ids).toContain('vendor/multimodal');
    // And the '-vl' name here is text-only, so it must stay out.
    expect(ids).not.toContain('vendor/vl-text-only');
    expect(body.detectionIsHeuristic).toBe(false);
  });

  it('parses OpenRouter string prices so free models read as free', async () => {
    stubFetch([[/\/v1\/models/, OPENROUTER_PAYLOAD]]);
    mockGetPrimaryApiKey.mockResolvedValue('sk-or-test');

    const res = await GET(req('openrouter'));
    const body = await res.json();
    const multimodal = body.models.find((m: { id: string }) => m.id === 'vendor/multimodal');

    // Was the string '0.00000075', which formatPrice would have treated as NaN.
    expect(typeof multimodal.pricePerToken).toBe('number');
    expect(multimodal.pricePerToken).toBeCloseTo(0.00000075, 10);
  });

  it('probes Ollama /api/show for real capabilities instead of guessing by name', async () => {
    mockGetPrimaryApiKey.mockResolvedValue('');
    // /api/show is per-model, so the stub must dispatch on the requested model.
    mockFetch.mockImplementation((url: string, init: RequestInit) => {
      if (/\/api\/show/.test(url)) {
        const model = JSON.parse(String(init.body)).model;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve(
              model === 'nomic-embed-text:latest' ? OLLAMA_SHOW_EMBED : OLLAMA_SHOW_VISION,
            ),
        });
      }
      if (/\/api\/tags/.test(url)) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(OLLAMA_TAGS),
        });
      }
      return Promise.reject(new Error(`unstubbed fetch: ${url}`));
    });

    const res = await GET(req('ollama', 'http://localhost:11434'));
    const body = await res.json();
    const models = body.models as Array<{ id: string; isVision: boolean; visionSource: string }>;

    const vision = models.find((m) => m.id === 'gemini-3-pro-preview:latest');
    const embed = models.find((m) => m.id === 'nomic-embed-text:latest');

    // 'gemini-3-pro-preview' matches no keyword, yet Ollama reports vision.
    expect(vision?.isVision).toBe(true);
    expect(vision?.visionSource).toBe('structured');
    // The embedding model is excluded from the vision dropdown.
    expect(embed?.isVision).toBe(false);
  });

  it('falls back to keyword matching and says so when the Ollama probe fails', async () => {
    mockGetPrimaryApiKey.mockResolvedValue('');
    stubFetch([
      [/\/api\/show/, {}],
      [/\/api\/tags/, { models: [{ name: 'llava:13b' }] }],
    ]);
    mockFetch.mockImplementation((url: string) => {
      if (/\/api\/show/.test(url)) return Promise.resolve({ ok: false, status: 500 });
      if (/\/api\/tags/.test(url)) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ models: [{ name: 'llava:13b' }] }),
        });
      }
      return Promise.reject(new Error('unstubbed'));
    });

    const res = await GET(req('ollama', 'http://localhost:11434'));
    const body = await res.json();

    expect(body.models[0].isVision).toBe(true);
    expect(body.models[0].visionSource).toBe('keyword');
    expect(body.detectionIsHeuristic).toBe(true);
    expect(body.warning).toContain('matched by name');
  });

  it('leaves Mistral unfiltered and admits it cannot verify page-image support', async () => {
    mockGetPrimaryApiKey.mockResolvedValue('m-test');
    stubFetch([[/\/models$/, { data: [{ id: 'pixtral-large-latest' }, { id: 'mistral-large-latest' }] }]]);

    const res = await GET(req('mistral'));
    const body = await res.json();

    // No filtering on unverified data — better a superset than a wrong exclusion.
    expect(body.filteredForVision).toBe(false);
    expect(body.totalCount).toBe(2);
    expect(body.detectionIsHeuristic).toBe(true);
    // 'pixtral' matches the documented keyword fallback; the plain text model
    // has no such marker and stays 'unknown' rather than being guessed at.
    const pixtral = body.models.find((m: { id: string }) => m.id === 'pixtral-large-latest');
    const textOnly = body.models.find((m: { id: string }) => m.id === 'mistral-large-latest');
    expect(pixtral.visionSource).toBe('keyword');
    expect(textOnly.visionSource).toBe('unknown');
    expect(textOnly.isVision).toBe(false);
    expect(body.warning).toContain('unfiltered');
  });

  it('leaves Groq unfiltered and states the one-image-per-request constraint', async () => {
    mockGetPrimaryApiKey.mockResolvedValue('gsk-test');
    stubFetch([[/\/models$/, { data: [{ id: 'llama-3.2-90b-vision-preview' }] }]]);

    const res = await GET(req('groq'));
    const body = await res.json();

    expect(body.filteredForVision).toBe(false);
    expect(body.models[0].maxImagesPerRequest).toBe(1);
    expect(body.warning).toContain('1 page per request');
  });

  it('lists custom-provider models unfiltered with a plain-language warning', async () => {
    mockGetPrimaryApiKey.mockResolvedValue('');
    stubFetch([[/\/models$/, { data: [{ id: 'my-local-vlm' }] }]]);

    const res = await GET(req('custom', 'https://llm.example.com/v1'));
    const body = await res.json();

    expect(body.filteredForVision).toBe(false);
    expect(body.models[0].id).toBe('my-local-vlm');
    expect(body.warning).toContain('unfiltered');
  });

  it('rejects a private custom endpoint (SSRF guard still applies)', async () => {
    mockGetPrimaryApiKey.mockResolvedValue('');
    const res = await GET(req('custom', 'http://169.254.169.254/v1'));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain('not a valid web address');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns no provider data when a provider fails', async () => {
    mockGetPrimaryApiKey.mockResolvedValue('sk-test');
    mockFetch.mockRejectedValue(new Error('boom'));

    const res = await GET(req('gemini'));
    const body = await res.json();

    // Failure is scoped to this request/provider; the shape stays stable so the
    // UI never has to render an undefined model list.
    expect(body.models).toEqual([]);
    expect(body.totalCount).toBe(0);
  });
});