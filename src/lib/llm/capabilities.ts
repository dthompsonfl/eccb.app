/**
 * LLM Provider Capability Validation
 *
 * Validates that models support requested features (vision, PDF, JSON mode)
 * before making API calls to prevent wasted quota and 400 errors.
 */

import { logger } from '@/lib/logger';

export interface ModelCapabilities {
  /** Model supports image/vision inputs */
  vision: boolean;
  /** Model supports native PDF document input */
  pdfNative: boolean;
  /** Model supports JSON mode / structured output */
  jsonMode: boolean;
  /** Model accepts image data URLs through the adapter path */
  supportsDataUrls: boolean;
  /** Maximum number of images per request */
  maxImages: number;
  /** Maximum tokens per request */
  maxTokens: number;
  /** Whether model supports system messages */
  systemMessages: boolean;
}

/** Models known to be text-only (no vision support) */
const TEXT_ONLY_MODELS = new Set([
  'google/gemma-3-27b-it',
  'google/gemma-3-27b-it:free',
  'google/gemma-2b-it',
  'google/gemma-7b-it',
  'meta-llama/llama-3.1-8b-instruct',
  'meta-llama/llama-3.1-70b-instruct',
  'mistralai/mistral-7b-instruct',
]);

/** Models known to support vision */
const VISION_CAPABLE_MODELS = new Set([
  'zai-org/glm-ocr',
  'glm-ocr',
  'glm_ocr',
  'gpt-4o',
  'gpt-4o-mini',
  'gpt-4-turbo',
  'claude-3-5-sonnet-20241022',
  'claude-3-5-sonnet-20240620',
  'claude-3-opus-20240229',
  'claude-3-sonnet-20240229',
  'claude-3-haiku-20240307',
  'gemini-1.5-flash',
  'gemini-1.5-pro',
  'gemini-2.0-flash-exp',
  'meta-llama/llama-3.2-11b-vision-instruct',
  'meta-llama/llama-3.2-11b-vision-instruct:free',
  'meta-llama/llama-3.2-90b-vision-instruct',
  'llava',
  'llava:latest',
  'bakllava',
  'moondream',
  'cogvlm',
]);

/** Provider-specific default capabilities */
const PROVIDER_DEFAULTS: Record<string, Partial<ModelCapabilities>> = {
  'glm-ocr': { vision: true, pdfNative: false, jsonMode: false, supportsDataUrls: true, maxImages: 1, maxTokens: 4096, systemMessages: true },
  openai: { vision: true, pdfNative: false, jsonMode: true, maxImages: 32, maxTokens: 4096, systemMessages: true },
  anthropic: { vision: true, pdfNative: false, jsonMode: true, maxImages: 20, maxTokens: 4096, systemMessages: true },
  gemini: { vision: true, pdfNative: true, jsonMode: true, maxImages: 16, maxTokens: 8192, systemMessages: true },
  openrouter: { vision: true, pdfNative: false, jsonMode: true, maxImages: 20, maxTokens: 4096, systemMessages: true },
  ollama: { vision: true, pdfNative: false, jsonMode: false, maxImages: 8, maxTokens: 4096, systemMessages: true },
  groq: { vision: true, pdfNative: false, jsonMode: true, maxImages: 1, maxTokens: 4096, systemMessages: true },
  mistral: { vision: true, pdfNative: false, jsonMode: true, maxImages: 8, maxTokens: 4096, systemMessages: true },
  custom: { vision: false, pdfNative: false, jsonMode: false, supportsDataUrls: true, maxImages: 4, maxTokens: 4096, systemMessages: true },
};

/**
 * Get capabilities for a specific provider/model combination.
 */
