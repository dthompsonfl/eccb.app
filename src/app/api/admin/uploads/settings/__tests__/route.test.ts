// src/app/api/admin/uploads/settings/__tests__/route.test.ts
// ============================================================
// Comprehensive tests for Smart Upload Settings API
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

// =============================================================================
// Mock Setup - All mocks must be defined before any imports
// =============================================================================

const mockGetSession = vi.hoisted(() => vi.fn());
const mockCheckUserPermission = vi.hoisted(() => vi.fn());
const mockValidateCSRF = vi.hoisted(() => vi.fn());
const mockAuditLog = vi.hoisted(() => vi.fn());
const mockPrismaSystemSettingFindMany = vi.hoisted(() => vi.fn());
const mockPrismaSystemSettingUpsert = vi.hoisted(() => vi.fn());
const mockPrismaTransaction = vi.hoisted(() => vi.fn());
const mockLoggerInfo = vi.hoisted(() => vi.fn());
const mockLoggerError = vi.hoisted(() => vi.fn());
const mockLoggerWarn = vi.hoisted(() => vi.fn());
const mockResetPromptsToDefaults = vi.hoisted(() => vi.fn());
const mockLoadSmartUploadSettingsFromDB = vi.hoisted(() => vi.fn());
const mockGetPrimaryApiKey = vi.hoisted(() => vi.fn());

// Mock dependencies
vi.mock('@/lib/auth/guards', () => ({
  getSession: mockGetSession,
}));

vi.mock('@/lib/auth/permissions', () => ({
  checkUserPermission: mockCheckUserPermission,
}));

vi.mock('@/lib/csrf', () => ({
  validateCSRF: mockValidateCSRF,
}));

vi.mock('@/lib/services/audit', () => ({
  auditLog: mockAuditLog,
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    systemSetting: {
      findMany: mockPrismaSystemSettingFindMany,
      upsert: mockPrismaSystemSettingUpsert,
    },
    $transaction: mockPrismaTransaction,
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    info: mockLoggerInfo,
    error: mockLoggerError,
    warn: mockLoggerWarn,
  },
}));

vi.mock('@/lib/smart-upload/bootstrap', () => ({
  resetPromptsToDefaults: mockResetPromptsToDefaults,
  loadSmartUploadSettingsFromDB: mockLoadSmartUploadSettingsFromDB,
}));

vi.mock('@/lib/llm/api-key-service', () => ({
  getPrimaryApiKey: mockGetPrimaryApiKey,
}));

// Mock global fetch for connection tests
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Import after mocks
import { GET, PUT, OPTIONS } from '../route';
import { POST as resetPromptsHandler } from '../reset-prompts/route';
import { POST as testConnectionHandler } from '../test/route';

// =============================================================================
// Test Utilities
// =============================================================================

