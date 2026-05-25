// src/lib/llm/config-loader.ts
// ============================================================
// Canonical LLM configuration loader.
// ALL API keys are stored exclusively in the database.
// Env vars may be used ONCE at first startup to seed the DB
// (via bootstrapLLMApiKeysFromEnv), then should be removed.
// SECURITY: Provider keys are strictly isolated; no env
// fallbacks for secrets after initial seeding.
// ============================================================

import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';
import { getDefaultEndpointForProvider } from './providers';
import type { LLMProviderValue } from './providers';
import { PROMPT_VERSION } from '@/lib/smart-upload/prompts';
import { getPrimaryApiKey, getFallbackApiKey } from './api-key-service';

export interface LLMRuntimeConfig {
  provider: LLMProviderValue;
  // Per-step provider overrides (new OCR-first architecture)
  visionProvider?: LLMProviderValue;
  verificationProvider?: LLMProviderValue;
  headerLabelProvider?: LLMProviderValue;
  adjudicatorProvider?: LLMProviderValue;
  // Legacy/default provider alias (backward compatibility)
  defaultProvider: LLMProviderValue;
  endpointUrl: string;
  visionModel: string;
  verificationModel: string;
  /** Adjudicator (3rd pass) model — defaults to verificationModel */
  adjudicatorModel: string;
  /** Header-label cheap-model pass model */
  headerLabelModel: string;
  openaiApiKey: string;
  anthropicApiKey: string;
  openrouterApiKey: string;
  geminiApiKey: string;
  ollamaCloudApiKey: string;
  mistralApiKey: string;
  groqApiKey: string;
  customApiKey: string;
  confidenceThreshold: number;
  twoPassEnabled: boolean;
  visionSystemPrompt?: string;
  verificationSystemPrompt?: string;
  /** Prompt for the header-labelling cheap-model pass */
  headerLabelPrompt?: string;
  /** Prompt for the adjudicator 3rd pass */
  adjudicatorPrompt?: string;
  rateLimit: number;
  autoApproveThreshold: number;
  skipParseThreshold: number;
  maxPages: number;
  maxFileSizeMb: number;
  maxConcurrent: number;
  allowedMimeTypes: string[];
  enableFullyAutonomousMode: boolean;
  autonomousApprovalThreshold: number;
  /** Maximum pages allowed for a single non-score PART before auto-commit is blocked. Default 12. */
  maxPagesPerPart: number;
  /** When true AND provider supports PDF input, send the full PDF instead of rendered images.
   *  Defaults to true — native PDF input is faster and more accurate than image rendering. */
  sendFullPdfToLlm: boolean;
  /** Enable OCR-first pipeline. When true, OCR is attempted before LLM. */
  enableOcrFirst: boolean;
  /** Minimum text layer confidence (0-100) to trust embedded text over OCR. */
  textLayerThresholdPct: number;
  /** OCR mode: 'header' | 'full' | 'both' */
  ocrMode: 'header' | 'full' | 'both';
  /** Maximum pages to OCR (0 = all) */
  ocrMaxPages: number;
  /** Number of pages to probe for text layer before falling back to OCR */
  textProbePages: number;
  /** Store raw OCR text in session for provenance (can be large) */
  storeRawOcrText: boolean;
  /** OCR engine to use: 'tesseract' | 'ocrmypdf' | 'vision_api' | 'native' */
  ocrEngine: 'tesseract' | 'ocrmypdf' | 'vision_api' | 'native';
  /** Rate limit for OCR engine (requests per minute) */
  ocrRateLimitRpm: number;
  /** Maximum pages to send to LLM for vision processing */
  llmMaxPages: number;
  /** Maximum header-label batches per document */
  llmMaxHeaderBatches: number;
  /** Maximum images to send in a single second-pass LLM request.
   *  0 = use the provider-level maxImagesPerRequest cap from providers.ts.
   *  Admins can lower this to reduce cost or raise it for high-capacity deployments. */
  secondPassMaxImages: number;
  /** Minimum OCR confidence (0-100) to accept OCR-derived metadata without LLM fallback. */
  ocrConfidenceThreshold: number;
  /** Maximum LLM calls allowed per upload session. 0 = unlimited. */
  budgetMaxLlmCalls: number;
  /** Maximum input tokens allowed per upload session. 0 = unlimited. */
  budgetMaxInputTokens: number;
  /** Enable Redis-backed LLM response cache to avoid redundant API calls. */
  enableLlmCache: boolean;
  /** TTL for LLM response cache entries (seconds). Default 86400 (24 h). */
  llmCacheTtlSeconds: number;
  visionModelParams: Record<string, unknown>;
  verificationModelParams: Record<string, unknown>;
  headerLabelModelParams: Record<string, unknown>;
  adjudicatorModelParams: Record<string, unknown>;
  promptVersion?: string;
  /** User prompt template for vision extraction (image mode, full schema including cuttingInstructions) */
  visionUserPrompt?: string;
  /** User prompt template for image-sampled metadata-only extraction (no cuttingInstructions) */
  visionMetadataOnlyUserPrompt?: string;
  /** User prompt template for PDF-to-LLM vision extraction */
  pdfVisionUserPrompt?: string;
  /** User prompt template for verification (second pass) */
  verificationUserPrompt?: string;
  /** User prompt template for header-label detection */
  headerLabelUserPrompt?: string;
  /** User prompt template for adjudicator (third pass) */
  adjudicatorUserPrompt?: string;
}

