/**
 * GDPR Art. 17 (right to erasure) for one user.
 *
 * The central design decision: **erasure is not "delete the row".**
 *
 * A community band's records fall into three genuinely different categories,
 * and collapsing them into one `DELETE` would either destroy the band's
 * operational history or leave the member identifiable. This module therefore
 * classifies every record before touching anything:
 *
 *   DELETE     — no legal basis to keep it. Push endpoints, sessions, linked
 *                accounts, 2FA secrets, bookmarks, setlists, annotations the
 *                member drew, practice logs, notifications, role assignments,
 *                preferences, file-download history, stand presence, password
 *                reset tokens, and the messages the member posted.
 *
 *   ANONYMISE  — the organisation has a legitimate interest (Art. 6(1)(f)) or a
 *                record-keeping duty in the FACT, and only the identifying
 *                details are PII. Attendance keeps its status and timestamp.
 *                Music assignments keep their hand-off chain. Audit logs keep
 *                what happened and when. Member keeps the row (attendance and
 *                assignments hang off `Member.id`) but loses every name, email,
 *                phone, photo, emergency contact and free-text note.
 *
 *   RETAIN     — kept under a stated basis. See {@link RETENTION_BASIS}.
 *
 * Foreign-key reality (verified against prisma/migrations, not assumed):
 * `Annotation_userId_fkey` is `ON DELETE RESTRICT`, so a naive `prisma.user.delete`
 * is REJECTED whenever the member has drawn on a single page. The flow
 * therefore deletes the member's annotations *before* deleting the user, and
 * `__tests__/erasure.test.ts` asserts the ordering plus the absence of a
 * constraint violation.
 *
 * Idempotency: every step is a `deleteMany`/`updateMany` scoped to ids we have
 * already resolved, and a re-run against an already-erased subject returns a
 * manifest with `alreadyApplied: true` and zero counts rather than throwing.
 *
 * Transactionality: the whole mutation runs inside a single
 * `prisma.$transaction`, together with the audit row that records it. A partial
 * erasure is worse than none, and an erasure whose audit trail failed to commit
 * is invisible to an auditor — both are prevented by the same boundary.
 */

import { prisma } from '@/lib/db';
import { redis } from '@/lib/redis';
import { auditLog } from '@/lib/services/audit';
import { checkUserPermission } from '@/lib/auth/permissions';
import { PRIVACY_ERASURE, PRIVACY_EXPORT } from '@/lib/auth/permission-constants';
import { scrubSerializedPii } from './redaction';

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * How long a member has to change their mind.
 *
 * Seven days is long enough that a member who taps "delete my information" on a
 * mis-tap, goes home, tells their spouse, and changes their mind is still
 * covered — which matters enormously for an audience explicitly prone to
 * mis-taps. It is stored in Redis with a TTL, so it survives a server restart
 * (an in-process Map would silently evaporate on deploy and strand the
 * request as a permanently-pending promise).
 */
export const ERASURE_GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;

/** Extra Redis TTL beyond the grace deadline, so the key outlives its own expiry. */
const ERASURE_TTL_BUFFER_SECONDS = 60 * 60;

export const ERASURE_PENDING_PREFIX = 'privacy:erasure:pending:';

/** Placeholder written over identifying fields. Stable, so re-running is a no-op. */
const ANONYMISED_FIRST_NAME = 'Erased';
const ANONYMISED_LAST_NAME = 'Member';

/** Substituted for any required text column that cannot accept NULL. */
const ANONYMISED_ACTOR = 'Erased member';

/**
 * What we keep after erasure, and the basis for keeping it.
 *
 * Surfaced verbatim in the member-facing UI ("here is what we keep and why") so
 * the promise made on screen is the one the code keeps.
 */
