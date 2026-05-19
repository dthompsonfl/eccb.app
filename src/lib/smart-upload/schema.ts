// src/lib/smart-upload/schema.ts
// ============================================================
// Canonical Smart Upload configuration schema.
// Single source of truth for validation across UI/API/Runtime.
// ============================================================

import { z } from 'zod';
import { PROMPT_VERSION as DEFAULT_PROMPT_VERSION } from './prompts';

// =============================================================================
// Version Constants
// =============================================================================

export const SMART_UPLOAD_SCHEMA_VERSION = '1.0.0';
export const PROMPT_VERSION = DEFAULT_PROMPT_VERSION;

const LEGACY_SECRET_KEYS = [
  'llm_openai_api_key',
  'llm_anthropic_api_key',
  'llm_openrouter_api_key',
  'llm_gemini_api_key',
  'llm_ollama_cloud_api_key',
  'llm_mistral_api_key',
  'llm_groq_api_key',
  'llm_custom_api_key',
] as const;

type LegacySecretKey = typeof LEGACY_SECRET_KEYS[number];

export const SECRET_KEYS = LEGACY_SECRET_KEYS;

const LEGACY_API_KEY_FIELD_BY_PROVIDER: Record<string, LegacySecretKey | ''> = {
  'glm-ocr': '',
  ollama: '',
  'ollama-cloud': 'llm_ollama_cloud_api_key',
  openai: 'llm_openai_api_key',
  anthropic: 'llm_anthropic_api_key',
  gemini: 'llm_gemini_api_key',
  openrouter: 'llm_openrouter_api_key',
  mistral: 'llm_mistral_api_key',
  groq: 'llm_groq_api_key',
  custom: 'llm_custom_api_key',
};

// =============================================================================
// Provider-specific validation
// =============================================================================

// Create provider enum from the existing values array — must match LLM_PROVIDER_VALUES in providers.ts
const providerTuple = ['glm-ocr', 'ollama', 'ollama-cloud', 'openai', 'anthropic', 'gemini', 'openrouter', 'mistral', 'groq', 'custom'] as const;
export const ProviderValueSchema = z.enum(providerTuple);
export type ProviderValue = z.infer<typeof ProviderValueSchema>;

// OCR engine options
const ocrEngineTuple = ['tesseract', 'ocrmypdf', 'vision_api', 'native'] as const;
export const OcrEngineSchema = z.enum(ocrEngineTuple);
export type OcrEngineValue = z.infer<typeof OcrEngineSchema>;

// OCR mode options
const ocrModeTuple = ['header', 'full', 'both'] as const;
export const OcrModeSchema = z.enum(ocrModeTuple);
export type OcrModeValue = z.infer<typeof OcrModeSchema>;

// =============================================================================
// Core Settings Schema
// =============================================================================

/**
 * Smart Upload settings keys that are stored in SystemSettings
 */