const DB_KEYS = [
  // Legacy/default provider (canonical key)
  'llm_provider',
  // Endpoint URL
  'llm_endpoint_url',
  // New per-step provider keys (OCR-first architecture)
  'llm_default_provider',
  'llm_vision_provider',
  'llm_verification_provider',
  'llm_header_label_provider',
  'llm_adjudicator_provider',
  // Legacy keys (still honoured as fallback)
  'llm_ollama_endpoint',
  'llm_custom_base_url',
  // Models
  'llm_vision_model',
  'llm_verification_model',
  'llm_header_label_model',
  // Behaviour — smart_upload_* are the canonical keys; legacy llm_* honoured as fallback
  'smart_upload_confidence_threshold',
  'smart_upload_auto_approve_threshold',
  'smart_upload_rate_limit_rpm',
  'smart_upload_skip_parse_threshold',
  'smart_upload_max_concurrent',
  'smart_upload_max_pages',
  'smart_upload_max_file_size_mb',
  'smart_upload_allowed_mime_types',
  'smart_upload_enable_autonomous_mode',
  'smart_upload_autonomous_approval_threshold',
  'smart_upload_max_pages_per_part',
  'smart_upload_send_full_pdf_to_llm',
  // OCR-first settings (new)
  'smart_upload_enable_ocr_first', 'smart_upload_text_layer_threshold_pct',
  'smart_upload_ocr_mode',
  'smart_upload_ocr_max_pages',
  'smart_upload_text_probe_pages',
  'smart_upload_store_raw_ocr_text',
  'smart_upload_ocr_engine',
  'smart_upload_ocr_rate_limit_rpm',
  'smart_upload_llm_max_pages',
  'smart_upload_llm_max_header_batches',
  'smart_upload_second_pass_max_images',
  // Legacy OCR settings
  'smart_upload_local_ocr_enabled',
  'smart_upload_ocr_confidence_threshold',
  'smart_upload_budget_max_llm_calls_per_session',
  'smart_upload_budget_max_input_tokens_per_session',
  'smart_upload_enable_llm_cache',
  'smart_upload_llm_cache_ttl_seconds',
  'llm_adjudicator_model',
  'llm_two_pass_enabled',
  'llm_vision_system_prompt',
  'llm_verification_system_prompt',
  'llm_header_label_prompt',
  'llm_adjudicator_prompt',
  // User prompt templates (stored in DB as single source of truth)
  'llm_vision_user_prompt',
  'llm_vision_metadata_only_user_prompt',
  'llm_pdf_vision_user_prompt',
  'llm_verification_user_prompt',
  'llm_header_label_user_prompt',
  'llm_adjudicator_user_prompt',
  // Legacy behaviour keys
  'llm_confidence_threshold',
  'llm_rate_limit_rpm',
  'llm_auto_approve_threshold',
  'llm_skip_parse_threshold',
  // Model params
  'vision_model_params',
  'verification_model_params',
  'llm_header_label_model_params',
  'llm_adjudicator_model_params',
  // Legacy model param keys
  'llm_vision_model_params',
  'llm_verification_model_params',
  // Prompt version
  'llm_prompt_version',
] as const;