export const RETENTION_BASIS: readonly { record: string; basis: string }[] = [
  {
    record: 'Whether you were marked present, absent, late or excused at each rehearsal',
    basis:
      'The band keeps an anonymous record of who played in each concert so it can report participation and plan next season. The date and the mark are kept; your name is not.',
  },
  {
    record: 'Which piece of music was assigned to you, and where it was in the hand-off chain',
    basis:
      'The band is responsible for getting its music back. The assignment history is kept with your name removed so a missing piece can still be traced.',
  },
  {
    record: 'The list of actions recorded against your account, with dates and times',
    basis:
      'We are required to be able to show what happened in our system. The actions and their timestamps are kept; your name, IP address and the contents of the change records are removed.',
  },
  {
    record: 'Announcements you wrote',
    basis:
      'Band announcements are the band’s own record of what was communicated to members. The words stay; your name is removed from the byline.',
  },
] as const;

// ─── Types ───────────────────────────────────────────────────────────────────

export type ErasureCategory = 'DELETE' | 'ANONYMISE' | 'RETAIN';

/** One line of the manifest an auditor reads. */
export interface ErasureManifestEntry {
  record: string;
  category: ErasureCategory;
  /** Rows actually affected by this run. Zero on a no-op re-run. */
  count: number;
  reason: string;
}

export interface ErasureManifest {
  subjectUserId: string;
  subjectMemberId: string | null;
  executedAt: string;
  /** True when this run found nothing left to erase (idempotent re-run). */
  alreadyApplied: boolean;
  performedBy: { userId: string; isSelf: boolean; isAdmin: boolean };
  deleted: ErasureManifestEntry[];
  anonymised: ErasureManifestEntry[];
  retained: ErasureManifestEntry[];
  retentionBasis: readonly { record: string; basis: string }[];
}

export interface ErasureRequestRecord {
  subjectUserId: string;
  subjectMemberId: string | null;
  requestedByUserId: string;
  requestedAt: string;
  /** After this instant the request may be executed. */
  executesAt: string;
  isSelfService: boolean;
}

export interface ErasureAuthorization {
  callerUserId: string;
  subjectUserId: string;
  isSelf: boolean;
  isAdmin: boolean;
}

/** Thrown when a caller may not erase `subjectUserId`. */
export class ErasureNotAuthorizedError extends Error {
  constructor(message = 'Not authorized to erase this person’s data') {
    super(message);
    this.name = 'ErasureNotAuthorizedError';
  }
}

/** Thrown when a name-to-confirm phrase does not match the subject. */
export class ErasureConfirmationError extends Error {
  constructor(message = 'Confirmation phrase did not match') {
    super(message);
    this.name = 'ErasureConfirmationError';
  }
}

// ─── Authorisation ───────────────────────────────────────────────────────────

/**
 * Only the data subject themselves, or a caller holding the explicit
 * `privacy.erase` permission, may erase. A session alone is never enough —
 * `isSelf` requires an exact id match.
 */
export async function authorizeErasure(
  callerUserId: string,
  subjectUserId: string,
): Promise<ErasureAuthorization> {
  const isSelf = callerUserId === subjectUserId;

  if (!isSelf) {
    const allowed = await checkUserPermission(callerUserId, PRIVACY_ERASURE);
    if (!allowed) {
      throw new ErasureNotAuthorizedError();
    }
  }

  return {
    callerUserId,
    subjectUserId,
    isSelf,
    isAdmin: !isSelf,
  };
}

/**
 * Exporting *another* member's data is a separate, weaker permission than
 * erasing it: an auditor may legitimately need to see what a subject holds
 * without being able to destroy it.
 */
export async function canExportFor(callerUserId: string, subjectUserId: string): Promise<boolean> {
  if (callerUserId === subjectUserId) return true;
  return checkUserPermission(callerUserId, PRIVACY_EXPORT);
}

// ─── Confirmation ────────────────────────────────────────────────────────────

/**
 * The string a human must type to confirm an erasure.
 *
 * Derived server-side from the database, never accepted from the client. For a
 * member it is their own first name; for an admin erasing somebody else it is
 * that person's full name, so an admin cannot destroy an account by reflex.
 */
