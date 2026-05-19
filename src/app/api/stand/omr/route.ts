import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth/config';
import { headers } from 'next/headers';
import { prisma } from '@/lib/db';
import { getUserRoles } from '@/lib/auth/permissions';
import { applyRateLimit } from '@/lib/rate-limit';
import { loadSmartUploadRuntimeConfig } from '@/lib/llm/config-loader';
import { z } from 'zod';

// Zod schema for OMR request validation
const omrRequestSchema = z.object({
  musicFileId: z.string().min(1, 'musicFileId is required'),
  forceReprocess: z.boolean().optional().default(false),
});

// OMR metadata structure extracted from sheet music
interface OMRMetadata {
  tempo?: number;
  keySignature?: string;
  timeSignature?: string;
  estimatedDuration?: number;
  measureCount?: number;
  pageCount?: number;
  difficulty?: 'GRADE_1' | 'GRADE_2' | 'GRADE_3' | 'GRADE_4' | 'GRADE_5' | 'GRADE_6';
  instruments?: string[];
  notes?: string;
  processedAt: string;
  provider: string;
}

/**
 * POST /api/stand/omr
 * Performs Optical Music Recognition on a PDF file using database-configured AI keys.
 *
 * This endpoint:
 * 1. Validates user authentication and role (DIRECTOR / SUPER_ADMIN / LIBRARIAN)
 * 2. Loads provider + API key from the SystemSetting table (DB-driven, never env)
 * 3. Fetches the PDF file from storage
 * 4. Calls the configured AI/vision provider for OMR analysis
 * 5. Stores extracted metadata in MusicFile.extractedMetadata
 *
 * Request body: { musicFileId: string, forceReprocess?: boolean }
 * Response: { success: boolean, metadata?: OMRMetadata, error?: string }
 */