export const SMART_UPLOAD_SETTING_KEYS = [
  // Core settings
  'llm_provider',
  'llm_endpoint_url',
  'llm_vision_model',
  'llm_verification_model',

  // Prompts (source of truth)
  'llm_vision_system_prompt',
  'llm_verification_system_prompt',
  'llm_prompt_version',
  // User prompt templates (editable via Admin UI / settings API)
  'llm_vision_user_prompt',
  'llm_vision_metadata_only_user_prompt',
  'llm_pdf_vision_user_prompt',
  'llm_verification_user_prompt',
  'llm_header_label_user_prompt',
  'llm_adjudicator_user_prompt',

  // Behavior settings
  'smart_upload_confidence_threshold',
  'smart_upload_auto_approve_threshold',
  'smart_upload_rate_limit_rpm',
  'smart_upload_skip_parse_threshold',
  'smart_upload_max_concurrent',
  'smart_upload_max_pages',
  'smart_upload_max_file_size_mb',
  'smart_upload_allowed_mime_types',
  'llm_two_pass_enabled',
  // Autonomy settings
  'smart_upload_enable_autonomous_mode',
  'smart_upload_autonomous_approval_threshold',
  'smart_upload_max_pages_per_part',
  'llm_adjudicator_model',
  'llm_header_label_prompt',
  'llm_adjudicator_prompt',
  // Model parameters (JSON)
  'vision_model_params',
  'verification_model_params',

  // Enterprise: OCR-first pipeline
  'smart_upload_local_ocr_enabled',
  'smart_upload_ocr_confidence_threshold',

  // Enterprise: PDF-to-LLM (send full PDF instead of images)
  'smart_upload_send_full_pdf_to_llm',

  // Enterprise: Budget system
  'smart_upload_budget_max_llm_calls_per_session',
  'smart_upload_budget_max_input_tokens_per_session',

  // LLM response cache
  'smart_upload_enable_llm_cache',
  'smart_upload_llm_cache_ttl_seconds',

  // Metadata
  'smart_upload_schema_version',

  // ========================================
  // NEW: OCR-first keys (Phase 1-2)
  // ========================================
  // Master OCR-first enable switch
  'smart_upload_enable_ocr_first',
  // Enforce OCR-based page splitting (LLM used only as fallback)
  'smart_upload_enforce_ocr_splitting',
  // Text layer quality threshold (0-100)
  'smart_upload_text_layer_threshold_pct',
  // OCR mode: header, full, or both
  'smart_upload_ocr_mode',
  // Max pages to run OCR on
  'smart_upload_ocr_max_pages',
  // Pages to probe for text layer
  'smart_upload_text_probe_pages',
  // Whether to store raw OCR text
  'smart_upload_store_raw_ocr_text',
  // OCR engine selection
  'smart_upload_ocr_engine',
  // OCR rate limit (jobs per minute)
  'smart_upload_ocr_rate_limit_rpm',
  // LLM max pages
  'smart_upload_llm_max_pages',
  // LLM max header batches
  'smart_upload_llm_max_header_batches',

  // ========================================
  // NEW: Per-step LLM provider/model keys
  // ========================================
  // Default provider (backward compatible with llm_provider)
  'llm_default_provider',
  // Vision step provider
  'llm_vision_provider',
  // Verification step provider
  'llm_verification_provider',
  // Header label step provider
  'llm_header_label_provider',
  // Adjudicator step provider
  'llm_adjudicator_provider',
  // Header label model (can differ from verification)
  'llm_header_label_model',
  // Header label model params (JSON)
  'llm_header_label_model_params',
  // Adjudicator model params (JSON)
  'llm_adjudicator_model_params',
  // Second-pass image cap override
  'smart_upload_second_pass_max_images',
] as const;

export type SmartUploadSettingKey = typeof SMART_UPLOAD_SETTING_KEYS[number];

// =============================================================================
// JSON Parameter Schemas
// =============================================================================

// Simple string schemas for form compatibility
const JsonParamsSchema = z.string().optional();

const MimeTypesSchema = z.string().optional();

// =============================================================================
// Main Settings Schema
// =============================================================================

/**
 * Strict schema for Smart Upload settings validation.
 * Used by API, UI, and runtime.
 */
