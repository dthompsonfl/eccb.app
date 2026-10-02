import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

/**
 * Login-screen tests for the two-factor challenge.
 *
 * Before this, `signIn.email`'s `twoFactorRedirect` flag was ignored entirely.
 * For a user with 2FA enabled the password check succeeded, no error was
 * raised, and no session existed — the user appeared to be "signed in
 * successfully" and then landed on an unauthenticated page. The challenge UI
 * is the missing half of the feature.
 */

const mockSignInEmail = vi.fn();
const mockVerifyTotp = vi.fn();
const mockVerifyBackupCode = vi.fn();
const mockPush = vi.fn();
const mockRefresh = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, refresh: mockRefresh }),
  useSearchParams: () => new URLSearchParams(''),
}));

vi.mock('@/lib/auth/client', () => ({
  authClient: {
    signIn: { email: (...args: unknown[]) => mockSignInEmail(...args) },
    twoFactor: {
      verifyTotp: (...args: unknown[]) => mockVerifyTotp(...args),
      verifyBackupCode: (...args: unknown[]) => mockVerifyBackupCode(...args),
    },
  },
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

// `input-otp` constructs a ResizeObserver with `new`. The shared test setup
// installs an arrow-function mock, which is not constructible, so provide a
// real (no-op) class for this file rather than changing the shared setup.
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = NoopResizeObserver as unknown as typeof ResizeObserver;

import { LoginForm } from '../login-form';

/** Drive the password step to completion. */
async function submitPassword() {
  fireEvent.change(screen.getByLabelText(/email address/i), {
    target: { value: 'member@test.com' },
  });
  fireEvent.change(screen.getByLabelText(/^password$/i), {
    target: { value: 'Passw0rd!xyz' },
  });
  fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));
  // Let the awaited auth call settle before assertions run.
  await waitFor(() => expect(mockSignInEmail).toHaveBeenCalled());
}

/**
 * Put a value into the segmented OTP input. `input-otp` renders a single
 * input, and changing it fires the component's onChange with the whole code —
 * exactly what a keyboard does.
 */
function enterCode(code: string) {
  fireEvent.change(screen.getByRole('textbox'), { target: { value: code } });
}

function clickVerify() {
  fireEvent.click(screen.getByRole('button', { name: /^verify$/i }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockVerifyTotp.mockResolvedValue({ data: {}, error: null });
  mockVerifyBackupCode.mockResolvedValue({ data: {}, error: null });
});

describe('LoginForm two-factor challenge', () => {
  it('offers a challenge when the server asks for a second factor', async () => {
    mockSignInEmail.mockResolvedValue({ data: { twoFactorRedirect: true }, error: null });
    render(<LoginForm />);

    await submitPassword();

    expect(await screen.findByText(/one more step to keep your account safe/i)).toBeTruthy();
    // Critically, we must NOT have navigated as if sign-in succeeded.
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('verifies the TOTP code before completing sign-in', async () => {
    mockSignInEmail.mockResolvedValue({ data: { twoFactorRedirect: true }, error: null });
    render(<LoginForm />);
    await submitPassword();
    await screen.findByText(/one more step to keep your account safe/i);

    enterCode('123456');
    clickVerify();

    await waitFor(() =>
      expect(mockVerifyTotp).toHaveBeenCalledWith(expect.objectContaining({ code: '123456' })),
    );
  });

  it('does not call the session-establishing verify until a code is entered', async () => {
    mockSignInEmail.mockResolvedValue({ data: { twoFactorRedirect: true }, error: null });
    render(<LoginForm />);
    await submitPassword();
    await screen.findByText(/one more step to keep your account safe/i);

    clickVerify();

    expect(mockVerifyTotp).not.toHaveBeenCalled();
  });

  it('can fall back to a backup code', async () => {
    mockSignInEmail.mockResolvedValue({ data: { twoFactorRedirect: true }, error: null });
    render(<LoginForm />);
    await submitPassword();
    await screen.findByText(/one more step to keep your account safe/i);

    fireEvent.click(screen.getByRole('button', { name: /use a spare code instead/i }));
    fireEvent.change(await screen.findByLabelText(/spare code/i), {
      target: { value: 'ABCDE-FGHIJ' },
    });
    clickVerify();

    await waitFor(() =>
      expect(mockVerifyBackupCode).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'ABCDE-FGHIJ' }),
      ),
    );
    expect(mockVerifyTotp).not.toHaveBeenCalled();
  });

  it('forwards the trust-device choice to the framework', async () => {
    mockSignInEmail.mockResolvedValue({ data: { twoFactorRedirect: true }, error: null });
    render(<LoginForm />);
    await submitPassword();
    await screen.findByText(/one more step to keep your account safe/i);

    fireEvent.click(screen.getByLabelText(/don't ask me for this code again/i));
    enterCode('123456');
    clickVerify();

    await waitFor(() =>
      expect(mockVerifyTotp).toHaveBeenCalledWith(expect.objectContaining({ trustDevice: true })),
    );
  });

  it('stays on the challenge when the code is rejected', async () => {
    mockSignInEmail.mockResolvedValue({ data: { twoFactorRedirect: true }, error: null });
    mockVerifyTotp.mockResolvedValue({ data: null, error: { message: 'Invalid code' } });
    render(<LoginForm />);
    await submitPassword();
    await screen.findByText(/one more step to keep your account safe/i);

    enterCode('000000');
    clickVerify();

    // Must not navigate on a rejected code.
    await waitFor(() => expect(mockVerifyTotp).toHaveBeenCalled());
    expect(screen.getByText(/one more step to keep your account safe/i)).toBeTruthy();
  });

  it('lets the user back out of the challenge', async () => {
    mockSignInEmail.mockResolvedValue({ data: { twoFactorRedirect: true }, error: null });
    render(<LoginForm />);
    await submitPassword();
    await screen.findByText(/one more step to keep your account safe/i);

    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));

    expect(await screen.findByLabelText(/email address/i)).toBeTruthy();
    expect(screen.queryByText(/one more step to keep your account safe/i)).toBeNull();
  });

  it('signs in normally when no second factor is required', async () => {
    mockSignInEmail.mockResolvedValue({ data: { redirect: false, token: 'x' }, error: null });
    render(<LoginForm />);

    await submitPassword();

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/'));
    expect(screen.queryByText(/one more step to keep your account safe/i)).toBeNull();
  });

  it('surfaces a plain sign-in error without showing a challenge', async () => {
    mockSignInEmail.mockResolvedValue({
      data: null,
      error: { message: 'Invalid email or password' },
    });
    render(<LoginForm />);

    await submitPassword();

    expect(screen.queryByText(/one more step to keep your account safe/i)).toBeNull();
    expect(mockPush).not.toHaveBeenCalled();
  });
});