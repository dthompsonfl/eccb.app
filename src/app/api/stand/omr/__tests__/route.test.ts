import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { POST, GET } from '../route';

// Mock dependencies
vi.mock('@/lib/auth/config', () => ({
  auth: {
    api: {
      getSession: vi.fn(),
    },
  },
}));

vi.mock('@/lib/auth/permissions', () => ({
  getUserRoles: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    musicFile: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    musicPiece: {
      update: vi.fn(),
    },
    $extends: vi.fn(),
    $disconnect: vi.fn(),
    $connect: vi.fn(),
    $on: vi.fn(),
  },
}));

vi.mock('@/lib/rate-limit', () => ({
  applyRateLimit: vi.fn().mockResolvedValue(null),
}));

vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

// All LLM config is DB-driven — mock the config loader, never env vars
vi.mock('@/lib/smart-upload/runtime-config', () => ({
  loadSmartUploadRuntimeConfig: vi.fn(),
}));

// Mock fetch for AI provider calls
global.fetch = vi.fn();

import { auth } from '@/lib/auth/config';
import { getUserRoles } from '@/lib/auth/permissions';
import { prisma } from '@/lib/db';
import { loadSmartUploadRuntimeConfig } from '@/lib/smart-upload/runtime-config';
const mockAuth = auth as unknown as { api: { getSession: ReturnType<typeof vi.fn> } };
const mockGetUserRoles = getUserRoles as ReturnType<typeof vi.fn>;
const mockLoadConfig = loadSmartUploadRuntimeConfig as ReturnType<typeof vi.fn>;
const mockPrisma = prisma as any;

/** Minimal LLM config with no API key — represents unconfigured state */
function makeEmptyConfig() {
  return {
    provider: 'openai',
    endpointUrl: 'https://api.openai.com/v1',
    visionModel: 'gpt-4o',
    verificationModel: 'gpt-4o',
    openaiApiKey: '',
    anthropicApiKey: '',
    openrouterApiKey: '',
    geminiApiKey: '',
    ollamaCloudApiKey: '',
    mistralApiKey: '',
    groqApiKey: '',
    customApiKey: '',
  };
}

/** Minimal LLM config with an API key set */
function makeConfigWithKey(provider = 'openai', key = 'test-server-key') {
  return {
    ...makeEmptyConfig(),
    provider,
    openaiApiKey: provider === 'openai' ? key : '',
    anthropicApiKey: provider === 'anthropic' ? key : '',
    geminiApiKey: provider === 'gemini' ? key : '',
    openrouterApiKey: provider === 'openrouter' ? key : '',
  };
}

