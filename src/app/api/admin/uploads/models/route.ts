import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/guards';
import { checkUserPermission } from '@/lib/auth/permissions';
import { logger } from '@/lib/logger';
import { prisma } from '@/lib/db';
import {
  LLM_PROVIDERS,
  LLM_PROVIDER_VALUES,
  getProviderMeta,
  type LLMProviderValue,
} from '@/lib/llm/providers';
import { getPrimaryApiKey } from '@/lib/llm/api-key-service';
import { validateOutboundEndpoint } from '@/lib/network/safe-endpoint';
import {
  classifyVisionCapability,
  classifyProviderHttpStatus,
  describeImageCap,
  describeProviderIssue,
  extractCapabilities,
  extractOllamaShowCapabilities,
  resolveMaxImagesPerRequest,
  type CapabilitySource,
  type ProviderCapabilities,
  type ProviderIssueKind,
  type RawModelEntry,
} from '@/lib/llm/model-capabilities';

import { SYSTEM_CONFIG } from '@/lib/auth/permission-constants';

/** Plain-language 4xx/5xx responses the admin UI can render verbatim. */
class ProviderIssueError extends Error {
  readonly status: number;
  readonly kind: ProviderIssueKind;

  constructor(status: number, kind: ProviderIssueKind, message: string) {
    super(message);
    this.name = 'ProviderIssueError';
    this.status = status;
    this.kind = kind;
  }
}
/**
 * Resolve the effective endpoint URL for a provider.
 * If `clientEndpoint` is provided, use it; otherwise fall back to DB or provider default.
 */
async function resolveEndpoint(provider: Provider, clientEndpoint?: string): Promise<string | undefined> {
  if (clientEndpoint && clientEndpoint.trim()) {
    return clientEndpoint.trim();
  }
  // Try DB
  try {
    const row = await prisma.systemSetting.findUnique({ where: { key: 'llm_endpoint_url' } });
    if (row?.value?.trim()) return row.value.trim();
  } catch { /* ignore */ }
  // Fallback to provider default
  const meta = LLM_PROVIDERS.find((p) => p.value === provider);
  return meta?.defaultEndpoint || undefined;
}

// =============================================================================
// Enhanced Types with Recommendation Support
// =============================================================================

type Provider = LLMProviderValue;

interface ModelInfo {
  id: string;
  name: string;
  isVision: boolean;
  supportsStructuredOutput: boolean;
  contextWindow: number | null;
  pricePerToken: number | null;
  priceDisplay: string;
  isDeprecated: boolean;
  releaseDate: string | null; // ISO date or null if unknown
  providerNote?: string;
  // Recommendation fields
  recommended: boolean;
  recommendationReason?: string;
  recommendationScore: number;
  /**
   * How the vision verdict was reached: 'structured' (provider told us),
   * 'providerRule' (certain provider-level truth), 'keyword' (name matching
   * fallback) or 'unknown'. Surfaced so the UI never overstates certainty.
   */
  visionSource: CapabilitySource;
  /** Effective page-image cap for this model, or null when unknown/unlimited. */
  maxImagesPerRequest: number | null;
}

interface ModelsResponse {
  models: ModelInfo[];
  totalCount: number;
  filteredForVision: boolean;
  recommendedModel: string | null;
  warning?: string;
  /** Plain-language summary when the provider could not be fully queried. */
  notice?: string;
  /** True when any model's vision flag came from keyword matching or is unknown. */
  detectionIsHeuristic: boolean;
}

// =============================================================================
// Configuration Constants
// =============================================================================

const MIN_CONTEXT_WINDOW = 8000;
const VISION_CAPABILITY_WEIGHT = 100;
const COST_WEIGHT = 50;
const RECENCY_WEIGHT = 30;
// Stability weight reserved for future use in model scoring
// const STABILITY_WEIGHT = 20;

// =============================================================================
// Provider Model Metadata
// =============================================================================

interface ModelMetadata {
  releaseDate: string;
  isDeprecated: boolean;
  contextWindow: number;
  supportsStructuredOutput: boolean;
}

