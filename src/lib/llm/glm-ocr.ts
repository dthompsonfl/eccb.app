import {
  type LLMAdapter,
  type LLMConfig,
  type VisionRequest,
  type VisionResponse,
} from './types';

const BLOCKED_BODY_PARAMS = new Set(['model', 'messages']);

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

function normalizeEndpoint(endpoint: string): string {
  const cleaned = endpoint.replace(/\/$/, '');
  return /\/v\d+$/.test(cleaned) ? cleaned : `${cleaned}/v1`;
}

export class GlmOcrAdapter implements LLMAdapter {
  buildRequest(
    config: LLMConfig,
    request: VisionRequest,
  ): { url: string; headers: Record<string, string>; body: unknown } {
    if (!config.llm_endpoint_url) {
      throw new Error('GLM-OCR endpoint URL is not configured.');
    }

    const baseUrl = normalizeEndpoint(config.llm_endpoint_url);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (config.llm_glm_ocr_api_key) {
      headers['Authorization'] = `Bearer ${config.llm_glm_ocr_api_key}`;
    }

    const content: Array<{ type: string; image_url?: { url: string }; text?: string }> = [];

    for (const image of request.images) {
      if (image.label?.trim()) {
        content.push({
          type: 'text',
          text: `[${image.label.trim()}]`,
        });
      }

      content.push({
        type: 'image_url',
        image_url: { url: `data:${image.mimeType};base64,${image.base64Data}` },
      });
    }

    if (request.labeledInputs) {
      for (const labeledInput of request.labeledInputs) {
        if (labeledInput.label?.trim()) {
          content.push({
            type: 'text',
            text: `[${labeledInput.label.trim()}]`,
          });
        }

        content.push({
          type: 'image_url',
          image_url: {
            url: `data:${labeledInput.mimeType};base64,${labeledInput.base64Data}`,
          },
        });
      }
    }

    content.push({
      type: 'text',
      text: request.prompt,
    });

    const messages: Array<Record<string, unknown>> = [];
    if (request.system) {
      messages.push({ role: 'system', content: request.system });
    }
    messages.push({ role: 'user', content });

    const body: Record<string, unknown> = {
      model: config.llm_vision_model || 'zai-org/GLM-OCR',
      messages,
      max_tokens: request.maxTokens ?? 4096,
      temperature: request.temperature ?? 0.1,
    };

    if (request.responseFormat?.type === 'json') {
      body.response_format = { type: 'json_object' };
    }

    mergeModelParams(body, request.modelParams);

    return {
      url: `${baseUrl}/chat/completions`,
      headers,
      body,
    };
  }

  parseResponse(response: unknown): VisionResponse {
    const res = response as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    return {
      content: res.choices?.[0]?.message?.content ?? '',
      usage:
        typeof res.usage?.prompt_tokens === 'number' &&
        typeof res.usage?.completion_tokens === 'number'
          ? {
              promptTokens: res.usage.prompt_tokens,
              completionTokens: res.usage.completion_tokens,
            }
          : undefined,
    };
  }
}

export const adapter = new GlmOcrAdapter();
