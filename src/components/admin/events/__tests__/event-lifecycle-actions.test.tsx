import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { EventLifecycleActions } from '@/components/admin/events/event-lifecycle-actions';

// vi.hoisted: vi.mock factories are hoisted above these declarations, so the
// mock functions must be created in the same hoisted pass to be referenceable.
const { mockUpdateEventStatus, mockDeleteEvent, mockPush, mockRefresh } = vi.hoisted(
  () => ({
    mockUpdateEventStatus: vi.fn(),
    mockDeleteEvent: vi.fn(),
    mockPush: vi.fn(),
    mockRefresh: vi.fn(),
  }),
);

vi.mock('@/app/(admin)/admin/events/actions', () => ({
  updateEventStatus: mockUpdateEventStatus,
  deleteEvent: mockDeleteEvent,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, refresh: mockRefresh }),
}));

const BASE = {
  eventId: 'event-1',
  eventTitle: 'Spring Concert',
  hasHistory: false,
};

describe('EventLifecycleActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateEventStatus.mockResolvedValue({ success: true });
    mockDeleteEvent.mockResolvedValue({ success: true });
  });

  it('offers cancel when the event is live, and reinstate when it is cancelled', () => {
    const { rerender } = render(<EventLifecycleActions {...BASE} isCancelled={false} />);
    expect(screen.getByRole('button', { name: /cancel event/i })).toBeTruthy();

    rerender(<EventLifecycleActions {...BASE} isCancelled={true} />);
    expect(screen.getByRole('button', { name: /back on schedule/i })).toBeTruthy();
  });

  it('marks the event cancelled through the existing updateEventStatus action', async () => {
    render(<EventLifecycleActions {...BASE} isCancelled={false} />);

    await fireEvent.click(screen.getByRole('button', { name: /cancel event/i }));

    await waitFor(() => {
      expect(mockUpdateEventStatus).toHaveBeenCalledWith('event-1', 'CANCELLED');
    });
    expect(mockRefresh).toHaveBeenCalled();
  });

  it('reinstates a cancelled event', async () => {
    render(<EventLifecycleActions {...BASE} isCancelled />);

    await fireEvent.click(screen.getByRole('button', { name: /back on schedule/i }));

    await waitFor(() => {
      expect(mockUpdateEventStatus).toHaveBeenCalledWith('event-1', 'SCHEDULED');
    });
  });

  it('warns that deleting an event with history destroys that history', async () => {
    render(<EventLifecycleActions {...BASE} isCancelled={false} hasHistory />);

    await fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toMatch(/attendance or programme content/i);
    // The safer alternative must be named, not implied.
    expect(dialog.textContent).toMatch(/Cancelling the event instead keeps the history/i);
  });

  it('does not claim there is history when there is none', async () => {
    render(<EventLifecycleActions {...BASE} isCancelled={false} hasHistory={false} />);

    await fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).not.toMatch(/attendance or programme content/i);
  });

  it('navigates back to the event list after a successful delete', async () => {
    render(<EventLifecycleActions {...BASE} isCancelled={false} />);

    await fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    const confirm = await screen.findByRole('button', {
      name: /delete permanently/i,
    });
    await fireEvent.click(confirm);

    await waitFor(() => {
      expect(mockDeleteEvent).toHaveBeenCalledWith('event-1');
    });
    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/admin/events');
    });
  });
});