export const SmartUploadSettingsSchema = z.object({
  // Provider selection (optional for incremental updates)
  llm_provider: ProviderValueSchema.or(z.literal('')).optional(),

  
  // Endpoint (required for custom, optional for others)
  llm_endpoint_url: z.string().url('Must be a valid URL').or(z.literal('')).optional(),
  
  // Models (optional for incremental settings updates, required at runtime)
  llm_vision_model: z.string().optional(),
  llm_verification_model: z.string().optional(),
  
  // Prompts (optional for updates, defaults provided if missing)
  llm_vision_system_prompt: z.string().optional(),
  llm_verification_system_prompt: z.string().optional(),
  llm_prompt_version: z.string().default(PROMPT_VERSION),

  // User prompt templates (optional — fall back to hardcoded defaults when absent)
  llm_vision_user_prompt: z.string().optional(),
  llm_vision_metadata_only_user_prompt: z.string().optional(),
  llm_pdf_vision_user_prompt: z.string().optional(),
  llm_verification_user_prompt: z.string().optional(),
  llm_header_label_user_prompt: z.string().optional(),
  llm_adjudicator_user_prompt: z.string().optional(),
  
  // Behavior settings with defaults
  smart_upload_confidence_threshold: z
    .union([z.string(), z.number()])
    .transform((v) => {
      const num = typeof v === 'string' ? Number(v) : v;
      return Math.max(0, Math.min(100, num));
    })
    .default(70),
  
  smart_upload_auto_approve_threshold: z
    .union([z.string(), z.number()])
    .transform((v) => {
      const num = typeof v === 'string' ? Number(v) : v;
      return Math.max(0, Math.min(100, num));
    })
    .default(90),
  
  smart_upload_rate_limit_rpm: z
    .union([z.string(), z.number()])
    .transform((v) => {
      const num = typeof v === 'string' ? Number(v) : v;
      return Math.max(1, Math.min(1000, num));
    })
    .default(15),

  smart_upload_skip_parse_threshold: z
    .union([z.string(), z.number()])
    .transform((v) => {
      const num = typeof v === 'string' ? Number(v) : v;
      return Math.max(0, Math.min(100, num));
    })
    .default(60),
  
  smart_upload_max_concurrent: z
    .union([z.string(), z.number()])
    .transform((v) => {
      const num = typeof v === 'string' ? Number(v) : v;
      return Math.max(1, Math.min(50, num));
    })
    .default(3),
  
  smart_upload_max_pages: z
    .union([z.string(), z.number()])
    .transform((v) => {
      const num = typeof v === 'string' ? Number(v) : v;
      return Math.max(1, Math.min(100, num));
    })
    .default(20),
  
  smart_upload_max_file_size_mb: z
    .union([z.string(), z.number()])
    .transform((v) => {
      const num = typeof v === 'string' ? Number(v) : v;
      return Math.max(1, Math.min(500, num));
    })
    .default(50),
  
  smart_upload_allowed_mime_types: MimeTypesSchema,
  llm_two_pass_enabled: z
    .union([z.boolean(), z.string()])
    .transform((v) => (typeof v === 'string' ? v === 'true' : v))
    .default(true),

  // Autonomy settings
  smart_upload_enable_autonomous_mode: z
    .union([z.boolean(), z.string()])
    .transform((v) => (typeof v === 'string' ? v === 'true' : v))
    .default(false),

  smart_upload_autonomous_approval_threshold: z
    .union([z.string(), z.number()])
    .transform((v) => {
      const num = typeof v === 'string' ? Number(v) : v;
      return Math.max(0, Math.min(100, isNaN(num) ? 95 : num));
    })
    .default(95),

  smart_upload_max_pages_per_part: z
    .union([z.string(), z.number()])
    .transform((v) => {
      const num = typeof v === 'string' ? Number(v) : v;
      return Math.max(1, isNaN(num) ? 12 : num);
    })
    .default(12),

  llm_adjudicator_model: z.string().optional(),
  llm_header_label_prompt: z.string().optional(),
  llm_adjudicator_prompt: z.string().optional(),
  
  // Model parameters
  vision_model_params: JsonParamsSchema,
  verification_model_params: JsonParamsSchema,

  // Enterprise: OCR-first pipeline
  smart_upload_local_ocr_enabled: z
    .union([z.boolean(), z.string()])
    .transform((v) => (typeof v === 'string' ? v === 'true' : v))
    .default(true),

  smart_upload_ocr_confidence_threshold: z
    .union([z.string(), z.number()])
    .transform((v) => {
      const num = typeof v === 'string' ? Number(v) : v;
      return Math.max(0, Math.min(100, isNaN(num) ? 60 : num));
    })
    .default(60),

  // Enterprise: PDF-to-LLM
  smart_upload_send_full_pdf_to_llm: z
    .union([z.boolean(), z.string()])
    .transform((v) => (typeof v === 'string' ? v === 'true' : v))
    .default(true),

  // Enterprise: Budget system
  smart_upload_budget_max_llm_calls_per_session: z
    .union([z.string(), z.number()])
    .transform((v) => {
      const num = typeof v === 'string' ? Number(v) : v;
      return Math.max(0, isNaN(num) ? 5 : num);
    })
    .default(5),

  smart_upload_budget_max_input_tokens_per_session: z
    .union([z.string(), z.number()])
    .transform((v) => {
      const num = typeof v === 'string' ? Number(v) : v;
      return Math.max(0, isNaN(num) ? 500000 : num);
    })
    .default(500000),

  // Schema version for migrations
  smart_upload_schema_version: z.string().default(SMART_UPLOAD_SCHEMA_VERSION),

  // LLM response cache
  smart_upload_enable_llm_cache: z
    .union([z.boolean(), z.string()])
    .transform((v) => (typeof v === 'string' ? v === 'true' : v))
    .default(false),

  smart_upload_llm_cache_ttl_seconds: z
    .union([z.string(), z.number()])
    .transform((v) => {
      const num = typeof v === 'string' ? Number(v) : v;
      return Math.max(60, isNaN(num) ? 86400 : num);
    })
    .default(86400),

  // ========================================
  // NEW: OCR-first fields (Phase 1-2)
  // ========================================
  // Master OCR-first enable switch
  smart_upload_enable_ocr_first: z
    .union([z.boolean(), z.string()])
    .transform((v) => (typeof v === 'string' ? v === 'true' : v))
    .default(true),

  // When true, prefer OCR-derived cutting instructions even if LLM appears more confident.
  // LLM is still used as a fallback when OCR results are invalid or missing.
  smart_upload_enforce_ocr_splitting: z
    .union([z.boolean(), z.string()])
    .transform((v) => (typeof v === 'string' ? v === 'true' : v))
    .default(false),

  // Text layer quality threshold (0-100)
  smart_upload_text_layer_threshold_pct: z
    .union([z.string(), z.number()])
    .transform((v) => {
      const num = typeof v === 'string' ? Number(v) : v;
      return Math.max(0, Math.min(100, isNaN(num) ? 40 : num));
    })
    .default(40),

  // OCR mode: header, full, or both
  smart_upload_ocr_mode: OcrModeSchema.default('both'),

  // Max pages to run OCR on
  smart_upload_ocr_max_pages: z
    .union([z.string(), z.number()])
    .transform((v) => {
      const num = typeof v === 'string' ? Number(v) : v;
      return Math.max(1, isNaN(num) ? 3 : Math.min(100, num));
    })
    .default(3),

  // Pages to probe for text layer
  smart_upload_text_probe_pages: z
    .union([z.string(), z.number()])
    .transform((v) => {
      const num = typeof v === 'string' ? Number(v) : v;
      return Math.max(1, isNaN(num) ? 10 : Math.min(100, num));
    })
    .default(10),

  // Whether to store raw OCR text
  smart_upload_store_raw_ocr_text: z
    .union([z.boolean(), z.string()])
    .transform((v) => (typeof v === 'string' ? v === 'true' : v))
    .default(false),

  // OCR engine selection
  smart_upload_ocr_engine: OcrEngineSchema.default('tesseract'),

  // OCR rate limit (jobs per minute)
  smart_upload_ocr_rate_limit_rpm: z
    .union([z.string(), z.number()])
    .transform((v) => {
      const num = typeof v === 'string' ? Number(v) : v;
      return Math.max(1, isNaN(num) ? 6 : Math.min(60, num));
    })
    .default(6),

  // LLM max pages
  smart_upload_llm_max_pages: z
    .union([z.string(), z.number()])
    .transform((v) => {
      const num = typeof v === 'string' ? Number(v) : v;
      return Math.max(1, isNaN(num) ? 10 : Math.min(100, num));
    })
    .default(10),

  // LLM max header batches
  smart_upload_llm_max_header_batches: z
    .union([z.string(), z.number()])
    .transform((v) => {
      const num = typeof v === 'string' ? Number(v) : v;
      return Math.max(1, isNaN(num) ? 2 : Math.min(10, num));
    })
    .default(2),

  // Maximum images per second-pass LLM request (0 = use provider-level cap)
  smart_upload_second_pass_max_images: z
    .union([z.string(), z.number()])
    .transform((v) => {
      const num = typeof v === 'string' ? Number(v) : v;
      return Math.max(0, isNaN(num) ? 0 : Math.min(200, Math.round(num)));
    })
    .default(0),

  // ========================================
  // NEW: Per-step LLM provider/model keys
  // ========================================
  // Default provider (backward compatible with llm_provider)
  llm_default_provider: ProviderValueSchema.optional(),

  // Vision step provider
  llm_vision_provider: ProviderValueSchema.optional(),

  // Verification step provider
  llm_verification_provider: ProviderValueSchema.optional(),

  // Header label step provider
  llm_header_label_provider: ProviderValueSchema.optional(),

  // Adjudicator step provider
  llm_adjudicator_provider: ProviderValueSchema.optional(),

  // Header label model (can differ from verification)
  llm_header_label_model: z.string().optional(),

  // Header label model params (JSON)
  llm_header_label_model_params: JsonParamsSchema,

  // Adjudicator model params (JSON)
  llm_adjudicator_model_params: JsonParamsSchema,
});