const OPENAI_METADATA: Record<string, ModelMetadata> = {
  'gpt-4o-mini': {
    releaseDate: '2024-07-18',
    isDeprecated: false,
    contextWindow: 128000,
    supportsStructuredOutput: true,
  },
  'gpt-4o': {
    releaseDate: '2024-05-13',
    isDeprecated: false,
    contextWindow: 128000,
    supportsStructuredOutput: true,
  },
  'gpt-4-turbo': {
    releaseDate: '2024-04-09',
    isDeprecated: true,
    contextWindow: 128000,
    supportsStructuredOutput: true,
  },
  'gpt-4-vision-preview': {
    releaseDate: '2023-11-06',
    isDeprecated: true,
    contextWindow: 128000,
    supportsStructuredOutput: false,
  },
};

const GEMINI_METADATA: Record<string, ModelMetadata> = {
  'gemini-2.0-flash': {
    releaseDate: '2025-02-05',
    isDeprecated: false,
    contextWindow: 1000000,
    supportsStructuredOutput: true,
  },
  'gemini-2.5-flash-preview': {
    releaseDate: '2025-04-01',
    isDeprecated: false,
    contextWindow: 1000000,
    supportsStructuredOutput: true,
  },
  'gemini-1.5-flash': {
    releaseDate: '2024-09-24',
    isDeprecated: false,
    contextWindow: 1000000,
    supportsStructuredOutput: true,
  },
  'gemini-2.5-pro-preview': {
    releaseDate: '2025-04-01',
    isDeprecated: false,
    contextWindow: 1000000,
    supportsStructuredOutput: true,
  },
  'gemini-1.5-pro': {
    releaseDate: '2024-05-24',
    isDeprecated: false,
    contextWindow: 2000000,
    supportsStructuredOutput: true,
  },
};

const ANTHROPIC_METADATA: Record<string, ModelMetadata> = {
  'claude-3-5-sonnet-20241022': {
    releaseDate: '2024-10-22',
    isDeprecated: false,
    contextWindow: 200000,
    supportsStructuredOutput: true,
  },
  'claude-3-5-haiku-20241022': {
    releaseDate: '2024-10-22',
    isDeprecated: false,
    contextWindow: 200000,
    supportsStructuredOutput: true,
  },
  'claude-3-opus-20240229': {
    releaseDate: '2024-02-29',
    isDeprecated: false,
    contextWindow: 200000,
    supportsStructuredOutput: true,
  },
  'claude-3-haiku-20240307': {
    releaseDate: '2024-03-07',
    isDeprecated: false,
    contextWindow: 200000,
    supportsStructuredOutput: true,
  },
};

// =============================================================================
// Hard-coded Price Tables (input price per token)
// =============================================================================

const OPENAI_PRICES: Record<string, number> = {
  'gpt-4o-mini': 0.00000015,
  'gpt-4o': 0.0000025,
  'gpt-4-turbo': 0.00001,
  'gpt-4-vision-preview': 0.00001,
};

const GEMINI_PRICES: Record<string, number> = {
  'models/gemini-2.0-flash': 0.00000010,
  'models/gemini-2.5-flash-preview': 0.00000015,
  'models/gemini-1.5-flash': 0.00000035,
  'models/gemini-2.5-pro-preview': 0.00000125,
  'models/gemini-1.5-pro': 0.00000175,
};

// =============================================================================
// Vision Model Keywords
//
// NOTE: name matching is a LAST-RESORT FALLBACK only. The authoritative
// decision lives in `classifyVisionCapability` (lib/llm/model-capabilities.ts),
// which prefers structured provider metadata. These lists are consulted ONLY
// when a provider returns no capability metadata for a model — see
// VISION_KEYWORDS in that module for the canonical list and full rationale.
// =============================================================================

/** Hard-coded provider fetches, per-provider labels for admin messaging. */
const PROVIDER_LABELS: Record<Provider, string> = Object.fromEntries(
  LLM_PROVIDER_VALUES.map((value) => [value, getProviderMeta(value)?.label ?? value]),
) as Record<Provider, string>;

function providerLabel(provider: Provider): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

// =============================================================================
// Helper Functions
// =============================================================================

function formatPrice(pricePerToken: number | null): string {
  if (pricePerToken === null || pricePerToken === 0) {
    return 'Free';
  }
  const pricePer1K = pricePerToken * 1000;
  return `$${pricePer1K.toFixed(5)} / 1K tokens`;
}

function getProviderNote(modelId: string, provider: Provider): string | undefined {
  if (provider === 'gemini') {
    if (modelId.includes('pro')) {
      return 'Rate limit: 2 RPM (free tier) / 1,000 RPM (paid)';
    }
    return 'Rate limit: 15 RPM (free tier) / 4,000 RPM (paid)';
  }
  if (provider === 'openai') {
    return 'Rate limit: 500 RPM (Tier 1)';
  }
  if (provider === 'openrouter') {
    if (modelId.includes(':free')) {
      return 'Rate limit: 20 RPM (free tier)';
    }
  }
  return undefined;
}

