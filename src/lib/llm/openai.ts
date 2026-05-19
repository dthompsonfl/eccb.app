import type { LLMAdapter, LLMConfig, VisionRequest, VisionResponse } from './types';

const BLOCKED_BODY_PARAMS = new Set(['model', 'messages']);

function buildLabelText(label: string): string {
  return `[${label}]`;
}

function pushOpenAIImageContent(
  content: Array<{ type: string; image_url?: { url: string }; text?: string }>,
  image: { mimeType: string; base64Data: string; label?: string }
): void {
  if (image.label?.trim()) {
    content.push({
      type: 'text',
      text: buildLabelText(image.label.trim()),
    });
  }

  content.push({
    type: 'image_url',
    image_url: {
      url: `data:${image.mimeType};base64,${image.base64Data}`,
    },
  });
}

function mergeModelParams(
  body: Record<string, unknown>,
  modelParams?: Record<string, unknown>
): void {
  if (!modelParams) return;

  for (const [key, value] of Object.entries(modelParams)) {
    if (BLOCKED_BODY_PARAMS.has(key)) continue;
    body[key] = value;
  }
}

/**
 * Normalise an Ollama or custom endpoint to include /v1 if needed.
 * Ollama's OpenAI-compat API lives at /v1/* — if user supplies the bare
 * host (http://localhost:11434) we add /v1 automatically.
 */
function normalizeOllamaEndpoint(endpoint: string): string {
  const cleaned = endpoint.replace(/\/$/, '');
  // If already contains /v1 (or any deeper path), leave it as-is
  if (/\/v\d+/.test(cleaned)) return cleaned;
  return `${cleaned}/v1`;
}

/**
 * OpenAI API adapter for chat.completions endpoint
 * Supports OpenAI-compatible APIs including custom endpoints and Ollama
 */
export class OpenAIAdapter implements LLMAdapter {
  buildRequest(
    config: LLMConfig,
    request: VisionRequest
  ): {
    url: string;
    headers: Record<string, string>;
    body: unknown;
  } {
    // SECURITY: Provider-aware API key selection.
    // Ollama (local) needs no key; custom endpoints may or may not need one.
    let apiKey: string | undefined;
    switch (config.llm_provider) {
      case 'openai':
        apiKey = config.llm_openai_api_key;
        if (!apiKey) throw new Error('OpenAI API key is required but not configured');
        break;
      case 'ollama':
        // Ollama running locally — no auth needed
        apiKey = undefined;
        break;
      case 'glm-ocr':
        apiKey = config.llm_glm_ocr_api_key || undefined;
        break;
      case 'custom':
        // Custom OpenAI-compat servers may or may not require a key
        apiKey = config.llm_custom_api_key || undefined;
        break;
      default:
        // Fallback: use OpenAI key (backwards compat for openrouter routing through this adapter)
        apiKey = config.llm_openai_api_key;
        if (!apiKey) throw new Error('API key is required but not configured');
    }

    // Build content array with images and text
    const content: Array<{ type: string; image_url?: { url: string }; text?: string }> = [];

    for (const image of request.images) {
      pushOpenAIImageContent(content, image);
    }

    if (request.labeledInputs) {
      for (const labeledInput of request.labeledInputs) {
        pushOpenAIImageContent(content, labeledInput);
      }
    }

    content.push({
      type: 'text',
      text: request.prompt,
    });

    // Resolve base URL, normalising Ollama bare hosts to include /v1
    let rawBase = config.llm_endpoint_url || 'https://api.openai.com/v1';
    if (config.llm_provider === 'ollama') {
      rawBase = normalizeOllamaEndpoint(rawBase);
    } else {
      rawBase = rawBase.replace(/\/$/, '');
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const messages: Array<Record<string, unknown>> = [];

    // System message — native support in /v1/chat/completions
    if (request.system) {
      messages.push({ role: 'system', content: request.system });
    }
    messages.push({ role: 'user', content });

    const body: Record<string, unknown> = {
      model: config.llm_vision_model || 'gpt-4o',
      messages,
      max_tokens: request.maxTokens ?? 4096,
      temperature: request.temperature ?? 0.1,
    };

    mergeModelParams(body, request.modelParams);

    // JSON mode — only for providers that support it (OpenAI, OpenRouter, OpenAI-compat)
    if (request.responseFormat?.type === 'json') {
      body['response_format'] = { type: 'json_object' };
    }

    return {
      url: `${rawBase}/chat/completions`,
      headers,
      body,
    };
  }

  parseResponse(response: unknown): VisionResponse {
    const data = response as {
      choices?: Array<{ message: { content: string } }>;
      usage?: { prompt_tokens: number; completion_tokens: number };
    };

    const content = data.choices?.[0]?.message?.content ?? '';

    return {
      content,
      usage: data.usage
        ? {
            promptTokens: data.usage.prompt_tokens,
            completionTokens: data.usage.completion_tokens,
          }
        : undefined,
    };
  }
}

export const adapter = new OpenAIAdapter();