export type SmartUploadSettings = z.infer<typeof SmartUploadSettingsSchema>;

// =============================================================================
// Validation Helpers
// =============================================================================

/**
 * Check if a provider requires an API key.
 * API keys are managed exclusively via the APIKey/AIProvider system —
 * this helper only answers the structural question.
 */
export function providerRequiresApiKey(provider?: ProviderValue | string): boolean {
  if (!provider || provider === '') return false;
  return provider !== 'glm-ocr' && provider !== 'ollama' && provider !== 'custom';
}

export function getApiKeyFieldForProvider(provider?: ProviderValue | string): LegacySecretKey | '' {
  if (!provider) return '';
  return LEGACY_API_KEY_FIELD_BY_PROVIDER[provider] ?? '';
}

export function validateProviderApiKey(
  provider: ProviderValue | string | undefined,
  _settings?: Record<string, string | undefined>,
): { valid: boolean; error?: string } {
  if (!provider || (provider !== 'custom' && !providerRequiresApiKey(provider))) {
    return { valid: true };
  }

  // Provider secrets are resolved at runtime via API key service only.
  return { valid: true };
}

/**
 * Check if a provider requires an endpoint URL
 */
export function providerRequiresEndpoint(provider?: ProviderValue | string): boolean {
  // Local and proxy-backed providers should expose an editable endpoint.
  return provider === 'glm-ocr' || provider === 'custom' || provider === 'ollama';
}

