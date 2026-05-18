// src/lib/llm/api-key-service.ts
// ============================================================
// CRUD service for LLM API keys using the AIProvider + APIKey
// tables. All secrets are encrypted at rest with AES-256-GCM.
// ============================================================

import { prisma } from '@/lib/db';
import { encryptSecret, decryptSecret, hashSecret } from '@/lib/crypto';
import { logger } from '@/lib/logger';
import { LLM_PROVIDERS, type LLMProviderValue } from './providers';
import { randomUUID } from 'crypto';

// ─── Types ───────────────────────────────────────────────────

export interface ApiKeyRecord {
  id: string;
  providerId: string;
  providerSlug: LLMProviderValue;
  label: string;
  isPrimary: boolean;
  isActive: boolean;
  isValid: boolean;
  validationError: string | null;
  lastValidated: Date | null;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string | null;
}

export interface ApiKeyWithSecret extends ApiKeyRecord {
  /** Decrypted plaintext key — only returned when needed for LLM calls */
  plaintextKey: string;
}

export interface CreateApiKeyInput {
  providerSlug: LLMProviderValue;
  label: string;
  plaintextKey: string;
  isPrimary?: boolean;
  createdBy?: string;
}

export interface UpdateApiKeyInput {
  label?: string;
  plaintextKey?: string;
  isPrimary?: boolean;
  isActive?: boolean;
}

// ─── Provider mapping ────────────────────────────────────────

/**
 * Map our LLMProviderValue slugs to the AIProvider.providerId
 * stored in the database. Uses the same slug for simplicity.
 */
function toDbProviderId(slug: LLMProviderValue): string {
  return slug;
}

// ─── Ensure AIProvider rows exist ────────────────────────────

/**
 * Ensure all LLM providers have an AIProvider row in the DB.
 * This is idempotent — only creates rows that don't exist.
 */
export async function ensureProvidersExist(): Promise<void> {
  const existing = await prisma.aIProvider.findMany({
    select: { providerId: true },
  });
  const existingSet = new Set(existing.map((p) => p.providerId));

  const toCreate = LLM_PROVIDERS.filter((p) => !existingSet.has(p.value));
  if (toCreate.length === 0) return;

  await prisma.$transaction(
    toCreate.map((p) =>
      prisma.aIProvider.create({
        data: {
          id: randomUUID(),
          providerId: p.value,
          displayName: p.label,
          description: p.description || null,
          baseUrl: p.defaultEndpoint || null,
          isEnabled: true,
          isDefault: false,
          sortOrder: 0,
          updatedAt: new Date(),
        },
      })
    )
  );

  logger.info('AIProvider rows seeded', { created: toCreate.map((p) => p.value) });
}

// ─── Internal helpers ────────────────────────────────────────

async function getProviderDbId(slug: LLMProviderValue): Promise<string> {
  const provider = await prisma.aIProvider.findUnique({
    where: { providerId: toDbProviderId(slug) },
    select: { id: true },
  });
  if (!provider) {
    // Auto-create if missing
    await ensureProvidersExist();
    const created = await prisma.aIProvider.findUnique({
      where: { providerId: toDbProviderId(slug) },
      select: { id: true },
    });
    if (!created) throw new Error(`Provider ${slug} not found after seeding`);
    return created.id;
  }
  return provider.id;
}

function toRecord(
  row: {
    id: string;
    providerId: string;
    keyName: string | null;
    isValid: boolean;
    validationError: string | null;
    lastValidated: Date | null;
    isActive: boolean;
    createdAt: Date;
    updatedAt: Date;
    createdBy: string | null;
    AIProvider: { providerId: string };
  },
  isPrimary: boolean
): ApiKeyRecord {
  return {
    id: row.id,
    providerId: row.providerId,
    providerSlug: row.AIProvider.providerId as LLMProviderValue,
    label: row.keyName || 'Default',
    isPrimary,
    isActive: row.isActive,
    isValid: row.isValid,
    validationError: row.validationError,
    lastValidated: row.lastValidated,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdBy: row.createdBy,
  };
}