/**
 * Build a ModelInfo with a provider-authoritative vision verdict and the
 * effective per-model image cap. All provider fetchers go through this so the
 * capability rules stay in one tested place.
 */
function buildModelInfo(
  id: string,
  provider: Provider,
  overrides: Partial<ModelInfo> = {},
  capabilities: ProviderCapabilities = {},
): ModelInfo {
  const verdict = classifyVisionCapability(id, provider, capabilities);
  const providerCap = getProviderMeta(provider)?.maxImagesPerRequest;

  return {
    id,
    name: overrides.name ?? id,
    isVision: overrides.isVision ?? verdict.isVision,
    supportsStructuredOutput: overrides.supportsStructuredOutput ?? false,
    contextWindow: overrides.contextWindow ?? null,
    pricePerToken: overrides.pricePerToken ?? null,
    priceDisplay: overrides.priceDisplay ?? formatPrice(overrides.pricePerToken ?? null),
    isDeprecated: overrides.isDeprecated ?? false,
    releaseDate: overrides.releaseDate ?? null,
    providerNote: overrides.providerNote,
    recommended: false,
    recommendationScore: 0,
    visionSource: verdict.source,
    maxImagesPerRequest: resolveMaxImagesPerRequest(provider, id, providerCap, overrides.maxImagesPerRequest),
  };
}

/** Marks the best candidate and returns the same array (mutating in place). */
function applyRecommendation(
  models: ModelInfo[],
  reason: string,
): ModelInfo[] {
  const recommended = selectRecommendedModel(models);
  if (recommended) {
    recommended.recommended = true;
    recommended.recommendationReason = reason;
  }
  return models;
}

function getModelMetadata(modelId: string, provider: Provider): Partial<ModelMetadata> {
  if (provider === 'openai') {
    return OPENAI_METADATA[modelId] || {};
  }
  if (provider === 'gemini') {
    // Gemini returns model names with 'models/' prefix
    const normalizedId = modelId.startsWith('models/') ? modelId : `models/${modelId}`;
    return GEMINI_METADATA[normalizedId] || GEMINI_METADATA[modelId] || {};
  }
  if (provider === 'anthropic') {
    return ANTHROPIC_METADATA[modelId] || {};
  }
  return {};
}

function getGlmOcrModels(): ModelInfo[] {
  const label = providerLabel('glm-ocr');
  return [
    buildModelInfo(
      'zai-org/GLM-OCR',
      'glm-ocr',
      {
        priceDisplay: 'Local GPU',
        maxImagesPerRequest: 1,
        providerNote:
          'Image-based OCR only. Pages are sent one at a time. Native PDF input stays disabled for Smart Upload.',
      },
      { ollamaCapabilities: ['vision'] },
    ),
  ].map((m) => {
    m.recommended = true;
    m.recommendationReason = `Best fit for local Smart Upload OCR (${label})`;
    m.recommendationScore = 1000;
    return m;
  });
}

function calculateRecommendationScore(model: ModelInfo): number {
  let score = 0;

  // Vision capability is required
  if (model.isVision) {
    score += VISION_CAPABILITY_WEIGHT;
  }

  // Structured output support is important
  if (model.supportsStructuredOutput) {
    score += 20;
  }

  // Adequate context window
  if (model.contextWindow && model.contextWindow >= MIN_CONTEXT_WINDOW) {
    score += 15;
  }

  // Cost factor (lower is better)
  if (model.pricePerToken === null || model.pricePerToken === 0) {
    score += COST_WEIGHT; // Free tier bonus
  } else if (model.pricePerToken < 0.000001) {
    score += COST_WEIGHT * 0.8;
  } else if (model.pricePerToken < 0.00001) {
    score += COST_WEIGHT * 0.5;
  } else if (model.pricePerToken < 0.0001) {
    score += COST_WEIGHT * 0.2;
  }

  // Recency (prefer newer models)
  if (model.releaseDate) {
    const releaseDate = new Date(model.releaseDate);
    const now = new Date();
    const monthsOld = (now.getTime() - releaseDate.getTime()) / (1000 * 60 * 60 * 24 * 30);
    
    if (monthsOld < 3) {
      score += RECENCY_WEIGHT;
    } else if (monthsOld < 6) {
      score += RECENCY_WEIGHT * 0.7;
    } else if (monthsOld < 12) {
      score += RECENCY_WEIGHT * 0.4;
    } else if (monthsOld < 24) {
      score += RECENCY_WEIGHT * 0.1;
    }
  }

  // Deprecation penalty
  if (model.isDeprecated) {
    score -= 100;
  }

  return score;
}