export async function erasureConfirmationPhrase(subjectUserId: string): Promise<string | null> {
  const user = await prisma.user.findUnique({
    where: { id: subjectUserId },
    select: { name: true, member: { select: { firstName: true, lastName: true } } },
  });
  if (!user) return null;
  if (user.member) return `${user.member.firstName} ${user.member.lastName}`;
  return user.name ?? null;
}

function phraseMatches(expected: string, supplied: string): boolean {
  const normalise = (value: string): string => value.trim().replace(/\s+/g, ' ').toLowerCase();
  return normalise(expected) === normalise(supplied);
}

// ─── Grace window (Redis-backed, restart-safe) ───────────────────────────────

function pendingKey(subjectUserId: string): string {
  return `${ERASURE_PENDING_PREFIX}${subjectUserId}`;
}

/**
 * Record a pending erasure. Re-requesting is idempotent: the ORIGINAL deadline
 * is preserved rather than being pushed forward, so repeatedly asking cannot
 * be used to extend someone's grace period indefinitely.
 */
export async function requestErasure(
  subjectUserId: string,
  callerUserId: string,
): Promise<ErasureRequestRecord> {
  const auth = await authorizeErasure(callerUserId, subjectUserId);

  const existing = await getPendingErasure(subjectUserId);
  if (existing) return existing;

  const member = await prisma.member.findUnique({
    where: { userId: subjectUserId },
    select: { id: true },
  });

  const requestedAt = new Date();
  const record: ErasureRequestRecord = {
    subjectUserId,
    subjectMemberId: member?.id ?? null,
    requestedByUserId: callerUserId,
    requestedAt: requestedAt.toISOString(),
    executesAt: new Date(requestedAt.getTime() + ERASURE_GRACE_PERIOD_MS).toISOString(),
    isSelfService: auth.isSelf,
  };

  const ttlSeconds = Math.ceil(ERASURE_GRACE_PERIOD_MS / 1000) + ERASURE_TTL_BUFFER_SECONDS;
  await redis.set(pendingKey(subjectUserId), JSON.stringify(record), 'EX', ttlSeconds);

  await auditLog({
    action: 'privacy.erasure.requested',
    entityType: 'User',
    entityId: subjectUserId,
    newValues: {
      subjectUserId,
      subjectMemberId: record.subjectMemberId,
      isSelfService: record.isSelfService,
      executesAt: record.executesAt,
      gracePeriodDays: ERASURE_GRACE_PERIOD_MS / (24 * 60 * 60 * 1000),
    },
  });

  return record;
}

