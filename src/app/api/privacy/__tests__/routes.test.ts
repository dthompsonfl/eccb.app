/**
 * Route-level tests for /api/privacy/export and /api/privacy/erasure.
 *
 * Follows the repo convention of mocking `@/lib/rate-limit` (so the limiter's
 * pass/deny branch is driven explicitly rather than depending on Redis), and
 * of mocking `@/lib/auth/config` for the session.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/rate-limit', () => ({
  applyRateLimit: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock('@/lib/csrf', () => ({
  validateCSRF: vi.fn().mockReturnValue({ valid: true }),
}));

vi.mock('@/lib/privacy/export', () => ({
  buildPersonalDataExport: vi.fn(),
  toCsvBundle: vi.fn().mockReturnValue('recordType,date\r\nAttendance,2026-01-01\r\n'),
  exportFileName: vi.fn(
    (_generatedAt: Date, extension: 'json' | 'csv') => `eccb-my-information.${extension}`,
  ),
  EXPORT_SCHEMA_VERSION: '1.0.0',
}));

vi.mock('@/lib/privacy/erasure', () => ({
  canExportFor: vi.fn().mockResolvedValue(false),
  requestErasure: vi.fn(),
  executeErasure: vi.fn(),
  cancelErasure: vi.fn(),
  getPendingErasure: vi.fn().mockResolvedValue(null),
  ErasureConfirmationError: class extends Error {},
  ErasureNotAuthorizedError: class extends Error {},
  RETENTION_BASIS: [{ record: 'Attendance', basis: 'Legitimate interest.' }],
}));

vi.mock('@/lib/services/audit', () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

import { GET as exportGet } from '@/app/api/privacy/export/route';
import {
  GET as erasureGet,
  POST as erasurePost,
  DELETE as erasureDelete,
} from '@/app/api/privacy/erasure/route';
import { applyRateLimit } from '@/lib/rate-limit';
import { auth } from '@/lib/auth/config';
import { validateCSRF } from '@/lib/csrf';
import { buildPersonalDataExport, toCsvBundle } from '@/lib/privacy/export';
import {
  canExportFor,
  cancelErasure,
  ErasureConfirmationError,
  ErasureNotAuthorizedError,
  executeErasure,
  getPendingErasure,
  requestErasure,
} from '@/lib/privacy/erasure';
import { auditLog } from '@/lib/services/audit';

const session = { user: { id: 'user-1', email: 'ruth@example.com' } };

function getRequest(url: string): NextRequest {
  return new NextRequest(url);
}

function postRequest(body: unknown, url = 'http://localhost/api/privacy/erasure'): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(applyRateLimit).mockResolvedValue(null);
  vi.mocked(auth.api.getSession).mockResolvedValue(session as never);
  vi.mocked(validateCSRF).mockReturnValue({ valid: true });
  vi.mocked(buildPersonalDataExport).mockResolvedValue({
    metadata: { generatedAt: new Date().toISOString(), schemaVersion: '1.0.0' },
    account: { id: 'user-1' },
  } as never);
});

// ─── Export ──────────────────────────────────────────────────────────────────

describe('GET /api/privacy/export', () => {
  it('requires a session', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(null as never);
    const response = await exportGet(getRequest('http://localhost/api/privacy/export'));
    expect(response.status).toBe(401);
  });

  it('applies the privacy-export rate limit bucket', async () => {
    await exportGet(getRequest('http://localhost/api/privacy/export'));
    expect(applyRateLimit).toHaveBeenCalledWith(expect.anything(), 'privacy-export');
  });

  it('returns the rate-limit response verbatim when the limit is hit', async () => {
    const { NextResponse } = await import('next/server');
    const limited = NextResponse.json({ error: 'Too many requests' }, { status: 429 });
    vi.mocked(applyRateLimit).mockResolvedValue(limited as never);

    const response = await exportGet(getRequest('http://localhost/api/privacy/export'));
    expect(response.status).toBe(429);
  });

  it('defaults to the caller’s own data', async () => {
    await exportGet(getRequest('http://localhost/api/privacy/export'));
    expect(buildPersonalDataExport).toHaveBeenCalledWith('user-1');
  });

  it('serves JSON as a download with a self-describing header', async () => {
    const response = await exportGet(getRequest('http://localhost/api/privacy/export'));

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('application/json');
    expect(response.headers.get('Content-Disposition')).toContain('attachment');
    expect(response.headers.get('Content-Disposition')).toContain('.json');
    // A personal-data response must never be cached by a proxy.
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('serves CSV when asked', async () => {
    const response = await exportGet(getRequest('http://localhost/api/privacy/export?format=csv'));

    expect(response.headers.get('Content-Type')).toContain('text/csv');
    expect(response.headers.get('Content-Disposition')).toContain('.csv');
    expect(toCsvBundle).toHaveBeenCalled();
  });

  it('lets a member export their own data without a permission check', async () => {
    await exportGet(getRequest('http://localhost/api/privacy/export?subject=user-1'));
    expect(canExportFor).not.toHaveBeenCalled();
    expect(buildPersonalDataExport).toHaveBeenCalledWith('user-1');
  });

  it('refuses to export another member without the permission', async () => {
    vi.mocked(canExportFor).mockResolvedValue(false);
    const response = await exportGet(
      getRequest('http://localhost/api/privacy/export?subject=user-2'),
    );

    // 404, not 403: a 403 would confirm that user-2 exists.
    expect(response.status).toBe(404);
    expect(buildPersonalDataExport).not.toHaveBeenCalled();
  });

  it('allows a permissioned admin to export another member’s data', async () => {
    vi.mocked(canExportFor).mockResolvedValue(true);
    const response = await exportGet(
      getRequest('http://localhost/api/privacy/export?subject=user-2'),
    );
    expect(response.status).toBe(200);
    expect(buildPersonalDataExport).toHaveBeenCalledWith('user-2');
  });

  it('rejects an absurdly long subject identifier', async () => {
    const response = await exportGet(
      getRequest(`http://localhost/api/privacy/export?subject=${'x'.repeat(200)}`),
    );
    expect(response.status).toBe(400);
  });

  it('audits every export', async () => {
    await exportGet(getRequest('http://localhost/api/privacy/export'));
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'privacy.export.generated', entityId: 'user-1' }),
    );
  });

  it('does not leak a stack trace when the build fails', async () => {
    vi.mocked(buildPersonalDataExport).mockRejectedValue(new Error('P2002 duplicate key'));
    const response = await exportGet(getRequest('http://localhost/api/privacy/export'));
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('P2002');
  });
});

// ─── Erasure ─────────────────────────────────────────────────────────────────

describe('/api/privacy/erasure', () => {
  it('applies the privacy-erasure rate limit bucket on every verb', async () => {
    await erasureGet(getRequest('http://localhost/api/privacy/erasure'));
    await erasurePost(postRequest({ action: 'request' }));
    await erasureDelete(
      new NextRequest('http://localhost/api/privacy/erasure', {
        method: 'DELETE',
        body: JSON.stringify({}),
      }),
    );

    for (const call of vi.mocked(applyRateLimit).mock.calls) {
      expect(call[1]).toBe('privacy-erasure');
    }
  });

  it('requires a session on every verb', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(null as never);

    expect((await erasureGet(getRequest('http://localhost/api/privacy/erasure'))).status).toBe(401);
    expect((await erasurePost(postRequest({ action: 'request' }))).status).toBe(401);
    expect(
      (
        await erasureDelete(
          new NextRequest('http://localhost/api/privacy/erasure', { method: 'DELETE' }),
        )
      ).status,
    ).toBe(401);
  });

  describe('POST request', () => {
    it('validates CSRF', async () => {
      vi.mocked(validateCSRF).mockReturnValue({ valid: false, reason: 'origin mismatch' });
      const response = await erasurePost(postRequest({ action: 'request' }));
      expect(response.status).toBe(403);
      expect(requestErasure).not.toHaveBeenCalled();
    });

    it('opens a pending request and returns the undo window', async () => {
      vi.mocked(requestErasure).mockResolvedValue({
        subjectUserId: 'user-1',
        subjectMemberId: 'member-1',
        requestedByUserId: 'user-1',
        requestedAt: new Date().toISOString(),
        executesAt: new Date(Date.now() + 604_800_000).toISOString(),
        isSelfService: true,
      });

      const response = await erasurePost(postRequest({ action: 'request' }));
      const body = (await response.json()) as { request: { isSelfService: boolean }; retentionBasis: unknown };

      expect(response.status).toBe(200);
      expect(body.request.isSelfService).toBe(true);
      // The UI states what is kept BEFORE anything happens — it needs this.
      expect(body.retentionBasis).toBeDefined();
      expect(requestErasure).toHaveBeenCalledWith('user-1', 'user-1');
    });

    it('rejects a malformed body', async () => {
      const response = await erasurePost(postRequest({ action: 'obliterate' }));
      expect(response.status).toBe(400);
    });

    it('rejects a confirm with no confirmation phrase', async () => {
      const response = await erasurePost(postRequest({ action: 'confirm', confirmation: '' }));
      expect(response.status).toBe(400);
      expect(executeErasure).not.toHaveBeenCalled();
    });
  });

  describe('POST confirm', () => {
    it('returns the manifest to the caller', async () => {
      vi.mocked(executeErasure).mockResolvedValue({
        subjectUserId: 'user-1',
        subjectMemberId: 'member-1',
        executedAt: new Date().toISOString(),
        alreadyApplied: false,
        performedBy: { userId: 'user-1', isSelf: true, isAdmin: false },
        deleted: [{ record: 'Annotations', category: 'DELETE', count: 3, reason: 'x' }],
        anonymised: [{ record: 'Attendance', category: 'ANONYMISE', count: 9, reason: 'y' }],
        retained: [],
        retentionBasis: [],
      } as never);

      const response = await erasurePost(
        postRequest({ action: 'confirm', confirmation: 'Ruth Calloway' }),
      );
      const body = (await response.json()) as { manifest: { deleted: unknown[]; anonymised: unknown[] } };

      expect(response.status).toBe(200);
      // The caller can see exactly what happened — that is the manifest's job.
      expect(body.manifest.deleted).toHaveLength(1);
      expect(body.manifest.anonymised).toHaveLength(1);
    });

    it('audits the confirmation with the full manifest', async () => {
      vi.mocked(executeErasure).mockResolvedValue({ deleted: [], anonymised: [] } as never);
      await erasurePost(postRequest({ action: 'confirm', confirmation: 'Ruth Calloway' }));

      expect(auditLog).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'privacy.erasure.confirmed', entityId: 'user-1' }),
      );
    });

    it('returns 400 with a readable message on a wrong name', async () => {
      vi.mocked(executeErasure).mockRejectedValue(new ErasureConfirmationError());

      const response = await erasurePost(
        postRequest({ action: 'confirm', confirmation: 'wrong' }),
      );
      const body = (await response.json()) as { error: string };

      expect(response.status).toBe(400);
      expect(body.error).toMatch(/did not match/i);
    });

    it('hides the existence of another member behind a 404', async () => {
      vi.mocked(executeErasure).mockRejectedValue(new ErasureNotAuthorizedError());

      const response = await erasurePost(
        postRequest({ action: 'confirm', confirmation: 'x', subject: 'user-2' }),
      );

      expect(response.status).toBe(404);
      const body = (await response.json()) as { error: string };
      expect(body.error).not.toMatch(/permission|forbidden/i);
    });

    it('tells the member nothing was changed when the erasure fails', async () => {
      vi.mocked(executeErasure).mockRejectedValue(new Error('deadlock'));

      const response = await erasurePost(
        postRequest({ action: 'confirm', confirmation: 'Ruth Calloway' }),
      );
      const body = (await response.json()) as { error: string };

      expect(response.status).toBe(500);
      expect(body.error).toContain('Nothing was changed');
      expect(body.error).not.toContain('deadlock');
    });
  });

  describe('DELETE cancel', () => {
    it('cancels the caller’s own pending request', async () => {
      vi.mocked(cancelErasure).mockResolvedValue({ cancelled: true });

      const request = new NextRequest('http://localhost/api/privacy/erasure', {
        method: 'DELETE',
        body: JSON.stringify({}),
      });
      const response = await erasureDelete(request);

      expect(response.status).toBe(200);
      expect((await response.json()).cancelled).toBe(true);
      expect(cancelErasure).toHaveBeenCalledWith('user-1', 'user-1');
    });

    it('accepts a request with no body at all', async () => {
      vi.mocked(cancelErasure).mockResolvedValue({ cancelled: false });
      const request = new NextRequest('http://localhost/api/privacy/erasure', {
        method: 'DELETE',
      });

      const response = await erasureDelete(request);
      expect(response.status).toBe(200);
      expect(cancelErasure).toHaveBeenCalledWith('user-1', 'user-1');
    });

    it('validates CSRF', async () => {
      vi.mocked(validateCSRF).mockReturnValue({ valid: false, reason: 'nope' });
      const request = new NextRequest('http://localhost/api/privacy/erasure', {
        method: 'DELETE',
        body: JSON.stringify({}),
      });

      expect((await erasureDelete(request)).status).toBe(403);
      expect(cancelErasure).not.toHaveBeenCalled();
    });
  });

  describe('GET status', () => {
    it('reports no pending request and states the retention basis', async () => {
      vi.mocked(getPendingErasure).mockResolvedValue(null);

      const response = await erasureGet(getRequest('http://localhost/api/privacy/erasure'));
      const body = (await response.json()) as { pending: boolean; retentionBasis: unknown[] };

      expect(body.pending).toBe(false);
      expect(body.retentionBasis.length).toBeGreaterThan(0);
    });

    it('reports a pending request so the UI can show the remaining window', async () => {
      const executesAt = new Date(Date.now() + 3 * 86400_000).toISOString();
      vi.mocked(getPendingErasure).mockResolvedValue({
        subjectUserId: 'user-1',
        subjectMemberId: null,
        requestedByUserId: 'user-1',
        requestedAt: new Date().toISOString(),
        executesAt,
        isSelfService: true,
      });

      const response = await erasureGet(getRequest('http://localhost/api/privacy/erasure'));
      const body = (await response.json()) as { pending: boolean; request: { executesAt: string } };

      expect(body.pending).toBe(true);
      expect(body.request.executesAt).toBe(executesAt);
    });
  });
});