export async function POST(request: NextRequest) {
  try {
    // Rate limit OMR requests
    const rateLimited = await applyRateLimit(request, 'stand-annotation');
    if (rateLimited) return rateLimited;

    const headersList = await headers();
    const session = await auth.api.getSession({ headers: headersList });

    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Only directors and librarians can trigger OMR analysis
    const roles = await getUserRoles(session.user.id);
    const canRunOMR = roles.includes('DIRECTOR') ||
      roles.includes('SUPER_ADMIN') ||
      roles.includes('LIBRARIAN');

    if (!canRunOMR) {
      return NextResponse.json(
        { error: 'Forbidden: Only directors and librarians can trigger OMR analysis' },
        { status: 403 }
      );
    }

    // Parse and validate request body
    const body = await request.json();
    const validated = omrRequestSchema.parse(body);

    // ── Load provider + API key from the database (single source of truth) ─
    const llmConfig = await loadSmartUploadRuntimeConfig();
    const omrProvider = llmConfig.provider;
    let omrApiKey: string | undefined;

    switch (omrProvider.toLowerCase()) {
      case 'openai':
        omrApiKey = llmConfig.openaiApiKey || undefined;
        break;
      case 'anthropic':
        omrApiKey = llmConfig.anthropicApiKey || undefined;
        break;
      case 'google':
      case 'gemini':
        omrApiKey = llmConfig.geminiApiKey || undefined;
        break;
      case 'openrouter':
        omrApiKey = llmConfig.openrouterApiKey || undefined;
        break;
      case 'mistral':
        omrApiKey = llmConfig.mistralApiKey || undefined;
        break;
      case 'groq':
        omrApiKey = llmConfig.groqApiKey || undefined;
        break;
      case 'custom':
        omrApiKey = llmConfig.customApiKey || undefined;
        break;
      // ollama / ollama-cloud: local, no API key required
      case 'ollama':
      case 'ollama-cloud':
        omrApiKey = 'local';
        break;
    }

    if (!omrApiKey) {
      return NextResponse.json(
        {
          error: 'OMR not configured',
          code: 'SERVER_KEY_REQUIRED',
          message: 'No AI API key is configured. Set your provider API key in Admin → Smart Upload Settings.',
        },
        { status: 503 }
      );
    }

    // Get the music file
    const musicFile = await prisma.musicFile.findUnique({
      where: { id: validated.musicFileId },
      select: {
        id: true,
        storageKey: true,
        extractedMetadata: true,
        pieceId: true,
      },
    });

    if (!musicFile) {
      return NextResponse.json({ error: 'Music file not found' }, { status: 404 });
    }

    // Check if already processed (unless force reprocess)
    if (musicFile.extractedMetadata && !validated.forceReprocess) {
      return NextResponse.json({
        success: true,
        metadata: JSON.parse(musicFile.extractedMetadata),
        cached: true,
      });
    }

    // Get file URL for processing
    const fileUrl = `/api/files/${musicFile.storageKey}`;

    // Call the appropriate AI provider for OMR (using DB-configured model)
    let metadata: OMRMetadata;

    try {
      metadata = await performOMRAnalysis(
        fileUrl,
        omrApiKey,
        omrProvider,
        llmConfig.visionModel,
        llmConfig.endpointUrl,
      );
    } catch (omrError) {
      console.error('OMR analysis failed:', omrError);
      return NextResponse.json(
        {
          error: 'OMR analysis failed',
          message: omrError instanceof Error ? omrError.message : 'Unknown error during analysis',
        },
        { status: 500 }
      );
    }

    // Store the extracted metadata
    await prisma.musicFile.update({
      where: { id: validated.musicFileId },
      data: {
        extractedMetadata: JSON.stringify(metadata),
      },
    });

    // If we have a music piece, also update its metadata
    if (musicFile.pieceId && metadata.tempo) {
      await prisma.musicPiece.update({
        where: { id: musicFile.pieceId },
        data: {
          tempo: String(metadata.tempo),
          ...(metadata.keySignature && { keySignature: metadata.keySignature }),
          ...(metadata.timeSignature && { timeSignature: metadata.timeSignature }),
          ...(metadata.difficulty && { difficulty: metadata.difficulty as never }),
          ...(metadata.estimatedDuration && { duration: Math.round(metadata.estimatedDuration) }),
        },
      });
    }

    return NextResponse.json({
      success: true,
      metadata,
      cached: false,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation error', details: error.issues },
        { status: 400 }
      );
    }
    console.error('Error in OMR processing:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

/**
 * GET /api/stand/omr
 * Returns OMR metadata for a music file if already processed
 * Query params: musicFileId
 */
export async function GET(request: NextRequest) {
  try {
    const headersList = await headers();
    const session = await auth.api.getSession({ headers: headersList });

    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const musicFileId = searchParams.get('musicFileId');

    if (!musicFileId) {
      return NextResponse.json(
        { error: 'musicFileId query parameter is required' },
        { status: 400 }
      );
    }

    const musicFile = await prisma.musicFile.findUnique({
      where: { id: musicFileId },
      select: {
        id: true,
        extractedMetadata: true,
      },
    });

    if (!musicFile) {
      return NextResponse.json({ error: 'Music file not found' }, { status: 404 });
    }

    if (!musicFile.extractedMetadata) {
      return NextResponse.json({
        processed: false,
        message: 'OMR analysis not yet performed for this file',
      });
    }

    return NextResponse.json({
      processed: true,
      metadata: JSON.parse(musicFile.extractedMetadata),
    });
  } catch (error) {
    console.error('Error fetching OMR metadata:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

/**
 * Convert the first page of a PDF buffer to a PNG base64 string.
 * Uses pdfjs-dist v5 (ESM) with the `canvas` package for server-side rendering.
 * Scale of 2.0 produces ~150 dpi equivalent which is sufficient for AI vision models.
 */
async function pdfBufferToPngBase64(pdfBuffer: Buffer): Promise<string> {
  // Use dynamic import for pdfjs-dist v5 (ESM-only) and canvas
  const pdfjsLib = await import('pdfjs-dist');
  // Disable worker for server-side Node.js usage
  pdfjsLib.GlobalWorkerOptions.workerSrc = '';
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createCanvas } = require('canvas');

  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(pdfBuffer) });
  const pdfDoc = await loadingTask.promise;
  const page = await pdfDoc.getPage(1);

  const SCALE = 2.0;
  const viewport = page.getViewport({ scale: SCALE });

  const canvas = createCanvas(Math.floor(viewport.width), Math.floor(viewport.height));
  const ctx = canvas.getContext('2d');

  // NodeCanvasFactory bridge for pdfjs-dist
  const renderContext = {
    canvasContext: ctx,
    canvas: canvas as unknown as HTMLCanvasElement,
    viewport,
  };

  await page.render(renderContext).promise;

  // Convert to PNG buffer, then base64
  const pngBuffer: Buffer = canvas.toBuffer('image/png');
  return pngBuffer.toString('base64');
}

/**
 * Download a file from a URL (absolute or relative to app base) and return its buffer.
 */
async function fetchFileBuffer(fileUrl: string): Promise<{ buffer: Buffer; mimeType: string }> {
  // Prevent SSRF: only allow relative paths starting with /
  if (fileUrl.startsWith('http://') || fileUrl.startsWith('https://') || !fileUrl.startsWith('/')) {
    throw new Error('Invalid file URL: must be a relative path');
  }

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  // Ensure we don't end up with // if baseUrl ends with /
  const cleanBaseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const fullUrl = `${cleanBaseUrl}${fileUrl}`;

  const res = await fetch(fullUrl);
  if (!res.ok) throw new Error(`Failed to fetch file: ${res.status} ${res.statusText}`);

  const contentType = res.headers.get('content-type') || '';
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, mimeType: contentType };
}

/**
 * Resolve file to a base64 PNG image, converting PDFs on the fly.
 * Returns { base64: string, mimeType: 'image/png' | 'image/jpeg' }
 */
async function resolveToBase64Image(
  fileUrl: string
): Promise<{ base64: string; mimeType: 'image/png' | 'image/jpeg' }> {
  const { buffer, mimeType } = await fetchFileBuffer(fileUrl);

  // Check if the content is a PDF by magic bytes (%PDF)
  const isPdf =
    mimeType.includes('pdf') ||
    (buffer.length > 4 && buffer.slice(0, 4).toString('ascii') === '%PDF');

  if (isPdf) {
    const base64 = await pdfBufferToPngBase64(buffer);
    return { base64, mimeType: 'image/png' };
  }

  // It's already an image; detect format from magic bytes
  const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8;
  const imgMime = isJpeg ? 'image/jpeg' : 'image/png';
  return { base64: buffer.toString('base64'), mimeType: imgMime };
}

/**
 * Perform OMR analysis using the database-configured AI provider.
 * Supports: openai, anthropic, google/gemini, openrouter (OpenAI-compatible),
 * mistral, groq, custom (OpenAI-compatible).
 */
async function performOMRAnalysis(
  fileUrl: string,
  apiKey: string,
  provider: string,
  visionModel?: string,
  endpointUrl?: string,
): Promise<OMRMetadata> {
  // Resolve the file to a base64-encoded PNG/JPEG, converting PDFs automatically
  const { base64, mimeType } = await resolveToBase64Image(fileUrl);

  const p = provider.toLowerCase();

  // OpenAI-compatible providers (openai, openrouter, mistral, groq, custom)
  if (p === 'openai' || p === 'openrouter' || p === 'mistral' || p === 'groq' || p === 'custom') {
    const endpoint =
      endpointUrl ||
      (p === 'openrouter' ? 'https://openrouter.ai/api/v1' :
       p === 'mistral'    ? 'https://api.mistral.ai/v1' :
       p === 'groq'       ? 'https://api.groq.com/openai/v1' :
       'https://api.openai.com/v1');
    const model =
      visionModel ||
      (p === 'openrouter' ? 'google/gemini-2.0-flash-exp:free' :
       p === 'mistral'    ? 'pixtral-12b-2409' :
       p === 'groq'       ? 'llama-3.2-11b-vision-preview' :
       'gpt-4o');
    return analyzeWithOpenAI(base64, mimeType, apiKey, endpoint, model);
  }

  if (p === 'anthropic') {
    const model = visionModel || 'claude-opus-4-5';
    return analyzeWithAnthropic(base64, mimeType, apiKey, model);
  }

  if (p === 'google' || p === 'gemini') {
    const model = visionModel || 'gemini-1.5-flash';
    return analyzeWithGoogle(base64, mimeType, apiKey, model);
  }

  throw new Error(`Unsupported OMR provider: ${provider}`);
}

/**
 * Analyze sheet music using the OpenAI Vision API (or any OpenAI-compatible endpoint).
 * Accepts pre-converted base64 image data for reliable PDF support.
 */
async function analyzeWithOpenAI(
  base64Image: string,
  mimeType: string,
  apiKey: string,
  endpointUrl = 'https://api.openai.com/v1',
  model = 'gpt-4o',
): Promise<OMRMetadata> {
  const dataUrl = `data:${mimeType};base64,${base64Image}`;

  const response = await fetch(`${endpointUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'system',
          content: `You are an expert music analyst. Analyze the provided sheet music image and extract musical metadata.
Return a JSON object with the following fields (only include fields you can confidently determine):
- tempo: number (BPM)
- keySignature: string (e.g., "C major", "G major", "F minor")
- timeSignature: string (e.g., "4/4", "3/4", "6/8")
- estimatedDuration: number (seconds)
- measureCount: number
- difficulty: "GRADE_1" | "GRADE_2" | "GRADE_3" | "GRADE_4" | "GRADE_5" | "GRADE_6" (1=easiest, 6=hardest)
- instruments: string[] (list of instruments this part appears to be for)
- notes: string (any additional observations)

Be conservative - only include fields you can determine with high confidence.`,
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Analyze this sheet music and extract the musical metadata.',
            },
            {
              type: 'image_url',
              image_url: { url: dataUrl },
            },
          ],
        },
      ],
      max_tokens: 1000,
      response_format: { type: 'json_object' },
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI API error: ${response.status} - ${error}`);
  }

  const data = await response.json();
  const content = data.choices[0]?.message?.content;

  if (!content) {
    throw new Error('No response content from OpenAI');
  }

  const parsed = JSON.parse(content);
  return {
    ...parsed,
    processedAt: new Date().toISOString(),
    provider: 'openai',
  };
}

/**
 * Analyze sheet music using Anthropic Claude API
 * Accepts pre-converted base64 image data.
 */
async function analyzeWithAnthropic(
  base64Image: string,
  mimeType: string,
  apiKey: string,
  model = 'claude-opus-4-5',
): Promise<OMRMetadata> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1000,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mimeType as 'image/png' | 'image/jpeg',
                data: base64Image,
              },
            },
            {
              type: 'text',
              text: `Analyze this sheet music and extract musical metadata. Return a JSON object with these fields (only include what you can confidently determine):
- tempo: number (BPM)
- keySignature: string (e.g., "C major", "G major")
- timeSignature: string (e.g., "4/4", "3/4")
- estimatedDuration: number (seconds)
- measureCount: number
- difficulty: "GRADE_1" | "GRADE_2" | "GRADE_3" | "GRADE_4" | "GRADE_5" | "GRADE_6" (1=easiest, 6=hardest)
- instruments: string[]
- notes: string

Return only valid JSON.`,
            },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Anthropic API error: ${response.status} - ${error}`);
  }

  const data = await response.json();
  const content = data.content[0]?.text;

  if (!content) {
    throw new Error('No response content from Anthropic');
  }

  // Parse JSON from the response
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('No JSON found in Anthropic response');
  }

  const parsed = JSON.parse(jsonMatch[0]);
  return {
    ...parsed,
    processedAt: new Date().toISOString(),
    provider: 'anthropic',
  };
}

/**
 * Analyze sheet music using Google Gemini API
 * Accepts pre-converted base64 image data.
 */
async function analyzeWithGoogle(
  base64Image: string,
  mimeType: string,
  apiKey: string,
  model = 'gemini-1.5-flash',
): Promise<OMRMetadata> {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                inline_data: {
                  mime_type: mimeType,
                  data: base64Image,
                },
              },
              {
                text: `Analyze this sheet music and extract musical metadata. Return a JSON object with these fields (only include what you can confidently determine):
- tempo: number (BPM)
- keySignature: string
- timeSignature: string
- estimatedDuration: number (seconds)
- measureCount: number
- difficulty: "GRADE_1" | "GRADE_2" | "GRADE_3" | "GRADE_4" | "GRADE_5" | "GRADE_6" (1=easiest, 6=hardest)
- instruments: string[]
- notes: string

Return only valid JSON.`,
              },
            ],
          },
        ],
        generationConfig: {
          response_mime_type: 'application/json',
        },
      }),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Google API error: ${response.status} - ${error}`);
  }

  const data = await response.json();
  const content = data.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!content) {
    throw new Error('No response content from Google');
  }

  const parsed = JSON.parse(content);
  return {
    ...parsed,
    processedAt: new Date().toISOString(),
    provider: 'google',
  };
}
