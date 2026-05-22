import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/guards';
import { checkUserPermission } from '@/lib/auth/permissions';
import { logger } from '@/lib/logger';

import { SYSTEM_CONFIG } from '@/lib/auth/permission-constants';
// =============================================================================
// Types
// =============================================================================

type Provider = 'glm-ocr' | 'ollama' | 'openai' | 'anthropic' | 'gemini' | 'openrouter' | 'custom';

type ParamType = 'number' | 'integer' | 'boolean' | 'string' | 'enum';

interface ModelParam {
  name: string;
  label: string;
  type: ParamType;
  min?: number;
  max?: number;
  step?: number;
  default: unknown;
  description: string;
  options?: Array<{ value: string; label: string }>;
  apiParamName: string;
}

interface ModelParamsResponse {
  params: ModelParam[];
}

// =============================================================================
// Reasoning Model Detection
// =============================================================================

const OPENAI_REASONING_MODELS = ['o1', 'o1-mini', 'o1-mini', 'o3', 'o3-mini'];

const GEMINI_PREVIEW_MODELS = ['gemini-2.5-pro-preview', 'gemini-2.5-flash-preview'];

function isReasoningModel(modelId: string): boolean {
  const lowerModel = modelId.toLowerCase();
  return OPENAI_REASONING_MODELS.some((m) => lowerModel.includes(m));
}

function isGeminiPreviewModel(modelId: string): boolean {
  const lowerModel = modelId.toLowerCase();
  return GEMINI_PREVIEW_MODELS.some((m) => lowerModel.includes(m));
}

// =============================================================================
// OpenAI-Compatible Parameters (OpenAI, OpenRouter, Custom, Gemini-via-OpenAI-Proxy)
// =============================================================================

function getOpenAICompatibleParams(): ModelParam[] {
  return [
    {
      name: 'temperature',
      label: 'Temperature',
      type: 'number',
      min: 0.0,
      max: 2.0,
      step: 0.01,
      default: 0.2,
      description: 'Controls randomness. Lower = more deterministic.',
      apiParamName: 'temperature',
    },
    {
      name: 'max_tokens',
      label: 'Max Tokens',
      type: 'integer',
      min: 256,
      max: 4096,
      step: 1,
      default: 1024,
      description: 'Maximum tokens in the response.',
      apiParamName: 'max_tokens',
    },
    {
      name: 'top_p',
      label: 'Top P',
      type: 'number',
      min: 0.0,
      max: 1.0,
      step: 0.01,
      default: 1.0,
      description: 'Nucleus sampling threshold.',
      apiParamName: 'top_p',
    },
    {
      name: 'frequency_penalty',
      label: 'Frequency Penalty',
      type: 'number',
      min: -2.0,
      max: 2.0,
      step: 0.01,
      default: 0.0,
      description: 'Reduces repetition of token sequences.',
      apiParamName: 'frequency_penalty',
    },
    {
      name: 'presence_penalty',
      label: 'Presence Penalty',
      type: 'number',
      min: -2.0,
      max: 2.0,
      step: 0.01,
      default: 0.0,
      description: 'Reduces repetition of topics.',
      apiParamName: 'presence_penalty',
    },
    {
      name: 'seed',
      label: 'Seed',
      type: 'integer',
      min: 0,
      max: 2147483647,
      step: 1,
      default: null,
      description: 'Fixed seed for reproducibility.',
      apiParamName: 'seed',
    },
  ];
}

function getOpenAIReasoningParams(): ModelParam[] {
  return [
    {
      name: 'reasoning_effort',
      label: 'Reasoning Effort',
      type: 'enum',
      default: 'medium',
      description: 'Controls how much reasoning the model uses.',
      options: [
        { value: 'low', label: 'Low' },
        { value: 'medium', label: 'Medium' },
        { value: 'high', label: 'High' },
      ],
      apiParamName: 'reasoning_effort',
    },
  ];
}

// =============================================================================
// Anthropic Parameters (Native /v1/messages)
// =============================================================================

function getAnthropicParams(): ModelParam[] {
  return [
    {
      name: 'temperature',
      label: 'Temperature',
      type: 'number',
      min: 0.0,
      max: 1.0,
      step: 0.01,
      default: 0.2,
      description: 'Controls randomness. Lower = more deterministic.',
      apiParamName: 'temperature',
    },
    {
      name: 'max_tokens',
      label: 'Max Tokens',
      type: 'integer',
      min: 1,
      max: 4096,
      step: 1,
      default: 1024,
      description: 'Maximum tokens in the response.',
      apiParamName: 'max_tokens',
    },
    {
      name: 'top_p',
      label: 'Top P',
      type: 'number',
      min: 0.0,
      max: 1.0,
      step: 0.01,
      default: 1.0,
      description: 'Nucleus sampling threshold.',
      apiParamName: 'top_p',
    },
    {
      name: 'top_k',
      label: 'Top K',
      type: 'integer',
      min: 0,
      max: 500,
      step: 1,
      default: 40,
      description: 'Only sample from top K tokens.',
      apiParamName: 'top_k',
    },
  ];
}

// =============================================================================
// Ollama Native Parameters
// =============================================================================

