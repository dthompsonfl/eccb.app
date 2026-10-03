/**
 * @vitest-environment jsdom
 */
/**
 * Regression tests for the assign-music dialog crash.
 *
 * ROOT CAUSE: the component's `Member` interface declared `user`,
 * `primaryInstrument` and `section`, but GET /api/members returns `user` (which
 * is NULL for members with no linked login), `instruments[]` and `sections[]`.
 * Reading `member.user.name` therefore threw a TypeError on first render, on the
 * music-assignment path.
 *
 * These tests feed the dialog the ROUTE'S REAL RESPONSE SHAPE so a future shape
 * drift fails here rather than in the browser.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { AssignMusicDialog } from '../assign-music-dialog';

// Radix Dialog renders in a portal and needs these; jsdom provides neither.
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

/** Exactly the JSON shape GET /api/members returns for an ACTIVE member. */
function routeMember(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'member-1',
    firstName: 'Maria',
    lastName: 'Delgado',
    email: 'maria@example.org',
    phone: null,
    profilePhoto: null,
    status: 'ACTIVE',
    joinDate: '2024-01-05T00:00:00.000Z',
    leaveDate: null,
    emergencyName: null,
    emergencyPhone: null,
    emergencyEmail: null,
    notes: null,
    createdAt: '2024-01-05T00:00:00.000Z',
    updatedAt: '2024-01-05T00:00:00.000Z',
    deletedAt: null,
    isSubstitute: false,
    userId: 'user-1',
    user: { id: 'user-1', name: 'Maria Delgado', email: 'maria@example.org', image: null },
    instruments: [
      {
        id: 'mi-1',
        memberId: 'member-1',
        instrumentId: 'inst-oboe',
        isPrimary: true,
        instrument: { id: 'inst-oboe', name: 'Oboe', family: 'Woodwind' },
      },
    ],
    sections: [
      {
        id: 'ms-1',
        memberId: 'member-1',
        sectionId: 'sec-woodwinds',
        isLeader: false,
        section: { id: 'sec-woodwinds', name: 'Woodwinds' },
      },
    ],
    ...overrides,
  };
}

function mockMembersResponse(members: Array<Record<string, unknown>>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ members, total: members.length, page: 1, totalPages: 1 }),
    })
  );
}

function renderDialog(existingMemberIds: string[] = []): void {
  render(
    <AssignMusicDialog
      pieceId="piece-1"
      existingMemberIds={existingMemberIds}
      open
      onOpenChange={vi.fn()}
    />
  );
}

describe('AssignMusicDialog — route response shape', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders without throwing and shows the member name from a linked user', async () => {
    mockMembersResponse([routeMember()]);

    expect(() => renderDialog()).not.toThrow();

    await waitFor(() => {
      expect(screen.getByText('Maria Delgado')).toBeInTheDocument();
    });
    expect(screen.getByText('Oboe • Woodwinds')).toBeInTheDocument();
  });

  it('renders a member with NO linked user account instead of throwing', async () => {
    // userId/user are null for a member who has never logged in.
    mockMembersResponse([
      routeMember({
        id: 'member-2',
        userId: null,
        user: null,
        email: null,
        firstName: 'Ruth',
        lastName: 'Okafor',
        instruments: [],
        sections: [],
      }),
    ]);

    expect(() => renderDialog()).not.toThrow();

    await waitFor(() => {
      expect(screen.getByText('Ruth Okafor')).toBeInTheDocument();
    });
    expect(screen.getByText('No instrument • No section')).toBeInTheDocument();
  });

  it('prefers the primary instrument when a member plays several', async () => {
    mockMembersResponse([
      routeMember({
        instruments: [
          {
            id: 'mi-2',
            memberId: 'member-1',
            instrumentId: 'inst-piccolo',
            isPrimary: false,
            instrument: { id: 'inst-piccolo', name: 'Piccolo', family: 'Woodwind' },
          },
          {
            id: 'mi-3',
            memberId: 'member-1',
            instrumentId: 'inst-oboe',
            isPrimary: true,
            instrument: { id: 'inst-oboe', name: 'Oboe', family: 'Woodwind' },
          },
        ],
      }),
    ]);

    renderDialog();

    await waitFor(() => {
      expect(screen.getByText('Oboe • Woodwinds')).toBeInTheDocument();
    });
    expect(screen.queryByText('Piccolo • Woodwinds')).not.toBeInTheDocument();
  });

  it('falls back to the first listed instrument when none is flagged primary', async () => {
    mockMembersResponse([
      routeMember({
        instruments: [
          {
            id: 'mi-4',
            memberId: 'member-1',
            instrumentId: 'inst-flute',
            isPrimary: false,
            instrument: { id: 'inst-flute', name: 'Flute', family: 'Woodwind' },
          },
        ],
      }),
    ]);

    renderDialog();

    await waitFor(() => {
      expect(screen.getByText('Flute • Woodwinds')).toBeInTheDocument();
    });
  });

  it('excludes already-assigned members and does not throw on a mixed roster', async () => {
    mockMembersResponse([routeMember(), routeMember({ id: 'member-9', user: null, userId: null })]);

    renderDialog(['member-9']);

    await waitFor(() => {
      expect(screen.getByText('Maria Delgado')).toBeInTheDocument();
    });
    expect(screen.queryByText('Unnamed member')).not.toBeInTheDocument();
  });

  it('renders an empty state rather than throwing when the route returns no members', async () => {
    mockMembersResponse([]);

    expect(() => renderDialog()).not.toThrow();

    await waitFor(() => {
      expect(screen.getByText('All members are already assigned')).toBeInTheDocument();
    });
  });

  it('searches across name, email, instrument and section without throwing', async () => {
    mockMembersResponse([
      routeMember(),
      routeMember({
        id: 'member-3',
        firstName: 'Theo',
        lastName: 'Bankole',
        user: { id: 'user-3', name: 'Theo Bankole', email: 'theo@example.org', image: null },
        instruments: [
          {
            id: 'mi-5',
            memberId: 'member-3',
            instrumentId: 'inst-bassoon',
            isPrimary: true,
            instrument: { id: 'inst-bassoon', name: 'Bassoon', family: 'Woodwind' },
          },
        ],
        sections: [],
      }),
    ]);

    renderDialog();

    await waitFor(() => {
      expect(screen.getByText('Maria Delgado')).toBeInTheDocument();
    });

    const search = screen.getByPlaceholderText('Search members...');
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.change(search, { target: { value: 'bassoon' } });

    await waitFor(() => {
      expect(screen.queryByText('Maria Delgado')).not.toBeInTheDocument();
    });
    expect(screen.getByText('Theo Bankole')).toBeInTheDocument();
  });
});