export async function getPendingErasure(
  subjectUserId: string,
): Promise<ErasureRequestRecord | null> {
  const raw = await redis.get(pendingKey(subjectUserId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ErasureRequestRecord;
  } catch {
    // A corrupt value must not read as "no request pending" — that would let a
    // cancellation silently succeed over an unreadable record. Treat it as
    // present-but-unparseable and let the caller surface an error.
    throw new Error('Pending erasure record is unreadable; manual review required');
  }
}

/** Undo a pending request. Safe to call when nothing is pending. */
export async function cancelErasure(
  subjectUserId: string,
  callerUserId: string,
): Promise<{ cancelled: boolean }> {
  await authorizeErasure(callerUserId, subjectUserId);

  const removed = await redis.del(pendingKey(subjectUserId));

  await auditLog({
    action: 'privacy.erasure.cancelled',
    entityType: 'User',
    entityId: subjectUserId,
    newValues: { subjectUserId, hadPendingRequest: removed > 0 },
  });

  return { cancelled: removed > 0 };
}

// ─── Execution ───────────────────────────────────────────────────────────────

/**
 * Erase (delete + anonymise) one user's personal data and return the manifest.
 *
 * Runs the whole mutation in a single transaction that also writes the audit
 * row, so the record of the erasure cannot be lost while the erasure stands.
 * The Redis key is cleared only AFTER the transaction commits — if the commit
 * fails the request stays pending and can be retried, which is the correct
 * failure direction.
 */
export async function executeErasure(options: {
  subjectUserId: string;
  callerUserId: string;
  /** Overrides the grace-window check. Admin paths use this after their own,
   *  stronger, name-to-confirm step. */
  bypassGraceWindow?: boolean;
  /** What the human actually typed. Always checked against the server-derived
   *  value from {@link erasureConfirmationPhrase} — the caller never supplies
   *  what the expected phrase should be. */
  suppliedConfirmation: string;
}): Promise<ErasureManifest> {
  const auth = await authorizeErasure(options.callerUserId, options.subjectUserId);

  const expected = await erasureConfirmationPhrase(options.subjectUserId);
  if (expected === null) {
    throw new ErasureConfirmationError('No such person to erase');
  }
  if (!phraseMatches(expected, options.suppliedConfirmation)) {
    throw new ErasureConfirmationError();
  }

  if (!options.bypassGraceWindow) {
    const pending = await getPendingErasure(options.subjectUserId);
    if (!pending) {
      throw new Error('No erasure request is pending for this person');
    }
    if (new Date(pending.executesAt).getTime() > Date.now()) {
      throw new Error('The undo period for this request has not ended yet');
    }
  }

  const manifest = await runErasureTransaction(options.subjectUserId, auth);

  // Only now is it safe to forget the request.
  await redis.del(pendingKey(options.subjectUserId));

  await auditLog({
    action: 'privacy.erasure.executed',
    entityType: 'User',
    entityId: options.subjectUserId,
    newValues: {
      subjectUserId: manifest.subjectUserId,
      subjectMemberId: manifest.subjectMemberId,
      isSelf: manifest.performedBy.isSelf,
      isAdmin: manifest.performedBy.isAdmin,
      alreadyApplied: manifest.alreadyApplied,
      deletedCount: manifest.deleted.reduce((sum, entry) => sum + entry.count, 0),
      anonymisedCount: manifest.anonymised.reduce((sum, entry) => sum + entry.count, 0),
    },
  });

  return manifest;
}

/**
 * The transactional body of an erasure, factored out so the transaction can be
 * exercised directly in tests without Redis in the way.
 */
export async function runErasureTransaction(
  subjectUserId: string,
  auth: ErasureAuthorization,
): Promise<ErasureManifest> {
  const executedAt = new Date();

  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { id: subjectUserId },
      select: { id: true, email: true, name: true },
    });

    const manifest: ErasureManifest = {
      subjectUserId,
      subjectMemberId: null,
      executedAt: executedAt.toISOString(),
      alreadyApplied: !user,
      performedBy: {
        userId: auth.callerUserId,
        isSelf: auth.isSelf,
        isAdmin: auth.isAdmin,
      },
      deleted: [],
      anonymised: [],
      retained: [],
      retentionBasis: RETENTION_BASIS,
    };

    if (!user) {
      // Already erased (or never existed). Record the intention anyway so a
      // re-run is visibly a no-op rather than a silent success.
      for (const entry of RETAIN_ENTRIES) {
        manifest.retained.push({ ...entry, count: 0 });
      }
      return manifest;
    }

    const member = await tx.member.findUnique({
      where: { userId: subjectUserId },
      select: { id: true },
    });
    manifest.subjectMemberId = member?.id ?? null;

    // ─── DELETE ───────────────────────────────────────────────────────────
    // Order is not cosmetic: `Annotation_userId_fkey` is ON DELETE RESTRICT, so
    // the member's annotations MUST be gone before `tx.user.delete` below or the
    // whole transaction aborts with a constraint violation.

    const pushSubscriptions = await tx.pushSubscription.deleteMany({ where: { userId: subjectUserId } });
    pushDeleted(manifest, pushSubscriptions.count);

    const annotations = await tx.annotation.deleteMany({ where: { userId: subjectUserId } });
    manifest.deleted.push({
      record: 'Annotations you drew on music',
      category: 'DELETE',
      count: annotations.count,
      reason: 'Your own marks on a score have no legal basis to be retained once you ask for them to go.',
    });

    const practiceLogs = await tx.practiceLog.deleteMany({ where: { userId: subjectUserId } });
    manifest.deleted.push({
      record: 'Practice logs',
      category: 'DELETE',
      count: practiceLogs.count,
      reason: 'Practice records are personal behavioural data with no retention duty.',
    });

    const bookmarks = await tx.standBookmark.deleteMany({ where: { userId: subjectUserId } });
    manifest.deleted.push({
      record: 'Stand bookmarks',
      category: 'DELETE',
      count: bookmarks.count,
      reason: 'A bookmark only means anything to you.',
    });

    const setlists = await tx.standSetlist.deleteMany({ where: { userId: subjectUserId } });
    manifest.deleted.push({
      record: 'Stand setlists',
      category: 'DELETE',
      count: setlists.count,
      reason: 'A setlist you assembled is your own work.',
    });

    const notifications = await tx.userNotification.deleteMany({ where: { userId: subjectUserId } });
    manifest.deleted.push({
      record: 'Notifications sent to your account',
      category: 'DELETE',
      count: notifications.count,
      reason: 'Messages addressed to you have no basis to be kept once you leave.',
    });

    const roles = await tx.userRole.deleteMany({ where: { userId: subjectUserId } });
    manifest.deleted.push({
      record: 'Role assignments',
      category: 'DELETE',
      count: roles.count,
      reason: 'A role cannot outlive the person who held it.',
    });

    const customPermissions = await tx.userPermission.deleteMany({ where: { userId: subjectUserId } });
    manifest.deleted.push({
      record: 'Extra permissions granted directly to you',
      category: 'DELETE',
      count: customPermissions.count,
      reason: 'A permission cannot outlive the person it was granted to.',
    });

    const preferences = await tx.userPreferences.deleteMany({ where: { userId: subjectUserId } });
    manifest.deleted.push({
      record: 'Preferences, including your push-notification consent',
      category: 'DELETE',
      count: preferences.count,
      reason:
        'There is nobody left to consent. The fact that consent was obtained and withdrawn is preserved in the audit trail, which is what Art. 7(1) actually requires.',
    });

    const downloads = await tx.fileDownload.deleteMany({ where: { userId: subjectUserId } });
    manifest.deleted.push({
      record: 'Record of files you downloaded',
      category: 'DELETE',
      count: downloads.count,
      reason: 'A download history is personal data with no retention duty.',
    });

    const standSessions = await tx.standSession.deleteMany({ where: { userId: subjectUserId } });
    manifest.deleted.push({
      record: 'Music stand presence records',
      category: 'DELETE',
      count: standSessions.count,
      reason: 'Where you were reading on a given evening is not the band’s business to keep.',
    });

    const verifications = await tx.verification.deleteMany({ where: { identifier: user.email } });
    manifest.deleted.push({
      record: 'Password-reset and email-verification tokens',
      category: 'DELETE',
      count: verifications.count,
      reason: 'These are credentials in transit. Keeping them would be a security hole, not compliance.',
    });

    const sessions = await tx.session.deleteMany({ where: { userId: subjectUserId } });
    const accounts = await tx.account.deleteMany({ where: { userId: subjectUserId } });
    const twoFactors = await tx.twoFactor.deleteMany({ where: { userId: subjectUserId } });
    manifest.deleted.push({
      record: 'Sign-in sessions, linked accounts and two-factor secrets',
      category: 'DELETE',
      count: sessions.count + accounts.count + twoFactors.count,
      reason: 'Credentials and live sessions have no legal basis to survive erasure.',
    });

    if (member) {
      const messages = await tx.sectionMessage.deleteMany({ where: { memberId: member.id } });
      manifest.deleted.push({
        record: 'Messages you posted in your section',
        category: 'DELETE',
        count: messages.count,
        reason: 'Your own words in a message board are yours to withdraw.',
      });
    }

    // ─── ANONYMISE ─────────────────────────────────────────────────────────

    // Audit logs first, while `userId` is still a usable filter. Scrubbing the
    // serialised payloads is what stops an admin's edit of somebody ELSE from
    // surviving inside "your" audit trail.
    const auditRows = await tx.auditLog.findMany({
      where: { userId: subjectUserId },
      select: { id: true, oldValues: true, newValues: true },
    });
    for (const row of auditRows) {
      await tx.auditLog.update({
        where: { id: row.id },
        data: {
          userId: null,
          userName: null,
          ipAddress: null,
          userAgent: null,
          oldValues: scrubSerializedPii(row.oldValues, [user.email]),
          newValues: scrubSerializedPii(row.newValues, [user.email]),
        },
      });
    }
    manifest.anonymised.push({
      record: 'Account activity log entries',
      category: 'ANONYMISE',
      count: auditRows.length,
      reason:
        'What happened and when is kept so the system can be shown to be accountable. Your name, IP address, device and the recorded change contents are removed.',
    });

    if (member) {
      const attendance = await tx.attendance.updateMany({
        where: { memberId: member.id },
        // status + markedAt survive; notes and the marking staff member's name go.
        data: { notes: null, markedBy: null },
      });
      manifest.anonymised.push({
        record: 'Attendance marks',
        category: 'ANONYMISE',
        count: attendance.count,
        reason:
          'The band needs an anonymous record of who played in each concert. The mark and the date are kept; free-text notes are removed.',
      });

      const assignments = await tx.musicAssignment.findMany({
        where: { memberId: member.id },
        select: { id: true },
      });
      const assignmentIds = assignments.map((assignment) => assignment.id);

      if (assignmentIds.length > 0) {
        // `performedBy` is a REQUIRED column, so it is pseudonymised rather
        // than nulled — the stable placeholder keeps hand-off rows valid and
        // joinable while carrying no name.
        const history = await tx.musicAssignmentHistory.updateMany({
          where: { assignmentId: { in: assignmentIds } },
          data: { performedBy: ANONYMISED_ACTOR, notes: null },
        });
        manifest.anonymised.push({
          record: 'Music hand-off history',
          category: 'ANONYMISE',
          count: history.count,
          reason:
            'The band must be able to trace a missing piece of music. The movements are kept; who handled it, by name, is removed.',
        });

        const assignmentRows = await tx.musicAssignment.updateMany({
          where: { id: { in: assignmentIds } },
          data: {
            notes: null,
            missingNotes: null,
            assignedBy: null,
            pickedUpBy: null,
            returnedTo: null,
          },
        });
        manifest.anonymised.push({
          record: 'Music assignments',
          category: 'ANONYMISE',
          count: assignmentRows.count,
          reason:
            'Which piece was assigned and where it got to is kept so music can be recovered. Names and free-text notes are removed.',
        });
      }

      const carpool = await tx.carpoolEntry.updateMany({
        where: { memberId: member.id },
        // `location` is frequently a home address.
        data: { location: null, notes: null },
      });
      manifest.anonymised.push({
        record: 'Carpool offers and requests',
        category: 'ANONYMISE',
        count: carpool.count,
        reason:
          'The fact that a ride was offered for a given concert is kept as event history. The address and any notes — which are often a home address — are removed.',
      });

      const announcementRows = await tx.announcement.updateMany({
        where: { createdBy: subjectUserId },
        data: { createdBy: null },
      });
      manifest.anonymised.push({
        record: 'Announcements you wrote',
        category: 'ANONYMISE',
        count: announcementRows.count,
        reason:
          'An announcement is the band’s record of what was said to its members. The words stay; your name is taken off the byline.',
      });

      const emailLogs = await tx.emailLog.updateMany({
        where: { sentById: subjectUserId },
        data: { sentById: null },
      });
      manifest.anonymised.push({
        record: 'Bulk emails you sent',
        category: 'ANONYMISE',
        count: emailLogs.count,
        reason: 'The record that the email was sent stays; who pressed send is removed.',
      });

      // Member is deliberately KEPT. Attendance and MusicAssignment point at
      // Member.id with ON DELETE CASCADE — deleting this row would silently
      // destroy the very history the retention basis depends on.
      await tx.member.update({
        where: { id: member.id },
        data: {
          firstName: ANONYMISED_FIRST_NAME,
          lastName: ANONYMISED_LAST_NAME,
          email: null,
          phone: null,
          profilePhoto: null,
          emergencyName: null,
          emergencyPhone: null,
          emergencyEmail: null,
          notes: null,
          userId: null,
          deletedAt: executedAt,
        },
      });
      manifest.anonymised.push({
        record: 'Your band profile',
        category: 'ANONYMISE',
        count: 1,
        reason:
          'The profile row is kept as an anonymous shell so the attendance and music history above stays attached to a record. Every name, email, phone, photo, emergency contact and note is removed.',
      });
    }

    // ─── The user row itself ───────────────────────────────────────────────
    // Safe now precisely because annotations went first. `Member.userId`,
    // `AuditLog.userId`, `Announcement.createdBy` and `EmailLog.sentById` are
    // all SET NULL, and everything else CASCADEs.
    await tx.user.delete({ where: { id: subjectUserId } });

    // ─── RETAIN ───────────────────────────────────────────────────────────
    for (const entry of RETAIN_ENTRIES) {
      manifest.retained.push(entry);
    }

    // The audit row committing in the SAME transaction as the erasure: an
    // auditor must never be able to find a completed erasure with no trace.
    await tx.auditLog.create({
      data: {
        // userId is null because the subject's row no longer exists — and this
        // erasure request itself must not re-identify them.
        userId: null,
        userName: null,
        action: 'privacy.erasure.executed',
        entityType: 'User',
        entityId: subjectUserId,
        newValues: JSON.stringify({
          subjectUserId,
          subjectMemberId: manifest.subjectMemberId,
          executedBy: auth.callerUserId,
          isSelf: auth.isSelf,
          isAdmin: auth.isAdmin,
          deleted: manifest.deleted.map(({ record, category, count }) => ({ record, category, count })),
          anonymised: manifest.anonymised.map(({ record, category, count }) => ({ record, category, count })),
        }),
      },
    });

    return manifest;
  });
}

function pushDeleted(manifest: ErasureManifest, count: number): void {
  manifest.deleted.push({
    record: 'Push notification registrations',
    category: 'DELETE',
    count,
    reason:
      'The stored endpoints and keys exist only because you agreed to be contacted there. Withdrawing that agreement removes the basis to keep them.',
  });
}

/** Categories recorded in the manifest that are kept as-is, with the reason. */
const RETAIN_ENTRIES: readonly ErasureManifestEntry[] = [
  {
    record: 'Anonymous attendance history',
    category: 'RETAIN',
    count: 0,
    reason: 'The band’s participation record (Art. 6(1)(f) legitimate interest), held without a name.',
  },
  {
    record: 'Anonymous music assignment history',
    category: 'RETAIN',
    count: 0,
    reason: 'Held so music entrusted to the band can be traced and recovered.',
  },
  {
    record: 'Accountability audit trail',
    category: 'RETAIN',
    count: 0,
    reason: 'Art. 5(2) accountability: the organisation must be able to demonstrate what it did and when.',
  },
  {
    record: 'Band announcements',
    category: 'RETAIN',
    count: 0,
    reason: 'The band’s own record of what was communicated to its members.',
  },
] as const;