function selectRecommendedModel(models: ModelInfo[]): ModelInfo | null {
  // Filter to valid candidates (vision capable, not deprecated, adequate context)
  const candidates = models.filter(
    (m) => m.isVision && !m.isDeprecated && m.contextWindow && m.contextWindow >= MIN_CONTEXT_WINDOW
  );

  if (candidates.length === 0) {
    // Fall back to any non-deprecated model with vision
    const visionModels = models.filter((m) => m.isVision && !m.isDeprecated);
    if (visionModels.length === 0) return null;
    
    // Pick cheapest
    return visionModels.sort((a, b) => (a.pricePerToken ?? Infinity) - (b.pricePerToken ?? Infinity)
    )[0];
  }

  // Score all candidates
  const scored = candidates.map((model) => ({
    model,
    score: calculateRecommendationScore(model),
  }));

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  return scored[0].model;
}

// =============================================================================
// Provider API Calls
//
// Every fetcher follows the same contract:
//  - bounded timeout, so one slow provider cannot hang the request
//  - upstream failures become ProviderIssueError with a plain-language message
//  - vision detection reads STRUCTURED metadata the provider actually returned
//  - the API key is only ever sent as a header/param, never logged or returned
// =============================================================================

const FETCH_TIMEOUT_MS = 8_000;

/** JSON GET with timeout + plain-language error mapping. */
async function fetchProviderJson(
  url: string,
  provider: Provider,
  init: RequestInit = {},
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    });
  } catch (error) {
    // Network error, DNS failure, or timeout — never surface the raw cause.
    const kind: ProviderIssueKind =
      error instanceof Error && error.name === 'TimeoutError' ? 'unreachable' : 'unreachable';
    throw new ProviderIssueError(
      502,
      kind,
      describeProviderIssue(providerLabel(provider), kind),
    );
  }

  if (!response.ok) {
    const kind = classifyProviderHttpStatus(response.status);
    throw new ProviderIssueError(
      response.status === 401 || response.status === 403 ? 401 : 502,
      kind,
      describeProviderIssue(providerLabel(provider), kind),
    );
  }

  try {
    return await response.json();
  } catch {
    throw new ProviderIssueError(
      502,
      'unknown',
      describeProviderIssue(providerLabel(provider), 'unknown'),
    );
  }
}

/** Reads an array of raw model entries out of an arbitrary provider payload. */
function readModelArray(payload: unknown): RawModelEntry[] {
  if (Array.isArray(payload)) return payload as RawModelEntry[];
  if (typeof payload !== 'object' || payload === null) return [];
  const record = payload as Record<string, unknown>;
  for (const key of ['data', 'models', 'result']) {
    if (Array.isArray(record[key])) return record[key] as RawModelEntry[];
  }
  return [];
}

/**
 * Ollama `/api/show` is a per-model POST that reports a real `capabilities`
 * array. We probe it concurrently (bounded) so vision detection is authoritative
 * rather than keyword-guessed, and fall back to keywords if the probe fails.
 */
