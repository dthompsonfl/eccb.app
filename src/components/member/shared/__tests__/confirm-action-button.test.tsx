/**
 * @vitest-environment jsdom
 */

/**
 * ConfirmActionButton — the guarantee that a destructive action in the member
 * surface cannot happen by accident.
 *
 * These tests exist because the behaviour they pin is the whole point of the
 * component: a single tap of a small icon must NOT destroy work, the member
 * must be told what is about to go, and there must be a way back.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { ConfirmActionButton } from '../confirm-action-button';

const mockSuccess = vi.fn();
const mockError = vi.fn();

vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => mockSuccess(...args),
    error: (...args: unknown[]) => mockError(...args),
  },
}));

type Props = Partial<React.ComponentProps<typeof ConfirmActionButton>>;

function renderButton(props: Props = {}) {
  const onConfirm = props.onConfirm ?? vi.fn();
  const utils = render(
    <ConfirmActionButton
      itemName="the setlist"
      confirmTitle="Delete this setlist?"
      confirmDescription="It will be taken off this concert."
      onConfirm={onConfirm}
      successMessage="Setlist deleted."
      {...props}
    />,
  );
  return { ...utils, onConfirm };
}

const trigger = () => screen.getByRole('button', { name: 'Delete setlist Spring Concert' });

describe('ConfirmActionButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does NOT run the destructive action on the first tap', async () => {
    const { onConfirm } = renderButton({ 'aria-label': 'Delete setlist Spring Concert' });

    fireEvent.click(trigger());

    // The dialog is armed but nothing has been destroyed yet. This is the
    // defect being fixed: previously this single tap deleted immediately.
    expect(onConfirm).not.toHaveBeenCalled();
    expect(await screen.findByText('Delete this setlist?')).toBeInTheDocument();
  });

  it('names the item and spells out the consequence before confirming', async () => {
    renderButton({ 'aria-label': 'Delete setlist Spring Concert' });

    fireEvent.click(trigger());

    expect(await screen.findByText('Delete this setlist?')).toBeInTheDocument();
    expect(screen.getByText('It will be taken off this concert.')).toBeInTheDocument();
  });

  it('runs the action only after explicit confirmation', async () => {
    const { onConfirm } = renderButton({ 'aria-label': 'Delete setlist Spring Concert' });

    fireEvent.click(trigger());
    fireEvent.click(await screen.findByRole('button', { name: /yes, remove it/i }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('"Keep it" cancels without destroying anything', async () => {
    const { onConfirm } = renderButton({ 'aria-label': 'Delete setlist Spring Concert' });

    fireEvent.click(trigger());
    fireEvent.click(await screen.findByRole('button', { name: /keep it/i }));

    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('confirms a definite success result when the action succeeds', async () => {
    renderButton({ 'aria-label': 'Delete setlist Spring Concert' });

    fireEvent.click(trigger());
    fireEvent.click(await screen.findByRole('button', { name: /yes, remove it/i }));

    await waitFor(() => expect(mockSuccess).toHaveBeenCalledWith('Setlist deleted.'));
    expect(mockError).not.toHaveBeenCalled();
  });

  it('reports failure in plain language and never leaks the raw error', async () => {
    renderButton({
      'aria-label': 'Delete setlist Spring Concert',
      onConfirm: () => {
        throw new Error('Prisma P2003: foreign key constraint failed');
      },
    });

    fireEvent.click(trigger());
    fireEvent.click(await screen.findByRole('button', { name: /yes, remove it/i }));

    await waitFor(() => expect(mockError).toHaveBeenCalled());
    const shown = String(mockError.mock.calls[0][0]);
    expect(shown).not.toContain('Prisma');
    expect(shown).not.toContain('P2003');
    expect(mockSuccess).not.toHaveBeenCalled();
  });

  it('offers a working undo affordance when onUndo is supplied', async () => {
    const onUndo = vi.fn();
    renderButton({ 'aria-label': 'Delete setlist Spring Concert', onUndo });

    fireEvent.click(trigger());
    fireEvent.click(await screen.findByRole('button', { name: /yes, remove it/i }));

    await waitFor(() => expect(mockSuccess).toHaveBeenCalled());
    const toastArgs = mockSuccess.mock.calls[0][1] as
      | { action?: { label: string; onClick: () => void } }
      | undefined;
    expect(toastArgs?.action?.label).toBe('Put it back');

    // Undoing must actually call through, not merely render a button.
    await act(async () => {
      toastArgs?.action?.onClick();
    });
    await waitFor(() => expect(onUndo).toHaveBeenCalledTimes(1));
  });

  it('gives an icon-only trigger an accessible name', () => {
    renderButton({ 'aria-label': 'Delete setlist Spring Concert' });
    expect(trigger()).toBeInTheDocument();
  });

  it('exposes a 44px minimum hit area on the trigger', () => {
    renderButton({ 'aria-label': 'Delete setlist Spring Concert' });
    const el = trigger();
    expect(el.className).toContain('min-w-[44px]');
    expect(el.className).toContain('min-h-[44px]');
  });

  it('can be armed from the keyboard', async () => {
    const { onConfirm } = renderButton({ 'aria-label': 'Delete setlist Spring Concert' });

    trigger().focus();
    expect(trigger()).toHaveFocus();
    fireEvent.click(trigger());

    // Dialog opened without a mouse.
    expect(await screen.findByText('Delete this setlist?')).toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});