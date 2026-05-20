import { describe, it, expect, vi, beforeEach } from 'vitest';

import { buildAdapterConfigForStep, loadLLMConfig } from '../config-loader';
import { prisma } from '@/lib/db';
import { getFallbackApiKey, getPrimaryApiKey } from '../api-key-service';

vi.mock('@/lib/db', () => ({
  prisma: {
    systemSetting: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock('../api-key-service', () => ({
  getPrimaryApiKey: vi.fn(),
  getFallbackApiKey: vi.fn(),
}));

describe('loadLLMConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getPrimaryApiKey).mockResolvedValue('');
    vi.mocked(getFallbackApiKey).mockResolvedValue('');
  });

  it('returns enforceOcrSplitting based on DB setting', async () => {
    vi.mocked(prisma.systemSetting.findMany).mockResolvedValueOnce([
      { key: 'smart_upload_enforce_ocr_splitting', value: 'true' },
    ] as any);
    const config = await loadLLMConfig();

    expect(config.enforceOcrSplitting).toBe(true);
  });

  it('preserves an explicit endpoint for glm-ocr step configs', async () => {
    vi.mocked(prisma.systemSetting.findMany).mockResolvedValueOnce([
      { key: 'llm_default_provider', value: 'glm-ocr' },
      { key: 'llm_endpoint_url', value: 'http://127.0.0.1:8090/v1' },
      { key: 'llm_vision_model', value: 'zai-org/GLM-OCR' },
    ] as any);

    const config = await loadLLMConfig();
    const stepConfig = await buildAdapterConfigForStep(config, 'vision');

    expect(config.endpointUrl).toBe('http://127.0.0.1:8090/v1');
    expect(stepConfig.endpointUrl).toBe('http://127.0.0.1:8090/v1');
  });

  it('uses provider defaults when no explicit endpoint is configured', async () => {
    vi.mocked(prisma.systemSetting.findMany).mockResolvedValueOnce([
      { key: 'llm_default_provider', value: 'openai' },
      { key: 'llm_vision_model', value: 'gpt-4o' },
    ] as any);

    const config = await loadLLMConfig();
    const stepConfig = await buildAdapterConfigForStep(config, 'vision');

    expect(config.endpointUrl).toBe('https://api.openai.com/v1');
    expect(stepConfig.endpointUrl).toBe('https://api.openai.com/v1');
  });
});