/**
 * Validate that the endpoint URL is set if required
 */
export function validateProviderEndpoint(
  provider?: ProviderValue | string,
  endpointUrl?: string
): { valid: boolean; error?: string } {
  if (!provider || !providerRequiresEndpoint(provider)) {
    return { valid: true };
  }

  if (!endpointUrl || endpointUrl.trim() === '') {
    return {
      valid: false,
      error: `${provider} requires an endpoint URL.`,
    };
  }

  try {
    new URL(endpointUrl);
    return { valid: true };
  } catch {
    return {
      valid: false,
      error: 'Endpoint URL must be a valid URL.',
    };
  }
}

// =============================================================================
// Settings Transformation
// =============================================================================

/**
 * Convert database settings record to typed SmartUploadSettings
 */
export function dbRecordToSettings(record: Record<string, string>): SmartUploadSettings {
  return SmartUploadSettingsSchema.parse({
    ...record,
    // Ensure required fields have defaults if missing
    llm_vision_system_prompt: record.llm_vision_system_prompt || '',
    llm_verification_system_prompt: record.llm_verification_system_prompt || '',
  });
}

export function maskSecrets(record: Record<string, string>): Record<string, string> {
  const masked = { ...record };
  for (const key of LEGACY_SECRET_KEYS) {
    if (!(key in masked)) continue;
    masked[key] = masked[key] === '' ? '__UNSET__' : '__SET__';
  }
  return masked;
}

/**
 * Convert SmartUploadSettings to database record format
 */
export function settingsToDbRecord(settings: SmartUploadSettings): Record<string, string> {
  const record: Record<string, string> = {};
  
  for (const key of SMART_UPLOAD_SETTING_KEYS) {
    const value = settings[key as keyof SmartUploadSettings];
    if (value !== undefined && value !== null) {
      if (typeof value === 'object') {
        record[key] = JSON.stringify(value);
      } else {
        record[key] = String(value);
      }
    }
  }
  
  return record;
}

/**
 * Merge new settings with existing, skipping placeholder values
 */
export function mergeSettingsPreservingSecrets(
  existing: Record<string, string>,
  updates: Record<string, string>
): Record<string, string> {
  const merged = { ...existing };
  
  for (const [key, value] of Object.entries(updates)) {
    // Skip placeholder values
    if (value === '__SET__' || value === '***' || value === '******') {
      continue;
    }
    // Allow explicit clear
    if (value === '__CLEAR__') {
      merged[key] = '';
      continue;
    }
    merged[key] = value;
  }
  
  return merged;
}

// =============================================================================
// Validation Entry Point
// =============================================================================

/**
 * Full validation of Smart Upload settings
 */
export function validateSmartUploadSettings(
  settings: Partial<SmartUploadSettings>
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Schema validation
  const schemaResult = SmartUploadSettingsSchema.safeParse(settings);
  if (!schemaResult.success) {
    for (const issue of schemaResult.error.issues) {
      errors.push(`${issue.path.join('.')}: ${issue.message}`);
    }
  }

  // Provider-specific validation - validate global provider endpoint
  if (settings.llm_provider) {
    const apiKeyResult = validateProviderApiKey(
      settings.llm_provider,
    );
    if (!apiKeyResult.valid) {
      errors.push(apiKeyResult.error!);
    }

    const endpointResult = validateProviderEndpoint(
      settings.llm_provider,
      settings.llm_endpoint_url
    );
    if (!endpointResult.valid) {
      errors.push(endpointResult.error!);
    }
  }

  const stepProviders = [
    settings.llm_default_provider,
    settings.llm_vision_provider,
    settings.llm_verification_provider,
    settings.llm_header_label_provider,
    settings.llm_adjudicator_provider,
  ];

  for (const provider of stepProviders) {
    if (!provider) {
      continue;
    }

    const apiKeyResult = validateProviderApiKey(
      provider,
    );
    if (!apiKeyResult.valid) {
      errors.push(apiKeyResult.error!);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
