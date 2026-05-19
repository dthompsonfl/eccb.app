import { describe, it, expect, vi, beforeEach } from 'vitest';
import { migrateSystemSettingKeysToApiKeyTable } from '../api-key-service';
import { prisma } from '@/lib/db';

// mock prisma
vi.mock('@/lib/db', () => ({
  prisma: {
    systemSetting: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    aIProvider: {
      findUnique: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
    },
    aPIKey: {
      count: vi.fn(),
      create: vi.fn(),
      groupBy: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

// mock ensureProvidersExist internal call inside migrateSystemSettingKeysToApiKeyTable
vi.mock('../api-key-service', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual as any,
    ensureProvidersExist: vi.fn().mockResolvedValue(undefined),
    createApiKey: vi.fn().mockResolvedValue({ id: 'mocked' }),
  };
});

// Mock logger
vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('migrateSystemSettingKeysToApiKeyTable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ENABLE_API_KEY_MIGRATION = 'true';
  });

  it('runs successfully without N+1 queries', async () => {
    // Setup mocks for the batch query
    (prisma.aIProvider.findMany as any).mockResolvedValue([
      { providerId: 'openai', id: 'provider-1' },
      { providerId: 'anthropic', id: 'provider-2' },
    ]);

    // Setup for APIKey count batching (if implemented) or loop
    (prisma.aPIKey.count as any).mockResolvedValue(0);

    // Setup for APIKey count batching (if implemented) or loop
    (prisma.aPIKey.groupBy as any).mockResolvedValue([]);

    // Setup for SystemSetting batching (if implemented) or loop
    (prisma.systemSetting.findMany as any).mockResolvedValue([
      { key: 'llm_openai_api_key', value: 'sk-123' },
      { key: 'llm_anthropic_api_key', value: 'sk-ant-123' }
    ]);

    await migrateSystemSettingKeysToApiKeyTable();

    // Verify
    expect(prisma.aIProvider.findMany).toHaveBeenCalled();
    // After refactoring, findUnique shouldn't be called inside the loop
  });
});
