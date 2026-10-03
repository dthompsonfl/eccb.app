/**
 * Model capability classification for Smart Upload model discovery.
 *
 * Smart Upload only ever sends **page images** to a model (vision/OCR), so the
 * single question this module answers is: "can this model accept an image?".
 *
 * PREFERENCE ORDER (most to least trustworthy)
 * --------------------------------------------
 * 1. `structured`   — the provider returned explicit capability metadata
 *                     (OpenRouter `architecture.input_modalities`, OpenAI
 *                     `modalities` / `capabilities`, Gemini
 *                     `supportedGenerationMethods`, Ollama `/api/show`
 *                     `capabilities`, Mistral `capabilities`).
 * 2. `keyword`      — the provider returned NO capability metadata for this
 *                     field, so we fall back to name matching. This is the
 *                     ONLY place name matching is used, and the result is
 *                     flagged so callers/UI can say so out loud.
 * 3. `providerRule` — a provider-level truth we are certain about and that
 *                     needs no metadata (e.g. every Gemini model reached by
 *                     `generateContent` accepts images; Anthropic Claude 3+).
 * 4. `unknown`      — nothing could be determined. Never silently coerced to
 *                     "vision capable"; surfaced to the admin as a caveat.
 *
 * Keyword matching is deliberately *last*, because it both false-positives
 * (any `...-vl` / `vision` name that is not actually multimodal) and
 * false-negatives (a genuinely multimodal model with no such token in its
 * name). Verified live against Ollama on this repo's dev host, where
 * `gemini-3-pro-preview:latest` reports `capabilities: [...,'vision',...]`
 * yet matches none of the keyword list.
 */

import type { LLMProviderValue } from './providers';

// =============================================================================
// Types
// =============================================================================

/**
 * Where a vision verdict came from. Surfaced in the API response and the
 * admin UI so a volunteer admin is never misled about how sure we are.
 */
export type CapabilitySource = 'structured' | 'providerRule' | 'keyword' | 'unknown';

export interface VisionVerdict {
  isVision: boolean;
  source: CapabilitySource;
}

/**
 * Normalised capability metadata harvested from a provider response.
 * Every field is optional: providers populate only what they actually return.
 */
export interface ProviderCapabilities {
  /** OpenRouter: `architecture.input_modalities` */
  inputModalities?: readonly string[];
  /** OpenAI: `modalities` array, or `capabilities` array */
  modalities?: readonly string[];
  /** OpenAI / generic: `capabilities` array when it is a flat list */
  capabilities?: readonly string[];
  /** Mistral: `capabilities` object, e.g. `{ vision_audio: true }` */
  capabilityFlags?: Readonly<Record<string, boolean>>;
  /** Gemini: `supportedGenerationMethods` */
  supportedGenerationMethods?: readonly string[];
  /** Ollama `/api/show`: `capabilities` */
  ollamaCapabilities?: readonly string[];
}

/** Structured shapes we read capability data out of. */
export interface RawModelEntry {
  id?: unknown;
  name?: unknown;
  model?: unknown;
  architecture?: unknown;
  modalities?: unknown;
  capabilities?: unknown;
  supportedGenerationMethods?: unknown;
  /** OpenRouter: top-level `context_length` */
  context_length?: unknown;
  /** OpenRouter: top-level `pricing` object with decimal-string prices */
  pricing?: unknown;
}

// =============================================================================
// Constants
// =============================================================================

/** Tokens that mean "accepts image input" in a provider's own vocabulary. */
const IMAGE_INPUT_TOKENS = ['image', 'images', 'vision', 'input_image'];

/** Tokens that mean "produces/embeds rather than accepts". */
const NON_INPUT_TOKENS = ['audio', 'video', 'embedding', 'embeddings'];

/** Mistral-style boolean capability flags meaning image input is supported. */
const VISION_CAPABILITY_FLAGS = ['vision', 'vision_audio', 'image_input', 'multimodal'];

/**
 * KEYWORD FALLBACK LIST — used ONLY when a provider returned no capability
 * metadata for the model (see module header). Each entry is a substring
 * matched against the lowercased model id. Known to be imprecise by nature.
 */
export const VISION_KEYWORDS: Partial<Record<LLMProviderValue, readonly string[]>> = {
  ollama: [
    'vision', 'vl', 'llava', 'bakllava', 'moondream', 'cogvlm',
    'minicpm-v', 'qwen2-vl', 'qwen2.5-vl', 'gemma3', 'llama3.2-vision',
    'mistral', 'phi3-vision', 'internvl', 'pixtral',
  ],
  'ollama-cloud': [
    'vision', 'vl', 'llava', 'bakllava', 'moondream', 'cogvlm',
    'minicpm-v', 'qwen2-vl', 'qwen2.5-vl', 'gemma3', 'llama3.2-vision',
    'mistral', 'phi3-vision', 'internvl', 'pixtral',
  ],
  openai: ['gpt-4o', 'gpt-4-turbo', 'gpt-4-vision', 'gpt-4.1', 'gpt-5', 'o3', 'o4'],
  anthropic: ['claude-3', 'claude-4', 'claude-sonnet', 'claude-opus', 'claude-haiku'],
  gemini: ['gemini'],
  openrouter: ['vision', 'vl', 'gpt-4o', 'gemini', 'claude-3'],
  mistral: ['pixtral', 'mistral-small-3', 'voxtral'],
  groq: ['vision'],
  'glm-ocr': ['glm-ocr'],
  custom: [],
};

