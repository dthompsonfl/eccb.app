import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadLLMConfig } from '../config-loader';
import { prisma } from '@/lib/db';
import * as apiKeyService from '../api-key-service';

vi.mock('@/lib/db', () => ({
  prisma: {
    systemSetting: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  },
}));

vi.mock('../api-key-service', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    getPrimaryApiKey: vi.fn().mockResolvedValue('mock-key'),
  };
});

describe('loadLLMConfig Performance', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('measures database hits', async () => {
    const iterations = 100;

    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      await loadLLMConfig();
    }
    const end = performance.now();

    const dbHits = vi.mocked(prisma.systemSetting.findMany).mock.calls.length;
    const apiKeyHits = vi.mocked(apiKeyService.getPrimaryApiKey).mock.calls.length;

    console.log(`[Baseline] Iterations: ${iterations}`);
    console.log(`[Baseline] Total time: ${(end - start).toFixed(2)}ms`);
    console.log(`[Baseline] Average time: ${((end - start) / iterations).toFixed(4)}ms`);
    console.log(`[Optimized] SystemSetting DB hits: ${dbHits}`);
    console.log(`[Optimized] getPrimaryApiKey hits: ${apiKeyHits}`);

    // With cache, we expect exactly 1 DB hit for the configuration
    // and exactly 1 call per provider for API keys, regardless of iterations.
    expect(dbHits).toBe(1);
    expect(apiKeyHits).toBe(8); // 8 providers, once each
  });
});