// ─── Primary key tracking ────────────────────────────────────
// We use a SystemSetting `llm_primary_key_{providerSlug}` to
// track which APIKey.id is the primary for each provider.

function primaryKeySettingKey(slug: LLMProviderValue): string {
  return `llm_primary_key_${slug}`;
}

async function getPrimaryKeyId(slug: LLMProviderValue): Promise<string | null> {
  const row = await prisma.systemSetting.findUnique({
    where: { key: primaryKeySettingKey(slug) },
    select: { value: true },
  });
  return row?.value || null;
}

async function setPrimaryKeyId(slug: LLMProviderValue, keyId: string): Promise<void> {
  await prisma.systemSetting.upsert({
    where: { key: primaryKeySettingKey(slug) },
    update: { value: keyId, updatedBy: 'system' },
    create: { key: primaryKeySettingKey(slug), value: keyId, updatedBy: 'system' },
  });
}

// ─── CRUD Operations ─────────────────────────────────────────

/**
 * List all API keys for a provider (without decrypted secrets).
 */
export async function listApiKeys(slug?: LLMProviderValue): Promise<ApiKeyRecord[]> {
  const where: Record<string, unknown> = {};
  if (slug) {
    const dbId = await getProviderDbId(slug);
    where.providerId = dbId;
  }

  const rows = await prisma.aPIKey.findMany({
    where,
    include: { AIProvider: { select: { providerId: true } } },
    orderBy: [{ createdAt: 'asc' }],
  });

  // Batch-fetch primary key IDs for all providers
  const providerSlugs = [...new Set(rows.map((r) => r.AIProvider.providerId as LLMProviderValue))];
  const primaryMap = new Map<string, string | null>();
  for (const s of providerSlugs) {
    primaryMap.set(s, await getPrimaryKeyId(s));
  }

  return rows.map((row) => {
    const provSlug = row.AIProvider.providerId as LLMProviderValue;
    const primaryId = primaryMap.get(provSlug);
    const isPrimary = primaryId === row.id || (!primaryId && rows.filter(r => r.AIProvider.providerId === row.AIProvider.providerId).indexOf(row) === 0);
    return toRecord(row, isPrimary);
  });
}

/**
 * List all API keys grouped by provider.
 */
export async function listApiKeysGrouped(): Promise<Record<LLMProviderValue, ApiKeyRecord[]>> {
  const all = await listApiKeys();
  const grouped: Partial<Record<LLMProviderValue, ApiKeyRecord[]>> = {};
  for (const key of all) {
    if (!grouped[key.providerSlug]) grouped[key.providerSlug] = [];
    grouped[key.providerSlug]!.push(key);
  }
  return grouped as Record<LLMProviderValue, ApiKeyRecord[]>;
}

/**
 * Create a new API key for a provider.
 */
export async function createApiKey(input: CreateApiKeyInput): Promise<ApiKeyRecord> {
  const dbProviderId = await getProviderDbId(input.providerSlug);
  const encrypted = encryptSecret(input.plaintextKey);
  const hash = hashSecret(input.plaintextKey);
  const id = randomUUID();

  const row = await prisma.aPIKey.create({
    data: {
      id,
      providerId: dbProviderId,
      keyName: input.label,
      encryptedKey: encrypted,
      keyHash: hash,
      isValid: false, // Will validate separately
      isActive: true,
      createdBy: input.createdBy || null,
      updatedAt: new Date(),
    },
    include: { AIProvider: { select: { providerId: true } } },
  });

  // If this is the first key or explicitly primary, set as primary
  const existingKeys = await prisma.aPIKey.count({
    where: { providerId: dbProviderId, isActive: true },
  });
  if (input.isPrimary || existingKeys === 1) {
    await setPrimaryKeyId(input.providerSlug, id);
  }

  const primaryId = await getPrimaryKeyId(input.providerSlug);
  return toRecord(row, primaryId === id);
}