// =============================================================================
// Small helpers
// =============================================================================

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((v): v is string => typeof v === 'string');
  return out.length > 0 ? out.map((v) => v.toLowerCase()) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True when any token in `tokens` means "accepts an image". */
function tokensIndicateImageInput(tokens: readonly string[]): boolean {
  return tokens.some((t) => IMAGE_INPUT_TOKENS.includes(t));
}

/** Embedding-only models can never be vision models, whatever the name says. */
function isNonGenerative(capabilities: ProviderCapabilities): boolean {
  const all = [
    ...(capabilities.ollamaCapabilities ?? []),
    ...(capabilities.supportedGenerationMethods ?? []),
    ...(capabilities.capabilities ?? []),
  ];
  return all.length > 0 && all.every((c) => NON_INPUT_TOKENS.includes(c) || c === 'embedding');
}

/** Matches the documented keyword fallback for a provider. */
export function matchesVisionKeyword(
  modelId: string,
  provider: LLMProviderValue,
): boolean {
  const keywords = VISION_KEYWORDS[provider] ?? [];
  const lower = modelId.toLowerCase();
  return keywords.some((k) => lower.includes(k.toLowerCase()));
}

// =============================================================================
// Structured extraction
// =============================================================================

/**
 * Pull structured capability metadata out of a raw provider model entry.
 * Returns only what the provider actually sent — never guesses.
 */
export function extractCapabilities(entry: RawModelEntry): ProviderCapabilities {
  const caps: ProviderCapabilities = {};

  const architecture = entry.architecture;
  if (isRecord(architecture)) {
    // OpenRouter `input_modalities`, and `modality` fallback ("text+image->text")
    const inputModalities = asStringArray(architecture.input_modalities);
    if (inputModalities) {
      caps.inputModalities = inputModalities;
    } else {
      const modality = architecture.modality;
      if (typeof modality === 'string' && modality.includes('->')) {
        const [inputs] = modality.split('->');
        const parsed = inputs
          .split('+')
          .map((m) => m.trim().toLowerCase())
          .filter(Boolean);
        if (parsed.length > 0) caps.inputModalities = parsed;
      }
    }
    const outputModalities = asStringArray(architecture.output_modalities);
    if (outputModalities) caps.capabilityFlags = { output_modalities: outputModalities.includes('text') };
  }

  // OpenAI `modalities`
  const modalities = asStringArray(entry.modalities);
  if (modalities) caps.modalities = modalities;

  // Ollama `/api/show` `capabilities`, or OpenAI flat `capabilities`
  const capabilities = asStringArray(entry.capabilities);
  if (capabilities) caps.capabilities = capabilities;

  // Mistral `capabilities` object
  if (isRecord(entry.capabilities)) {
    const flags: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(entry.capabilities)) {
      if (typeof v === 'boolean') flags[k.toLowerCase()] = v;
    }
    if (Object.keys(flags).length > 0) caps.capabilityFlags = { ...flags, ...caps.capabilityFlags };
  }

  // Gemini
  const methods = asStringArray(entry.supportedGenerationMethods);
  if (methods) caps.supportedGenerationMethods = methods;

  return caps;
}

/**
 * Probe Ollama `/api/show` response for its `capabilities` array.
 * Separate from `extractCapabilities` because it arrives from a second request.
 */
export function extractOllamaShowCapabilities(payload: unknown): string[] | undefined {
  if (!isRecord(payload)) return undefined;
  return asStringArray(payload.capabilities);
}

// =============================================================================
// Core classification
// =============================================================================

/**
 * Decide whether a model accepts image input.
 *
 * @param modelId    Stable model identifier as returned by the provider.
 * @param provider   Provider slug, used for the keyword fallback + provider rules.
 * @param caps       Structured metadata the provider actually returned.
 */
export function classifyVisionCapability(
  modelId: string,
  provider: LLMProviderValue,
  caps: ProviderCapabilities = {},
): VisionVerdict {
  // Embedding-only models are never vision models, whatever any field claims.
  if (isNonGenerative(caps)) return { isVision: false, source: 'structured' };

  // ---- Tier 1: provider-level rules we are certain about, no metadata needed.
  // Gemini: anything reachable via generateContent accepts image parts.
  if (provider === 'gemini') {
    const methods = caps.supportedGenerationMethods;
    if (methods && methods.includes('generatecontent')) {
      return { isVision: true, source: 'providerRule' };
    }
  }

  // Anthropic: every Claude 3 and newer accepts images. Uses metadata when the
  // provider offers it, otherwise the family rule (which is itself certain).
  if (provider === 'anthropic') {
    const structured = structuredVerdict(caps);
    if (structured) return structured;
    if (/^claude-(3|4|5|[a-z]+-\d)/i.test(modelId) || /claude-(sonnet|opus|haiku)/i.test(modelId)) {
      return { isVision: true, source: 'providerRule' };
    }
  }

  // ---- Tier 1b: structured metadata, when the provider supplied any.
  const structured = structuredVerdict(caps);
  if (structured) return structured;

  // ---- Tier 2: documented keyword fallback (no structured data available).
  if (matchesVisionKeyword(modelId, provider)) {
    return { isVision: true, source: 'keyword' };
  }

  // ---- Tier 3: nothing determined.
  return { isVision: false, source: 'unknown' };
}

