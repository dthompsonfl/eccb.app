/**
 * UI tests for the "Your information" panel.
 *
 * The behaviours asserted here are the ones that keep an elderly member from
 * destroying their data by accident:
 *   - nothing irreversible on a single press,
 *   - "I've changed my mind" is present and actually works,
 *   - errors are real adjacent text, not colour alone (WCAG 1.4.1),
 *   - status changes are announced (aria-live),
 *   - the retention basis is shown BEFORE any deletion is offered.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, render, screen, waitFor, fireEvent } from '@testing-library/react';
import { PrivacySettings } from '../privacy-settings';

const jsonFetch = vi.fn();
const postFetch = vi.fn();
const deleteFetch = vi.fn();

function mockFetch(url: string, init?: RequestInit): Promise<Response> {
  if (init?.method === 'POST') return postFetch(url, init);
  if (init?.method === 'DELETE') return deleteFetch(url, init);
  return jsonFetch(url, init);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn(mockFetch));

  // Default: no pending request.
  jsonFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      pending: false,
      request: null,
      retentionBasis: [
        {
          record: 'Whether you played at each rehearsal',
          basis: 'So the band can plan next season. Your name is removed.',
        },
      ],
    }),
    blob: async () => new Blob(['{}'], { type: 'application/json' }),
    headers: new Headers({ 'Content-Disposition': 'attachment; filename="my-info.json"' }),
  });
});

const RENDER = () => render(<PrivacySettings memberName="Ruth Calloway" />);

/** The repo does not depend on `@testing-library/user-event`, so clicks and
 *  typing go through `fireEvent` wrapped in `act` — without it, the state
 *  updates these handlers trigger land outside React's batching and the
 *  assertions race the render. */
async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(element);
  });
}

async function type(element: HTMLElement, text: string): Promise<void> {
  await act(async () => {
    fireEvent.change(element, { target: { value: text } });
  });
}

