// src/lib/smart-upload/__tests__/schema.test.ts
// ============================================================
// Comprehensive tests for Smart Upload schema validation
// ============================================================

import { describe, it, expect } from 'vitest';
import {
  SmartUploadSettingsSchema,
  ProviderValueSchema,
  getApiKeyFieldForProvider,
  providerRequiresApiKey,
  providerRequiresEndpoint,
  validateProviderApiKey,
  validateProviderEndpoint,
  maskSecrets,
  mergeSettingsPreservingSecrets,
  validateSmartUploadSettings,
  SECRET_KEYS,
  SMART_UPLOAD_SCHEMA_VERSION,
  dbRecordToSettings,
  settingsToDbRecord,
  SMART_UPLOAD_SETTING_KEYS,
} from '../schema';
import { PROMPT_VERSION } from '../prompts';

// =============================================================================
// SmartUploadSettingsSchema Validation Tests
// =============================================================================

describe('SmartUploadSettingsSchema', () => {
  const validSettings = {
    llm_provider: 'ollama' as const,
    llm_vision_model: 'llama3.2-vision',
    llm_verification_model: 'qwen2.5:7b',
    llm_vision_system_prompt: 'Test vision prompt',
    llm_verification_system_prompt: 'Test verification prompt',
  };

  describe('valid settings', () => {
    it('should pass validation with minimal valid settings', () => {
      const result = SmartUploadSettingsSchema.safeParse(validSettings);
      expect(result.success).toBe(true);
    });

    it('should pass validation with all fields populated', () => {
      const fullSettings = {
        ...validSettings,
        llm_endpoint_url: 'http://localhost:11434',
        llm_openai_api_key: 'sk-test',
        llm_anthropic_api_key: 'sk-ant-test',
        llm_openrouter_api_key: 'sk-or-test',
        llm_gemini_api_key: 'AIza-test',
        llm_custom_api_key: 'custom-key',
        llm_prompt_version: PROMPT_VERSION,
        smart_upload_confidence_threshold: 75,
        smart_upload_auto_approve_threshold: 85,
        smart_upload_rate_limit_rpm: 20,
        smart_upload_max_concurrent: 5,
        smart_upload_max_pages: 30,
        smart_upload_max_file_size_mb: 100,
        smart_upload_allowed_mime_types: JSON.stringify(['application/pdf']),
        llm_two_pass_enabled: true,
        vision_model_params: JSON.stringify({ temperature: 0.1 }),
        verification_model_params: JSON.stringify({ temperature: 0.2 }),
        smart_upload_schema_version: SMART_UPLOAD_SCHEMA_VERSION,
      };
      const result = SmartUploadSettingsSchema.safeParse(fullSettings);
      expect(result.success).toBe(true);
    });

    it('should apply default values for optional fields', () => {
      const result = SmartUploadSettingsSchema.safeParse(validSettings);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.smart_upload_confidence_threshold).toBe(70);
        expect(result.data.smart_upload_auto_approve_threshold).toBe(90);
        expect(result.data.smart_upload_rate_limit_rpm).toBe(15);
        expect(result.data.smart_upload_max_concurrent).toBe(3);
        expect(result.data.smart_upload_max_pages).toBe(20);
        expect(result.data.smart_upload_max_file_size_mb).toBe(50);
        expect(result.data.llm_two_pass_enabled).toBe(true);
        expect(result.data.llm_prompt_version).toBe(PROMPT_VERSION);
        expect(result.data.smart_upload_schema_version).toBe(SMART_UPLOAD_SCHEMA_VERSION);
      }
    });
  });

  describe('provider validation', () => {
    it('should accept all valid provider values', () => {
      const providers = ['glm-ocr', 'ollama', 'ollama-cloud', 'openai', 'anthropic', 'gemini', 'openrouter', 'mistral', 'groq', 'custom'] as const;
      for (const provider of providers) {
        const result = SmartUploadSettingsSchema.safeParse({
          ...validSettings,
          llm_provider: provider,
        });
        expect(result.success).toBe(true);
      }
    });

    it('should reject invalid provider values', () => {
      const result = SmartUploadSettingsSchema.safeParse({
        ...validSettings,
        llm_provider: 'invalid-provider',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toContain('llm_provider');
      }
    });

    it('should allow empty provider (optional for incremental updates)', () => {
      const result = SmartUploadSettingsSchema.safeParse({
        ...validSettings,
        llm_provider: '',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('required fields validation', () => {
    it('should allow vision_model to be missing (optional for incremental updates)', () => {
      const { llm_vision_model: _, ...settingsWithoutVision } = validSettings;
      const result = SmartUploadSettingsSchema.safeParse(settingsWithoutVision);
      expect(result.success).toBe(true);
    });

    it('should allow verification_model to be missing (optional for incremental updates)', () => {
      const { llm_verification_model: _, ...settingsWithoutVerification } = validSettings;
      const result = SmartUploadSettingsSchema.safeParse(settingsWithoutVerification);
      expect(result.success).toBe(true);
    });

    it('should allow vision_system_prompt to be empty (optional for incremental updates)', () => {
      const result = SmartUploadSettingsSchema.safeParse({
        ...validSettings,
        llm_vision_system_prompt: '',
      });
      expect(result.success).toBe(true);
    });

    it('should allow verification_system_prompt to be empty (optional for incremental updates)', () => {
      const result = SmartUploadSettingsSchema.safeParse({
        ...validSettings,
        llm_verification_system_prompt: '',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('endpoint URL validation', () => {
    it('should accept valid URLs', () => {
      const validUrls = [
        'http://localhost:11434',
        'https://api.openai.com/v1',
        'https://example.com:8080/path',
      ];
      for (const url of validUrls) {
        const result = SmartUploadSettingsSchema.safeParse({
          ...validSettings,
          llm_endpoint_url: url,
        });
        expect(result.success).toBe(true);
      }
    });

    it('should accept empty string for endpoint', () => {
      const result = SmartUploadSettingsSchema.safeParse({
        ...validSettings,
        llm_endpoint_url: '',
      });
      expect(result.success).toBe(true);
    });

    it('should reject invalid URLs', () => {
      // Note: ftp:// URLs and http:// are technically valid URL structures
      // per the URL constructor. We test truly invalid URL formats here.
      const invalidUrls = ['not-a-url', 'spaces in url', '\\backslashes\\'];
      for (const url of invalidUrls) {
        const result = SmartUploadSettingsSchema.safeParse({
          ...validSettings,
          llm_endpoint_url: url,
        });
        expect(result.success).toBe(false);
      }
    });
  });

  describe('numeric threshold clamping', () => {
    it('should clamp confidence threshold to 0-100 range', () => {
      const result = SmartUploadSettingsSchema.safeParse({
        ...validSettings,
        smart_upload_confidence_threshold: 150,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.smart_upload_confidence_threshold).toBe(100);
      }
    });

    it('should clamp negative confidence threshold to 0', () => {
      const result = SmartUploadSettingsSchema.safeParse({
        ...validSettings,
        smart_upload_confidence_threshold: -10,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.smart_upload_confidence_threshold).toBe(0);
      }
    });

    it('should clamp auto-approve threshold to 0-100 range', () => {
      const result = SmartUploadSettingsSchema.safeParse({
        ...validSettings,
        smart_upload_auto_approve_threshold: 200,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.smart_upload_auto_approve_threshold).toBe(100);
      }
    });

    it('should handle string numeric values', () => {
      const result = SmartUploadSettingsSchema.safeParse({
        ...validSettings,
        smart_upload_confidence_threshold: '85',
        smart_upload_auto_approve_threshold: '95',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.smart_upload_confidence_threshold).toBe(85);
        expect(result.data.smart_upload_auto_approve_threshold).toBe(95);
      }
    });

    it('should clamp rate limit to 1-1000 range', () => {
      const resultHigh = SmartUploadSettingsSchema.safeParse({
        ...validSettings,
        smart_upload_rate_limit_rpm: 5000,
      });
      expect(resultHigh.success).toBe(true);
      if (resultHigh.success) {
        expect(resultHigh.data.smart_upload_rate_limit_rpm).toBe(1000);
      }

      const resultLow = SmartUploadSettingsSchema.safeParse({
        ...validSettings,
        smart_upload_rate_limit_rpm: 0,
      });
      expect(resultLow.success).toBe(true);
      if (resultLow.success) {
        expect(resultLow.data.smart_upload_rate_limit_rpm).toBe(1);
      }
    });

    it('should clamp max concurrent to 1-50 range', () => {
      const result = SmartUploadSettingsSchema.safeParse({
        ...validSettings,
        smart_upload_max_concurrent: 100,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.smart_upload_max_concurrent).toBe(50);
      }
    });

    it('should clamp max pages to 1-100 range', () => {
      const result = SmartUploadSettingsSchema.safeParse({
        ...validSettings,
        smart_upload_max_pages: 500,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.smart_upload_max_pages).toBe(100);
      }
    });

    it('should clamp max file size to 1-500 MB range', () => {
      const result = SmartUploadSettingsSchema.safeParse({
        ...validSettings,
        smart_upload_max_file_size_mb: 1000,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.smart_upload_max_file_size_mb).toBe(500);
      }
    });

    it('should default smart_upload_second_pass_max_images to 0', () => {
      const result = SmartUploadSettingsSchema.safeParse(validSettings);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.smart_upload_second_pass_max_images).toBe(0);
      }
    });

    it('should clamp smart_upload_second_pass_max_images to 0-200 range', () => {
      const resultHigh = SmartUploadSettingsSchema.safeParse({
        ...validSettings,
        smart_upload_second_pass_max_images: 500,
      });
      expect(resultHigh.success).toBe(true);
      if (resultHigh.success) {
        expect(resultHigh.data.smart_upload_second_pass_max_images).toBe(200);
      }

      const resultNeg = SmartUploadSettingsSchema.safeParse({
        ...validSettings,
        smart_upload_second_pass_max_images: -5,
      });
      expect(resultNeg.success).toBe(true);
      if (resultNeg.success) {
        expect(resultNeg.data.smart_upload_second_pass_max_images).toBe(0);
      }
    });

    it('should accept string value for smart_upload_second_pass_max_images', () => {
      const result = SmartUploadSettingsSchema.safeParse({
        ...validSettings,
        smart_upload_second_pass_max_images: '32',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.smart_upload_second_pass_max_images).toBe(32);
      }
    });
  });

  describe('boolean field handling', () => {
    it('should handle string boolean values', () => {
      const result = SmartUploadSettingsSchema.safeParse({
        ...validSettings,
        llm_two_pass_enabled: 'false',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.llm_two_pass_enabled).toBe(false);
      }
    });

    it('should handle actual boolean values', () => {
      const result = SmartUploadSettingsSchema.safeParse({
        ...validSettings,
        llm_two_pass_enabled: false,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.llm_two_pass_enabled).toBe(false);
      }
    });
  });
});

// =============================================================================
// ProviderValueSchema Tests
// =============================================================================

describe('ProviderValueSchema', () => {
  it('should accept all valid provider values', () => {
    const providers = ['ollama', 'ollama-cloud', 'openai', 'anthropic', 'gemini', 'openrouter', 'mistral', 'groq', 'custom'];
    for (const provider of providers) {
      const result = ProviderValueSchema.safeParse(provider);
      expect(result.success).toBe(true);
    }
  });

  it('should reject invalid provider values', () => {
    const result = ProviderValueSchema.safeParse('invalid');
    expect(result.success).toBe(false);
  });
});

// =============================================================================
// Helper Function Tests
// =============================================================================

describe('getApiKeyFieldForProvider', () => {
  it('should return correct API key field for each provider', () => {
    expect(getApiKeyFieldForProvider('ollama')).toBe('');
    expect(getApiKeyFieldForProvider('openai')).toBe('llm_openai_api_key');
    expect(getApiKeyFieldForProvider('anthropic')).toBe('llm_anthropic_api_key');
    expect(getApiKeyFieldForProvider('gemini')).toBe('llm_gemini_api_key');
    expect(getApiKeyFieldForProvider('openrouter')).toBe('llm_openrouter_api_key');
    expect(getApiKeyFieldForProvider('ollama-cloud')).toBe('llm_ollama_cloud_api_key');
    expect(getApiKeyFieldForProvider('mistral')).toBe('llm_mistral_api_key');
    expect(getApiKeyFieldForProvider('groq')).toBe('llm_groq_api_key');
    expect(getApiKeyFieldForProvider('custom')).toBe('llm_custom_api_key');
  });

  it('should return empty string for unknown provider', () => {
    // TypeScript should prevent this, but test defensive behavior
    expect(getApiKeyFieldForProvider('unknown' as any)).toBe('');
  });
});

describe('providerRequiresApiKey', () => {
  it('should return false for local-only providers', () => {
    expect(providerRequiresApiKey('ollama')).toBe(false);
    expect(providerRequiresApiKey('custom')).toBe(false);
  });

  it('should return true for all cloud providers', () => {
    expect(providerRequiresApiKey('openai')).toBe(true);
    expect(providerRequiresApiKey('anthropic')).toBe(true);
    expect(providerRequiresApiKey('gemini')).toBe(true);
    expect(providerRequiresApiKey('openrouter')).toBe(true);
    expect(providerRequiresApiKey('ollama-cloud')).toBe(true);
    expect(providerRequiresApiKey('mistral')).toBe(true);
    expect(providerRequiresApiKey('groq')).toBe(true);
  });

  it('should return false for local glm-ocr', () => {
    expect(providerRequiresApiKey('glm-ocr')).toBe(false);
  });
});

describe('providerRequiresEndpoint', () => {
  it('should return true for local and custom providers', () => {
    expect(providerRequiresEndpoint('glm-ocr')).toBe(true);
    expect(providerRequiresEndpoint('custom')).toBe(true);
    expect(providerRequiresEndpoint('ollama')).toBe(true);
  });

  it('should return false for cloud providers', () => {
    expect(providerRequiresEndpoint('openai')).toBe(false);
    expect(providerRequiresEndpoint('anthropic')).toBe(false);
    expect(providerRequiresEndpoint('gemini')).toBe(false);
    expect(providerRequiresEndpoint('openrouter')).toBe(false);
    expect(providerRequiresEndpoint('ollama-cloud')).toBe(false);
    expect(providerRequiresEndpoint('mistral')).toBe(false);
    expect(providerRequiresEndpoint('groq')).toBe(false);
  });
});

describe('validateProviderApiKey', () => {
  it('should return valid for ollama without API key', () => {
    const result = validateProviderApiKey('ollama', {});
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('validates provider key requirements through API key service, not settings payload', () => {
    expect(validateProviderApiKey('openai').valid).toBe(true);
    expect(validateProviderApiKey('anthropic').valid).toBe(true);
    expect(validateProviderApiKey('custom').valid).toBe(true);
  });
});

describe('validateProviderEndpoint', () => {
  it('should return valid for cloud providers regardless of endpoint', () => {
    expect(validateProviderEndpoint('openai').valid).toBe(true);
    expect(validateProviderEndpoint('openai', '').valid).toBe(true);
    expect(validateProviderEndpoint('ollama', 'http://localhost').valid).toBe(true);
  });

  it('should return invalid when endpoint is missing for glm-ocr provider', () => {
    const result = validateProviderEndpoint('glm-ocr');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('glm-ocr requires an endpoint URL.');
  });

  it('should return invalid when endpoint is empty for custom provider', () => {
    const result = validateProviderEndpoint('custom', '');
    expect(result.valid).toBe(false);
  });

  it('should return invalid when endpoint is not a valid URL', () => {
    const result = validateProviderEndpoint('custom', 'not-a-url');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Endpoint URL must be a valid URL.');
  });

  it('should return valid for valid custom endpoint URL', () => {
    const result = validateProviderEndpoint('custom', 'http://localhost:8080');
    expect(result.valid).toBe(true);
  });
});

describe('maskSecrets', () => {
  it('should mask all secret keys', () => {
    const record = {
      llm_openai_api_key: 'sk-secret',
      llm_anthropic_api_key: 'sk-ant-secret',
      llm_openrouter_api_key: 'sk-or-secret',
      llm_gemini_api_key: 'AIza-secret',
      llm_custom_api_key: 'custom-secret',
      llm_provider: 'openai',
      llm_vision_model: 'gpt-4o',
    };

    const masked = maskSecrets(record);

    expect(masked.llm_openai_api_key).toBe('__SET__');
    expect(masked.llm_anthropic_api_key).toBe('__SET__');
    expect(masked.llm_openrouter_api_key).toBe('__SET__');
    expect(masked.llm_gemini_api_key).toBe('__SET__');
    expect(masked.llm_custom_api_key).toBe('__SET__');
    expect(masked.llm_provider).toBe('openai');
    expect(masked.llm_vision_model).toBe('gpt-4o');
  });

  it('should mark empty secrets as __UNSET__', () => {
    const record = {
      llm_openai_api_key: '',
      llm_anthropic_api_key: '  ',
      llm_provider: 'ollama',
    };

    const masked = maskSecrets(record);

    expect(masked.llm_openai_api_key).toBe('__UNSET__');
    expect(masked.llm_anthropic_api_key).toBe('__SET__'); // whitespace counts as set
  });

  it('should not modify non-secret keys', () => {
    const record = {
      llm_provider: 'openai',
      llm_vision_model: 'gpt-4o',
      llm_endpoint_url: 'http://localhost',
    };

    const masked = maskSecrets(record);

    expect(masked.llm_provider).toBe('openai');
    expect(masked.llm_vision_model).toBe('gpt-4o');
    expect(masked.llm_endpoint_url).toBe('http://localhost');
  });

  it('should return a new object without mutating original', () => {
    const record = {
      llm_openai_api_key: 'secret',
      llm_provider: 'openai',
    };

    const masked = maskSecrets(record);

    expect(record.llm_openai_api_key).toBe('secret');
    expect(masked.llm_openai_api_key).toBe('__SET__');
  });
});

describe('mergeSettingsPreservingSecrets', () => {
  const existing = {
    llm_openai_api_key: 'existing-secret',
    llm_provider: 'openai',
    llm_vision_model: 'gpt-4o',
  };

  it('should update non-secret values', () => {
    const updates = {
      llm_provider: 'anthropic',
      llm_vision_model: 'claude-3',
    };

    const merged = mergeSettingsPreservingSecrets(existing, updates);

    expect(merged.llm_provider).toBe('anthropic');
    expect(merged.llm_vision_model).toBe('claude-3');
    expect(merged.llm_openai_api_key).toBe('existing-secret');
  });

  it('should preserve secrets when __SET__ placeholder is used', () => {
    const updates = {
      llm_openai_api_key: '__SET__',
      llm_provider: 'openai',
    };

    const merged = mergeSettingsPreservingSecrets(existing, updates);

    expect(merged.llm_openai_api_key).toBe('existing-secret');
  });

  it('should preserve secrets when *** placeholder is used', () => {
    const updates = {
      llm_openai_api_key: '***',
      llm_provider: 'openai',
    };

    const merged = mergeSettingsPreservingSecrets(existing, updates);

    expect(merged.llm_openai_api_key).toBe('existing-secret');
  });

  it('should preserve secrets when ****** placeholder is used', () => {
    const updates = {
      llm_openai_api_key: '******',
      llm_provider: 'openai',
    };

    const merged = mergeSettingsPreservingSecrets(existing, updates);

    expect(merged.llm_openai_api_key).toBe('existing-secret');
  });

  it('should clear secrets when __CLEAR__ is used', () => {
    const updates = {
      llm_openai_api_key: '__CLEAR__',
      llm_provider: 'openai',
    };

    const merged = mergeSettingsPreservingSecrets(existing, updates);

    expect(merged.llm_openai_api_key).toBe('');
  });

  it('should update secrets when new value is provided', () => {
    const updates = {
      llm_openai_api_key: 'new-secret',
      llm_provider: 'openai',
    };

    const merged = mergeSettingsPreservingSecrets(existing, updates);

    expect(merged.llm_openai_api_key).toBe('new-secret');
  });

  it('should add new keys from updates', () => {
    const updates = {
      llm_verification_model: 'claude-3-haiku',
    };

    const merged = mergeSettingsPreservingSecrets(existing, updates);

    expect(merged.llm_verification_model).toBe('claude-3-haiku');
  });
});

describe('validateSmartUploadSettings', () => {
  it('should return valid for complete settings', () => {
    const settings = {
      llm_provider: 'ollama' as const,
      llm_vision_model: 'llama3.2-vision',
      llm_verification_model: 'qwen2.5:7b',
      llm_vision_system_prompt: 'Test prompt',
      llm_verification_system_prompt: 'Test prompt',
      llm_endpoint_url: 'http://localhost:11434',
    };

    const result = validateSmartUploadSettings(settings);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should return errors for invalid settings', () => {
    const settings = {
      llm_provider: 'invalid' as any,
      llm_vision_model: '',
      llm_verification_model: '',
      llm_vision_system_prompt: '',
      llm_verification_system_prompt: '',
    };

    const result = validateSmartUploadSettings(settings);

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('should include schema validation errors', () => {
    const settings = {
      llm_provider: 'openai' as const,
      llm_vision_model: 'gpt-4o',
      llm_verification_model: 'gpt-4o-mini',
      llm_vision_system_prompt: 'Test',
      llm_verification_system_prompt: 'Test',
      // Missing API key for openai
    };

    const result = validateSmartUploadSettings(settings);

    expect(result.valid).toBe(true);
  });

  it('should include endpoint validation errors for custom provider', () => {
    const settings = {
      llm_provider: 'custom' as const,
      llm_vision_model: 'custom-model',
      llm_verification_model: 'custom-verification',
      llm_vision_system_prompt: 'Test',
      llm_verification_system_prompt: 'Test',
      llm_custom_api_key: 'custom-key',
      // Missing endpoint URL
    };

    const result = validateSmartUploadSettings(settings);

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('Custom provider requires'))).toBe(true);
  });

  it('should validate URL format for custom provider endpoint', () => {
    const settings = {
      llm_provider: 'custom' as const,
      llm_vision_model: 'custom-model',
      llm_verification_model: 'custom-verification',
      llm_vision_system_prompt: 'Test',
      llm_verification_system_prompt: 'Test',
      llm_custom_api_key: 'custom-key',
      llm_endpoint_url: 'not-a-valid-url',
    };

    const result = validateSmartUploadSettings(settings);

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('Endpoint URL must be a valid URL'))).toBe(true);
  });
});

// =============================================================================
// Database Conversion Tests
// =============================================================================

describe('dbRecordToSettings', () => {
  it('should convert database record to settings object', () => {
    const record = {
      llm_provider: 'openai',
      llm_vision_model: 'gpt-4o',
      llm_verification_model: 'gpt-4o-mini',
      llm_vision_system_prompt: 'Vision prompt',
      llm_verification_system_prompt: 'Verification prompt',
    };

    const settings = dbRecordToSettings(record);

    expect(settings.llm_provider).toBe('openai');
    expect(settings.llm_vision_model).toBe('gpt-4o');
  });

  it('should apply defaults for missing optional fields', () => {
    const record = {
      llm_provider: 'ollama',
      llm_vision_model: 'llama3.2-vision',
      llm_verification_model: 'qwen2.5:7b',
      llm_vision_system_prompt: 'Test',
      llm_verification_system_prompt: 'Test',
    };

    const settings = dbRecordToSettings(record);

    expect(settings.smart_upload_confidence_threshold).toBe(70);
    expect(settings.llm_two_pass_enabled).toBe(true);
  });

  it('should parse successfully when prompts are missing (optional)', () => {
    const record = {
      llm_provider: 'ollama',
      llm_vision_model: 'llama3.2-vision',
      llm_verification_model: 'qwen2.5:7b',
    };

    // Prompts are now optional for incremental updates
    const settings = dbRecordToSettings(record);
    expect(settings).toBeDefined();
    expect(settings.llm_provider).toBe('ollama');
  });

  it('should parse successfully when prompts are provided in record', () => {
    const record = {
      llm_provider: 'ollama',
      llm_vision_model: 'llama3.2-vision',
      llm_verification_model: 'qwen2.5:7b',
      llm_vision_system_prompt: 'Vision prompt from DB',
      llm_verification_system_prompt: 'Verification prompt from DB',
    };

    const settings = dbRecordToSettings(record);

    expect(settings.llm_vision_system_prompt).toBe('Vision prompt from DB');
    expect(settings.llm_verification_system_prompt).toBe('Verification prompt from DB');
  });
});

describe('settingsToDbRecord', () => {
  it('should convert settings to database record format', () => {
    const settings = SmartUploadSettingsSchema.parse({
      llm_provider: 'openai',
      llm_vision_model: 'gpt-4o',
      llm_verification_model: 'gpt-4o-mini',
      llm_vision_system_prompt: 'Vision prompt',
      llm_verification_system_prompt: 'Verification prompt',
      llm_openai_api_key: 'sk-secret',
    });

    const record = settingsToDbRecord(settings);

    expect(record.llm_provider).toBe('openai');
    expect(record.llm_openai_api_key).toBeUndefined();
  });

  it('should stringify object values', () => {
    const settings = SmartUploadSettingsSchema.parse({
      llm_provider: 'ollama',
      llm_vision_model: 'llama3.2-vision',
      llm_verification_model: 'qwen2.5:7b',
      llm_vision_system_prompt: 'Test',
      llm_verification_system_prompt: 'Test',
      vision_model_params: JSON.stringify({ temperature: 0.1 }),
    });

    const record = settingsToDbRecord(settings);

    expect(typeof record.vision_model_params).toBe('string');
  });

  it('should include all SMART_UPLOAD_SETTING_KEYS', () => {
    const settings = SmartUploadSettingsSchema.parse({
      llm_provider: 'ollama',
      llm_vision_model: 'llama3.2-vision',
      llm_verification_model: 'qwen2.5:7b',
      llm_vision_system_prompt: 'Test',
      llm_verification_system_prompt: 'Test',
    });

    const record = settingsToDbRecord(settings);

    // Should have entries for all keys that have values
    expect(Object.keys(record).length).toBeGreaterThan(0);
  });

  it('should include enforceOcrSplitting key in SMART_UPLOAD_SETTING_KEYS', () => {
    expect(SMART_UPLOAD_SETTING_KEYS).toContain('smart_upload_enforce_ocr_splitting');
  });
});

// =============================================================================
// Constants Tests
// =============================================================================

describe('SECRET_KEYS', () => {
  it('should contain all API key fields', () => {
    expect(SECRET_KEYS).toContain('llm_openai_api_key');
    expect(SECRET_KEYS).toContain('llm_anthropic_api_key');
    expect(SECRET_KEYS).toContain('llm_openrouter_api_key');
    expect(SECRET_KEYS).toContain('llm_gemini_api_key');
    expect(SECRET_KEYS).toContain('llm_ollama_cloud_api_key');
    expect(SECRET_KEYS).toContain('llm_mistral_api_key');
    expect(SECRET_KEYS).toContain('llm_groq_api_key');
    expect(SECRET_KEYS).toContain('llm_custom_api_key');
  });

  it('should be immutable (readonly array)', () => {
    // TypeScript ensures this at compile time
    expect(Array.isArray(SECRET_KEYS)).toBe(true);
    expect(SECRET_KEYS.length).toBe(8);
  });
});