function getOllamaParams(): ModelParam[] {
  return [
    {
      name: 'temperature',
      label: 'Temperature',
      type: 'number',
      min: 0.0,
      max: 2.0,
      step: 0.01,
      default: 0.2,
      description: 'Controls randomness. Lower = more deterministic.',
      apiParamName: 'temperature',
    },
    {
      name: 'num_predict',
      label: 'Max Tokens',
      type: 'integer',
      min: -1,
      max: 4096,
      step: 1,
      default: 256,
      description: 'Max tokens to generate. -1 = infinite.',
      apiParamName: 'num_predict',
    },
    {
      name: 'top_k',
      label: 'Top K',
      type: 'integer',
      min: 0,
      max: 100,
      step: 1,
      default: 40,
      description: 'Only sample from top K tokens.',
      apiParamName: 'top_k',
    },
    {
      name: 'top_p',
      label: 'Top P',
      type: 'number',
      min: 0.0,
      max: 1.0,
      step: 0.01,
      default: 0.9,
      description: 'Nucleus sampling threshold.',
      apiParamName: 'top_p',
    },
    {
      name: 'repeat_penalty',
      label: 'Repeat Penalty',
      type: 'number',
      min: 0.0,
      max: 2.0,
      step: 0.01,
      default: 1.1,
      description: 'Penalise repeated tokens.',
      apiParamName: 'repeat_penalty',
    },
    {
      name: 'num_ctx',
      label: 'Context Size',
      type: 'integer',
      min: 512,
      max: 131072,
      step: 512,
      default: 4096,
      description: 'Context window size (tokens).',
      apiParamName: 'num_ctx',
    },
    {
      name: 'seed',
      label: 'Seed',
      type: 'integer',
      min: 0,
      max: 2147483647,
      step: 1,
      default: null,
      description: 'Fixed seed for reproducibility.',
      apiParamName: 'seed',
    },
  ];
}

// =============================================================================
// Gemini Native Parameters
// =============================================================================

function getGeminiParams(modelId: string): ModelParam[] {
  const maxOutputTokens = isGeminiPreviewModel(modelId) ? 65536 : 8192;

  return [
    {
      name: 'temperature',
      label: 'Temperature',
      type: 'number',
      min: 0.0,
      max: 2.0,
      step: 0.01,
      default: 0.2,
      description: 'Controls randomness. Lower = more deterministic.',
      apiParamName: 'temperature',
    },
    {
      name: 'maxOutputTokens',
      label: 'Max Output Tokens',
      type: 'integer',
      min: 1,
      max: maxOutputTokens,
      step: 1,
      default: 1024,
      description: 'Maximum tokens in the response.',
      apiParamName: 'maxOutputTokens',
    },
    {
      name: 'topP',
      label: 'Top P',
      type: 'number',
      min: 0.0,
      max: 1.0,
      step: 0.01,
      default: 0.95,
      description: 'Nucleus sampling threshold.',
      apiParamName: 'topP',
    },
    {
      name: 'topK',
      label: 'Top K',
      type: 'integer',
      min: 1,
      max: 64,
      step: 1,
      default: 40,
      description: 'Only sample from top K tokens.',
      apiParamName: 'topK',
    },
  ];
}

// =============================================================================
// Main Handler
// =============================================================================

export async function GET(request: NextRequest) {
  try {
    // Authentication and authorization
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const hasPermission = await checkUserPermission(session.user.id, SYSTEM_CONFIG);
    if (!hasPermission) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Parse query parameters
    const { searchParams } = new URL(request.url);
    const provider = searchParams.get('provider') as Provider | null;
    const model = searchParams.get('model');

    // Validate required parameters
    if (!provider) {
      return NextResponse.json(
        { error: 'Missing required parameter: provider' },
        { status: 400 }
      );
    }

    if (!model) {
      return NextResponse.json(
        { error: 'Missing required parameter: model' },
        { status: 400 }
      );
    }

    const validProviders: Provider[] = ['glm-ocr', 'ollama', 'openai', 'anthropic', 'gemini', 'openrouter', 'custom'];
    if (!validProviders.includes(provider)) {
      return NextResponse.json(
        { error: `Invalid provider: ${provider}. Must be one of: ${validProviders.join(', ')}` },
        { status: 400 }
      );
    }

    // Get parameters based on provider
    let params: ModelParam[];

    switch (provider) {
      case 'glm-ocr':
      case 'openai':
      case 'openrouter':
      case 'custom': {
        // These use OpenAI-compatible API
        params = getOpenAICompatibleParams();

        // Add reasoning effort for OpenAI reasoning models
        if (provider === 'openai' && isReasoningModel(model)) {
          params = getOpenAIReasoningParams();
        }
        break;
      }

      case 'anthropic':
        params = getAnthropicParams();
        break;

      case 'ollama':
        params = getOllamaParams();
        break;

      case 'gemini':
        params = getGeminiParams(model);
        break;

      default:
        return NextResponse.json({ error: 'Unknown provider' }, { status: 400 });
    }

    const response: ModelParamsResponse = { params };

    logger.info('Returned model parameters', {
      provider,
      model,
      paramCount: params.length,
      userId: session.user.id,
    });

    return NextResponse.json(response);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to get model parameters', {
      error: errorMessage,
    });

    return NextResponse.json(
      { error: `Failed to get model parameters: ${errorMessage}` },
      { status: 500 }
    );
  }
}

// =============================================================================
// OPTIONS
// =============================================================================

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}