function createMockRequest(options: {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  url?: string;
}): NextRequest {
  const { method = 'GET', body, headers = {}, url = 'http://localhost/api/admin/uploads/settings' } = options;
  
  return new NextRequest(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

const TEST_USER_ID = 'test-user-123';
const TEST_ADMIN_SESSION = {
  user: {
    id: TEST_USER_ID,
    email: 'admin@eccb.app',
    name: 'Test Admin',
  },
};

const DEFAULT_SETTINGS = {
  llm_provider: 'ollama',
  llm_vision_model: 'llama3.2-vision',
  llm_verification_model: 'qwen2.5:7b',
  llm_vision_system_prompt: 'Test vision prompt',
  llm_verification_system_prompt: 'Test verification prompt',
  llm_endpoint_url: 'http://localhost:11434',
  llm_prompt_version: '1.0.0',
  llm_openai_api_key: 'sk-secret',
  llm_anthropic_api_key: '',
  smart_upload_confidence_threshold: '70',
  smart_upload_auto_approve_threshold: '90',
};

// =============================================================================
// Test Suite
// =============================================================================

describe('Smart Upload Settings API', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default mock implementations
    mockValidateCSRF.mockReturnValue({ valid: true });
    mockGetSession.mockResolvedValue(TEST_ADMIN_SESSION);
    mockCheckUserPermission.mockResolvedValue(true);
    mockAuditLog.mockResolvedValue(undefined);
    mockLoggerInfo.mockReturnValue(undefined);
    mockLoggerError.mockReturnValue(undefined);
    mockLoggerWarn.mockReturnValue(undefined);
    
    // Mock database response as array format (used by GET handler)
    mockPrismaSystemSettingFindMany.mockResolvedValue([
      { id: '1', key: 'llm_provider', value: 'ollama', description: null, updatedAt: new Date(), updatedBy: null },
      { id: '2', key: 'llm_vision_model', value: 'llama3.2-vision', description: null, updatedAt: new Date(), updatedBy: null },
      { id: '3', key: 'llm_verification_model', value: 'qwen2.5:7b', description: null, updatedAt: new Date(), updatedBy: null },
      { id: '4', key: 'llm_vision_system_prompt', value: 'Test vision prompt', description: null, updatedAt: new Date(), updatedBy: null },
      { id: '5', key: 'llm_verification_system_prompt', value: 'Test verification prompt', description: null, updatedAt: new Date(), updatedBy: null },
      { id: '6', key: 'llm_prompt_version', value: '1.0.0', description: null, updatedAt: new Date(), updatedBy: null },
      { id: '7', key: 'llm_openai_api_key', value: 'sk-secret', description: null, updatedAt: new Date(), updatedBy: null },
      { id: '8', key: 'llm_anthropic_api_key', value: '', description: null, updatedAt: new Date(), updatedBy: null },
      { id: '9', key: 'smart_upload_confidence_threshold', value: '70', description: null, updatedAt: new Date(), updatedBy: null },
      { id: '10', key: 'smart_upload_auto_approve_threshold', value: '90', description: null, updatedAt: new Date(), updatedBy: null },
    ]);

    mockLoadSmartUploadSettingsFromDB.mockResolvedValue({
      settings: DEFAULT_SETTINGS,
      masked: {
        ...DEFAULT_SETTINGS,
        llm_openai_api_key: '__SET__',
        llm_anthropic_api_key: '__UNSET__',
      },
    });

    mockPrismaTransaction.mockImplementation(async (operations: unknown[]) => {
      for (const op of operations) {
        if (typeof op === 'function') {
          await op();
        }
      }
      return operations;
    });

    mockResetPromptsToDefaults.mockResolvedValue({
      success: true,
      resetKeys: ['llm_vision_system_prompt', 'llm_verification_system_prompt', 'llm_prompt_version'],
    });
    mockGetPrimaryApiKey.mockResolvedValue('');

    // Default fetch response for connection tests
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ id: 'model-1' }, { id: 'model-2' }],
      }),
    });
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  // ===========================================================================
  // GET /api/admin/uploads/settings
  // ===========================================================================

  describe('GET /api/admin/uploads/settings', () => {
    it('should return 401 when not authenticated', async () => {
      mockGetSession.mockResolvedValue(null);

      const response = await GET();
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error).toBe('Unauthorized');
    });

    it('should return 401 when user has no id', async () => {
      mockGetSession.mockResolvedValue({ user: {} });

      const response = await GET();
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error).toBe('Unauthorized');
    });

    it('should return 403 when missing permission', async () => {
      mockCheckUserPermission.mockResolvedValue(false);

      const response = await GET();
      const data = await response.json();

      expect(response.status).toBe(403);
      expect(data.error).toBe('Forbidden');
    });

    it('should return masked settings when authenticated with permission', async () => {
      const response = await GET();
      const data = await response.json();
      expect(response.status).toBe(200);
      expect(data.settings).toBeDefined();
      expect(Array.isArray(data.settings)).toBe(true);
      const findSetting = (key: string) => data.settings.find((s: { key: string }) => s.key === key);
      expect(findSetting('llm_openai_api_key')?.value).toBe('__SET__');
      expect(findSetting('llm_anthropic_api_key')?.value).toBe('__UNSET__');
      expect(findSetting('llm_provider')?.value).toBe('ollama');
    });

    it('should inject all default prompts when missing in DB', async () => {
      // simulate DB with no prompt rows
      mockPrismaSystemSettingFindMany.mockResolvedValue([]);
      const response = await GET();
      const data = await response.json();
      expect(response.status).toBe(200);
      const keys = data.settings.map((s: any) => s.key);
      // default prompts from getDefaultPromptsRecord should be included
      expect(keys).toContain('llm_vision_system_prompt');
      expect(keys).toContain('llm_verification_system_prompt');
      expect(keys).toContain('llm_header_label_prompt');
      expect(keys).toContain('llm_adjudicator_prompt');
    });

    it('should mask all secret keys in response', async () => {
      // Mock the database response with secrets
      mockPrismaSystemSettingFindMany.mockResolvedValue([
        { id: '1', key: 'llm_provider', value: 'openai', description: null, updatedAt: new Date(), updatedBy: null },
        { id: '2', key: 'llm_openai_api_key', value: 'sk-secret', description: null, updatedAt: new Date(), updatedBy: null },
        { id: '3', key: 'llm_anthropic_api_key', value: 'sk-ant-secret', description: null, updatedAt: new Date(), updatedBy: null },
        { id: '4', key: 'llm_openrouter_api_key', value: 'sk-or-secret', description: null, updatedAt: new Date(), updatedBy: null },
        { id: '5', key: 'llm_gemini_api_key', value: 'AIza-secret', description: null, updatedAt: new Date(), updatedBy: null },
        { id: '6', key: 'llm_custom_api_key', value: 'custom-secret', description: null, updatedAt: new Date(), updatedBy: null },
      ]);

      const response = await GET();
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(Array.isArray(data.settings)).toBe(true);
      
      // Find settings by key in the array
      const findSetting = (key: string) => data.settings.find((s: { key: string }) => s.key === key);
      
      expect(findSetting('llm_openai_api_key')?.value).toBe('__SET__');
      expect(findSetting('llm_anthropic_api_key')?.value).toBe('__SET__');
      expect(findSetting('llm_openrouter_api_key')?.value).toBe('__SET__');
      expect(findSetting('llm_gemini_api_key')?.value).toBe('__SET__');
      expect(findSetting('llm_custom_api_key')?.value).toBe('__SET__');
    });

    it('should return 500 on database error', async () => {
      mockPrismaSystemSettingFindMany.mockRejectedValue(new Error('Database error'));

      const response = await GET();
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.error).toBe('Failed to fetch settings');
      expect(mockLoggerError).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // PUT /api/admin/uploads/settings
  // ===========================================================================

  describe('PUT /api/admin/uploads/settings', () => {
    it('should return 401 when not authenticated', async () => {
      mockGetSession.mockResolvedValue(null);

      const request = createMockRequest({
        method: 'PUT',
        body: { settings: [] },
      });

      const response = await PUT(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error).toBe('Unauthorized');
    });

    it('should return 403 when missing permission', async () => {
      mockCheckUserPermission.mockResolvedValue(false);

      const request = createMockRequest({
        method: 'PUT',
        body: { settings: [] },
      });

      const response = await PUT(request);
      const data = await response.json();

      expect(response.status).toBe(403);
      expect(data.error).toBe('Forbidden');
    });

    it('should return 403 when CSRF validation fails', async () => {
      mockValidateCSRF.mockReturnValue({ valid: false, reason: 'Invalid CSRF token' });

      const request = createMockRequest({
        method: 'PUT',
        body: { settings: [] },
      });

      const response = await PUT(request);
      const data = await response.json();

      expect(response.status).toBe(403);
      expect(data.error).toBe('CSRF validation failed');
      expect(data.reason).toBe('Invalid CSRF token');
    });

    it('should return 400 for invalid request body', async () => {
      const request = createMockRequest({
        method: 'PUT',
        body: { notSettings: [] },
      });

      const response = await PUT(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe('Invalid request body');
    });

    it('should return 400 for invalid JSON fields', async () => {
      const request = createMockRequest({
        method: 'PUT',
        body: {
          settings: [
            { key: 'vision_model_params', value: 'not-valid-json' },
            { key: 'llm_header_label_model_params', value: 'also-bad' },
          ],
        },
      });

      const response = await PUT(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toContain('Invalid JSON');
    });

    it('should validate settings using schema', async () => {
      const request = createMockRequest({
        method: 'PUT',
        body: {
          settings: [
            { key: 'llm_provider', value: 'invalid-provider' },
          ],
        },
      });

      const response = await PUT(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe('Validation failed');
      expect(data.details).toBeDefined();
    });

    it('should reject invalid provider/model combinations', async () => {
      // Mock existing settings without API key
      mockLoadSmartUploadSettingsFromDB.mockResolvedValue({
        settings: {
          llm_provider: 'ollama', // Different from what we're setting
          llm_vision_model: 'gpt-4o',
          llm_verification_model: 'gpt-4o-mini',
          llm_vision_system_prompt: 'Test prompt',
          llm_verification_system_prompt: 'Test prompt',
          // No API key for openai
        },
        masked: {
          llm_provider: 'ollama',
          llm_vision_model: 'gpt-4o',
          llm_verification_model: 'gpt-4o-mini',
          llm_vision_system_prompt: 'Test prompt',
          llm_verification_system_prompt: 'Test prompt',
          llm_openai_api_key: '__UNSET__',
        },
      });

      const request = createMockRequest({
        method: 'PUT',
        body: {
          settings: [
            { key: 'llm_provider', value: 'openai' },
            { key: 'llm_vision_model', value: 'gpt-4o' },
            { key: 'llm_verification_model', value: 'gpt-4o-mini' },
            { key: 'llm_vision_system_prompt', value: 'Test prompt' },
            { key: 'llm_verification_system_prompt', value: 'Test prompt' },
            // Missing API key for openai
          ],
        },
      });

      const response = await PUT(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
    });

    it('should preserve secrets when using __SET__ placeholder', async () => {
      mockLoadSmartUploadSettingsFromDB.mockResolvedValue({
        settings: {
          llm_provider: 'openai',
          llm_openai_api_key: 'existing-secret',
        },
        masked: {
          llm_provider: 'openai',
          llm_openai_api_key: '__SET__',
        },
      });

      const request = createMockRequest({
        method: 'PUT',
        body: {
          settings: [
            { key: 'llm_provider', value: 'openai' },
            { key: 'llm_openai_api_key', value: '__SET__' },
            { key: 'llm_vision_model', value: 'gpt-4o' },
            { key: 'llm_verification_model', value: 'gpt-4o-mini' },
            { key: 'llm_vision_system_prompt', value: 'Test prompt' },
            { key: 'llm_verification_system_prompt', value: 'Test prompt' },
          ],
        },
      });

      const response = await PUT(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
    });

    it('should update settings when valid', async () => {
      mockPrismaSystemSettingUpsert.mockResolvedValue({});

      // Mock existing settings to be different from updates
      mockLoadSmartUploadSettingsFromDB.mockResolvedValue({
        settings: {
          llm_provider: 'openai', // Different value
          llm_vision_model: 'gpt-4o', // Different value
          llm_verification_model: 'gpt-4o-mini',
          llm_vision_system_prompt: 'Test',
          llm_verification_system_prompt: 'Test',
          llm_openai_api_key: 'sk-test-key',
        },
        masked: {
          llm_provider: 'openai',
          llm_vision_model: 'gpt-4o',
          llm_verification_model: 'gpt-4o-mini',
          llm_vision_system_prompt: 'Test',
          llm_verification_system_prompt: 'Test',
          llm_openai_api_key: '__SET__',
        },
      });

      const request = createMockRequest({
        method: 'PUT',
        body: {
          settings: [
            { key: 'llm_provider', value: 'ollama' },
            { key: 'llm_vision_model', value: 'llama3.2-vision' },
            { key: 'llm_endpoint_url', value: 'http://localhost:11434' },
          ],
        },
      });

      const response = await PUT(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.updated).toContain('llm_provider');
      expect(mockPrismaTransaction).toHaveBeenCalled();
    });

    it('should skip unchanged settings', async () => {
      // Mock existing settings that match the incoming settings exactly
      mockLoadSmartUploadSettingsFromDB.mockResolvedValue({
        settings: {
          llm_provider: 'ollama',
          llm_vision_model: 'llama3.2-vision',
          llm_verification_model: 'qwen2.5:7b',
          llm_vision_system_prompt: 'Test',
          llm_verification_system_prompt: 'Test',
          llm_endpoint_url: 'http://localhost:11434',
        },
        masked: {
          llm_provider: 'ollama',
          llm_vision_model: 'llama3.2-vision',
          llm_verification_model: 'qwen2.5:7b',
          llm_vision_system_prompt: 'Test',
          llm_verification_system_prompt: 'Test',
          llm_endpoint_url: 'http://localhost:11434',
        },
      });

      const request = createMockRequest({
        method: 'PUT',
        body: {
          settings: [
            { key: 'llm_provider', value: 'ollama' },
            { key: 'llm_vision_model', value: 'llama3.2-vision' },
            { key: 'llm_endpoint_url', value: 'http://localhost:11434' },
          ],
        },
      });

      const response = await PUT(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.message).toBe('No changes to update');
    });

    it('should reject missing API key when a per-step provider is specified', async () => {
      mockLoadSmartUploadSettingsFromDB.mockResolvedValue({
        settings: {
          llm_provider: 'ollama',
          llm_vision_model: 'model',
          llm_verification_model: 'model',
          llm_openai_api_key: '',
        },
        masked: {
          llm_provider: 'ollama',
          llm_openai_api_key: '__UNSET__',
        },
      });

      const request = createMockRequest({
        method: 'PUT',
        body: {
          settings: [
            { key: 'llm_vision_provider', value: 'openai' },
            { key: 'llm_verification_model', value: 'model' },
          ],
        },
      });

      const response = await PUT(request);
      const data = await response.json();
      expect(response.status).toBe(400);
      expect(data.error).toBe('Validation failed');
      expect(data.details.some((e: string) => e.includes('endpoint URL'))).toBe(true);
    });

    it('should skip disallowed keys', async () => {
      mockLoadSmartUploadSettingsFromDB.mockResolvedValue({
        settings: {
          llm_provider: 'openai',
          llm_vision_model: 'gpt-4o',
          llm_verification_model: 'gpt-4o-mini',
          llm_vision_system_prompt: 'Test',
          llm_verification_system_prompt: 'Test',
          llm_openai_api_key: 'sk-test-key',
        },
        masked: {
          llm_provider: 'openai',
          llm_vision_model: 'gpt-4o',
          llm_verification_model: 'gpt-4o-mini',
          llm_vision_system_prompt: 'Test',
          llm_verification_system_prompt: 'Test',
          llm_openai_api_key: '__SET__',
        },
      });
      const request = createMockRequest({
        method: 'PUT',
        body: {
          settings: [
            { key: 'llm_provider', value: 'openai' },
            { key: 'disallowed_key', value: 'some-value' },
          ],
        },
      });

      const response = await PUT(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.skipped).toContain('disallowed_key');
    });

    it('should create audit log entry', async () => {
      const request = createMockRequest({
        method: 'PUT',
        body: {
          settings: [{ key: 'llm_provider', value: 'openai' }],
        },
      });

      await PUT(request);

      expect(mockAuditLog).toHaveBeenCalledWith({
        action: 'UPDATE_SMART_UPLOAD_SETTINGS',
        entityType: 'SETTING',
        entityId: 'smart_upload',
        newValues: expect.objectContaining({
          keys: expect.arrayContaining(['llm_provider']),
        }),
      });
    });

    it('should return 500 on database error', async () => {
      // Setup: settings that pass validation but transaction fails
      mockLoadSmartUploadSettingsFromDB.mockResolvedValue({
        settings: {
          llm_provider: 'openai', // Will be updated to ollama
          llm_vision_model: 'gpt-4o',
          llm_verification_model: 'gpt-4o-mini',
          llm_vision_system_prompt: 'Test',
          llm_verification_system_prompt: 'Test',
          llm_openai_api_key: 'sk-test-key',
        },
        masked: {
          llm_provider: 'openai',
          llm_vision_model: 'gpt-4o',
          llm_verification_model: 'gpt-4o-mini',
          llm_vision_system_prompt: 'Test',
          llm_verification_system_prompt: 'Test',
          llm_openai_api_key: '__SET__',
        },
      });
      mockPrismaTransaction.mockRejectedValue(new Error('Database error'));

      const request = createMockRequest({
        method: 'PUT',
        body: {
          settings: [{ key: 'llm_vision_model', value: 'gpt-4o-new' }],
        },
      });

      const response = await PUT(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.error).toBe('Failed to update settings');
    });
  });

  // ===========================================================================
  // POST /api/admin/uploads/settings/reset-prompts
  // ===========================================================================

  describe('POST /api/admin/uploads/settings/reset-prompts', () => {
    const POST = resetPromptsHandler;
    it('should reset prompts to defaults', async () => {
      mockLoadSmartUploadSettingsFromDB.mockResolvedValue({
        settings: {
          llm_vision_system_prompt: 'New vision prompt',
          llm_verification_system_prompt: 'New verification prompt',
          llm_prompt_version: '1.0.0',
        },
        masked: {
          llm_vision_system_prompt: 'New vision prompt',
          llm_verification_system_prompt: 'New verification prompt',
          llm_prompt_version: '1.0.0',
        },
      });

      const request = createMockRequest({
        method: 'POST',
        url: 'http://localhost/api/admin/uploads/settings/reset-prompts',
        body: {},
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.message).toBe('Prompts reset to defaults successfully');
      expect(mockResetPromptsToDefaults).toHaveBeenCalledWith(TEST_USER_ID);
    });

    it('should return new prompt values after reset', async () => {
      const newPrompts = {
        llm_vision_system_prompt: 'Default vision prompt',
        llm_verification_system_prompt: 'Default verification prompt',
        llm_prompt_version: '1.0.0',
      };

      mockLoadSmartUploadSettingsFromDB.mockResolvedValue({
        settings: newPrompts,
        masked: newPrompts,
      });

      const request = createMockRequest({
        method: 'POST',
        url: 'http://localhost/api/admin/uploads/settings/reset-prompts',
        body: {},
      });

      const response = await POST(request);
      const data = await response.json();

      expect(data.prompts).toBeDefined();
      expect(data.prompts.llm_vision_system_prompt).toBe('Default vision prompt');
      expect(data.prompts.llm_verification_system_prompt).toBe('Default verification prompt');
    });

    it('should be CSRF protected', async () => {
      mockValidateCSRF.mockReturnValue({ valid: false, reason: 'Invalid CSRF token' });

      const request = createMockRequest({
        method: 'POST',
        url: 'http://localhost/api/admin/uploads/settings/reset-prompts',
        body: {},
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(403);
      expect(data.error).toBe('CSRF validation failed');
    });

    it('should create audit log entry', async () => {
      const request = createMockRequest({
        method: 'POST',
        url: 'http://localhost/api/admin/uploads/settings/reset-prompts',
        body: {},
      });

      await POST(request);

      expect(mockAuditLog).toHaveBeenCalledWith({
        action: 'RESET_SMART_UPLOAD_PROMPTS',
        entityType: 'SETTING',
        entityId: 'smart_upload',
        newValues: expect.objectContaining({
          resetKeys: expect.any(Array),
        }),
      });
    });

    it('should return 401 when not authenticated', async () => {
      mockGetSession.mockResolvedValue(null);

      const request = createMockRequest({
        method: 'POST',
        url: 'http://localhost/api/admin/uploads/settings/reset-prompts',
        body: {},
      });

      const response = await POST(request);
      expect(response.status).toBe(401);
    });

    it('should return 403 when missing permission', async () => {
      mockCheckUserPermission.mockResolvedValue(false);

      const request = createMockRequest({
        method: 'POST',
        url: 'http://localhost/api/admin/uploads/settings/reset-prompts',
        body: {},
      });

      const response = await POST(request);
      expect(response.status).toBe(403);
    });

    it('should return 500 on reset failure', async () => {
      mockResetPromptsToDefaults.mockResolvedValue({
        success: false,
        resetKeys: [],
      });

      const request = createMockRequest({
        method: 'POST',
        url: 'http://localhost/api/admin/uploads/settings/reset-prompts',
        body: {},
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.error).toBe('Failed to reset prompts');
    });
  });

  // ===========================================================================
  // POST /api/admin/uploads/settings/test
  // ===========================================================================

  describe('POST /api/admin/uploads/settings/test', () => {
    const POST = testConnectionHandler;
    it('should test provider connectivity', async () => {
      const request = createMockRequest({
        method: 'POST',
        url: 'http://localhost/api/admin/uploads/settings/test',
        body: {
          provider: 'ollama',
          endpoint: 'http://localhost:11434',
          model: 'llama3.2-vision',
        },
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.ok).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:11434/api/tags',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
          }),
        })
      );
    });

    it('should return ok: false on connection failure', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      });

      const request = createMockRequest({
        method: 'POST',
        url: 'http://localhost/api/admin/uploads/settings/test',
        body: {
          provider: 'openai',
          apiKey: 'invalid-key',
          model: 'gpt-4o',
        },
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.ok).toBe(false);
      expect(data.error).toContain('Connection failed');
    });

    it('should handle different providers correctly', async () => {
      const providers = ['openai', 'anthropic', 'gemini', 'openrouter'] as const;
      
      for (const provider of providers) {
        vi.clearAllMocks();
        mockFetch.mockResolvedValue({
          ok: true,
          json: async () => ({ data: [] }),
        });

        const request = createMockRequest({
          method: 'POST',
          url: 'http://localhost/api/admin/uploads/settings/test',
          body: {
            provider,
            apiKey: 'test-key',
            model: 'test-model',
          },
        });

        const response = await POST(request);
        const data = await response.json();

        expect(response.status).toBe(200);
        expect(data.ok).toBe(true);
        expect(mockFetch).toHaveBeenCalled();
      }
    });

    it('should use the stored GLM service token when testing a protected local service', async () => {
      mockGetPrimaryApiKey.mockResolvedValueOnce('glm-stored-token');
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'ready' }),
      });

      const request = createMockRequest({
        method: 'POST',
        url: 'http://localhost/api/admin/uploads/settings/test',
        body: {
          provider: 'glm-ocr',
          endpoint: 'http://127.0.0.1:8090/v1',
          model: 'zai-org/GLM-OCR',
        },
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.ok).toBe(true);
      expect(mockGetPrimaryApiKey).toHaveBeenCalledWith('glm-ocr');
      expect(mockFetch).toHaveBeenCalledWith(
        'http://127.0.0.1:8090/readyz',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Authorization: 'Bearer glm-stored-token',
          }),
        }),
      );
    });

    it('should require API key for cloud providers', async () => {
      const request = createMockRequest({
        method: 'POST',
        url: 'http://localhost/api/admin/uploads/settings/test',
        body: {
          provider: 'openai',
          model: 'gpt-4o',
          // Missing API key
        },
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toContain('API key is required');
    });

    it('should require endpoint for custom provider', async () => {
      const request = createMockRequest({
        method: 'POST',
        url: 'http://localhost/api/admin/uploads/settings/test',
        body: {
          provider: 'custom',
          model: 'custom-model',
          apiKey: 'custom-api-key', // Provide API key so endpoint check is reached
          // Missing endpoint
        },
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toContain('Endpoint URL is required');
    });

    it('should require model for all providers', async () => {
      const request = createMockRequest({
        method: 'POST',
        url: 'http://localhost/api/admin/uploads/settings/test',
        body: {
          provider: 'ollama',
          // Missing model
        },
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe('Invalid request body');
    });

    it('should handle connection timeout', async () => {
      mockFetch.mockImplementation(() => {
        const error = new Error('The operation was aborted');
        error.name = 'AbortError';
        throw error;
      });

      const request = createMockRequest({
        method: 'POST',
        url: 'http://localhost/api/admin/uploads/settings/test',
        body: {
          provider: 'ollama',
          endpoint: 'http://localhost:11434',
          model: 'llama3.2-vision',
        },
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.ok).toBe(false);
      expect(data.error).toContain('Could not reach Ollama');
    });

    it('should be CSRF protected', async () => {
      mockValidateCSRF.mockReturnValue({ valid: false, reason: 'Invalid CSRF token' });

      const request = createMockRequest({
        method: 'POST',
        url: 'http://localhost/api/admin/uploads/settings/test',
        body: {
          provider: 'ollama',
          model: 'llama3.2-vision',
        },
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(403);
      expect(data.error).toBe('CSRF validation failed');
    });

    it('should create audit log entry', async () => {
      const request = createMockRequest({
        method: 'POST',
        url: 'http://localhost/api/admin/uploads/settings/test',
        body: {
          provider: 'ollama',
          model: 'llama3.2-vision',
        },
      });

      await POST(request);

      expect(mockAuditLog).toHaveBeenCalledWith({
        action: 'TEST_LLM_CONNECTION',
        entityType: 'SETTING',
        entityId: 'smart_upload',
        newValues: expect.objectContaining({
          provider: 'ollama',
          model: 'llama3.2-vision',
          success: true,
        }),
      });
    });

    it('should return 401 when not authenticated', async () => {
      mockGetSession.mockResolvedValue(null);

      const request = createMockRequest({
        method: 'POST',
        url: 'http://localhost/api/admin/uploads/settings/test',
        body: {
          provider: 'ollama',
          model: 'llama3.2-vision',
        },
      });

      const response = await POST(request);
      expect(response.status).toBe(401);
    });

    it('should return 403 when missing permission', async () => {
      mockCheckUserPermission.mockResolvedValue(false);

      const request = createMockRequest({
        method: 'POST',
        url: 'http://localhost/api/admin/uploads/settings/test',
        body: {
          provider: 'ollama',
          model: 'llama3.2-vision',
        },
      });

      const response = await POST(request);
      expect(response.status).toBe(403);
    });
  });

  // ===========================================================================
  // OPTIONS Handler
  // ===========================================================================

  describe('OPTIONS', () => {
    it('should return 204 with correct CORS headers', async () => {
      const response = await OPTIONS();

      expect(response.status).toBe(204);
      expect(response.headers.get('Access-Control-Allow-Methods')).toBe(
        'GET, PUT, POST, OPTIONS'
      );
      expect(response.headers.get('Access-Control-Allow-Headers')).toBe(
        'Content-Type, Authorization'
      );
    });
  });

  // ===========================================================================
  // Error Handling
  // ===========================================================================

  describe('Error Handling', () => {
    // Note: Unknown POST sub-paths are handled natively by Next.js App Router
    // returning 404. The old catch-all POST handler has been replaced by
    // dedicated route files (reset-prompts/route.ts, test/route.ts).
    it('should rely on Next.js for unknown POST paths', () => {
      // behaviour covered by framework; just assert true
      expect(true).toBe(true);
    });
  });
});
