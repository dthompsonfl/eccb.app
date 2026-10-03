import { describe, it, expect, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import {
  dedupeAttendanceRecords,
  replaceEventAttendance,
  type BulkAttendanceInput,
} from '@/lib/attendance/bulk-write';

function makeTx(staleCount = 0) {
  const upserts: unknown[] = [];
  const deletes: unknown[] = [];
  const tx = {
    attendance: {
      deleteMany: vi.fn(async () => {
        deletes.push('deleteMany');
        return { count: staleCount };
      }),
      upsert: vi.fn(async (args: unknown) => {
        upserts.push(args);
        return {};
      }),
    },
  } as unknown as Prisma.TransactionClient;
  return { tx, upserts, deletes };
}

const M1 = 'member-1';
const M2 = 'member-2';

describe('dedupeAttendanceRecords', () => {
  it('leaves a duplicate-free payload untouched', () => {
    const records: BulkAttendanceInput[] = [
      { memberId: M1, status: 'PRESENT' },
      { memberId: M2, status: 'ABSENT' },
    ];
    expect(dedupeAttendanceRecords(records)).toEqual(records);
  });

  it('folds duplicates with last-write-wins', () => {
    // This is the idempotency case: Attendance is @@unique([eventId, memberId]),
    // so a payload naming the same member twice used to fail the unique
    // constraint AFTER the deleteMany had already run.
    const result = dedupeAttendanceRecords([
      { memberId: M1, status: 'ABSENT', notes: 'first' },
      { memberId: M1, status: 'PRESENT', notes: 'second' },
    ]);
    expect(result).toEqual([{ memberId: M1, status: 'PRESENT', notes: 'second' }]);
  });

  it('handles an empty payload', () => {
    expect(dedupeAttendanceRecords([])).toEqual([]);
  });
});

describe('replaceEventAttendance', () => {
  it('upserts rather than deletes, so a member keeps their row', async () => {
    const { tx, upserts } = makeTx();
    await replaceEventAttendance(tx, 'event-1', [{ memberId: M1, status: 'PRESENT' }], 'admin-1');

    expect(upserts).toHaveLength(1);
    const call = upserts[0] as {
      where: unknown;
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    expect(call.where).toEqual({ eventId_memberId: { eventId: 'event-1', memberId: M1 } });
    expect(call.create.status).toBe('PRESENT');
    expect(call.update.status).toBe('PRESENT');
    expect(call.update.markedBy).toBe('admin-1');
  });

  it('deletes only members absent from the payload', async () => {
    const { tx } = makeTx(2);
    await replaceEventAttendance(tx, 'event-1', [{ memberId: M1, status: 'PRESENT' }], 'admin-1');

    const deleteMany = (tx.attendance.deleteMany as unknown as ReturnType<typeof vi.fn>);
    expect(deleteMany).toHaveBeenCalledWith({
      where: { eventId: 'event-1', memberId: { notIn: [M1] } },
    });
  });

  it('is idempotent: the same payload twice converges on the same rows', async () => {
    const records: BulkAttendanceInput[] = [
      { memberId: M1, status: 'PRESENT' },
      { memberId: M2, status: 'LATE' },
    ];

    const first = makeTx();
    const firstResult = await replaceEventAttendance(first.tx, 'event-1', records, 'admin-1');

    const second = makeTx();
    const secondResult = await replaceEventAttendance(second.tx, 'event-1', records, 'admin-1');

    expect(firstResult.count).toBe(2);
    expect(secondResult.count).toBe(2);

    // `markedAt` is stamped with a fresh `new Date()` per call (bulk-write.ts),
    // so two invocations a millisecond apart legitimately differ on that field.
    // Assert convergence on everything that actually defines the row.
    const stripTimestamp = (calls: unknown[]) =>
      (calls as Record<string, Record<string, unknown>>[]).map((call) => {
        const { create, update, ...rest } = call;
        return {
          ...rest,
          create: { ...create, markedAt: expect.any(Date) },
          update: { ...update, markedAt: expect.any(Date) },
        };
      });

    expect(stripTimestamp(first.upserts)).toEqual(stripTimestamp(second.upserts));
  });

  it('survives a duplicate memberId in the payload (no unique-constraint blowup)', async () => {
    const { tx, upserts } = makeTx();
    const result = await replaceEventAttendance(
      tx,
      'event-1',
      [
        { memberId: M1, status: 'ABSENT' },
        { memberId: M1, status: 'PRESENT' },
      ],
      'admin-1',
    );

    expect(upserts).toHaveLength(1);
    expect(result.count).toBe(1);
  });

  it('deletes every row for the event when the payload is empty', async () => {
    // Deliberate: "save an empty roster" means clear it. The transaction is what
    // makes this safe — it cannot leave the event half-cleared.
    const { tx } = makeTx(7);
    const result = await replaceEventAttendance(tx, 'event-1', [], 'admin-1');

    expect((tx.attendance.deleteMany as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      { where: { eventId: 'event-1' } },
    );
    expect(result.count).toBe(0);
    expect(result.removed).toBe(7);
  });

  it('reports how many stale rows it removed', async () => {
    const { tx } = makeTx(3);
    const result = await replaceEventAttendance(
      tx,
      'event-1',
      [{ memberId: M1, status: 'PRESENT' }],
      'admin-1',
    );
    expect(result).toEqual({ count: 1, removed: 3 });
  });
});