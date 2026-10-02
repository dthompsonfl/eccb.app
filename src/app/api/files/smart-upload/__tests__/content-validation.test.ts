/**
 * @vitest-environment node
 *
 * Content-validation tests for the Smart Upload intake: an upload is judged by
 * its actual bytes, not the MIME type the client declared.
 *
 * Uses the same NextRequest/hoisted-mock harness as integration.test.ts, which
 * is required because undici's multipart parser and jsdom's File are not
 * interchangeable.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockGetSession = vi.hoisted(() => vi.fn());
const mockCheckUserPermission = vi.hoisted(() => vi.fn());
const mockApplyRateLimit = vi.hoisted(() => vi.fn());
const mockValidateCSRF = vi.hoisted(() => vi.fn());
const mockUploadFile = vi.hoisted(() => vi.fn());
const mockQueueSmartUploadProcess = vi.hoisted(() => vi.fn());
const mockComputeSha256 = vi.hoisted(() => vi.fn(() => 'sha-abc'));
const mockLoadSmartUploadRuntimeConfig = vi.hoisted(() => vi.fn());
const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('@/lib/auth/guards', () => ({ getSession: mockGetSession }));
vi.mock('@/lib/auth/permissions', () => ({ checkUserPermission: mockCheckUserPermission }));
vi.mock('@/lib/rate-limit', () => ({ applyRateLimit: mockApplyRateLimit }));
vi.mock('@/lib/csrf', () => ({ validateCSRF: mockValidateCSRF }));
vi.mock('@/lib/logger', () => ({ logger: mockLogger }));
vi.mock('@/lib/services/storage', () => ({
  uploadFile: mockUploadFile,
  validateFileMagicBytes: vi.fn(() => true),
  downloadFile: vi.fn(),
  deleteFile: vi.fn(),
}));
vi.mock('@/lib/jobs/smart-upload', () => ({
  queueSmartUploadProcess: mockQueueSmartUploadProcess,
  queueSmartUploadSecondPass: vi.fn(),
  queueSmartUploadAutoCommit: vi.fn(),
  SmartUploadJobProgress: {},
  SMART_UPLOAD_JOB_NAMES: { PROCESS: 'process' },
}));
vi.mock('@/lib/smart-upload/duplicate-detection', () => ({
  computeSha256: mockComputeSha256,
}));
vi.mock('@/lib/smart-upload/runtime-config', () => ({
  loadSmartUploadRuntimeConfig: mockLoadSmartUploadRuntimeConfig,
  runtimeToAdapterConfig: vi.fn(() => ({})),
  buildAdapterConfigForStep: vi.fn(async () => ({})),
  loadSmartUploadSettingsSnapshot: vi.fn(async () => ({})),
  buildSmartUploadSettingsSnapshotSummary: vi.fn(() => ({})),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    smartUploadSession: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        uploadSessionId: data.uploadSessionId,
        ...data,
      })),
      update: vi.fn(async () => ({})),
    },
    musicFile: { findFirst: vi.fn(async () => null) },
  },
}));

import { POST } from '@/app/api/files/smart-upload/route';

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
const PDF_BYTES = Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<<>>\nendobj\n', 'binary');
const ELF_BYTES = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]);

function buildUploadRequest(
  filename: string,
  declaredType: string,
  bytes: Buffer,
): NextRequest {
  const file = new File([new Uint8Array(bytes)], filename, { type: declaredType });
  const formData = new FormData();
  formData.append('file', file);
  return new NextRequest('http://localhost:3000/api/files/smart-upload', {
    method: 'POST',
    body: formData,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSession.mockResolvedValue({ user: { id: 'admin-1', role: 'admin' } });
  mockCheckUserPermission.mockResolvedValue(true);
  mockApplyRateLimit.mockResolvedValue(null);
  mockValidateCSRF.mockReturnValue({ valid: true });
  mockUploadFile.mockResolvedValue('etag');
  mockQueueSmartUploadProcess.mockResolvedValue({ id: 'job-1' });
  mockComputeSha256.mockReturnValue('sha-abc');
  mockLoadSmartUploadRuntimeConfig.mockResolvedValue({
    allowedMimeTypes: ['application/pdf', 'image/png', 'image/jpeg', 'image/tiff'],
    maxFileSizeMb: 50,
  });
});

describe('Smart Upload rejects content that does not match its claim', () => {
  it('rejects a PNG renamed to .pdf and declared application/pdf', async () => {
    const res = await POST(buildUploadRequest('innocent.pdf', 'application/pdf', PNG_BYTES));

    expect(res.status).toBe(400);
    // Nothing was stored.
    expect(mockUploadFile).not.toHaveBeenCalled();
  });

  it('rejects an ELF binary declared as a PDF', async () => {
    const res = await POST(buildUploadRequest('score.pdf', 'application/pdf', ELF_BYTES));

    expect(res.status).toBe(400);
    expect(mockUploadFile).not.toHaveBeenCalled();
  });

  it('rejects plain text declared as a PDF', async () => {
    const res = await POST(
      buildUploadRequest('notes.pdf', 'application/pdf', Buffer.from('just some text')),
    );
    expect(res.status).toBe(400);
  });

  it('rejects a disallowed declared type before reading content', async () => {
    const res = await POST(buildUploadRequest('page.html', 'text/html', PDF_BYTES));

    expect(res.status).toBe(400);
    expect(mockUploadFile).not.toHaveBeenCalled();
  });

  it('names PDF in the error so an administrator knows what to fix', async () => {
    const res = await POST(buildUploadRequest('score.pdf', 'application/pdf', ELF_BYTES));
    const body = await res.json();
    expect(body.error).toContain('PDF');
  });
});
