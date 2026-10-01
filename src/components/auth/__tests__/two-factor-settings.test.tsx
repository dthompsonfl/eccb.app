import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

/**
 * Two-factor enrolment tests.
 *
 * The plugin was configured but had no UI at all: `find src/app src/components
 * -ipath '*two*factor*'` returned nothing. There was also a dead toggle in the
 * member settings form that called `disable({ password: '' })` — a literal
 * empty password, which the framework rejects — and whose "enable" branch only
 * set a state flag no dialog was bound to.
 *
 * These tests pin the properties that make enrolment safe rather than merely
 * present: two-step enrolment, so an abandoned setup cannot lock anyone out,
 * and password-gated removal.
 */

const mockEnable = vi.fn();
const mockVerifyTotp = vi.fn();
const mockDisable = vi.fn();
const mockRefresh = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

vi.mock('@/lib/auth/client', () => ({
  authClient: {
    twoFactor: {
      enable: (...args: unknown[]) => mockEnable(...args),
      verifyTotp: (...args: unknown[]) => mockVerifyTotp(...args),
      disable: (...args: unknown[]) => mockDisable(...args),
    },
  },
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

// input-otp needs a constructible ResizeObserver; see login-form test.
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = NoopResizeObserver as unknown as typeof ResizeObserver;

import { TwoFactorSettings } from '../two-factor-settings';

const TOTP_URI =
  'otpauth://totp/ECC:member%40test.com?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=ECC';

beforeEach(() => {
  vi.clearAllMocks();
  mockEnable.mockResolvedValue({
    data: { totpURI: TOTP_URI, backupCodes: ['AAAAA-BBBBB', 'CCCCC-DDDDD'] },
    error: null,
  });
  mockVerifyTotp.mockResolvedValue({ data: {}, error: null });
  mockDisable.mockResolvedValue({ data: {}, error: null });
});

async function beginEnrollment() {
  fireEvent.click(screen.getByRole('switch'));
  await screen.findByLabelText(/^password$/i);
  fireEvent.change(screen.getByLabelText(/^password$/i), {
    target: { value: 'Passw0rd!xyz' },
  });
  fireEvent.click(screen.getByRole('button', { name: /continue/i }));
  await waitFor(() => expect(mockEnable).toHaveBeenCalled());
}

describe('TwoFactorSettings', () => {
  /** Radix renders the switch as a button exposing `aria-checked`. */
  const switchState = () => screen.getByRole('switch').getAttribute('aria-checked');

  it('reflects the current enrolment state when disabled', () => {
    render(<TwoFactorSettings enabled={false} />);
    expect(switchState()).toBe('false');
    expect(screen.getByText(/not enabled/i)).toBeTruthy();
  });

  it('reflects the current enrolment state when enabled', () => {
    render(<TwoFactorSettings enabled />);
    expect(switchState()).toBe('true');
  });

  it('requires a password before contacting the framework', async () => {
    render(<TwoFactorSettings enabled={false} />);

    fireEvent.click(screen.getByRole('switch'));
    await screen.findByLabelText(/^password$/i);
    // Continue stays disabled with no password, so no request is made.
    expect(screen.getByRole('button', { name: /continue/i })).toHaveAttribute('disabled');
    expect(mockEnable).not.toHaveBeenCalled();
  });

  it('does not mark 2FA enabled until the user proves the authenticator works', async () => {
    // This is the lockout guard: `enable` alone only stages the secret.
    render(<TwoFactorSettings enabled={false} />);
    await beginEnrollment();

    await screen.findByRole('textbox');
    expect(switchState()).toBe('false');
    expect(mockVerifyTotp).not.toHaveBeenCalled();
  });

  it('shows the setup key and backup codes exactly once, during enrolment', async () => {
    render(<TwoFactorSettings enabled={false} />);
    await beginEnrollment();

    // The setup key is what a user types into an app with manual entry.
    expect(await screen.findByText(/JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP/)).toBeTruthy();
    expect(screen.getByText('AAAAA-BBBBB')).toBeTruthy();
    expect(screen.getByText(/only now/i)).toBeTruthy();
  });

  it('never renders the raw otpauth URI into an attribute a third party could read', async () => {
    const { container } = render(<TwoFactorSettings enabled={false} />);
    await beginEnrollment();

    // No QR-service URL: sending the TOTP secret to an external renderer would
    // leak the credential to a third party.
    expect(container.innerHTML).not.toMatch(/api\.qrserver\.com|https?:\/\/[^"']*qrcode/i);
    expect(container.innerHTML).not.toMatch(/src=["']http/i);
  });

  it('enables 2FA only after a valid code', async () => {
    render(<TwoFactorSettings enabled={false} />);
    await beginEnrollment();
    await screen.findByRole('textbox');

    fireEvent.change(screen.getByRole('textbox'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: /verify and enable/i }));

    await waitFor(() =>
      expect(mockVerifyTotp).toHaveBeenCalledWith({ code: '123456' }),
    );
    expect(switchState()).toBe('true');
    expect(mockRefresh).toHaveBeenCalled();
  });

  it('does not enable 2FA when the code is rejected', async () => {
    mockVerifyTotp.mockResolvedValue({ data: null, error: { message: 'Invalid code' } });
    render(<TwoFactorSettings enabled={false} />);
    await beginEnrollment();
    await screen.findByRole('textbox');

    fireEvent.change(screen.getByRole('textbox'), { target: { value: '000000' } });
    fireEvent.click(screen.getByRole('button', { name: /verify and enable/i }));

    await waitFor(() => expect(mockVerifyTotp).toHaveBeenCalled());
    expect(switchState()).toBe('false');
  });

  it('lets the user abandon setup without changing state', async () => {
    render(<TwoFactorSettings enabled={false} />);
    await beginEnrollment();
    await screen.findByRole('textbox');

    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));

    await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
    expect(switchState()).toBe('false');
    expect(mockVerifyTotp).not.toHaveBeenCalled();
  });

  it('requires a password to disable, and never sends an empty one', async () => {
    render(<TwoFactorSettings enabled />);

    // Turning the switch off.
    fireEvent.click(screen.getByRole('switch'));
    await screen.findByLabelText(/^password$/i);
    expect(screen.getByRole('button', { name: /turn off/i })).toHaveAttribute('disabled');
    expect(mockDisable).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/^password$/i), {
      target: { value: 'Passw0rd!xyz' },
    });
    fireEvent.click(screen.getByRole('button', { name: /turn off/i }));

    await waitFor(() =>
      expect(mockDisable).toHaveBeenCalledWith({ password: 'Passw0rd!xyz' }),
    );
    // The regression this replaces: disable({ password: '' }).
    expect(mockDisable).not.toHaveBeenCalledWith({ password: '' });
  });
});