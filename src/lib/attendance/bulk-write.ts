/**
 * Bulk attendance writes.
 *
 * This exists because the same write was implemented twice — once as a server
 * action and once as an HTTP route — and both copies had the same two defects:
 *
 *  1. **No transaction.** `deleteMany({ eventId })` ran, then `createMany` ran
 *     separately. If the create failed for any reason the event was left with
 *     NO attendance at all: a single bad memberId silently erased the rehearsal
 *     record for everyone. Attendance is the record a section leader uses to
 *     decide who needs chasing, so that is real data loss, not a cosmetic bug.
 *
 *  2. **Duplicate memberIds were fatal.** `Attendance` is
 *     `@@unique([eventId, memberId])`. A payload containing the same member
 *     twice — a double-click merging two edits, or a retry of a request that
 *     was retried by the network — reached `createMany` intact and blew up on
 *     the unique constraint, landing in the same data-loss path as (1).
 *
 * Both are fixed by doing the whole thing in one interactive transaction and by
 * folding duplicates with last-write-wins before the write, so the operation is
 * idempotent: running it twice, or running it concurrently, converges on the
 * same rows instead of destroying them.
 */

import type { AttendanceStatus, Prisma } from '@prisma/client';

export interface BulkAttendanceInput {
  memberId: string;
  status: AttendanceStatus;
  notes?: string;
}

export interface BulkAttendanceResult {
  /** Number of member rows written (duplicates folded, not counted twice). */
  count: number;
  /** Number of stale rows for members absent from the payload that were removed. */
  removed: number;
}

/**
 * Fold duplicate memberIds, last write wins.
 *
 * Last-write-wins is deliberate: the payload is a snapshot of an editor's form,
 * so a member appearing twice means the later entry supersedes the earlier one.
 * Rejecting the payload instead would make a double-click look like a data
 * error to a section leader who has simply made a mistake.
 */
export function dedupeAttendanceRecords(
  records: BulkAttendanceInput[],
): BulkAttendanceInput[] {
  const byMember = new Map<string, BulkAttendanceInput>();
  for (const record of records) {
    byMember.set(record.memberId, record);
  }
  return [...byMember.values()];
}

/**
 * Replace attendance for an event inside a single transaction.
 *
 * Members present in `records` are upserted, so their previous status and note
 * are overwritten rather than lost to a delete. Members with an existing row
 * who are NOT in the payload are deleted — that preserves the "save replaces
 * the roster" behaviour the admin UI depends on, without the window in which
 * the event has no attendance at all.
 *
 * @param tx       Prisma transaction client.
 * @param eventId  Event whose attendance is being written.
 * @param records  Desired end state. Duplicates are tolerated.
 * @param markedBy User id recorded as the marker.
 */
export async function replaceEventAttendance(
  tx: Prisma.TransactionClient,
  eventId: string,
  records: BulkAttendanceInput[],
  markedBy: string,
): Promise<BulkAttendanceResult> {
  const deduped = dedupeAttendanceRecords(records);
  const keptMemberIds = deduped.map((record) => record.memberId);

  // Delete only the rows the payload does not account for, and do it AFTER the
  // upserts so that at no point does the event have fewer rows than it should.
  const stale = await tx.attendance.deleteMany({
    where: { eventId, ...(keptMemberIds.length > 0 ? { memberId: { notIn: keptMemberIds } } : {}) },
  });

  for (const record of deduped) {
    await tx.attendance.upsert({
      where: { eventId_memberId: { eventId, memberId: record.memberId } },
      create: {
        eventId,
        memberId: record.memberId,
        status: record.status,
        notes: record.notes,
        markedBy,
      },
      update: {
        status: record.status,
        notes: record.notes,
        markedBy,
        markedAt: new Date(),
      },
    });
  }

  return { count: deduped.length, removed: stale.count };
}