describe('PrivacySettings', () => {
  describe('plain language', () => {
    it('never shows the member a raw field name or a cuid', async () => {
      RENDER();
      await waitFor(() =>
        expect(screen.getByRole('button', { name: /^Download my information$/ })).toBeEnabled(),
      );

      const text = document.body.textContent ?? '';
      expect(text).not.toMatch(/[a-z0-9]{25}\b/); // a cuid
      expect(text).not.toMatch(/userId|memberId|pushConsentedAt/i);
      expect(text).not.toMatch(/Art\.\s*\d+/); // no legalese article citations
    });

    it('states what is kept, and why, before offering any deletion', async () => {
      RENDER();
      await waitFor(() => expect(screen.getByText(/What we would keep, and why/)).toBeInTheDocument());
      expect(screen.getByText(/Whether you played at each rehearsal/)).toBeInTheDocument();
    });
  });

  describe('download', () => {
    it('offers a plain "Download my information" button', async () => {
      RENDER();
      await waitFor(() =>
        expect(screen.getByRole('button', { name: /^Download my information$/ })).toBeEnabled(),
      );
      // A spreadsheet option for members who live in Excel.
      expect(screen.getByRole('button', { name: /spreadsheet/i })).toBeEnabled();
    });

    it('explains that passwords are never included', async () => {
      RENDER();
      expect(
        await screen.findByText(/password and your security codes are never included/i),
      ).toBeInTheDocument();
    });

    it('shows a readable error, not just a red border, when the download fails', async () => {
      jsonFetch.mockResolvedValue({ ok: false, status: 500, statusText: 'err' });
      RENDER();

      await click(await screen.findByRole('button', { name: /^Download my information$/ }));

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(/could not prepare your file/i);
      // Not colour-only: the message is real text in the accessibility tree.
      expect(alert.textContent?.length ?? 0).toBeGreaterThan(20);
    });

    it('explains a rate limit in plain terms', async () => {
      jsonFetch.mockResolvedValue({ ok: false, status: 429, statusText: 'too many' });
      RENDER();

      await click(await screen.findByRole('button', { name: /^Download my information$/ }));
      expect(await screen.findByRole('alert')).toHaveTextContent(/wait an hour/i);
    });
  });

  describe('erasure safety', () => {
    it('does not delete anything on the first press', async () => {
      RENDER();

      await click(await screen.findByRole('button', { name: /^Ask us to delete my information$/ }));

      // A request, not an execution.
      await waitFor(() => expect(postFetch).toHaveBeenCalled());
      const [, init] = postFetch.mock.calls[0];
      expect(JSON.parse(init.body as string)).toEqual({ action: 'request' });
      expect(deleteFetch).not.toHaveBeenCalled();
    });

    it('says plainly that nothing has been deleted yet, and for how long', async () => {
      postFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          request: {
            requestedAt: new Date().toISOString(),
            executesAt: new Date(Date.now() + 5 * 86400_000).toISOString(),
          },
          retentionBasis: [],
        }),
      });

      RENDER();
      await click(await screen.findByRole('button', { name: /^Ask us to delete my information$/ }));

      expect(await screen.findByText(/Nothing has been deleted yet/i)).toBeInTheDocument();
      expect(screen.getByText(/in about 5 days/i)).toBeInTheDocument();
    });

    it('gives "I have changed my mind" a button and it cancels', async () => {
      deleteFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ cancelled: true }) });

      postFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          request: { requestedAt: new Date().toISOString(), executesAt: new Date(Date.now() + 86400_000).toISOString() },
          retentionBasis: [],
        }),
      });

      RENDER();
      await click(await screen.findByRole('button', { name: /^Ask us to delete my information$/ }));

      const undo = await screen.findByRole('button', { name: /changed my mind/i });
      expect(undo).toBeEnabled();
      await click(undo);

      await waitFor(() => expect(deleteFetch).toHaveBeenCalled());
      expect(await screen.findByText(/nothing was deleted/i)).toBeInTheDocument();
    });

    it('requires the name to be typed before it will proceed', async () => {
      postFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          request: { requestedAt: new Date().toISOString(), executesAt: new Date(Date.now() + 86400_000).toISOString() },
          retentionBasis: [],
        }),
      });

      RENDER();
      await click(await screen.findByRole('button', { name: /^Ask us to delete my information$/ }));

      const confirm = await screen.findByRole('button', { name: /^Yes, delete my information now$/ });
      await click(confirm);

      // No confirm POST: the empty phrase is refused client-side, with an error
      // attached to the field via aria-describedby.
      expect(await screen.findByText(/type your name in the box/i)).toBeInTheDocument();
      expect(document.getElementById('erasure-confirmation')).toHaveAttribute(
        'aria-describedby',
        expect.stringContaining('erasure-confirmation-error'),
      );
    });

    it('labels the confirmation field and points at the expected name', async () => {
      postFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          request: { requestedAt: new Date().toISOString(), executesAt: new Date(Date.now() + 86400_000).toISOString() },
          retentionBasis: [],
        }),
      });

      RENDER();
      await click(await screen.findByRole('button', { name: /^Ask us to delete my information$/ }));
      await screen.findByRole('button', { name: /^Yes, delete my information now$/ });

      const input = screen.getByLabelText(/Type your name to confirm/i);
      expect(input).toHaveAttribute('placeholder', 'Ruth Calloway');
    });

    it('tells the member nothing changed when the erasure fails', async () => {
      postFetch
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            request: { requestedAt: new Date().toISOString(), executesAt: new Date(Date.now() + 86400_000).toISOString() },
            retentionBasis: [],
          }),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          json: async () => ({ error: 'Something went wrong. Nothing was changed.' }),
        });

      RENDER();
      await click(await screen.findByRole('button', { name: /^Ask us to delete my information$/ }));

      const input = await screen.findByLabelText(/Type your name to confirm/i);
      await type(input, 'Ruth Calloway');
      await click(screen.getByRole('button', { name: /^Yes, delete my information now$/ }));

      expect(await screen.findByText(/Nothing was changed/i)).toBeInTheDocument();
      // Still offerable afterwards — a failed attempt must not dead-end.
      expect(screen.getByRole('button', { name: /^Yes, delete my information now$/ })).toBeEnabled();
    });
  });

  describe('accessibility', () => {
    it('announces errors assertively and exactly once, never duplicated', async () => {
      RENDER();

      // Idle: nothing is announced, because nothing has been announced yet.
      expect(screen.queryByRole('status')).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();

      // One failure produces exactly ONE alert — a screen reader must not read
      // the same sentence twice because it was mirrored into an sr-only region.
      postFetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
      await click(screen.getByRole('button', { name: /^Ask us to delete my information$/ }));

      const alerts = await screen.findAllByRole('alert');
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toHaveAttribute('aria-live', 'assertive');
    });

    it('uses controls large enough to hit for a shaky hand', async () => {
      RENDER();
      for (const button of screen.getAllByRole('button')) {
        expect(button.className).toContain('min-h-11');
      }
    });

    it('hides decorative icons from assistive technology', async () => {
      const { container } = RENDER();
      const decorative = container.querySelectorAll('svg[aria-hidden="true"]');
      expect(decorative.length).toBeGreaterThan(0);
    });
  });
});