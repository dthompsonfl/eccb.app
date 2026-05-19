// src/lib/llm/providers.ts
// ============================================================
// Single source of truth for LLM provider metadata.
// All default endpoints / models / capabilities live here.
// ============================================================

export const LLM_PROVIDER_VALUES = [
  'glm-ocr',
  'ollama',
  'ollama-cloud',
  'openai',
  'anthropic',
  'gemini',
  'openrouter',
  'mistral',
  'groq',
  'custom',
] as const;

export type LLMProviderValue = (typeof LLM_PROVIDER_VALUES)[number];

export interface ProviderMeta {
  value: LLMProviderValue;
  label: string;
  description: string;
  requiresApiKey: boolean;
  defaultEndpoint: string;
  /** Default vision-capable model for 1st pass */
  defaultVisionModel: string;
  /** Default model for 2nd verification pass */
  defaultVerificationModel: string;
  apiKeyLabel: string;
  apiKeyPlaceholder: string;
  docsUrl: string;
  /** Whether this provider accepts native PDF document input */
  supportsPdfInput: boolean;
  /**
   * Maximum number of images that can be sent in a single request.
   * Undefined means no hard provider-level limit (model determines the cap).
   * Second-pass workers clamp their page-image count to this value when set.
   */
  maxImagesPerRequest?: number;
}

