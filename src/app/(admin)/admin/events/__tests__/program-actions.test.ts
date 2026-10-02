import { describe, it, expect, beforeEach, vi } from 'vitest';
import { reorderEventProgram } from '../program-actions';
import { prisma } from '@/lib/db';
import { requirePermission } from '@/lib/auth/guards';
import { EVENT_EDIT } from '@/lib/auth/permission-constants';
import { sortProgramItems } from '@/lib/events/program';

vi.mock('@/lib/db', () => ({
  prisma: {
    eventMusic: {
      findMany: vi.fn(),
      update: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock('@/lib/auth/guards', () => ({
  requirePermission: vi.fn(),
}));

vi.mock('@/lib/services/audit', () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

const EVENT_ID = 'event-1';

function fakeRows(ids: string[]) {
  return ids.map((id, index) => ({ id, sortOrder: index }));
}

describe('reorderEventProgram', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (requirePermission as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { id: 'admin-1' },
    });
    (prisma.eventMusic.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    // Prisma's query builders are thenables; echoing the args lets the
    // transaction assertion inspect exactly what would be written.
    (prisma.eventMusic.update as ReturnType<typeof vi.fn>).mockImplementation(
      (args: unknown) => args
    );
  });

  it('persists contiguous sortOrder values in the submitted order', async () => {
    const ids = ['em-c', 'em-a', 'em-b'];
    (prisma.eventMusic.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(fakeRows(ids));

    const result = await reorderEventProgram(EVENT_ID, ids);

    expect(result.success).toBe(true);
    expect(result.order).toEqual(ids);

    const updates = (prisma.eventMusic.update as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => (call[0] as { where: { id: string }; data: { sortOrder: number } })
    );
    expect(updates).toEqual([
      { where: { id: 'em-c' }, data: { sortOrder: 0 } },
      { where: { id: 'em-a' }, data: { sortOrder: 1 } },
      { where: { id: 'em-b' }, data: { sortOrder: 2 } },
    ]);
  });

  it('writes inside a single transaction so a reload cannot see a half-applied order', async () => {
    const ids = ['em-a', 'em-b'];
    (prisma.eventMusic.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(fakeRows(ids));

    await reorderEventProgram(EVENT_ID, ids);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).toHaveBeenCalledWith([
      { where: { id: 'em-a' }, data: { sortOrder: 0 } },
      { where: { id: 'em-b' }, data: { sortOrder: 1 } },
    ]);
  });

  it('round-trips: the sortOrder values written read back in the requested order', async () => {
    // Simulate the database: apply the writes the action issued, then re-read
    // and sort with the same rule the program renderer uses.
    const store = new Map<string, number>([
      ['em-a', 2],
      ['em-b', 0],
      ['em-c', 1],
    ]);
    (prisma.eventMusic.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(
      [...store.keys()].map((id) => ({ id, sortOrder: store.get(id) ?? 0 }))
    );
    (prisma.eventMusic.update as ReturnType<typeof vi.fn>).mockImplementation(
      (args: { where: { id: string }; data: { sortOrder: number } }) => {
        store.set(args.where.id, args.data.sortOrder);
        return args;
      }
    );

    const requested = ['em-c', 'em-a', 'em-b'];
    const result = await reorderEventProgram(EVENT_ID, requested);
    expect(result.success).toBe(true);

    const readBack = sortProgramItems(
      [...store.entries()].map(([id, sortOrder]) => ({
        id,
        sortOrder,
        pieceId: id,
        title: id,
        subtitle: null,
        composer: null,
        arranger: null,
        duration: null,
        notes: null,
        performers: [],
      }))
    );
    expect(readBack.map((i) => i.id)).toEqual(requested);
  });

  it('refuses an id belonging to another event and writes nothing', async () => {
    (prisma.eventMusic.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'em-a', sortOrder: 0 },
    ]);

    const result = await reorderEventProgram(EVENT_ID, ['em-a', 'em-from-another-event']);

    expect(result.success).toBe(false);
    expect(result.error).toBe('One or more pieces do not belong to this event');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.eventMusic.update).not.toHaveBeenCalled();
  });

  it('rejects an empty order and duplicate ids', async () => {
    const empty = await reorderEventProgram(EVENT_ID, []);
    expect(empty.success).toBe(false);

    (prisma.eventMusic.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'em-a', sortOrder: 0 },
    ]);
    const dupes = await reorderEventProgram(EVENT_ID, ['em-a', 'em-a']);
    expect(dupes.success).toBe(false);
    expect(dupes.error).toBe('Duplicate pieces in order');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('scopes the ownership check to the event', async () => {
    (prisma.eventMusic.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'em-a', sortOrder: 0 },
    ]);

    await reorderEventProgram('event-42', ['em-a']);

    expect(prisma.eventMusic.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ eventId: 'event-42' }) })
    );
  });

  it('a non-admin cannot reorder: the guard rejects before any write', async () => {
    const forbidden = new Error('NEXT_REDIRECT');
    (requirePermission as ReturnType<typeof vi.fn>).mockRejectedValue(forbidden);

    await expect(reorderEventProgram(EVENT_ID, ['em-a', 'em-b'])).rejects.toThrow('NEXT_REDIRECT');

    expect(requirePermission).toHaveBeenCalledWith(EVENT_EDIT);
    expect(prisma.eventMusic.findMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.eventMusic.update).not.toHaveBeenCalled();
  });
});
