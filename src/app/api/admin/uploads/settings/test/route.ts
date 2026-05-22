import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/guards';
import { checkUserPermission } from '@/lib/auth/permissions';
import { validateCSRF } from '@/lib/csrf';
import { logger } from '@/lib/logger';
import { auditLog } from '@/lib/services/audit';
import { z } from 'zod';
import { getDefaultEndpointForProvider } from '@/lib/llm/providers';
import { ProviderValueSchema, providerRequiresApiKey } from '@/lib/smart-upload/schema';
import { getPrimaryApiKey } from '@/lib/llm/api-key-service';
import { type LLMProviderValue } from '@/lib/llm/providers';
import { validateOutboundEndpoint } from '@/lib/network/safe-endpoint';

import { SYSTEM_CONFIG } from '@/lib/auth/permission-constants';
// =============================================================================
// Schema
// =============================================================================

const testSchema = z.object({
  provider: ProviderValueSchema,
  endpoint: z.string().optional(),
  model: z.string(),
  apiKey: z.string().optional(),
});

// =============================================================================
// POST /api/admin/uploads/settings/test
// =============================================================================

export async function POST(request: NextRequest) {
  // CSRF validation
  const csrfResult = validateCSRF(request);
  if (!csrfResult.valid) {
    return NextResponse.json(
      { error: 'CSRF validation failed', reason: csrfResult.reason },
      { status: 403 }
    );
  }

  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const hasPermission = await checkUserPermission(session.user.id, SYSTEM_CONFIG);
    if (!hasPermission) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await request.json();
    const parsed = testSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const { provider, endpoint, model, apiKey: requestApiKey } = parsed.data;

    const needsApiKey = providerRequiresApiKey(provider);
    let apiKey = requestApiKey?.trim() || '';

    if (!apiKey && needsApiKey) {
      try {
        apiKey = await getPrimaryApiKey(provider as LLMProviderValue);
      } catch {
        apiKey = '';
      }
    }

    if (providerRequiresApiKey(provider) && !apiKey) {
      return NextResponse.json(
        { ok: false, error: `API key is required for ${provider}.` },
        { status: 400 }
      );
    }

    // Only validate endpoint for providers that actually use it
    const providersUsingEndpoint = ['glm-ocr', 'ollama', 'ollama-cloud', 'custom'];
    if (endpoint?.trim() && providersUsingEndpoint.includes(provider)) {
      const endpointPolicy = provider === 'glm-ocr' || provider === 'ollama' || provider === 'ollama-cloud'
        ? 'allow-local'
        : 'strict-public';
      const endpointValidation = validateOutboundEndpoint(endpoint.trim(), endpointPolicy);
      if (!endpointValidation.valid) {
        return NextResponse.json({ ok: false, error: endpointValidation.error }, { status: 400 });
      }
    }

    logger.info('Testing LLM connection', {
      userId: session.user.id,
      provider,
      model,
      endpoint: endpoint?.replace(/^(https?:\/\/[^/]+).*/, '$1'),
    });

    // Build the request depending on provider
    let testUrl = '';
    const testHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    switch (provider) {
      case 'glm-ocr': {
        const raw = (endpoint?.trim() || getDefaultEndpointForProvider('glm-ocr')).replace(/\/$/, '');
        const base = /\/v\d+$/.test(raw) ? raw.replace(/\/v\d+$/, '') : raw;
        testUrl = `${base}/readyz`;
        if (apiKey) testHeaders['Authorization'] = `Bearer ${apiKey}`;
        break;
      }

      case 'ollama': {
        const base = (endpoint || 'http://localhost:11434').replace(/\/$/, '');
        // Try /api/tags first (native Ollama), then /v1/models (OpenAI-compat layer)
        const ollamaUrls = [`${base}/api/tags`, `${base}/v1/models`];
        let lastError = '';
        for (const url of ollamaUrls) {
          try {
            const res = await fetch(url, {
              method: 'GET',
              headers: testHeaders,
              signal: AbortSignal.timeout(5_000),
            });
            if (res.ok) {
              const successMessage = `Successfully connected to Ollama (model: ${model}).`;
              await auditLog({
                action: 'TEST_LLM_CONNECTION',
                entityType: 'SETTING',
                entityId: 'smart_upload',
                newValues: { provider, model, success: true, message: successMessage },
              });
              return NextResponse.json({
                ok: true,
                message: successMessage,
              });
            }
            lastError = `${url} → HTTP ${res.status}`;
          } catch (e) {
            lastError = `${url} → ${e instanceof Error ? e.message : String(e)}`;
          }
        }
        const failureMsg = `Connection failed: Could not reach Ollama. Last error: ${lastError}`;
        await auditLog({
          action: 'TEST_LLM_CONNECTION',
          entityType: 'SETTING',
          entityId: 'smart_upload',
          newValues: { provider, model, success: false, error: failureMsg },
        });
        return NextResponse.json({ ok: false, error: failureMsg });
      }

      case 'openai': {
        const base = (endpoint?.trim() || getDefaultEndpointForProvider('openai')).replace(/\/$/, '');
        testUrl = `${base}/models`;
        if (apiKey) testHeaders['Authorization'] = `Bearer ${apiKey}`;
        break;
      }

      case 'anthropic': {
        const base = (endpoint?.trim() || getDefaultEndpointForProvider('anthropic')).replace(/\/$/, '');
        testUrl = `${base}/v1/models`;
        if (apiKey) {
          testHeaders['x-api-key'] = apiKey;
          testHeaders['anthropic-version'] = '2023-06-01';
        }
        break;
      }

      case 'gemini': {
        const rawBase = (endpoint?.trim() || getDefaultEndpointForProvider('gemini')).replace(/\/$/, '');
        // Ensure /v1beta is present regardless of what the user saved
        const base = rawBase.endsWith('/v1beta')
          ? rawBase
          : rawBase.replace(/\/v\d+[a-z]*$/, '') + '/v1beta';
        const key = apiKey ? `?key=${encodeURIComponent(apiKey)}` : '';
        // Use model list endpoint instead of specific model — more reliable
        testUrl = `${base}/models${key}`;
        break;
      }

      case 'openrouter': {
        const base = (endpoint?.trim() || getDefaultEndpointForProvider('openrouter')).replace(/\/$/, '');
        testUrl = `${base}/models`;
        if (apiKey) testHeaders['Authorization'] = `Bearer ${apiKey}`;
        break;
      }

      case 'mistral': {
        const base = (endpoint?.trim() || getDefaultEndpointForProvider('mistral')).replace(/\/$/, '');
        testUrl = `${base}/models`;
        if (apiKey) testHeaders['Authorization'] = `Bearer ${apiKey}`;
        break;
      }

      case 'groq': {
        const base = (endpoint?.trim() || getDefaultEndpointForProvider('groq')).replace(/\/$/, '');
        testUrl = `${base}/models`;
        if (apiKey) testHeaders['Authorization'] = `Bearer ${apiKey}`;
        break;
      }

      case 'ollama-cloud': {
        // Ollama Cloud uses the same OpenAI-compat /models endpoint
        const raw = (endpoint?.trim() || getDefaultEndpointForProvider('ollama-cloud')).replace(/\/$/, '');
        const base = /\/v\d+/.test(raw) ? raw : `${raw}/v1`;
        testUrl = `${base}/models`;
        if (apiKey) testHeaders['Authorization'] = `Bearer ${apiKey}`;
        break;
      }

      case 'custom': {
        const base = (endpoint || '').replace(/\/$/, '');
        if (!base) {
          return NextResponse.json(
            { ok: false, error: 'Endpoint URL is required' },
            { status: 400 }
          );
        }
        // Try a generic /models endpoint (works for most OpenAI-compat servers)
        testUrl = `${base}/models`;
        if (apiKey) testHeaders['Authorization'] = `Bearer ${apiKey}`;
        break;
      }

      default: {
        return NextResponse.json(
          { ok: false, error: `Unknown provider: ${provider}` },
          { status: 400 }
        );
      }
    }

    let response: Response;
    try {
      response = await fetch(testUrl, {
        method: 'GET',
        headers: testHeaders,
        signal: AbortSignal.timeout(10_000), // 10-second timeout
      });
    } catch (netErr) {
      const isTimeout =
        netErr instanceof Error &&
        (netErr.name === 'TimeoutError' || netErr.name === 'AbortError');
      const msg = isTimeout
        ? `Connection timed out after 10 seconds. Make sure the endpoint is reachable.`
        : `Network error: ${netErr instanceof Error ? netErr.message : String(netErr)}`;
      const errText = `Connection failed: ${msg}`;
      await auditLog({
        action: 'TEST_LLM_CONNECTION',
        entityType: 'SETTING',
        entityId: 'smart_upload',
        newValues: { provider, model, success: false, error: errText },
      });
      return NextResponse.json({ ok: false, error: errText });
    }

    if (!response.ok) {
      const hint = response.status === 401
        ? ' — check your API key.'
        : response.status === 404
          ? ' — check the endpoint URL.'
          : '';
      const errText = `Connection failed: server responded with ${response.status}${hint}`;
      await auditLog({
        action: 'TEST_LLM_CONNECTION',
        entityType: 'SETTING',
        entityId: 'smart_upload',
        newValues: { provider, model, success: false, error: errText },
      });
      return NextResponse.json({
        ok: false,
        error: errText,
      });
    }

    const successMessage = `Successfully connected to ${provider} (model: ${model}).`;
    await auditLog({
      action: 'TEST_LLM_CONNECTION',
      entityType: 'SETTING',
      entityId: 'smart_upload',
      newValues: { provider, model, success: true, message: successMessage },
    });
    return NextResponse.json({
      ok: true,
      message: successMessage,
    });
  } catch (error) {
    logger.error('LLM connection test failed', { error });
    return NextResponse.json(
      { ok: false, error: 'Internal server error during connection test.' },
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
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}