/**
 * Interpret structured capability metadata. Returns null when the provider
 * supplied nothing this function can act on, so the caller can fall through.
 */
function structuredVerdict(caps: ProviderCapabilities): VisionVerdict | null {
  if (caps.inputModalities) {
    return { isVision: tokensIndicateImageInput(caps.inputModalities), source: 'structured' };
  }
  if (caps.modalities) {
    return { isVision: tokensIndicateImageInput(caps.modalities), source: 'structured' };
  }
  if (caps.ollamaCapabilities) {
    return {
      isVision: tokensIndicateImageInput(caps.ollamaCapabilities),
      source: 'structured',
    };
  }
  if (caps.capabilities) {
    return { isVision: tokensIndicateImageInput(caps.capabilities), source: 'structured' };
  }
  if (caps.capabilityFlags) {
    const keys = Object.keys(caps.capabilityFlags).map((k) => k.toLowerCase());
    const named = keys.some((k) => VISION_CAPABILITY_FLAGS.includes(k));
    const flagged = VISION_CAPABILITY_FLAGS.some((k) => caps.capabilityFlags?.[k] === true);
    if (named) return { isVision: flagged, source: 'structured' };
  }
  return null;
}

// =============================================================================
// Image-count caps
// =============================================================================

/**
 * Effective maximum images per request for a model.
 *
 * Prefers a per-model cap the provider reported, then falls back to the
 * provider-level cap from `providers.ts`. Returns null when neither exists —
 * meaning "no hard cap known", which the caller must treat as unknown rather
 * than unlimited.
 */
export function resolveMaxImagesPerRequest(
  provider: LLMProviderValue,
  _modelId: string,
  providerCap: number | undefined,
  modelCap?: number | null,
): number | null {
  if (typeof modelCap === 'number' && Number.isFinite(modelCap) && modelCap > 0) {
    return Math.min(modelCap, providerCap ?? modelCap);
  }
  return providerCap ?? null;
}

/**
 * Plain-language note explaining an image cap, for the admin UI.
 * Returns null when the cap is unknown or effectively unlimited.
 */
export function describeImageCap(maxImages: number | null, providerLabel: string): string | null {
  if (maxImages === null) return null;
  if (maxImages <= 1) {
    return `${providerLabel} accepts only 1 page image per request, so pages are sent one at a time. This is automatic.`;
  }
  return `${providerLabel} accepts up to ${maxImages} page images per request. Pages beyond that are split automatically.`;
}

// =============================================================================
// Admin-facing error messages
// =============================================================================

export type ProviderIssueKind =
  | 'missing-api-key'
  | 'missing-endpoint'
  | 'invalid-endpoint'
  | 'unauthorized'
  | 'unreachable'
  | 'no-models'
  | 'unknown';

/**
 * Turn a provider failure into one plain sentence a non-technical admin can act
 * on. Never leaks the API key, the raw upstream body, or a stack trace.
 */
export function describeProviderIssue(
  providerLabel: string,
  kind: ProviderIssueKind,
  detail?: string,
): string {
  switch (kind) {
    case 'missing-api-key':
      return `No API key saved for ${providerLabel}. Add one in Settings, then try again.`;
    case 'missing-endpoint':
      return `No server address saved for ${providerLabel}. Add the address in Settings, then try again.`;
    case 'invalid-endpoint':
      return `The server address saved for ${providerLabel} is not a valid web address. Check it in Settings.`;
    case 'unauthorized':
      return `${providerLabel} rejected the saved API key. Check the key in Settings, then try again.`;
    case 'unreachable':
      return `Could not reach ${providerLabel}. Check your internet connection and that the address in Settings is correct.`;
    case 'no-models':
      return `${providerLabel} did not return any models that can read page images. Check the account plan or add a different provider.`;
    case 'unknown':
    default:
      return detail
        ? `Could not load the ${providerLabel} model list. ${detail}`
        : `Could not load the ${providerLabel} model list. Try again in a moment.`;
  }
}

/**
 * Maps an upstream HTTP status onto a plain-language issue kind.
 * 401/403 are credential problems, everything else is treated as reachability.
 */
export function classifyProviderHttpStatus(status: number): ProviderIssueKind {
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 404) return 'unreachable';
  return 'unreachable';
}