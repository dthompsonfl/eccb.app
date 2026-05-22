import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/guards';
import { checkUserPermission } from '@/lib/auth/permissions';
import { logger } from '@/lib/logger';
import { prisma } from '@/lib/db';
import { LLM_PROVIDERS, type LLMProviderValue } from '@/lib/llm/providers';
import { getPrimaryApiKey } from '@/lib/llm/api-key-service';
import { validateOutboundEndpoint } from '@/lib/network/safe-endpoint';

import { SYSTEM_CONFIG } from '@/lib/auth/permission-constants';
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

type Provider = 'glm-ocr' | 'ollama' | 'openai' | 'anthropic' | 'gemini' | 'openrouter' | 'mistral' | 'groq' | 'ollama-cloud' | 'custom';

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
}

interface ModelsResponse {
  models: ModelInfo[];
  totalCount: number;
  filteredForVision: boolean;
  recommendedModel: string | null;
  warning?: string;
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
// =============================================================================

const OLLAMA_VISION_KEYWORDS = [
  'vision', 'vl', 'llava', 'bakllava', 'moondream', 'cogvlm',
  'minicpm-v', 'qwen2-vl', 'qwen2.5-vl', 'gemma3', 'llama3.2-vision',
  'mistral', 'phi3-vision', 'internvl', 'pixtral',
];

const OPENAI_VISION_KEYWORDS = ['gpt-4o', 'gpt-4-turbo', 'gpt-4-vision'];

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

function isVisionModel(modelName: string, provider: Provider, keywords: string[]): boolean {
  const lowerName = modelName.toLowerCase();
  
  if (provider === 'gemini') {
    // All Gemini generateContent models support vision
    return true;
  }
  
  if (provider === 'anthropic') {
    // All Claude 3+ models support vision
    return lowerName.includes('claude-3');
  }
  
  if (provider === 'openrouter') {
    // Check modality hints from API or common patterns
    return (
      lowerName.includes('vision') ||
      lowerName.includes('vl') ||
      lowerName.includes('gpt-4o') ||
      lowerName.includes('gemini') ||
      lowerName.includes('claude-3')
    );
  }
  
  return keywords.some((keyword) => lowerName.includes(keyword.toLowerCase()));
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
  return [
    {
      id: 'zai-org/GLM-OCR',
      name: 'zai-org/GLM-OCR',
      isVision: true,
      supportsStructuredOutput: false,
      contextWindow: null,
      pricePerToken: null,
      priceDisplay: 'Local GPU',
      isDeprecated: false,
      releaseDate: null,
      providerNote: 'Image-based OCR only. Native PDF input stays disabled for Smart Upload.',
      recommended: true,
      recommendationReason: 'Best fit for local Smart Upload OCR migration',
      recommendationScore: 1000,
    },
  ];
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
// =============================================================================

async function fetchOllamaModels(endpoint: string): Promise<ModelInfo[]> {
  const response = await fetch(`${endpoint}/api/tags`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(5_000),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Ollama API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  const models: ModelInfo[] = (data.models || []).map((model: { name: string }) => {
    const isVision = isVisionModel(model.name, 'ollama', OLLAMA_VISION_KEYWORDS);
    return {
      id: model.name,
      name: model.name,
      isVision,
      supportsStructuredOutput: true, // Assume true for most Ollama models
      contextWindow: null, // Unknown without inspecting model details
      pricePerToken: null,
      priceDisplay: 'Local (no cost)',
      isDeprecated: false,
      releaseDate: null,
      recommended: false,
      recommendationScore: 0,
    };
  });

  // Mark recommended model
  const recommended = selectRecommendedModel(models);
  if (recommended) {
    recommended.recommended = true;
    recommended.recommendationReason = 'Best vision model available locally';
  }

  return models;
}

async function fetchOpenAIModels(apiKey: string): Promise<ModelInfo[]> {
  const response = await fetch('https://api.openai.com/v1/models', {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  const models: ModelInfo[] = (data.data || [])
    .map((model: { id: string }) => {
      const metadata = getModelMetadata(model.id, 'openai');
      const isVision = isVisionModel(model.id, 'openai', OPENAI_VISION_KEYWORDS);
      const pricePerToken = OPENAI_PRICES[model.id] ?? null;
      
      return {
        id: model.id,
        name: model.id,
        isVision,
        supportsStructuredOutput: metadata.supportsStructuredOutput ?? false,
        contextWindow: metadata.contextWindow ?? null,
        pricePerToken,
        priceDisplay: formatPrice(pricePerToken),
        isDeprecated: metadata.isDeprecated ?? false,
        releaseDate: metadata.releaseDate ?? null,
        providerNote: getProviderNote(model.id, 'openai'),
        recommended: false,
        recommendationScore: 0,
      };
    })
    .filter((m: ModelInfo) => m.isVision); // Only return vision-capable models

  // Mark recommended model
  const recommended = selectRecommendedModel(models);
  if (recommended) {
    recommended.recommended = true;
    recommended.recommendationReason = 'Best balance of cost, quality, and recency';
  }

  return models;
}

function fetchAnthropicModels(): ModelInfo[] {
  // Anthropic has no public list-models endpoint - use curated list
  const models = Object.keys(ANTHROPIC_METADATA);

  const modelInfos: ModelInfo[] = models.map((id) => {
    const metadata = ANTHROPIC_METADATA[id];
    return {
      id,
      name: id,
      isVision: true, // All Claude 3+ models support vision
      supportsStructuredOutput: metadata.supportsStructuredOutput,
      contextWindow: metadata.contextWindow,
      pricePerToken: null, // Anthropic pricing varies by tier
      priceDisplay: 'Pricing varies by usage tier',
      isDeprecated: metadata.isDeprecated,
      releaseDate: metadata.releaseDate,
      providerNote: 'Requires Anthropic API key',
      recommended: false,
      recommendationScore: 0,
    };
  });

  // Mark recommended model
  const recommended = selectRecommendedModel(modelInfos);
  if (recommended) {
    recommended.recommended = true;
    recommended.recommendationReason = 'Best vision model with strong OCR accuracy';
  }

  return modelInfos;
}

async function fetchGeminiModels(apiKey: string): Promise<ModelInfo[]> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  const models: ModelInfo[] = (data.models || [])
    .filter((model: { name: string; supportedGenerationMethods?: string[] }) => {
      // Must support generateContent (not just embeddings)
      if (!model.supportedGenerationMethods?.includes('generateContent')) {
        return false;
      }
      // Exclude embed and aqa models
      const name = model.name.toLowerCase();
      return !name.includes('embed') && !name.includes('aqa');
    })
    .map((model: { name: string }) => {
      const modelId = model.name;
      const metadata = getModelMetadata(modelId, 'gemini');
      const pricePerToken = GEMINI_PRICES[modelId] ?? null;
      
      return {
        id: modelId,
        name: modelId.replace('models/', ''),
        isVision: true, // All Gemini models with generateContent support vision
        supportsStructuredOutput: metadata.supportsStructuredOutput ?? true,
        contextWindow: metadata.contextWindow ?? 1000000,
        pricePerToken,
        priceDisplay: formatPrice(pricePerToken),
        isDeprecated: metadata.isDeprecated ?? false,
        releaseDate: metadata.releaseDate ?? null,
        providerNote: getProviderNote(modelId, 'gemini'),
        recommended: false,
        recommendationScore: 0,
      };
    });

  // Mark recommended model
  const recommended = selectRecommendedModel(models);
  if (recommended) {
    recommended.recommended = true;
    recommended.recommendationReason = 'Generous free tier with excellent vision capabilities';
  }

  return models;
}

async function fetchOpenRouterModels(apiKey: string): Promise<ModelInfo[]> {
  const response = await fetch('https://openrouter.ai/api/v1/models', {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      // OpenRouter recommends these headers for attribution
      'HTTP-Referer': process.env.NEXT_PUBLIC_APP_URL || 'https://eccb.app',
      'X-Title': 'ECCB Smart Upload',
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenRouter API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  const models: ModelInfo[] = (data.data || [])
    .map((model: {
      id: string;
      name?: string;
      architecture?: { modality?: string };
      pricing?: { prompt?: number | null };
      context_length?: number;
    }) => {
      const modality = model.architecture?.modality;
      const isVision =
        modality === 'text+image->text' ||
        model.id.toLowerCase().includes('vision') ||
        model.id.toLowerCase().includes('vl') ||
        model.id.toLowerCase().includes('gpt-4o') ||
        model.id.toLowerCase().includes('gemini') ||
        model.id.toLowerCase().includes('claude-3');
      const pricePerToken = model.pricing?.prompt ?? null;

      let providerNote: string | undefined;
      if (pricePerToken === 0 || pricePerToken === null) {
        providerNote = 'Rate limit: 20 RPM (free tier)';
      }

      return {
        id: model.id,
        name: model.name || model.id,
        isVision,
        supportsStructuredOutput: true, // Most OpenRouter models support this
        contextWindow: model.context_length ?? null,
        pricePerToken,
        priceDisplay: formatPrice(pricePerToken),
        isDeprecated: false, // OpenRouter filters deprecated models
        releaseDate: null, // Not provided by OpenRouter API
        providerNote,
        recommended: false,
        recommendationScore: 0,
      };
    })
    .filter((m: ModelInfo) => m.isVision);

  // Mark recommended model
  const recommended = selectRecommendedModel(models);
  if (recommended) {
    recommended.recommended = true;
    recommended.recommendationReason = pricePerTokenToDisplay(recommended.pricePerToken);
  }

  return models;
}

function pricePerTokenToDisplay(price: number | null): string {
  if (price === null || price === 0) return 'Free tier available';
  if (price < 0.000001) return 'Very low cost option';
  if (price < 0.00001) return 'Cost-effective choice';
  return 'Premium quality model';
}

async function fetchCustomModels(endpoint: string, apiKey?: string): Promise<ModelInfo[]> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const response = await fetch(`${endpoint}/models`, {
    method: 'GET',
    headers,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Custom API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  const modelArray = Array.isArray(data) ? data : data.models || [];

  const models: ModelInfo[] = modelArray.map((model: { id?: string; name?: string }) => {
    const id = model.id ?? model.name ?? 'unknown';
    return {
      id,
      name: model.name ?? id,
      isVision: false, // Custom provider - no filtering
      supportsStructuredOutput: false,
      contextWindow: null,
      pricePerToken: null,
      priceDisplay: 'Unknown',
      isDeprecated: false,
      releaseDate: null,
      recommended: false,
      recommendationScore: 0,
    };
  });

  return models;
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

    const validProviders: Provider[] = ['ollama', 'openai', 'anthropic', 'gemini', 'openrouter', 'mistral', 'groq', 'ollama-cloud', 'custom'];
    if (!validProviders.includes(provider)) {
      return NextResponse.json(
        { error: `Invalid provider: ${provider}. Must be one of: ${validProviders.join(', ')}` },
        { status: 400 }
      );
    }

    // Resolve API key from encrypted APIKey table and endpoint
    const apiKey = await getPrimaryApiKey(provider as LLMProviderValue);
    const endpoint = await resolveEndpoint(provider, clientEndpoint);

    // Only validate endpoint for providers that actually use it
    let safeEndpoint = endpoint;
    const providersUsingEndpoint = ['ollama', 'ollama-cloud', 'custom'];
    if (providersUsingEndpoint.includes(provider) && endpoint) {
      const endpointPolicy = provider === 'ollama' || provider === 'ollama-cloud'
        ? 'allow-local'
        : 'strict-public';
      const validatedEndpoint = validateOutboundEndpoint(endpoint, endpointPolicy);

      if (!validatedEndpoint.valid) {
        return NextResponse.json({ error: validatedEndpoint.error }, { status: 400 });
      }

      safeEndpoint = validatedEndpoint.url.toString();
    }

    // Fetch models based on provider
    let models: ModelInfo[];
    let filteredForVision = false;
    let warning: string | undefined;

    switch (provider) {
      case 'glm-ocr': {
        models = getGlmOcrModels();
        filteredForVision = true;
        warning = 'GLM-OCR runs as a local image-based OCR provider. Keep full-PDF sending disabled.';
        break;
      }

      case 'ollama': {
        const ollamaEndpoint = safeEndpoint || 'http://localhost:11434';
        models = await fetchOllamaModels(ollamaEndpoint);
        filteredForVision = true;
        break;
      }

      case 'openai': {
        if (!apiKey) {
          return NextResponse.json(
            { error: 'Missing required parameter: apiKey for openai provider' },
            { status: 400 }
          );
        }
        models = await fetchOpenAIModels(apiKey);
        filteredForVision = true;
        break;
      }

      case 'anthropic': {
        models = fetchAnthropicModels();
        filteredForVision = true;
        break;
      }

      case 'gemini': {
        if (!apiKey) {
          return NextResponse.json(
            { error: 'Missing required parameter: apiKey for gemini provider' },
            { status: 400 }
          );
        }
        models = await fetchGeminiModels(apiKey);
        filteredForVision = true;
        break;
      }

      case 'openrouter': {
        if (!apiKey) {
          return NextResponse.json(
            { error: 'Missing required parameter: apiKey for openrouter provider' },
            { status: 400 }
          );
        }
        models = await fetchOpenRouterModels(apiKey);
        filteredForVision = true;
        break;
      }

      case 'custom': {
        if (!safeEndpoint) {
          return NextResponse.json(
            { error: 'Missing required parameter: endpoint for custom provider' },
            { status: 400 }
          );
        }
        models = await fetchCustomModels(safeEndpoint, apiKey);
        warning = 'Custom provider: vision capability detection unavailable. Please verify model supports vision.';
        break;
      }

      case 'mistral': {
        if (!apiKey) {
          return NextResponse.json(
            { error: 'Missing required parameter: apiKey for mistral provider' },
            { status: 400 }
          );
        }
        // Mistral uses an OpenAI-compatible API at https://api.mistral.ai/v1
        models = await fetchCustomModels('https://api.mistral.ai/v1', apiKey);
        filteredForVision = true;
        warning = 'Mistral: vision capability detection is best-effort. Verify your model supports vision.';
        break;
      }

      case 'groq': {
        if (!apiKey) {
          return NextResponse.json(
            { error: 'Missing required parameter: apiKey for groq provider' },
            { status: 400 }
          );
        }
        // Groq uses an OpenAI-compatible API at https://api.groq.com/openai/v1
        models = await fetchCustomModels('https://api.groq.com/openai/v1', apiKey);
        filteredForVision = true;
        warning = 'Groq: vision capability detection is best-effort. Verify your model supports vision.';
        break;
      }

      case 'ollama-cloud': {
        // Ollama instance at a remote URL (same API as local Ollama)
        const ollamaCloudEndpoint = safeEndpoint || 'http://localhost:11434';
        models = await fetchOllamaModels(ollamaCloudEndpoint);
        filteredForVision = true;
        break;
      }

      default:
        return NextResponse.json({ error: 'Unknown provider' }, { status: 400 });
    }

    // Sort models by recommendation (recommended first), then by price
    models.sort((a, b) => {
      if (a.recommended && !b.recommended) return -1;
      if (!a.recommended && b.recommended) return 1;
      return (a.pricePerToken ?? Infinity) - (b.pricePerToken ?? Infinity);
    });

    const recommendedModel = models.find((m) => m.recommended)?.id ?? null;

    const response: ModelsResponse = {
      models,
      totalCount: models.length,
      filteredForVision,
      recommendedModel,
    };

    if (warning) {
      response.warning = warning;
    }

    logger.info('Fetched models from provider', {
      provider,
      modelCount: models.length,
      filteredForVision,
      recommendedModel,
      userId: session.user.id,
    });

    return NextResponse.json(response);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to fetch models from provider', {
      error: errorMessage,
    });

    return NextResponse.json(
      { error: 'Failed to fetch models from provider.' },
      { status: 502 }
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