export const LLM_PROVIDERS: ProviderMeta[] = [
  {
    value: 'glm-ocr',
    label: 'GLM-OCR (Local GPU)',
    description: 'Local NVIDIA GPU-backed GLM-OCR service for Smart Upload image OCR',
    requiresApiKey: false,
    defaultEndpoint: 'http://glm-ocr:8090/v1',
    defaultVisionModel: 'zai-org/GLM-OCR',
    defaultVerificationModel: 'zai-org/GLM-OCR',
    apiKeyLabel: 'GLM-OCR Service Token',
    apiKeyPlaceholder: 'Optional bearer token',
    docsUrl: '/docs/smart-upload-glm-ocr',
    supportsPdfInput: false,
    maxImagesPerRequest: 1,
  },
  {
    value: 'ollama',
    label: 'Ollama (Local / Self-hosted)',
    description: 'Free, private, runs on your server or laptop',
    requiresApiKey: false,
    defaultEndpoint: 'http://localhost:11434',
    defaultVisionModel: 'llama3.2-vision',
    defaultVerificationModel: 'qwen2.5:7b',
    apiKeyLabel: '',
    apiKeyPlaceholder: '',
    docsUrl: 'https://ollama.com',
    supportsPdfInput: false,
  },
  {
    value: 'ollama-cloud',
    label: 'Ollama Cloud',
    description: 'Paid, cloud-hosted Ollama models',
    requiresApiKey: true,
    defaultEndpoint: 'https://api.ollama.com',
    defaultVisionModel: 'llama3.2-vision',
    defaultVerificationModel: 'qwen2.5:7b',
    apiKeyLabel: 'Ollama Cloud API Key',
    apiKeyPlaceholder: 'oc_...',
    docsUrl: 'https://ollama.com/cloud',
    supportsPdfInput: false,
  },
  {
    value: 'openai',
    label: 'OpenAI',
    description: 'GPT-4o, GPT-4 Vision — most reliable vision models',
    requiresApiKey: true,
    defaultEndpoint: 'https://api.openai.com/v1',
    defaultVisionModel: 'gpt-4o',
    defaultVerificationModel: 'gpt-4o-mini',
    apiKeyLabel: 'OpenAI API Key',
    apiKeyPlaceholder: 'sk-...',
    docsUrl: 'https://platform.openai.com/api-keys',
    supportsPdfInput: false,
  },
  {
    value: 'anthropic',
    label: 'Anthropic',
    description: 'Claude 3.5 Sonnet — strong reasoning and OCR accuracy',
    requiresApiKey: true,
    defaultEndpoint: 'https://api.anthropic.com',
    defaultVisionModel: 'claude-3-5-sonnet-20241022',
    defaultVerificationModel: 'claude-3-haiku-20240307',
    apiKeyLabel: 'Anthropic API Key',
    apiKeyPlaceholder: 'sk-ant-...',
    docsUrl: 'https://console.anthropic.com/keys',
    supportsPdfInput: true,
  },
  {
    value: 'gemini',
    label: 'Google Gemini',
    description: 'Gemini 2.0 Flash — generous free tier for testing',
    requiresApiKey: true,
    defaultEndpoint: 'https://generativelanguage.googleapis.com/v1beta',
    defaultVisionModel: 'gemini-2.0-flash-exp',
    defaultVerificationModel: 'gemini-2.0-flash-exp',
    apiKeyLabel: 'Gemini API Key',
    apiKeyPlaceholder: 'AIza...',
    docsUrl: 'https://aistudio.google.com/app/apikey',
    supportsPdfInput: true,
  },
  {
    value: 'openrouter',
    label: 'OpenRouter',
    description: 'Access 200+ models via a single API key — free tier available',
    requiresApiKey: true,
    defaultEndpoint: 'https://openrouter.ai/api/v1',
    defaultVisionModel: 'google/gemini-2.0-flash-exp:free',
    // gemma-3-27b-it is text-only; use a free vision-capable model for verification
    defaultVerificationModel: 'meta-llama/llama-3.2-11b-vision-instruct:free',
    apiKeyLabel: 'OpenRouter API Key',
    apiKeyPlaceholder: 'sk-or-...',
    docsUrl: 'https://openrouter.ai/keys',
    supportsPdfInput: false,
    // Conservative cap for free-tier OpenRouter vision models (varies per model)
    maxImagesPerRequest: 20,
  },
  {
    value: 'mistral',
    label: 'Mistral',
    description: 'High-performance open and commercial models from France.',
    requiresApiKey: true,
    defaultEndpoint: 'https://api.mistral.ai/v1',
    // pixtral-large-2411 is Mistral\'s latest multimodal (vision) model
    defaultVisionModel: 'pixtral-large-2411',
    defaultVerificationModel: 'mistral-large-latest',
    apiKeyLabel: 'Mistral API Key',
    apiKeyPlaceholder: 'm_...',
    docsUrl: 'https://console.mistral.ai/api-keys/',
    supportsPdfInput: false,
  },
  {
    value: 'groq',
    label: 'Groq',
    description: 'The world\'s fastest inference, running on custom LPU hardware.',
    requiresApiKey: true,
    defaultEndpoint: 'https://api.groq.com/openai/v1',
    // llama-3.2-90b-vision-preview is Groq\'s most capable vision model
    defaultVisionModel: 'llama-3.2-90b-vision-preview',
    defaultVerificationModel: 'llama-3.3-70b-versatile',
    apiKeyLabel: 'Groq API Key',
    apiKeyPlaceholder: 'gsk_...',
    docsUrl: 'https://console.groq.com/keys',
    supportsPdfInput: false,
    // Groq vision models (llama-3.2-*-vision-*) accept only 1 image per request
    maxImagesPerRequest: 1,
  },
  {
    value: 'custom',
    label: 'Custom (OpenAI-compatible)',
    description: 'vLLM, LM Studio, Mistral, Groq, or any OpenAI-compatible API',
    requiresApiKey: false,
    defaultEndpoint: '',
    defaultVisionModel: '',
    defaultVerificationModel: '',
    apiKeyLabel: 'Custom API Key',
    apiKeyPlaceholder: 'Bearer token or API key',
    docsUrl: '',
    supportsPdfInput: false,
  },
];

/** O(1) lookup — returns undefined for unknown values */
export function getProviderMeta(value: string): ProviderMeta | undefined {
  return LLM_PROVIDERS.find((p) => p.value === value);
}

/**
 * Returns the default API endpoint for the given provider.
 * Returns '' for 'custom' and unknown values.
 */
export function getDefaultEndpointForProvider(value: string): string {
  return getProviderMeta(value)?.defaultEndpoint ?? '';
}