export function getModelCapabilities(
  provider: string,
  model: string,
): ModelCapabilities {
  const defaults = PROVIDER_DEFAULTS[provider] ?? PROVIDER_DEFAULTS.custom;
  
  // Check for explicitly known text-only models
  if (TEXT_ONLY_MODELS.has(model) || TEXT_ONLY_MODELS.has(model.replace(':free', ''))) {
    return {
      vision: false,
      pdfNative: false,
      jsonMode: defaults.jsonMode ?? false,
      supportsDataUrls: defaults.supportsDataUrls ?? false,
      maxImages: 0,
      maxTokens: defaults.maxTokens ?? 4096,
      systemMessages: defaults.systemMessages ?? true,
    };
  }
  
  // Check for explicitly known vision models
  if (VISION_CAPABLE_MODELS.has(model) || VISION_CAPABLE_MODELS.has(model.replace(':free', ''))) {
    return {
      vision: true,
      pdfNative: defaults.pdfNative ?? false,
      jsonMode: defaults.jsonMode ?? true,
      supportsDataUrls: defaults.supportsDataUrls ?? true,
      maxImages: defaults.maxImages ?? 8,
      maxTokens: defaults.maxTokens ?? 4096,
      systemMessages: defaults.systemMessages ?? true,
    };
  }
  
  // Infer from model name patterns
  const isVision = /vision|vl|llava|bakllava|moondream|cogvlm|gpt-4o|claude-3|gemini|glm[-_]?ocr|zai-org\/glm-ocr/i.test(model);
  const isTextOnly = /gemma-(2b|7b|27b)-it|mistral-7b-instruct|llama-3\.1-(8b|70b)/i.test(model);
  
  return {
    vision: isVision && !isTextOnly,
    pdfNative: defaults.pdfNative ?? false,
    jsonMode: defaults.jsonMode ?? true,
    supportsDataUrls: defaults.supportsDataUrls ?? true,
    maxImages: isVision ? (defaults.maxImages ?? 8) : 0,
    maxTokens: defaults.maxTokens ?? 4096,
    systemMessages: defaults.systemMessages ?? true,
  };
}

export interface CapabilityValidationResult {
  valid: boolean;
  error?: string;
  warnings: string[];
}

/**
 * Validate that a provider/model supports the requested request type.
 */
export function validateCapabilities(
  provider: string,
  model: string,
  requestType: 'vision' | 'pdf' | 'text',
  options?: {
    imageCount?: number;
    requireJson?: boolean;
  },
): CapabilityValidationResult {
  const caps = getModelCapabilities(provider, model);
  const warnings: string[] = [];
  
  // Vision request validation
  if (requestType === 'vision') {
    if (!caps.vision) {
      return {
        valid: false,
        error: `Model "${model}" (${provider}) does not support vision/image inputs. ` +
               `Please select a vision-capable model (e.g., gpt-4o, claude-3-5-sonnet, llama-3.2-vision).`,
        warnings,
      };
    }
    
    if (options?.imageCount && options.imageCount > caps.maxImages) {
      return {
        valid: false,
        error:
          `Request includes ${options.imageCount} images but model "${model}" (${provider}) supports max ${caps.maxImages}. ` +
          `Reduce image count before sending the request.`,
        warnings,
      };
    }
  }
  
  // PDF request validation
  if (requestType === 'pdf' && !caps.pdfNative) {
    warnings.push(
      `Model "${model}" (${provider}) does not support native PDF input. ` +
      `PDF will be converted to images, which may reduce quality.`
    );
  }
  
  // JSON mode validation
  if (options?.requireJson && !caps.jsonMode) {
    warnings.push(
      `Model "${model}" (${provider}) may not support structured JSON output. ` +
      `Response parsing might fail.`
    );
  }
  
  return { valid: true, warnings };
}

/**
 * Assert capabilities and throw if invalid.
 */
export function assertCapabilities(
  provider: string,
  model: string,
  requestType: 'vision' | 'pdf' | 'text',
  options?: {
    imageCount?: number;
    requireJson?: boolean;
  },
): void {
  const result = validateCapabilities(provider, model, requestType, options);
  
  if (!result.valid) {
    logger.error('LLM capability validation failed', {
      provider,
      model,
      requestType,
      error: result.error,
    });
    throw new Error(result.error);
  }
  
  if (result.warnings.length > 0) {
    logger.warn('LLM capability warnings', {
      provider,
      model,
      requestType,
      warnings: result.warnings,
    });
  }
}

/**
 * Check if a model is known to be incompatible with vision requests.
 */
export function isIncompatibleWithVision(provider: string, model: string): boolean {
  const caps = getModelCapabilities(provider, model);
  return !caps.vision;
}

/**
 * Get recommended alternative models for vision tasks.
 */
export function getVisionModelRecommendations(provider: string): string[] {
  const recommendations: Record<string, string[]> = {
    openrouter: [
      'meta-llama/llama-3.2-11b-vision-instruct:free',
      'google/gemini-2.0-flash-exp:free',
    ],
    openai: ['gpt-4o-mini', 'gpt-4o'],
    anthropic: ['claude-3-5-sonnet-20241022', 'claude-3-haiku-20240307'],
    gemini: ['gemini-1.5-flash', 'gemini-2.0-flash-exp'],
    ollama: ['llava:latest', 'bakllava', 'moondream'],
    groq: ['llama-3.2-90b-vision-preview'],
    mistral: ['pixtral-large-2411'],
  };
  
  return recommendations[provider] ?? [];
}