describe('OMR API Route', () => {
  const mockSession = {
    user: {
      id: 'user-123',
      email: 'test@example.com',
    },
  };

  const mockMusicFile = {
    id: 'file-123',
    storageKey: 'music/sheet.pdf',
    extractedMetadata: null,
    pieceId: 'piece-123',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: user is a DIRECTOR (has OMR permissions)
    mockGetUserRoles.mockResolvedValue(['DIRECTOR']);
    // Default: DB has no API key configured (DB-driven, no env vars)
    mockLoadConfig.mockResolvedValue(makeEmptyConfig());
  });

  describe('GET /api/stand/omr', () => {
    it('should return 401 when not authenticated', async () => {
      mockAuth.api.getSession.mockResolvedValue(null);

      const request = new NextRequest(
        new URL('http://localhost:3000/api/stand/omr?musicFileId=file-123'),
        { method: 'GET' }
      );

      const response = await GET(request);
      expect(response.status).toBe(401);
    });

    it('should return 400 when musicFileId is missing', async () => {
      mockAuth.api.getSession.mockResolvedValue(mockSession);

      const request = new NextRequest(new URL('http://localhost:3000/api/stand/omr'), {
        method: 'GET',
      });

      const response = await GET(request);
      expect(response.status).toBe(400);
    });

    it('should return 404 when music file not found', async () => {
      mockAuth.api.getSession.mockResolvedValue(mockSession);
      mockPrisma.musicFile.findUnique.mockResolvedValue(null);

      const request = new NextRequest(
        new URL('http://localhost:3000/api/stand/omr?musicFileId=file-123'),
        { method: 'GET' }
      );

      const response = await GET(request);
      expect(response.status).toBe(404);
    });

    it('should return processed: false when no metadata exists', async () => {
      mockAuth.api.getSession.mockResolvedValue(mockSession);
      mockPrisma.musicFile.findUnique.mockResolvedValue({
        ...mockMusicFile,
        extractedMetadata: null,
      });

      const request = new NextRequest(
        new URL('http://localhost:3000/api/stand/omr?musicFileId=file-123'),
        { method: 'GET' }
      );

      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.processed).toBe(false);
    });

    it('should return metadata when already processed', async () => {
      mockAuth.api.getSession.mockResolvedValue(mockSession);
      mockPrisma.musicFile.findUnique.mockResolvedValue({
        ...mockMusicFile,
        extractedMetadata: JSON.stringify({
          tempo: 120,
          keySignature: 'C major',
          processedAt: '2024-01-01T00:00:00.000Z',
          provider: 'openai',
        }),
      });

      const request = new NextRequest(
        new URL('http://localhost:3000/api/stand/omr?musicFileId=file-123'),
        { method: 'GET' }
      );

      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.processed).toBe(true);
      expect(data.metadata.tempo).toBe(120);
    });
  });

  describe('POST /api/stand/omr', () => {
    it('should return 401 when not authenticated', async () => {
      mockAuth.api.getSession.mockResolvedValue(null);

      const request = new NextRequest(
        new URL('http://localhost:3000/api/stand/omr'),
        { method: 'POST', body: JSON.stringify({ musicFileId: 'file-123' }) }
      );

      const response = await POST(request);
      expect(response.status).toBe(401);
    });

    it('should return 403 when user lacks required role', async () => {
      mockAuth.api.getSession.mockResolvedValue(mockSession);
      mockGetUserRoles.mockResolvedValue(['MEMBER']); // Not a director/librarian

      const request = new NextRequest(
        new URL('http://localhost:3000/api/stand/omr'),
        { method: 'POST', body: JSON.stringify({ musicFileId: 'file-123' }) }
      );

      const response = await POST(request);
      expect(response.status).toBe(403);
    });

    it('should return 503 when server API key not configured', async () => {
      mockAuth.api.getSession.mockResolvedValue(mockSession);
      mockGetUserRoles.mockResolvedValue(['DIRECTOR']);
      // No env var set (cleared in beforeEach)

      const request = new NextRequest(
        new URL('http://localhost:3000/api/stand/omr'),
        { method: 'POST', body: JSON.stringify({ musicFileId: 'file-123' }) }
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(503);
      expect(data.code).toBe('SERVER_KEY_REQUIRED');
    });

    it('should return cached metadata when already processed', async () => {
      mockAuth.api.getSession.mockResolvedValue(mockSession);
      mockGetUserRoles.mockResolvedValue(['DIRECTOR']);
      mockLoadConfig.mockResolvedValue(makeConfigWithKey('openai', 'test-server-key'));

      mockPrisma.musicFile.findUnique.mockResolvedValue({
        ...mockMusicFile,
        extractedMetadata: JSON.stringify({
          tempo: 120,
          keySignature: 'C major',
          processedAt: '2024-01-01T00:00:00.000Z',
          provider: 'openai',
        }),
      });

      const request = new NextRequest(
        new URL('http://localhost:3000/api/stand/omr'),
        { method: 'POST', body: JSON.stringify({ musicFileId: 'file-123' }) }
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.cached).toBe(true);
      expect(data.metadata.tempo).toBe(120);
    });

    it('should process OMR when forceReprocess is true', async () => {
      mockAuth.api.getSession.mockResolvedValue(mockSession);
      mockGetUserRoles.mockResolvedValue(['LIBRARIAN']);
      mockLoadConfig.mockResolvedValue(makeConfigWithKey('openai', 'test-server-key'));

      mockPrisma.musicFile.findUnique.mockResolvedValue(mockMusicFile);
      mockPrisma.musicFile.update.mockResolvedValue({});
      mockPrisma.musicPiece.update.mockResolvedValue({});

      // Mock fetch for both file retrieval and OpenAI API.
      // Return a simple PNG image (to avoid pdfjs-dist conversion)
      vi.mocked(global.fetch).mockImplementation(async (url: string | URL | Request, _opts?: RequestInit) => {
        const u = typeof url === 'string' ? url : url.toString();
        if (u.includes('/api/files/')) {
          // Return a simple PNG image buffer instead of PDF to skip conversion
          const pngBuffer = Buffer.from([137, 80, 78, 71]); // PNG magic: ‰PNG
          return {
            ok: true,
            headers: { get: () => 'image/png' },
            arrayBuffer: async () => pngBuffer.buffer,
          } as unknown as Response;
        }
        // Otherwise assume OpenAI analysis request
        return {
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    tempo: 140,
                    keySignature: 'G major',
                    timeSignature: '4/4',
                  }),
                },
              },
            ],
          }),
        } as unknown as Response;
      });

      const request = new NextRequest(
        new URL('http://localhost:3000/api/stand/omr'),
        {
          method: 'POST',
          body: JSON.stringify({ musicFileId: 'file-123', forceReprocess: true }),
        }
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.cached).toBe(false);
      expect(data.metadata.tempo).toBe(140);
    });
  });
});