/**
 * Update an existing API key.
 */
export async function updateApiKey(
  id: string,
  input: UpdateApiKeyInput
): Promise<ApiKeyRecord> {
  const existing = await prisma.aPIKey.findUnique({
    where: { id },
    include: { AIProvider: { select: { providerId: true } } },
  });
  if (!existing) throw new Error(`API key ${id} not found`);

  const data: Record<string, unknown> = { updatedAt: new Date() };

  if (input.label !== undefined) data.keyName = input.label;
  if (input.isActive !== undefined) data.isActive = input.isActive;
  if (input.plaintextKey) {
    data.encryptedKey = encryptSecret(input.plaintextKey);
    data.keyHash = hashSecret(input.plaintextKey);
    data.isValid = false; // Re-validate after key change
    data.validationError = null;
  }

  const row = await prisma.aPIKey.update({
    where: { id },
    data,
    include: { AIProvider: { select: { providerId: true } } },
  });

  const slug = row.AIProvider.providerId as LLMProviderValue;

  if (input.isPrimary) {
    await setPrimaryKeyId(slug, id);
  }

  const primaryId = await getPrimaryKeyId(slug);
  return toRecord(row, primaryId === id);
}

/**
 * Delete an API key.
 */
export async function deleteApiKey(id: string): Promise<void> {
  const existing = await prisma.aPIKey.findUnique({
    where: { id },
    include: { AIProvider: { select: { providerId: true } } },
  });
  if (!existing) return;

  await prisma.aPIKey.delete({ where: { id } });

  const slug = existing.AIProvider.providerId as LLMProviderValue;

  // If the deleted key was primary, promote the next active key
  const primaryId = await getPrimaryKeyId(slug);
  if (primaryId === id) {
    const next = await prisma.aPIKey.findFirst({
      where: {
        AIProvider: { providerId: slug },
        isActive: true,
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    if (next) {
      await setPrimaryKeyId(slug, next.id);
    } else {
      // No keys left — clear the primary key tracker
      await prisma.systemSetting.deleteMany({
        where: { key: primaryKeySettingKey(slug) },
      });
    }
  }
}

/**
 * Get the decrypted primary API key for a provider.
 * This is what the pipeline uses at runtime.
 */
export async function getPrimaryApiKey(slug: LLMProviderValue): Promise<string> {
  const primaryId = await getPrimaryKeyId(slug);

  let row: { id: string; encryptedKey: string; isActive: boolean } | null = null;

  if (primaryId) {
    row = await prisma.aPIKey.findUnique({
      where: { id: primaryId },
      select: { id: true, encryptedKey: true, isActive: true },
    });
  }

  // Fallback: get first active key for provider
  if (!row || !row.isActive) {
    const provider = await prisma.aIProvider.findUnique({
      where: { providerId: slug },
      select: { id: true },
    });
    if (provider) {
      row = await prisma.aPIKey.findFirst({
        where: { providerId: provider.id, isActive: true },
        orderBy: { createdAt: 'asc' },
        select: { id: true, encryptedKey: true, isActive: true },
      });
    }
  }

  if (!row) return '';

  try {
    return decryptSecret(row.encryptedKey);
  } catch (err) {
    logger.error('Failed to decrypt API key', { keyId: row.id, error: String(err) });
    return '';
  }
}

/**
 * Get a fallback API key for a provider (any active key that isn't the primary).
 */
export async function getFallbackApiKey(slug: LLMProviderValue): Promise<string> {
  const primaryId = await getPrimaryKeyId(slug);
  const provider = await prisma.aIProvider.findUnique({
    where: { providerId: slug },
    select: { id: true },
  });
  if (!provider) return '';

  const row = await prisma.aPIKey.findFirst({
    where: {
      providerId: provider.id,
      isActive: true,
      ...(primaryId ? { id: { not: primaryId } } : {}),
    },
    orderBy: { createdAt: 'asc' },
    select: { encryptedKey: true },
  });

  if (!row) return '';

  try {
    return decryptSecret(row.encryptedKey);
  } catch {
    return '';
  }
}

// ─── Migration: SystemSetting → APIKey ───────────────────────

/**
 * Migrate existing plaintext API keys from SystemSetting to
 * encrypted APIKey rows. Idempotent — skips providers that
 * already have keys in the APIKey table.
 *
 * Guarded by ENABLE_API_KEY_MIGRATION env var or SystemSetting.
 * Set to 'true' to enable, any other value (or absent) disables
 * to prevent accidental data manipulation in production.
 */
export async function migrateSystemSettingKeysToApiKeyTable(): Promise<void> {
  // Feature flag: must be explicitly enabled
  const envFlag = process.env.ENABLE_API_KEY_MIGRATION;
  if (envFlag !== 'true') {
    // Check DB-level setting as secondary gate
    const dbFlag = await prisma.systemSetting.findUnique({
      where: { key: 'enable_api_key_migration' },
      select: { value: true },
    });
    if (dbFlag?.value !== 'true') {
      logger.info('API key migration skipped — ENABLE_API_KEY_MIGRATION not enabled');
      return;
    }
  }

  await ensureProvidersExist();

  // Local map used only by this one-time migration
  const PROVIDER_TO_SETTING_KEY: Record<string, string> = {
    openai: 'llm_openai_api_key',
    anthropic: 'llm_anthropic_api_key',
    openrouter: 'llm_openrouter_api_key',
    gemini: 'llm_gemini_api_key',
    'ollama-cloud': 'llm_ollama_cloud_api_key',
    mistral: 'llm_mistral_api_key',
    groq: 'llm_groq_api_key',
    custom: 'llm_custom_api_key',
  };

  // ⚡ Bolt: Batch database operations to prevent N+1 queries
  const slugs = Object.keys(PROVIDER_TO_SETTING_KEY);
  const settingKeys = Object.values(PROVIDER_TO_SETTING_KEY);

  // 1. Fetch all relevant AI Providers
  const providers = await prisma.aIProvider.findMany({
    where: { providerId: { in: slugs } },
    select: { id: true, providerId: true },
  });
  const providerMap = new Map(providers.map(p => [p.providerId, p.id]));

  // 2. Fetch all existing API key counts for these providers
  const providerIds = providers.map(p => p.id);
  const existingCounts = providerIds.length > 0 ? await prisma.aPIKey.groupBy({
    by: ['providerId'],
    where: { providerId: { in: providerIds } },
    _count: { _all: true },
  }) : [];
  const countMap = new Map<string, number>(
    existingCounts.map((c: any) => [c.providerId, c._count._all])
  );

  // 3. Fetch all relevant system settings
  const settings = await prisma.systemSetting.findMany({
    where: { key: { in: settingKeys } },
    select: { key: true, value: true },
  });
  const settingMap = new Map<string, string>(settings.map(s => [s.key, s.value]));

  for (const [slug, settingKey] of Object.entries(PROVIDER_TO_SETTING_KEY)) {
    try {
      const providerId = providerMap.get(slug);
      if (!providerId) continue;

      const existingCount = countMap.get(providerId) || 0;
      if (existingCount > 0) continue; // Already migrated

      const settingValue = settingMap.get(settingKey);
      if (!settingValue || settingValue.trim() === '') continue;

      // Skip masked sentinel values
      if (settingValue.startsWith('__')) continue;

      // Create encrypted APIKey record
      await createApiKey({
        providerSlug: slug as LLMProviderValue,
        label: 'Primary (migrated)',
        plaintextKey: settingValue,
        isPrimary: true,
        createdBy: 'system:migration',
      });

      logger.info('Migrated API key from SystemSetting to APIKey table', {
        provider: slug,
      });
    } catch (err) {
      logger.warn('Failed to migrate API key for provider', {
        provider: slug,
        error: String(err),
      });
    }
  }
}
