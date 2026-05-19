import { describe, it, expect } from 'vitest';
import { getAdapter } from '../index';
import { OpenAIAdapter } from '../openai';
import { AnthropicAdapter } from '../anthropic';
import { GeminiAdapter } from '../gemini';
import { OpenRouterAdapter } from '../openrouter';
import { OllamaAdapter } from '../ollama';
import { OllamaCloudAdapter } from '../ollama-cloud';
import { MistralAdapter } from '../mistral';
import { GroqAdapter } from '../groq';
import { GlmOcrAdapter } from '../glm-ocr';
import { CustomAdapter } from '../custom';

describe('LLM Adapters', () => {
  const mockConfig = {
    llm_provider: 'openai' as const,
    llm_openai_api_key: 'sk-test',
    llm_anthropic_api_key: 'sk-ant-test',
    llm_gemini_api_key: 'gemini-test',
    llm_openrouter_api_key: 'sk-or-test',
    llm_glm_ocr_api_key: 'glm-token',
    llm_vision_model: 'gpt-4-turbo',
  };

  describe('getAdapter', () => {
    it('should return OpenAI adapter for openai provider', async () => {
      const adapter = await getAdapter('openai');
      expect(adapter).toBeInstanceOf(OpenAIAdapter);
    });

    it('should return Anthropic adapter for anthropic provider', async () => {
      const adapter = await getAdapter('anthropic');
      expect(adapter).toBeInstanceOf(AnthropicAdapter);
    });

    it('should return Gemini adapter for gemini provider', async () => {
      const adapter = await getAdapter('gemini');
      expect(adapter).toBeInstanceOf(GeminiAdapter);
    });

    it('should return OpenRouter adapter for openrouter provider', async () => {
      const adapter = await getAdapter('openrouter');
      expect(adapter).toBeInstanceOf(OpenRouterAdapter);
    });

    it('should return CustomAdapter for custom provider', async () => {
      const adapter = await getAdapter('custom');
      expect(adapter).toBeInstanceOf(CustomAdapter);
    });

    it('should return GlmOcrAdapter for glm-ocr provider', async () => {
      const adapter = await getAdapter('glm-ocr');
      expect(adapter).toBeInstanceOf(GlmOcrAdapter);
    });

    it('should return OllamaAdapter for ollama provider', async () => {
      const adapter = await getAdapter('ollama');
      expect(adapter).toBeInstanceOf(OllamaAdapter);
    });

    it('should return OllamaCloudAdapter for ollama-cloud provider', async () => {
      const adapter = await getAdapter('ollama-cloud');
      expect(adapter).toBeInstanceOf(OllamaCloudAdapter);
    });

    it('should return MistralAdapter for mistral provider', async () => {
      const adapter = await getAdapter('mistral');
      expect(adapter).toBeInstanceOf(MistralAdapter);
    });

    it('should return GroqAdapter for groq provider', async () => {
      const adapter = await getAdapter('groq');
      expect(adapter).toBeInstanceOf(GroqAdapter);
    });

    it('should throw for unknown provider', async () => {
      await expect(getAdapter('unknown' as any)).rejects.toThrow('Unknown LLM provider');
    });
  });

  describe('OpenAI Adapter', () => {
    const adapter = new OpenAIAdapter();

    it('should build correct request', () => {
      const request = {
        images: [{ mimeType: 'image/png', base64Data: 'base64data' }],
        prompt: 'Extract metadata',
        maxTokens: 4000,
        temperature: 0.1,
      };

      const result = adapter.buildRequest(mockConfig, request);

      expect(result.url).toBe('https://api.openai.com/v1/chat/completions');
      expect(result.headers['Authorization']).toBe('Bearer sk-test');
      expect(result.headers['Content-Type']).toBe('application/json');
      expect(result.body).toHaveProperty('model', 'gpt-4-turbo');
      expect(result.body).toHaveProperty('messages');
      expect(result.body).toHaveProperty('max_tokens', 4000);
      expect(result.body).toHaveProperty('temperature', 0.1);
    });

    it('should use custom endpoint when provided', () => {
      const configWithEndpoint = {
        ...mockConfig,
        llm_endpoint_url: 'https://custom.openai.com/v1/',
      };

      const result = adapter.buildRequest(configWithEndpoint, {
        images: [],
        prompt: 'test',
      });

      expect(result.url).toBe('https://custom.openai.com/v1/chat/completions');
    });

    it('should parse response correctly', () => {
      const mockResponse = {
        choices: [{ message: { content: 'Test response' } }],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      };

      const result = adapter.parseResponse(mockResponse);

      expect(result.content).toBe('Test response');
      expect(result.usage).toEqual({
        promptTokens: 100,
        completionTokens: 50,
      });
    });

    it('should throw error when API key is missing', () => {
      const configWithoutKey = { ...mockConfig, llm_openai_api_key: undefined };

      expect(() =>
        adapter.buildRequest(configWithoutKey, { images: [], prompt: 'test' })
      ).toThrow('OpenAI API key is required');
    });
  });

  describe('Anthropic Adapter', () => {
    const adapter = new AnthropicAdapter();

    it('should build correct request', () => {
      const anthropicConfig = {
        ...mockConfig,
        llm_vision_model: 'claude-3-5-sonnet-20241022',
      };
      const request = {
        images: [{ mimeType: 'image/png', base64Data: 'base64data' }],
        prompt: 'Extract metadata',
        maxTokens: 4000,
        temperature: 0.1,
      };

      const result = adapter.buildRequest(anthropicConfig, request);

      expect(result.url).toBe('https://api.anthropic.com/v1/messages');
      expect(result.headers['x-api-key']).toBe('sk-ant-test');
      expect(result.headers['anthropic-version']).toBe('2023-06-01');
      expect(result.body).toHaveProperty('model', 'claude-3-5-sonnet-20241022');
    });

    it('should parse Anthropic response correctly', () => {
      const mockResponse = {
        content: [{ type: 'text', text: 'Test response' }],
        usage: { input_tokens: 100, output_tokens: 50 },
      };

      const result = adapter.parseResponse(mockResponse);

      expect(result.content).toBe('Test response');
      expect(result.usage).toEqual({
        promptTokens: 100,
        completionTokens: 50,
      });
    });

    it('should throw error when API key is missing', () => {
      const configWithoutKey = { ...mockConfig, llm_anthropic_api_key: undefined };

      expect(() =>
        adapter.buildRequest(configWithoutKey, { images: [], prompt: 'test' })
      ).toThrow('Anthropic API key is required');
    });
  });

  describe('Adapter Security', () => {
    it('should use different API keys for different providers', () => {
      const openaiAdapter = new OpenAIAdapter();
      const anthropicAdapter = new AnthropicAdapter();

      const openaiResult = openaiAdapter.buildRequest(mockConfig, {
        images: [],
        prompt: 'test',
      });

      const anthropicResult = anthropicAdapter.buildRequest(mockConfig, {
        images: [],
        prompt: 'test',
      });

      expect(openaiResult.headers['Authorization']).toBe('Bearer sk-test');
      expect(anthropicResult.headers['x-api-key']).toBe('sk-ant-test');
    });
  });

  describe('GLM-OCR Adapter', () => {
    const adapter = new GlmOcrAdapter();

    it('builds an OpenAI-compatible chat.completions request', () => {
      const result = adapter.buildRequest(
        {
          ...mockConfig,
          llm_provider: 'glm-ocr',
          llm_endpoint_url: 'http://glm-ocr:8090/v1',
          llm_vision_model: 'zai-org/GLM-OCR',
        },
        {
          images: [{ mimeType: 'image/png', base64Data: 'abcd', label: 'Header' }],
          prompt: 'Return JSON only',
          responseFormat: { type: 'json' },
        },
      );

      expect(result.url).toBe('http://glm-ocr:8090/v1/chat/completions');
      expect(result.headers.Authorization).toBe('Bearer glm-token');
      expect(result.body).toMatchObject({
        model: 'zai-org/GLM-OCR',
        response_format: { type: 'json_object' },
      });
    });

    it('normalizes endpoints that omit /v1', () => {
      const result = adapter.buildRequest(
        {
          ...mockConfig,
          llm_provider: 'glm-ocr',
          llm_endpoint_url: 'http://glm-ocr:8090',
          llm_vision_model: 'zai-org/GLM-OCR',
        },
        {
          images: [{ mimeType: 'image/png', base64Data: 'abcd' }],
          prompt: 'Test',
        },
      );

      expect(result.url).toBe('http://glm-ocr:8090/v1/chat/completions');
    });
  });

  describe('Anthropic Adapter — configurable endpoint', () => {
    const adapter = new AnthropicAdapter();

    it('uses the default Anthropic endpoint when llm_endpoint_url is empty', () => {
      const result = adapter.buildRequest({ ...mockConfig, llm_provider: 'anthropic', llm_endpoint_url: '' }, { images: [], prompt: 'test' });
      expect(result.url).toMatch(/^https:\/\/api\.anthropic\.com/);
    });

    it('uses a custom endpoint when llm_endpoint_url is set', () => {
      const result = adapter.buildRequest(
        { ...mockConfig, llm_provider: 'anthropic', llm_endpoint_url: 'https://proxy.example.com' },
        { images: [], prompt: 'test' }
      );
      expect(result.url).toMatch(/^https:\/\/proxy\.example\.com/);
      expect(result.url).not.toContain('api.anthropic.com');
    });

    it('strips trailing slash from custom endpoint', () => {
      const result = adapter.buildRequest(
        { ...mockConfig, llm_provider: 'anthropic', llm_endpoint_url: 'https://proxy.example.com/' },
        { images: [], prompt: 'test' }
      );
      // No double-slash after the domain (trailing slash was stripped)
      expect(result.url.replace('://', '')).not.toContain('//');
    });
  });

  describe('Gemini Adapter — configurable endpoint', () => {
    const adapter = new GeminiAdapter();
    const geminiConfig = { ...mockConfig, llm_provider: 'gemini' as const };

    it('uses the default Gemini endpoint when llm_endpoint_url is empty', () => {
      const result = adapter.buildRequest({ ...geminiConfig, llm_endpoint_url: '' }, { images: [], prompt: 'test' });
      expect(result.url).toMatch(/^https:\/\/generativelanguage\.googleapis\.com/);
    });

    it('uses a custom endpoint when llm_endpoint_url is set', () => {
      const result = adapter.buildRequest(
        { ...geminiConfig, llm_endpoint_url: 'https://gemini-proxy.example.com/v1beta' },
        { images: [], prompt: 'test' }
      );
      expect(result.url).toMatch(/^https:\/\/gemini-proxy\.example\.com/);
      expect(result.url).not.toContain('googleapis.com');
    });

    it('URL-encodes the Gemini API key', () => {
      const result = adapter.buildRequest(
        { ...geminiConfig, llm_endpoint_url: '', llm_gemini_api_key: 'key with spaces+special' },
        { images: [], prompt: 'test' }
      );
      expect(result.url).not.toContain('key with spaces');
      expect(result.url).toContain('key%20with%20spaces');
    });
  });

  describe('Ollama Adapter (via OpenAIAdapter)', () => {
    const adapter = new OpenAIAdapter();
    const ollamaConfig = {
      ...mockConfig,
      llm_provider: 'ollama' as const,
      llm_endpoint_url: 'http://localhost:11434',
      // No API key supplied — Ollama doesn't need one
      llm_openai_api_key: undefined,
    };

    it('does not include Authorization header when no API key is provided', () => {
      const result = adapter.buildRequest(ollamaConfig, { images: [], prompt: 'test' });
      expect(result.headers).not.toHaveProperty('Authorization');
    });

    it('normalises bare host to include /v1 automatically', () => {
      const result = adapter.buildRequest(
        { ...ollamaConfig, llm_endpoint_url: 'http://localhost:11434' },
        { images: [], prompt: 'test' }
      );
      expect(result.url).toContain('/v1/');
    });

    it('does not double-add /v1 when endpoint already contains /v1', () => {
      const result = adapter.buildRequest(
        { ...ollamaConfig, llm_endpoint_url: 'http://localhost:11434/v1' },
        { images: [], prompt: 'test' }
      );
      // Should not result in /v1/v1/
      expect(result.url.replace('://', '')).not.toContain('/v1/v1');
    });

    it('never sets Authorization header for ollama — even when a key is supplied — because ollama does not require auth', () => {
      const result = adapter.buildRequest(
        { ...ollamaConfig, llm_openai_api_key: 'ollama-key' },
        { images: [], prompt: 'test' }
      );
      // Ollama adapter hard-codes apiKey = undefined for the 'ollama' case
      expect(result.headers).not.toHaveProperty('Authorization');
    });
  });

  // ==========================================================================
  // OllamaAdapter (native) Tests
  // ==========================================================================

  describe('OllamaAdapter (native)', () => {
    const adapter = new OllamaAdapter();

    it('should build correct request', () => {
      const config = {
        ...mockConfig,
        llm_provider: 'ollama' as const,
        llm_endpoint_url: 'http://localhost:11434',
        llm_vision_model: 'llama3.2-vision',
      };

      const result = adapter.buildRequest(config, {
        images: [{ mimeType: 'image/png', base64Data: 'abc' }],
        prompt: 'Extract metadata',
        maxTokens: 4000,
        temperature: 0.1,
      });

      expect(result.url).toBe('http://localhost:11434/v1/chat/completions');
      expect(result.headers['Content-Type']).toBe('application/json');
      expect(result.headers).not.toHaveProperty('Authorization');
      expect(result.body).toHaveProperty('model', 'llama3.2-vision');
      expect(result.body).toHaveProperty('max_tokens', 4000);
      expect(result.body).toHaveProperty('temperature', 0.1);
    });

    it('should throw when endpoint is missing', () => {
      expect(() =>
        adapter.buildRequest(
          { ...mockConfig, llm_endpoint_url: undefined },
          { images: [], prompt: 'test' }
        )
      ).toThrow('Ollama endpoint URL is not configured');
    });

    it('should include system message when provided', () => {
      const result = adapter.buildRequest(
        { ...mockConfig, llm_endpoint_url: 'http://localhost:11434' },
        { images: [], prompt: 'test', system: 'You are a music expert' }
      );
      const body = result.body as { messages: Array<{ role: string; content: unknown }> };
      expect(body.messages[0]).toEqual({ role: 'system', content: 'You are a music expert' });
    });

    it('should support labeled images', () => {
      const result = adapter.buildRequest(
        { ...mockConfig, llm_endpoint_url: 'http://localhost:11434' },
        {
          images: [{ mimeType: 'image/png', base64Data: 'abc', label: 'Page 1' }],
          prompt: 'Extract',
        }
      );
      const body = result.body as { messages: Array<{ role: string; content: unknown[] }> };
      const userContent = body.messages.find((m) => m.role === 'user')?.content as Array<{ type: string; text?: string }>;
      expect(userContent[0]).toEqual({ type: 'text', text: '[Page 1]' });
    });

    it('should support labeledInputs for verification pass', () => {
      const result = adapter.buildRequest(
        { ...mockConfig, llm_endpoint_url: 'http://localhost:11434' },
        {
          images: [],
          prompt: 'Verify',
          labeledInputs: [{ mimeType: 'image/jpeg', base64Data: 'xyz', label: 'Ref Image' }],
        }
      );
      const body = result.body as { messages: Array<{ role: string; content: unknown[] }> };
      const userContent = body.messages.find((m) => m.role === 'user')?.content as Array<{ type: string; text?: string }>;
      expect(userContent[0]).toEqual({ type: 'text', text: '[Ref Image]' });
    });

    it('should safely merge modelParams without overwriting model/messages', () => {
      const result = adapter.buildRequest(
        { ...mockConfig, llm_endpoint_url: 'http://localhost:11434' },
        {
          images: [],
          prompt: 'test',
          modelParams: { model: 'EVIL', messages: 'EVIL', top_p: 0.9 },
        }
      );
      const body = result.body as Record<string, unknown>;
      expect(body.model).toBe('gpt-4-turbo'); // original model, not overwritten
      expect(body.top_p).toBe(0.9); // allowed param merged
    });

    it('should add json_object response format', () => {
      const result = adapter.buildRequest(
        { ...mockConfig, llm_endpoint_url: 'http://localhost:11434' },
        { images: [], prompt: 'test', responseFormat: { type: 'json' } }
      );
      const body = result.body as Record<string, unknown>;
      expect(body.response_format).toEqual({ type: 'json_object' });
    });

    it('should parse OpenAI-compatible response', () => {
      const result = adapter.parseResponse({
        choices: [{ message: { content: 'extracted text' } }],
        usage: { prompt_tokens: 200, completion_tokens: 100 },
      });
      expect(result.content).toBe('extracted text');
      expect(result.usage).toEqual({ promptTokens: 200, completionTokens: 100 });
    });

    it('should handle missing usage in response', () => {
      const result = adapter.parseResponse({
        choices: [{ message: { content: 'text' } }],
      });
      expect(result.content).toBe('text');
      expect(result.usage).toBeUndefined();
    });
  });

  // ==========================================================================
  // OllamaCloudAdapter Tests
  // ==========================================================================

  describe('OllamaCloudAdapter', () => {
    const adapter = new OllamaCloudAdapter();
    const ollamaCloudConfig = {
      ...mockConfig,
      llm_endpoint_url: 'https://api.ollama.com/v1',
      llm_ollama_cloud_api_key: 'oc-test-key',
      llm_vision_model: 'llama3.2-vision',
    };

    it('should build correct request with auth header', () => {
      const result = adapter.buildRequest(ollamaCloudConfig, {
        images: [{ mimeType: 'image/png', base64Data: 'abc' }],
        prompt: 'Extract',
        maxTokens: 2000,
        temperature: 0.2,
      });

      expect(result.url).toBe('https://api.ollama.com/v1/chat/completions');
      expect(result.headers['Authorization']).toBe('Bearer oc-test-key');
      expect(result.body).toHaveProperty('model', 'llama3.2-vision');
    });

    it('should throw when endpoint is missing', () => {
      expect(() =>
        adapter.buildRequest(
          { ...ollamaCloudConfig, llm_endpoint_url: undefined },
          { images: [], prompt: 'test' }
        )
      ).toThrow('Ollama Cloud endpoint URL is not configured');
    });

    it('should throw when API key is missing', () => {
      expect(() =>
        adapter.buildRequest(
          { ...ollamaCloudConfig, llm_ollama_cloud_api_key: undefined },
          { images: [], prompt: 'test' }
        )
      ).toThrow('Ollama Cloud API key is not configured');
    });

    it('should parse response correctly', () => {
      const result = adapter.parseResponse({
        choices: [{ message: { content: 'cloud response' } }],
        usage: { prompt_tokens: 50, completion_tokens: 25 },
      });
      expect(result.content).toBe('cloud response');
      expect(result.usage).toEqual({ promptTokens: 50, completionTokens: 25 });
    });
  });

  // ==========================================================================
  // MistralAdapter Tests
  // ==========================================================================

  describe('MistralAdapter', () => {
    const adapter = new MistralAdapter();
    const mistralConfig = {
      ...mockConfig,
      llm_endpoint_url: 'https://api.mistral.ai/v1',
      llm_mistral_api_key: 'ms-test-key',
      llm_vision_model: 'pixtral-large-latest',
    };

    it('should build correct request with auth header', () => {
      const result = adapter.buildRequest(mistralConfig, {
        images: [{ mimeType: 'image/png', base64Data: 'abc' }],
        prompt: 'Extract',
        maxTokens: 3000,
        temperature: 0.15,
      });

      expect(result.url).toBe('https://api.mistral.ai/v1/chat/completions');
      expect(result.headers['Authorization']).toBe('Bearer ms-test-key');
      expect(result.body).toHaveProperty('model', 'pixtral-large-latest');
      expect(result.body).toHaveProperty('max_tokens', 3000);
    });

    it('should throw when endpoint is missing', () => {
      expect(() =>
        adapter.buildRequest(
          { ...mistralConfig, llm_endpoint_url: undefined },
          { images: [], prompt: 'test' }
        )
      ).toThrow('Mistral endpoint URL is not configured');
    });

    it('should throw when API key is missing', () => {
      expect(() =>
        adapter.buildRequest(
          { ...mistralConfig, llm_mistral_api_key: undefined },
          { images: [], prompt: 'test' }
        )
      ).toThrow('Mistral API key is not configured');
    });

    it('should support labeled images and labeledInputs', () => {
      const result = adapter.buildRequest(mistralConfig, {
        images: [{ mimeType: 'image/png', base64Data: 'img1', label: 'Title Page' }],
        prompt: 'Verify',
        labeledInputs: [{ mimeType: 'image/jpeg', base64Data: 'ref1', label: 'Reference' }],
      });
      const body = result.body as { messages: Array<{ role: string; content: unknown[] }> };
      const userContent = body.messages.find((m) => m.role === 'user')?.content as Array<{ type: string; text?: string }>;
      expect(userContent[0]).toEqual({ type: 'text', text: '[Title Page]' });
      // Find the reference label
      const refLabel = userContent.find((c) => c.text === '[Reference]');
      expect(refLabel).toBeDefined();
    });

    it('should parse response correctly', () => {
      const result = adapter.parseResponse({
        choices: [{ message: { content: 'mistral response' } }],
        usage: { prompt_tokens: 150, completion_tokens: 75 },
      });
      expect(result.content).toBe('mistral response');
      expect(result.usage).toEqual({ promptTokens: 150, completionTokens: 75 });
    });
  });

  // ==========================================================================
  // GroqAdapter Tests
  // ==========================================================================

  describe('GroqAdapter', () => {
    const adapter = new GroqAdapter();
    const groqConfig = {
      ...mockConfig,
      llm_endpoint_url: 'https://api.groq.com/openai/v1',
      llm_groq_api_key: 'gsk-test-key',
      llm_vision_model: 'llama-3.2-90b-vision-preview',
    };

    it('should build correct request with auth header', () => {
      const result = adapter.buildRequest(groqConfig, {
        images: [{ mimeType: 'image/png', base64Data: 'abc' }],
        prompt: 'Extract',
        maxTokens: 2000,
        temperature: 0.1,
      });

      expect(result.url).toBe('https://api.groq.com/openai/v1/chat/completions');
      expect(result.headers['Authorization']).toBe('Bearer gsk-test-key');
      expect(result.body).toHaveProperty('model', 'llama-3.2-90b-vision-preview');
    });

    it('should throw when endpoint is missing', () => {
      expect(() =>
        adapter.buildRequest(
          { ...groqConfig, llm_endpoint_url: undefined },
          { images: [], prompt: 'test' }
        )
      ).toThrow('Groq endpoint URL is not configured');
    });

    it('should throw when API key is missing', () => {
      expect(() =>
        adapter.buildRequest(
          { ...groqConfig, llm_groq_api_key: undefined },
          { images: [], prompt: 'test' }
        )
      ).toThrow('Groq API key is not configured');
    });

    it('should parse response with usage', () => {
      const result = adapter.parseResponse({
        choices: [{ message: { content: 'groq fast response' } }],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      });
      expect(result.content).toBe('groq fast response');
      expect(result.usage).toEqual({ promptTokens: 100, completionTokens: 50 });
    });

    it('should handle empty choices gracefully', () => {
      const result = adapter.parseResponse({ choices: [] });
      expect(result.content).toBe('');
    });
  });

  // ==========================================================================
  // CustomAdapter Tests
  // ==========================================================================

  describe('CustomAdapter', () => {
    const adapter = new CustomAdapter();
    const customConfig = {
      ...mockConfig,
      llm_endpoint_url: 'https://my-server.local/v1',
      llm_custom_api_key: 'my-custom-key',
      llm_vision_model: 'custom-vision',
    };

    it('should build correct request with auth header', () => {
      const result = adapter.buildRequest(customConfig, {
        images: [],
        prompt: 'Extract',
      });

      expect(result.url).toBe('https://my-server.local/v1/chat/completions');
      expect(result.headers['Authorization']).toBe('Bearer my-custom-key');
      expect(result.body).toHaveProperty('model', 'custom-vision');
    });

    it('should omit Authorization header when no API key is provided', () => {
      const noKeyConfig = { ...customConfig, llm_custom_api_key: undefined };
      const result = adapter.buildRequest(noKeyConfig, {
        images: [],
        prompt: 'test',
      });
      expect(result.headers).not.toHaveProperty('Authorization');
    });

    it('should throw when endpoint is missing', () => {
      expect(() =>
        adapter.buildRequest(
          { ...customConfig, llm_endpoint_url: undefined },
          { images: [], prompt: 'test' }
        )
      ).toThrow('Custom LLM endpoint URL is not configured');
    });

    it('should safely merge modelParams', () => {
      const result = adapter.buildRequest(customConfig, {
        images: [],
        prompt: 'test',
        modelParams: { model: 'overwrite-attempt', top_k: 40 },
      });
      const body = result.body as Record<string, unknown>;
      expect(body.model).toBe('custom-vision');
      expect(body.top_k).toBe(40);
    });

    it('should parse response correctly', () => {
      const result = adapter.parseResponse({
        choices: [{ message: { content: 'custom response' } }],
        usage: { prompt_tokens: 80, completion_tokens: 40 },
      });
      expect(result.content).toBe('custom response');
      expect(result.usage).toEqual({ promptTokens: 80, completionTokens: 40 });
    });
  });
});