async function fetchOllamaShowCapabilities(
  endpoint: string,
  modelName: string,
): Promise<string[] | undefined> {
  try {
    const response = await fetch(`${endpoint}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelName }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    return extractOllamaShowCapabilities(await response.json());
  } catch {
    return undefined;
  }
}

/** Runs `worker` over `items` with a bounded number of in-flight requests. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index]);
    }
  });

  await Promise.all(runners);
  return results;
}

interface OllamaFetchResult {
  models: ModelInfo[];
  /** True when at least one model could not be capability-probed. */
  probeFailed: boolean;
}

async function fetchOllamaModels(
  endpoint: string,
  provider: Provider,
): Promise<OllamaFetchResult> {
  const data = await fetchProviderJson(`${endpoint}/api/tags`, provider);
  const entries = readModelArray(data);

  const named = entries
    .map((entry) => (typeof entry.name === 'string' ? entry.name : entry.model))
    .filter((n): n is string => typeof n === 'string');

  const capabilitiesByModel = new Map<string, string[] | undefined>();
  await mapWithConcurrency(named, 4, async (modelName) => {
    capabilitiesByModel.set(
      modelName,
      await fetchOllamaShowCapabilities(endpoint, modelName),
    );
  });

  let probeFailed = false;

  const models: ModelInfo[] = named.map((modelName) => {
    const probed = capabilitiesByModel.get(modelName);
    if (!probed) probeFailed = true;
    return buildModelInfo(
      modelName,
      provider,
      { priceDisplay: 'Local (no cost)' },
      probed ? { ollamaCapabilities: probed } : {},
    );
  });

  applyRecommendation(models, 'Best vision model available locally');

  return { models, probeFailed };
}
/**
 * OpenAI `/v1/models` returns no per-model modality metadata on every account
 * tier, so structured metadata is used when present and the keyword fallback
 * applies otherwise. Text-only model families are excluded explicitly so the
 * keyword list cannot promote them into the vision dropdown.
 */
const OPENAI_TEXT_ONLY_PREFIXES = ['text-embedding', 'dall-e', 'tts-', 'whisper', 'omni-moderation'];

async function fetchOpenAIModels(apiKey: string): Promise<ModelInfo[]> {
  const data = await fetchProviderJson('https://api.openai.com/v1/models', 'openai', {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  const models: ModelInfo[] = readModelArray(data)
    .filter((entry) => typeof entry.id === 'string')
    .map((entry) => {
      const id = entry.id as string;
      const metadata = getModelMetadata(id, 'openai');
      const pricePerToken = OPENAI_PRICES[id] ?? null;

      return buildModelInfo(
        id,
        'openai',
        {
          name: id,
          supportsStructuredOutput: metadata.supportsStructuredOutput ?? false,
          contextWindow: metadata.contextWindow ?? null,
          pricePerToken,
          isDeprecated: metadata.isDeprecated ?? false,
          releaseDate: metadata.releaseDate ?? null,
          providerNote: getProviderNote(id, 'openai'),
        },
        extractCapabilities(entry),
      );
    })
    .filter((m) => !OPENAI_TEXT_ONLY_PREFIXES.some((prefix) => m.id.toLowerCase().startsWith(prefix)))
    .filter((m) => m.isVision);

  applyRecommendation(models, 'Best balance of cost, quality, and recency');

  return models;
}

/**
 * Anthropic exposes `/v1/models`; we query it and merge the curated metadata
 * table so context window / structured-output details survive. Falls back to
 * the curated list when the key is absent or the call fails — the list is the
 * only source of Anthropic capability facts in this codebase.
 */
async function fetchAnthropicModels(apiKey: string | undefined): Promise<ModelInfo[]> {
  const ids = new Set(Object.keys(ANTHROPIC_METADATA));

  if (apiKey) {
    try {
      const data = await fetchProviderJson('https://api.anthropic.com/v1/models?limit=100', 'anthropic', {
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      });
      for (const entry of readModelArray(data)) {
        if (typeof entry.id === 'string') ids.add(entry.id);
      }
    } catch (error) {
      // A failed listing must not blank the provider — keep the curated list.
      logger.info('Anthropic live model listing unavailable, using curated list', {
        reason: error instanceof ProviderIssueError ? error.kind : 'unknown',
      });
    }
  }

  const models: ModelInfo[] = [...ids]
    .filter((id) => /claude/i.test(id))
    .map((id) => {
      const metadata = ANTHROPIC_METADATA[id];
      return buildModelInfo(id, 'anthropic', {
        name: id,
        // Anthropic publishes no modality field; every Claude 3+ accepts images.
        isVision: true,
        supportsStructuredOutput: metadata?.supportsStructuredOutput ?? true,
        contextWindow: metadata?.contextWindow ?? null,
        priceDisplay: 'Pricing varies by usage tier',
        isDeprecated: metadata?.isDeprecated ?? false,
        releaseDate: metadata?.releaseDate ?? null,
        providerNote: apiKey ? undefined : 'No API key saved yet — add one in Settings before using this model.',
      });
    });

  applyRecommendation(models, 'Best vision model with strong OCR accuracy');

  return models;
}

/**
 * Gemini returns `supportedGenerationMethods` per model — real structured
 * metadata. Only models reachable via `generateContent` can accept images, so
 * that field is the gate; embedding/retrieval/AQA models are excluded.
 */
async function fetchGeminiModels(apiKey: string): Promise<ModelInfo[]> {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200';
  const data = await fetchProviderJson(url, 'gemini', {
    headers: { 'x-goog-api-key': apiKey },
  });

  const models: ModelInfo[] = readModelArray(data)
    .filter((entry) => typeof entry.name === 'string')
    .map((entry) => {
      const modelId = entry.name as string;
      const metadata = getModelMetadata(modelId, 'gemini');
      const pricePerToken = GEMINI_PRICES[modelId] ?? null;

      return buildModelInfo(
        modelId,
        'gemini',
        {
          name: modelId.replace('models/', ''),
          supportsStructuredOutput: metadata.supportsStructuredOutput ?? true,
          contextWindow: metadata.contextWindow ?? 1000000,
          pricePerToken,
          isDeprecated: metadata.isDeprecated ?? false,
          releaseDate: metadata.releaseDate ?? null,
          providerNote: getProviderNote(modelId, 'gemini'),
        },
        extractCapabilities(entry),
      );
    })
    // Not generative → cannot read page images, whatever the name suggests.
    .filter((m) => m.isVision);

  applyRecommendation(models, 'Generous free tier with excellent vision capabilities');

  return models;
}

/**
 * OpenRouter returns authoritative `architecture.input_modalities`. The old
 * code matched only the exact string 'text+image->text', which silently dropped
 * 235 of 295 image-capable models (every model that also accepts file, audio or
 * video input). Verified live against the OpenRouter catalogue.
 *
 * `pricing.prompt` is a decimal STRING, not a number — it is parsed here so
 * free-tier models are detected as free instead of falling through to "$0".
 */
async function fetchOpenRouterModels(apiKey: string): Promise<ModelInfo[]> {
  const data = await fetchProviderJson('https://openrouter.ai/api/v1/models', 'openrouter', {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      // OpenRouter recommends these headers for attribution
      'HTTP-Referer': process.env.NEXT_PUBLIC_APP_URL || 'https://eccb.app',
      'X-Title': 'ECCB Smart Upload',
    },
  });

  const models: ModelInfo[] = readModelArray(data)
    .filter((entry) => typeof entry.id === 'string')
    .map((entry) => {
      const id = entry.id as string;
      const name = typeof entry.name === 'string' ? entry.name : id;
      const pricing = (entry.pricing ?? {}) as Record<string, unknown>;
      const contextWindow =
        typeof entry.context_length === 'number' ? entry.context_length : null;
      const pricePerToken = parsePrice(pricing.prompt);

      return buildModelInfo(
        id,
        'openrouter',
        {
          name,
          supportsStructuredOutput: true,
          contextWindow,
          pricePerToken,
          isDeprecated: false, // OpenRouter omits deprecated models
          releaseDate: null, // Not provided by the OpenRouter API
          providerNote:
            pricePerToken === null || pricePerToken === 0
              ? 'Free tier available — rate limited to about 20 requests per minute.'
              : undefined,
        },
        extractCapabilities(entry),
      );
    })
    .filter((m) => m.isVision);

  const recommended = selectRecommendedModel(models);
  if (recommended) {
    recommended.recommended = true;
    recommended.recommendationReason = pricePerTokenToDisplay(recommended.pricePerToken);
  }

  return models;
}

/**
 * Parses a provider price. Providers return prices as decimal STRINGS
 * (OpenRouter) or numbers (tables in this file); anything else becomes null so
 * it is never mistaken for a free model.
 */
function parsePrice(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function pricePerTokenToDisplay(price: number | null): string {
  if (price === null || price === 0) return 'Free tier available';
  if (price < 0.000001) return 'Very low cost option';
  if (price < 0.00001) return 'Cost-effective choice';
  return 'Premium quality model';
}

/**
 * OpenAI-compatible `/models` listing, used by Custom, Mistral and Groq.
 *
 * Vision detection is marked `unknown` rather than guessed: these endpoints
 * return no capability metadata, and claiming a text-only model can read page
 * images is exactly the failure that wastes an admin's paid requests. Models
 * are returned unfiltered with `filteredForVision: false`, and the UI says so.
 */
async function fetchOpenAICompatibleModels(
  endpoint: string,
  provider: Provider,
  apiKey?: string,
): Promise<ModelInfo[]> {
  const headers: Record<string, string> = {};
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const data = await fetchProviderJson(`${endpoint}/models`, provider, { headers });

  return readModelArray(data)
    .map((entry) => {
      const id =
        (typeof entry.id === 'string' && entry.id) ||
        (typeof entry.name === 'string' && entry.name) ||
        null;
      if (!id) return null;

      return buildModelInfo(
        id,
        provider,
        {
          name: typeof entry.name === 'string' ? entry.name : id,
          supportsStructuredOutput: false,
          contextWindow: null,
          pricePerToken: null,
          priceDisplay: provider === 'mistral' ? 'See Mistral pricing' : 'See Groq pricing',
          providerNote: 'Page-image support could not be confirmed — check the model docs.',
        },
        extractCapabilities(entry),
      );
    })
    .filter((m): m is ModelInfo => m !== null);
}

// =============================================================================
// Main Handler
// =============================================================================

export async function GET(request: NextRequest) {
  try {
    // Authentication and authorization
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const hasPermission = await checkUserPermission(session.user.id, SYSTEM_CONFIG);
    if (!hasPermission) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Parse query parameters
    const { searchParams } = new URL(request.url);
    const provider = searchParams.get('provider') as Provider | null;
    const clientEndpoint = searchParams.get('endpoint') || undefined;

    // Validate required parameters
    if (!provider) {
      return NextResponse.json(
        { error: 'Missing required parameter: provider' },
        { status: 400 }
      );
    }

    // Validate against the canonical provider list — a hard-coded copy here once
    // drifted and rejected `glm-ocr` with a raw "Invalid provider" error.
    const validProviders: readonly Provider[] = LLM_PROVIDER_VALUES;
    if (!LLM_PROVIDER_VALUES.includes(provider)) {
      return NextResponse.json(
        { error: `That provider is not supported. Choose one of: ${validProviders.join(', ')}.` },
        { status: 400 },
      );
    }

    // Resolve API key from the encrypted APIKey table and the endpoint.
    const apiKey = await getPrimaryApiKey(provider);
    const endpoint = await resolveEndpoint(provider, clientEndpoint);
    const meta = getProviderMeta(provider);

    // Providers that call out to a self-chosen URL need SSRF validation.
    const providersUsingEndpoint = ['ollama', 'ollama-cloud', 'custom'];
    let safeEndpoint = endpoint;
    if (providersUsingEndpoint.includes(provider) && endpoint) {
      const endpointPolicy = provider === 'custom' ? 'strict-public' : 'allow-local';
      const validatedEndpoint = validateOutboundEndpoint(endpoint, endpointPolicy);

      if (!validatedEndpoint.valid) {
        return NextResponse.json(
          { error: describeProviderIssue(providerLabel(provider), 'invalid-endpoint') },
          { status: 400 },
        );
      }

      safeEndpoint = validatedEndpoint.url.toString();
    }

    // ---------------------------------------------------------------------
    // Fetch models for the selected provider.
    //
    // Each branch is independent: the request targets exactly one provider, so
    // a failure here can only affect that provider's dropdown. Failures raise
    // ProviderIssueError, which is converted to a plain-language response below
    // instead of a blank list or a raw upstream error.
    // ---------------------------------------------------------------------
    let models: ModelInfo[];
    let filteredForVision = false;
    let warning: string | undefined;
    let notice: string | undefined;

    /** Missing-credential guard shared by every key-requiring provider. */
    const requireApiKey = (): void => {
      if (!apiKey?.trim()) {
        throw new ProviderIssueError(
          400,
          'missing-api-key',
          describeProviderIssue(providerLabel(provider), 'missing-api-key'),
        );
      }
    };

    /** Empty-result guard: never show a bare dropdown with nothing in it. */
    const requireModels = (found: ModelInfo[]): ModelInfo[] => {
      if (found.length === 0) {
        throw new ProviderIssueError(
          200,
          'no-models',
          describeProviderIssue(providerLabel(provider), 'no-models'),
        );
      }
      return found;
    };

    switch (provider) {
      case 'glm-ocr': {
        models = getGlmOcrModels();
        filteredForVision = true;
        warning =
          'GLM-OCR runs as a local image-based OCR provider and reads one page image at a time. Keep full-PDF sending disabled.';
        break;
      }

      case 'ollama':
      case 'ollama-cloud': {
        const ollamaEndpoint = safeEndpoint || meta?.defaultEndpoint || 'http://localhost:11434';
        const result = await fetchOllamaModels(ollamaEndpoint, provider);
        models = requireModels(result.models);
        filteredForVision = true;
        if (result.probeFailed) {
          warning =
            `${providerLabel(provider)} did not report page-image capability for every model, so some were matched by name. Pick a model you know can read images.`;
        }
        break;
      }

      case 'openai': {
        requireApiKey();
        models = requireModels(await fetchOpenAIModels(apiKey));
        filteredForVision = true;
        break;
      }

      case 'anthropic': {
        models = requireModels(await fetchAnthropicModels(apiKey));
        filteredForVision = true;
        if (!apiKey?.trim()) {
          notice = describeProviderIssue(providerLabel(provider), 'missing-api-key');
        }
        break;
      }

      case 'gemini': {
        requireApiKey();
        models = requireModels(await fetchGeminiModels(apiKey));
        filteredForVision = true;
        break;
      }

      case 'openrouter': {
        requireApiKey();
        models = requireModels(await fetchOpenRouterModels(apiKey));
        filteredForVision = true;
        break;
      }

      case 'mistral': {
        requireApiKey();
        models = await fetchOpenAICompatibleModels('https://api.mistral.ai/v1', provider, apiKey);
        warning =
          'Mistral does not report which models can read page images, so this list is unfiltered. Choose a model documented as vision-capable (for example Pixtral).';
        break;
      }

      case 'groq': {
        requireApiKey();
        models = await fetchOpenAICompatibleModels('https://api.groq.com/openai/v1', provider, apiKey);
        warning =
          'Groq does not report which models can read page images, so this list is unfiltered. Only Groq vision models accept page images, and they accept 1 page per request.';
        break;
      }

      case 'custom': {
        if (!safeEndpoint) {
          throw new ProviderIssueError(
            400,
            'missing-endpoint',
            describeProviderIssue(providerLabel(provider), 'missing-endpoint'),
          );
        }
        models = await fetchOpenAICompatibleModels(safeEndpoint, provider, apiKey);
        warning =
          'Custom provider: this server does not report page-image capability, so the list is unfiltered. Choose a model you know can read images.';
        break;
      }
    }

    // Sort models by recommendation (recommended first), then by price.
    // Models whose image support is unconfirmed sort last so an admin is
    // steered toward a verified choice.
    models.sort((a, b) => {
      if (a.recommended && !b.recommended) return -1;
      if (!a.recommended && b.recommended) return 1;
      const aUnknown = a.visionSource === 'unknown' ? 1 : 0;
      const bUnknown = b.visionSource === 'unknown' ? 1 : 0;
      if (aUnknown !== bUnknown) return aUnknown - bUnknown;
      return (a.pricePerToken ?? Infinity) - (b.pricePerToken ?? Infinity);
    });

    const recommendedModel = models.find((m) => m.recommended)?.id ?? null;
    const detectionIsHeuristic = models.some(
      (m) => m.visionSource === 'keyword' || m.visionSource === 'unknown',
    );

    const response: ModelsResponse = {
      models,
      totalCount: models.length,
      filteredForVision,
      recommendedModel,
      detectionIsHeuristic,
    };

    if (warning) response.warning = warning;
    if (notice) response.notice = notice;

    const capNote = describeImageCap(meta?.maxImagesPerRequest ?? null, providerLabel(provider));
    if (capNote) {
      response.warning = response.warning ? `${response.warning} ${capNote}` : capNote;
    }

    logger.info('Fetched models from provider', {
      provider,
      modelCount: models.length,
      filteredForVision,
      detectionIsHeuristic,
      recommendedModel,
      userId: session.user.id,
    });

    return NextResponse.json(response);
  } catch (error) {
    // Provider failures already carry a plain-language, actionable message.
    // Log without the key and return the message the admin can act on.
    if (error instanceof ProviderIssueError) {
      logger.info('Provider model discovery issue', {
        kind: error.kind,
        status: error.status,
      });

      return NextResponse.json(
        { error: error.message, kind: error.kind, models: [], totalCount: 0 },
        { status: error.status === 200 ? 404 : error.status },
      );
    }

    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to fetch models from provider', { error: errorMessage });

    return NextResponse.json(
      {
        error: 'Could not load the model list. Try again in a moment.',
        kind: 'unknown',
        models: [],
        totalCount: 0,
      },
      { status: 502 },
    );
  }
}
// =============================================================================
// OPTIONS
// =============================================================================

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}