function parseJsonParam(raw: string | undefined): Record<string, unknown> {
  try {
    if (!raw || raw.trim() === '') return {};
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function parseMimeTypes(raw: string | undefined): string[] {
  if (!raw || raw.trim() === '') return ['application/pdf'];

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return ['application/pdf'];

    const mimeTypes = parsed.filter((entry): entry is string => typeof entry === 'string');
    return mimeTypes.length > 0 ? mimeTypes : ['application/pdf'];
  } catch {
    return ['application/pdf'];
  }
}

/**
 * Load LLM configuration from the database ONLY.
 * Runtime env vars are NOT read for provider/model/endpoint selection.
 * Use bootstrapLLMApiKeysFromEnv() at startup to seed DB from env if needed.
 * Call once per job/request; cache the result if calling multiple times.
 */
let cachedConfigPromise: Promise<LLMRuntimeConfig> | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 60 * 1000; // 60s memory cache

/**
 * Clear the LLM config cache to force a fresh DB read.
 * Call this when LLM-related system settings or API keys are updated.
 */
export function clearLLMConfigCache() {
  cachedConfigPromise = null;
  cacheTimestamp = 0;
}

/**
 * Load LLM configuration from the database ONLY.
 * Runtime env vars are NOT read for provider/model/endpoint selection.
 * Use bootstrapLLMApiKeysFromEnv() at startup to seed DB from env if needed.
 * Call once per job/request; cache the result if calling multiple times.
 */
export async function loadLLMConfig(): Promise<LLMRuntimeConfig> {
  const now = Date.now();
  if (cachedConfigPromise && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedConfigPromise;
  }

  cacheTimestamp = now;
  cachedConfigPromise = (async () => {
    let db: Record<string, string> = {};

    try {
      const rows = await prisma.systemSetting.findMany({
        where: { key: { in: [...DB_KEYS] } },
        select: { key: true, value: true },
      });
      db = rows.reduce<Record<string, string>>((acc, r) => {
        if (r.value !== null && r.value !== undefined) acc[r.key] = r.value;
        return acc;
      }, {});
    } catch (err) {
      // Clear cache on error so next attempt tries again
      clearLLMConfigCache();
      // If DB unavailable, we cannot proceed - throw error
      // Workers should have DB connectivity; admin can configure via UI
      logger.error('loadLLMConfig: DB unavailable, cannot load config', { err });
      throw new Error('LLM config DB unavailable');
    }

    // ── Provider resolution (DB-only, with backward-compat legacy key) ────────
    // Priority: explicit per-step provider → default_provider → legacy llm_provider → 'ollama'
    const defaultProvider = (db['llm_default_provider'] ||
      db['llm_provider'] ||
      'ollama') as LLMProviderValue;

    // Per-step provider overrides (new OCR-first architecture)
    const visionProvider = (db['llm_vision_provider'] ||
      defaultProvider) as LLMProviderValue;
    const verificationProvider = (db['llm_verification_provider'] ||
      defaultProvider) as LLMProviderValue;
    const headerLabelProvider = (db['llm_header_label_provider'] ||
      defaultProvider) as LLMProviderValue;
    const adjudicatorProvider = (db['llm_adjudicator_provider'] ||
      defaultProvider) as LLMProviderValue;

    // ── Endpoint resolution (DB-only) ─────────────────────────────────────────
    // Priority: explicit DB value → provider default endpoint
    let endpointUrl = db['llm_endpoint_url'] || '';

    if (!endpointUrl) {
      // Fall back to provider default endpoints (no runtime env fallback)
      endpointUrl = getDefaultEndpointForProvider(defaultProvider);
    }

    // ── Models (DB-only, with backward-compat legacy keys) ───────────────────
    const visionModel = db['llm_vision_model'] || 'llama3.2-vision';
    const verificationModel = db['llm_verification_model'] || 'qwen2.5:7b';
    const headerLabelModel = db['llm_header_label_model'] || verificationModel;

    // ── Model params — prefer new keys, fall back to legacy prefixed keys ────
    const visionModelParams = parseJsonParam(
      db['vision_model_params'] || db['llm_vision_model_params']
    );
    const verificationModelParams = parseJsonParam(
      db['verification_model_params'] || db['llm_verification_model_params']
    );
    const headerLabelModelParams = parseJsonParam(
      db['llm_header_label_model_params']
    );
    const adjudicatorModelParams = parseJsonParam(
      db['llm_adjudicator_model_params']
    );

    // ── OCR-first settings (DB-only, no env fallback) ──────────────────────────
    const enableOcrFirst =
      (db['smart_upload_enable_ocr_first'] ?? 'true') === 'true';
    const textLayerThresholdPct = Number(
      db['smart_upload_text_layer_threshold_pct'] ?? 40
    );
    const ocrMode = (db['smart_upload_ocr_mode'] || 'both') as
      | 'header'
      | 'full'
      | 'both';
    const ocrMaxPages = Number(db['smart_upload_ocr_max_pages'] ?? 3);
    const textProbePages = Number(db['smart_upload_text_probe_pages'] ?? 10);
    const storeRawOcrText =
      (db['smart_upload_store_raw_ocr_text'] ?? 'false') === 'true';
    const ocrEngine = (db['smart_upload_ocr_engine'] || 'tesseract') as
      | 'tesseract'
      | 'ocrmypdf'
      | 'vision_api'
      | 'native';
    const ocrRateLimitRpm = Number(db['smart_upload_ocr_rate_limit_rpm'] ?? 6);
    const llmMaxPages = Number(db['smart_upload_llm_max_pages'] ?? 10);
    const llmMaxHeaderBatches = Number(
      db['smart_upload_llm_max_header_batches'] ?? 2
    );
    const secondPassMaxImages = Math.max(
      0,
      parseInt(db['smart_upload_second_pass_max_images'] ?? '0', 10)
    );

    // ── API keys — encrypted APIKey table is the sole source of truth ────────
    const PROVIDER_SLUGS: readonly LLMProviderValue[] = [
      'openai',
      'anthropic',
      'openrouter',
      'gemini',
      'ollama-cloud',
      'mistral',
      'groq',
      'custom',
    ] as const;

    // Fetch all keys in parallel to reduce DB round-trip latency
    let apiKeys: Record<string, string> = {};
    try {
      const apiKeyResults = await Promise.all(
        PROVIDER_SLUGS.map((slug) => getPrimaryApiKey(slug))
      );

      PROVIDER_SLUGS.forEach((slug, i) => {
        apiKeys[slug] = apiKeyResults[i];
      });
    } catch (err) {
      // Clear cache on error so next attempt tries again
      clearLLMConfigCache();
      logger.error('loadLLMConfig: Failed to fetch API keys', { err });
      throw err;
    }

    return {
      // ── Providers ───────────────────────────────────────────────────────────
      // Default provider (backward compat)
      provider: defaultProvider,
      // Per-step providers (new OCR-first architecture)
      visionProvider,
      verificationProvider,
      headerLabelProvider,
      adjudicatorProvider,
      defaultProvider,
      // ── Endpoint ───────────────────────────────────────────────────────────
      endpointUrl,
      // ── Models ─────────────────────────────────────────────────────────────
      visionModel,
      verificationModel,
      headerLabelModel,
      adjudicatorModel:
        db['llm_adjudicator_model'] ||
        (verificationProvider === 'openai' ? 'gpt-4o' :
         verificationProvider === 'anthropic' ? 'claude-3-5-sonnet-20241022' :
         verificationModel),
      // ── Model params ───────────────────────────────────────────────────────
      visionModelParams,
      verificationModelParams,
      headerLabelModelParams,
      adjudicatorModelParams,
      // ── API keys — DB is the single source of truth. No env fallback. ──────
      // Prefer encrypted APIKey table, fall back to SystemSetting for migration.
      openaiApiKey: apiKeys.openai,
      anthropicApiKey: apiKeys.anthropic,
      openrouterApiKey: apiKeys.openrouter,
      geminiApiKey: apiKeys.gemini,
      ollamaCloudApiKey: apiKeys['ollama-cloud'],
      mistralApiKey: apiKeys.mistral,
      groqApiKey: apiKeys.groq,
      customApiKey: apiKeys.custom,
      // ── Threshold / behavior settings ─────────────────────────────────────
      confidenceThreshold: Number(
        db['smart_upload_confidence_threshold'] ||
        db['llm_confidence_threshold'] ||
        70
      ),
      twoPassEnabled: (db['llm_two_pass_enabled'] ?? 'true') === 'true',
      // ── Prompts ───────────────────────────────────────────────────────────
      visionSystemPrompt: db['llm_vision_system_prompt'] || undefined,
      verificationSystemPrompt: db['llm_verification_system_prompt'] || undefined,
      headerLabelPrompt: db['llm_header_label_prompt'] || undefined,
      adjudicatorPrompt: db['llm_adjudicator_prompt'] || undefined,
      // ── Rate limits ───────────────────────────────────────────────────────
      rateLimit: Number(
        db['smart_upload_rate_limit_rpm'] ||
        db['llm_rate_limit_rpm'] ||
        15
      ),
      autoApproveThreshold: Number(
        db['smart_upload_auto_approve_threshold'] ||
        db['llm_auto_approve_threshold'] ||
        90
      ),
      skipParseThreshold: Number(
        db['smart_upload_skip_parse_threshold'] ||
        db['llm_skip_parse_threshold'] ||
        60
      ),
      // ── Resource limits ───────────────────────────────────────────────────
      maxPages: Number(db['smart_upload_max_pages'] ?? 20),
      maxFileSizeMb: Number(db['smart_upload_max_file_size_mb'] ?? 50),
      maxConcurrent: Number(db['smart_upload_max_concurrent'] ?? 3),
      // ── MIME types ─────────────────────────────────────────────────────────
      allowedMimeTypes: parseMimeTypes(db['smart_upload_allowed_mime_types']),
      // ── Autonomous mode ───────────────────────────────────────────────────
      enableFullyAutonomousMode: (db['smart_upload_enable_autonomous_mode'] ?? 'false') === 'true',
      autonomousApprovalThreshold: Number(db['smart_upload_autonomous_approval_threshold'] ?? 95),
      maxPagesPerPart: Number(db['smart_upload_max_pages_per_part'] ?? 12),
      sendFullPdfToLlm: (db['smart_upload_send_full_pdf_to_llm'] ?? 'true') === 'true',
      // ── OCR settings (legacy - superseded by OCR-first settings above) ────────
      ocrConfidenceThreshold: Number(db['smart_upload_ocr_confidence_threshold'] ?? 60),
      // ── Budget / cost limits ──────────────────────────────────────────────
      budgetMaxLlmCalls: Number(db['smart_upload_budget_max_llm_calls_per_session'] ?? 5),
      budgetMaxInputTokens: Number(db['smart_upload_budget_max_input_tokens_per_session'] ?? 500000),
      // ── LLM response cache ────────────────────────────────────────────────
      enableLlmCache: (db['smart_upload_enable_llm_cache'] ?? 'true') === 'true',
      llmCacheTtlSeconds: Number(db['smart_upload_llm_cache_ttl_seconds'] ?? 86400),
      // ── Prompt version ─────────────────────────────────────────────────────
      promptVersion: db['llm_prompt_version'] || PROMPT_VERSION,
      // ── User prompt templates — DB is the single source of truth ──────────
      visionUserPrompt: db['llm_vision_user_prompt'] || undefined,
      visionMetadataOnlyUserPrompt: db['llm_vision_metadata_only_user_prompt'] || undefined,
      pdfVisionUserPrompt: db['llm_pdf_vision_user_prompt'] || undefined,
      verificationUserPrompt: db['llm_verification_user_prompt'] || undefined,
      headerLabelUserPrompt: db['llm_header_label_user_prompt'] || undefined,
      adjudicatorUserPrompt: db['llm_adjudicator_user_prompt'] || undefined,
      // ── OCR-first settings (new) ───────────────────────────────────────────
      enableOcrFirst,
      textLayerThresholdPct,
      ocrMode,
      ocrMaxPages,
      textProbePages,
      storeRawOcrText,
      ocrEngine,
      ocrRateLimitRpm,
      llmMaxPages,
      llmMaxHeaderBatches,
      secondPassMaxImages,
    };
  })();

  return cachedConfigPromise;
}

/**
 * Alias for loadLLMConfig — reads canonical smart_upload_* settings.
 * Workers should call this instead of loadLLMConfig.
 */
export async function loadSmartUploadRuntimeConfig(): Promise<LLMRuntimeConfig> {
  return loadLLMConfig();
}

// =============================================================================
// One-time ENV → DB seeding
// =============================================================================

/** Map of DB setting key → env var name for LLM secrets.  */
const LLM_API_KEY_ENV_MAP: Record<string, string> = {
  llm_openai_api_key: 'LLM_OPENAI_API_KEY',
  llm_anthropic_api_key: 'LLM_ANTHROPIC_API_KEY',
  llm_openrouter_api_key: 'LLM_OPENROUTER_API_KEY',
  llm_gemini_api_key: 'LLM_GEMINI_API_KEY',
  llm_ollama_cloud_api_key: 'LLM_OLLAMA_CLOUD_API_KEY',
  llm_mistral_api_key: 'LLM_MISTRAL_API_KEY',
  llm_groq_api_key: 'LLM_GROQ_API_KEY',
  llm_custom_api_key: 'LLM_CUSTOM_API_KEY',
};

/** Non-secret config env vars that can pre-seed DB provider/model selection. */
const LLM_CONFIG_ENV_MAP: Record<string, string> = {
  llm_provider: 'LLM_PROVIDER',
  llm_vision_model: 'LLM_VISION_MODEL',
  llm_verification_model: 'LLM_VERIFICATION_MODEL',
};

/**
 * Seed LLM API keys and config from environment variables into the database
 * on first startup. This is a one-time migration: if the DB already has a
 * value for a key it is NOT overwritten. After seeding, the env vars are no
 * longer read by the loader — manage all keys via the Admin UI.
 *
 * Call this from instrumentation.ts (Next.js) or the worker startup script.
 * Safe to call on every startup — no-ops when DB values already exist.
 */
export async function bootstrapLLMApiKeysFromEnv(updatedBy = 'system:env-bootstrap'): Promise<void> {
  const allMaps = { ...LLM_API_KEY_ENV_MAP, ...LLM_CONFIG_ENV_MAP };
  const dbKeys = Object.keys(allMaps);

  try {
    const existing = await prisma.systemSetting.findMany({
      where: { key: { in: dbKeys } },
      select: { key: true, value: true },
    });
    const existingMap = new Map(existing.map((r) => [r.key, r.value]));

    const toSeed: Array<{ key: string; value: string }> = [];

    for (const [dbKey, envVar] of Object.entries(allMaps)) {
      const envValue = process.env[envVar];
      // Only seed if: env var is non-empty AND DB value is missing/empty
      if (envValue && envValue.trim() !== '' && !existingMap.get(dbKey)) {
        toSeed.push({ key: dbKey, value: envValue.trim() });
      }
    }

    if (toSeed.length === 0) return;

    // Upsert in a transaction for atomicity
    await prisma.$transaction(
      toSeed.map(({ key, value }) =>
        prisma.systemSetting.upsert({
          where: { key },
          update: {}, // Never overwrite existing — env seeds only fill gaps
          create: { key, value, updatedBy },
        })
      )
    );

    logger.info('LLM settings seeded from environment variables (one-time bootstrap)', {
      seededKeys: toSeed.map(({ key }) => key),
    });
  } catch (err) {
    // Non-fatal: log and continue. The admin can configure keys via the UI.
    logger.warn('bootstrapLLMApiKeysFromEnv: failed to seed, will retry on next startup', { err });
  }
}

/**
 * Convert LLMRuntimeConfig to the LLMConfig interface expected by adapters.
 * SECURITY: Only the correct provider key is included per call; others are omitted.
 */
export function runtimeToAdapterConfig(cfg: LLMRuntimeConfig) {
  return {
    llm_provider: cfg.provider,
    llm_endpoint_url: cfg.endpointUrl,
    llm_vision_model: cfg.visionModel,
    llm_verification_model: cfg.verificationModel,
    llm_openai_api_key: cfg.openaiApiKey,
    llm_anthropic_api_key: cfg.anthropicApiKey,
    llm_openrouter_api_key: cfg.openrouterApiKey,
    llm_gemini_api_key: cfg.geminiApiKey,
    llm_ollama_cloud_api_key: cfg.ollamaCloudApiKey,
    llm_mistral_api_key: cfg.mistralApiKey,
    llm_groq_api_key: cfg.groqApiKey,
    llm_custom_api_key: cfg.customApiKey,
  } as const;
}

// =============================================================================
// Per-step adapter config builder (OCR-first architecture)
// =============================================================================

/** Supported pipeline steps that can use different LLM providers. */
export type LLMStepName = 'vision' | 'verification' | 'header-label' | 'adjudicator';

/**
 * Build adapter config for a specific pipeline step.
 * Resolves the appropriate provider/model/params for that step,
 * falling back to global defaults only for backward compatibility.
 * If the primary API key is empty, attempts to use a fallback key
 * from the encrypted APIKey table.
 *
 * @param cfg - Full runtime config loaded from DB
 * @param stepName - Pipeline step name (vision, verification, header-label, adjudicator)
 * @returns Adapter config object with provider, model, endpoint, and API key
 */
export async function buildAdapterConfigForStep(
  cfg: LLMRuntimeConfig,
  stepName: LLMStepName
): Promise<{
  provider: LLMProviderValue;
  model: string;
  modelParams: Record<string, unknown> | undefined;
  endpointUrl: string;
  apiKey: string;
  systemPrompt: string | undefined;
  userPrompt: string | undefined;
}> {
  // Resolve provider per step - use explicit provider or fall back to defaultProvider
  let provider: LLMProviderValue;
  let model: string;
  let modelParams: Record<string, unknown> | undefined;
  let systemPrompt: string | undefined;
  let userPrompt: string | undefined;

  switch (stepName) {
    case 'vision':
      provider = cfg.visionProvider || cfg.defaultProvider;
      model = cfg.visionModel;
      modelParams = cfg.visionModelParams;
      systemPrompt = cfg.visionSystemPrompt;
      userPrompt = cfg.visionUserPrompt;
      break;
    case 'verification':
      provider = cfg.verificationProvider || cfg.defaultProvider;
      model = cfg.verificationModel;
      modelParams = cfg.verificationModelParams;
      systemPrompt = cfg.verificationSystemPrompt;
      userPrompt = cfg.verificationUserPrompt;
      break;
    case 'header-label':
      provider = cfg.headerLabelProvider || cfg.defaultProvider;
      model = cfg.headerLabelModel;
      modelParams = cfg.headerLabelModelParams;
      systemPrompt = cfg.headerLabelPrompt;
      userPrompt = cfg.headerLabelUserPrompt;
      break;
    case 'adjudicator':
      provider = cfg.adjudicatorProvider || cfg.defaultProvider;
      model = cfg.adjudicatorModel;
      modelParams = cfg.adjudicatorModelParams;
      systemPrompt = cfg.adjudicatorPrompt;
      userPrompt = cfg.adjudicatorUserPrompt;
      break;
    default:
      // Fallback to default provider for unknown steps
      provider = cfg.defaultProvider;
      model = cfg.verificationModel;
      modelParams = cfg.verificationModelParams;
  }

  // Resolve endpoint (use default endpoint for the provider)
  const endpointUrl = getDefaultEndpointForProvider(provider);

  // Resolve API key for the provider (primary from config)
  let apiKey = getApiKeyForProvider(cfg, provider);

  // If primary key is empty, try fallback from encrypted APIKey table
  if (!apiKey && provider !== 'ollama') {
    try {
      const fallback = await getFallbackApiKey(provider);
      if (fallback) {
        apiKey = fallback;
        logger.info('Using fallback API key for step', { stepName, provider });
      }
    } catch {
      // Fallback lookup failed — proceed without key
    }
  }

  return {
    provider,
    model,
    modelParams,
    endpointUrl,
    apiKey,
    systemPrompt,
    userPrompt,
  };
}

/**
 * Get API key for a specific provider from the runtime config.
 */
function getApiKeyForProvider(
  cfg: LLMRuntimeConfig,
  provider: LLMProviderValue
): string {
  switch (provider) {
    case 'openai':
      return cfg.openaiApiKey;
    case 'anthropic':
      return cfg.anthropicApiKey;
    case 'openrouter':
      return cfg.openrouterApiKey;
    case 'gemini':
      return cfg.geminiApiKey;
    case 'ollama-cloud':
      return cfg.ollamaCloudApiKey;
    case 'mistral':
      return cfg.mistralApiKey;
    case 'groq':
      return cfg.groqApiKey;
    case 'custom':
      return cfg.customApiKey;
    case 'ollama':
    default:
      return ''; // Ollama uses local endpoints, no API key required
  }
}
