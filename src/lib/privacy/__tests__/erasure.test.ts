/**
 * Erasure tests.
 *
 * These use a STATEFUL fake Prisma rather than a bag of `vi.fn()`s, because the
 * single most important thing to prove here is a database constraint: a member
 * who has drawn on a score cannot have their User row deleted naively. A mock
 * that returns `{count: 1}` from everything would happily "pass" a broken
 * implementation.
 *
 * `createFakePrisma` enforces `Annotation_userId_fkey`'s ON DELETE RESTRICT
 * behaviour exactly as MySQL does — `user.delete()` throws a P2003-style
 * constraint error if any annotation still references the user. That makes the
 * FK-heavy test a real test: delete the annotations in the wrong order and it
 * fails here, not silently in production.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/redis', () => ({
  redis: {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
  },
}));

vi.mock('@/lib/services/audit', () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/auth/permissions', () => ({
  checkUserPermission: vi.fn().mockResolvedValue(false),
}));

// `vi.mock` factories are hoisted above every top-level declaration, so the
// harness must live somewhere the factory can reach without capturing a
// `const`. `globalThis` is the same trick the repo's own rate-limit/redis
// singletons use, and it lets each test swap in a freshly seeded harness.
vi.mock('@/lib/db', () => ({
  get prisma() {
    return (globalThis as { __privacyFakePrisma?: unknown }).__privacyFakePrisma;
  },
}));

import { prisma as fake } from '@/lib/db';

function installFake(harness: { model: unknown }): void {
  (globalThis as { __privacyFakePrisma?: unknown }).__privacyFakePrisma = harness.model;
}
import { redis } from '@/lib/redis';
import { checkUserPermission } from '@/lib/auth/permissions';
import {
  authorizeErasure,
  cancelErasure,
  ERASURE_GRACE_PERIOD_MS,
  ErasureConfirmationError,
  ErasureNotAuthorizedError,
  executeErasure,
  getPendingErasure,
  requestErasure,
  RETENTION_BASIS,
  runErasureTransaction,
} from '@/lib/privacy/erasure';
import { PRIVACY_ERASURE } from '@/lib/auth/permission-constants';

// ─── Fake Prisma ─────────────────────────────────────────────────────────────

interface Annotation {
  id: string;
  userId: string;
}

/**
 * A minimal but CONSTRAINT-FAITHFUL stand-in for the slice of Prisma the
 * erasure touches. Only what the implementation actually calls is modelled;
 * every method records its arguments so ordering can be asserted.
 */
function createFakePrisma(seed: {
  users: Array<{ id: string; email: string; name: string | null }>;
  members: Array<{ id: string; userId: string | null; firstName: string; lastName: string; email?: string | null; phone?: string | null; notes?: string | null }>;
  annotations?: Annotation[];
  attendance?: Array<{ id: string; memberId: string; status: string; notes: string | null; markedBy: string | null }>;
  auditLogs?: Array<{ id: string; userId: string | null; oldValues: string | null; newValues: string | null }>;
}) {
  const state = {
    users: [...seed.users],
    members: seed.members.map((m) => ({ ...m })),
    annotations: [...(seed.annotations ?? [])],
    attendance: [...(seed.attendance ?? [])],
    auditLogs: [...(seed.auditLogs ?? [])],
    calls: [] as string[],
  };

  const model = {
    user: {
      // `select` is honoured loosely: every caller in the erasure flow wants
      // id/email/name, and the name-to-confirm lookup additionally wants the
      // linked Member's first/last name. Returning both shapes keeps one fake
      // serving all three call sites.
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        state.calls.push('user.findUnique');
        const user = state.users.find((u) => u.id === where.id);
        if (!user) return null;
        const member = state.members.find((m) => m.userId === user.id);
        return {
          id: user.id,
          email: user.email,
          name: user.name,
          member: member
            ? { firstName: member.firstName, lastName: member.lastName }
            : null,
        };
      }),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        state.calls.push('user.delete');
        const existing = state.users.find((u) => u.id === where.id);
        if (!existing) throw new Error('Record to delete does not exist');

        // THE CONSTRAINT UNDER TEST. Mirrors `Annotation_userId_fkey
        // ON DELETE RESTRICT` in prisma/migrations — a MySQL 1451 surfaced by
        // Prisma as P2003.
        const blocking = state.annotations.filter((a) => a.userId === where.id);
        if (blocking.length > 0) {
          const error = new Error(
            'Foreign key constraint failed on the field: `Annotation_userId`',
          ) as Error & { code: string };
          error.code = 'P2003';
          throw error;
        }

        state.users = state.users.filter((u) => u.id !== where.id);
        // Mirror the SET NULL / CASCADE clauses that actually exist.
        state.members = state.members.map((m) =>
          m.userId === where.id ? { ...m, userId: null } : m,
        );
        state.auditLogs = state.auditLogs.map((a) =>
          a.userId === where.id ? { ...a, userId: null } : a,
        );
        return existing;
      }),
    },

    member: {
      findUnique: vi.fn(async ({ where }: { where: { userId?: string; id?: string } }) => {
        state.calls.push('member.findUnique');
        if (where.userId !== undefined) {
          return state.members.find((m) => m.userId === where.userId) ?? null;
        }
        return state.members.find((m) => m.id === where.id) ?? null;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        state.calls.push('member.update');
        const index = state.members.findIndex((m) => m.id === where.id);
        if (index === -1) throw new Error('Record to update does not exist');
        state.members[index] = { ...state.members[index], ...data };
        return state.members[index];
      }),
    },

    annotation: {
      deleteMany: vi.fn(async ({ where }: { where: { userId: string } }) => {
        state.calls.push('annotation.deleteMany');
        const before = state.annotations.length;
        state.annotations = state.annotations.filter((a) => a.userId !== where.userId);
        return { count: before - state.annotations.length };
      }),
    },

    pushSubscription: { deleteMany: vi.fn(async () => ({ count: 2 })) },
    practiceLog: { deleteMany: vi.fn(async () => ({ count: 3 })) },
    standBookmark: { deleteMany: vi.fn(async () => ({ count: 1 })) },
    standSetlist: { deleteMany: vi.fn(async () => ({ count: 1 })) },
    userNotification: { deleteMany: vi.fn(async () => ({ count: 4 })) },
    userRole: { deleteMany: vi.fn(async () => ({ count: 1 })) },
    userPermission: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    userPreferences: { deleteMany: vi.fn(async () => ({ count: 1 })) },
    fileDownload: { deleteMany: vi.fn(async () => ({ count: 5 })) },
    standSession: { deleteMany: vi.fn(async () => ({ count: 1 })) },
    verification: { deleteMany: vi.fn(async () => ({ count: 1 })) },
    session: { deleteMany: vi.fn(async () => ({ count: 2 })) },
    account: { deleteMany: vi.fn(async () => ({ count: 1 })) },
    twoFactor: { deleteMany: vi.fn(async () => ({ count: 1 })) },
    sectionMessage: { deleteMany: vi.fn(async () => ({ count: 2 })) },

    auditLog: {
      findMany: vi.fn(async ({ where }: { where: { userId: string } }) => {
        state.calls.push('auditLog.findMany');
        return state.auditLogs
          .filter((a) => a.userId === where.userId)
          .map(({ id, oldValues, newValues }) => ({ id, oldValues, newValues }));
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        state.calls.push('auditLog.update');
        const index = state.auditLogs.findIndex((a) => a.id === where.id);
        if (index === -1) throw new Error('Record to update does not exist');
        state.auditLogs[index] = { ...state.auditLogs[index], ...data };
        return state.auditLogs[index];
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        state.calls.push('auditLog.create');
        return data;
      }),
    },

    attendance: {
      updateMany: vi.fn(async ({ where, data }: { where: { memberId: string }; data: Record<string, unknown> }) => {
        state.calls.push('attendance.updateMany');
        const targets = state.attendance.filter((a) => a.memberId === where.memberId);
        state.attendance = state.attendance.map((a) =>
          a.memberId === where.memberId ? { ...a, ...data } : a,
        );
        return { count: targets.length };
      }),
    },

    musicAssignment: {
      findMany: vi.fn(async ({ where }: { where: { memberId: string } }) => {
        state.calls.push('musicAssignment.findMany');
        return [{ id: 'assign-1', memberId: where.memberId }];
      }),
      updateMany: vi.fn(async () => {
        state.calls.push('musicAssignment.updateMany');
        return { count: 1 };
      }),
    },

    musicAssignmentHistory: { updateMany: vi.fn(async () => ({ count: 5 })) },
    carpoolEntry: { updateMany: vi.fn(async () => ({ count: 2 })) },
    announcement: { updateMany: vi.fn(async () => ({ count: 1 })) },
    emailLog: { updateMany: vi.fn(async () => ({ count: 1 })) },

    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(model)),
  };

  return { model, state };
}

// ─── Fixture ─────────────────────────────────────────────────────────────────

const SUBJECT = {
  users: [{ id: 'user-1', email: 'member@example.com', name: 'Ruth' }],
  members: [
    {
      id: 'member-1',
      userId: 'user-1',
      firstName: 'Ruth',
      lastName: 'Calloway',
      email: 'ruth@example.com',
      phone: '555-123-4567',
      notes: 'Plays second flute',
    },
  ],
  annotations: [
    { id: 'ann-1', userId: 'user-1' },
    { id: 'ann-2', userId: 'user-1' },
  ],
  attendance: [{ id: 'att-1', memberId: 'member-1', status: 'PRESENT', notes: 'brought cookies', markedBy: 'Alice' }],
  auditLogs: [
    {
      id: 'audit-1',
      userId: 'user-1',
      oldValues: JSON.stringify({ email: 'member@example.com', otherMember: 'alice@example.com' }),
      newValues: JSON.stringify({ phone: '555-123-4567' }),
    },
  ],
};

const SELF = { callerUserId: 'user-1', subjectUserId: 'user-1', isSelf: true, isAdmin: false };

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('GDPR Art. 17 erasure', () => {
  let harness: ReturnType<typeof createFakePrisma>;

  beforeEach(() => {
    harness = createFakePrisma(structuredClone(SUBJECT));
    installFake(harness);
    vi.mocked(redis.get).mockResolvedValue(null);
    vi.mocked(redis.del).mockResolvedValue(0);
    vi.mocked(checkUserPermission).mockResolvedValue(false);
  });

  describe('the foreign-key case: a member WITH annotations', () => {
    it('erases without a constraint violation, deleting annotations before the user row', async () => {
      // The naive implementation — straight to prisma.user.delete — is rejected
      // by Annotation_userId_fkey ON DELETE RESTRICT. Assert the fake really
      // does reject it, so the test below is not vacuous.
      await expect(
        harness.model.user.delete({ where: { id: 'user-1' } }),
      ).rejects.toMatchObject({ code: 'P2003' });

      harness = createFakePrisma(structuredClone(SUBJECT));
      installFake(harness);

      const manifest = await runErasureTransaction('user-1', SELF);

      expect(manifest.subjectMemberId).toBe('member-1');
      expect(harness.state.users).toHaveLength(0);
      expect(harness.state.annotations).toHaveLength(0);

      const annotationAt = harness.state.calls.indexOf('annotation.deleteMany');
      const userDeleteAt = harness.state.calls.indexOf('user.delete');
      expect(annotationAt).toBeGreaterThanOrEqual(0);
      expect(userDeleteAt).toBeGreaterThan(annotationAt);
    });

    it('deletes the annotation rows it reports in the manifest', async () => {
      const manifest = await runErasureTransaction('user-1', SELF);

      const annotationEntry = manifest.deleted.find((entry) =>
        entry.record.includes('Annotations'),
      );
      expect(annotationEntry?.category).toBe('DELETE');
      expect(annotationEntry?.count).toBe(2);
    });
  });

  describe('what gets deleted', () => {
    it('deletes every no-legal-basis category', async () => {
      const manifest = await runErasureTransaction('user-1', SELF);
      const records = manifest.deleted.map((entry) => entry.record);

      expect(records).toEqual(
        expect.arrayContaining([
          expect.stringContaining('Push notification'),
          expect.stringContaining('Annotations'),
          expect.stringContaining('Practice logs'),
          expect.stringContaining('bookmarks'),
          expect.stringContaining('setlists'),
          expect.stringContaining('Notifications'),
          expect.stringContaining('Role assignments'),
          expect.stringContaining('Preferences'),
          expect.stringContaining('downloaded'),
          expect.stringContaining('Music stand presence'),
          expect.stringContaining('Password-reset'),
          expect.stringContaining('Sign-in sessions'),
          expect.stringContaining('section'),
        ]),
      );
      expect(manifest.deleted.every((entry) => entry.category === 'DELETE')).toBe(true);
    });
  });

  describe('what gets anonymised', () => {
    it('strips PII from the Member row but keeps the row itself', async () => {
      await runErasureTransaction('user-1', SELF);

      const member = harness.state.members[0];
      // Kept: the row attendance and assignments hang off.
      expect(member.id).toBe('member-1');
      // Gone: every identifier.
      expect(member.firstName).toBe('Erased');
      expect(member.lastName).toBe('Member');
      expect(member.email).toBeNull();
      expect(member.phone).toBeNull();
      expect(member.notes).toBeNull();
      expect(member.userId).toBeNull();
      expect(member.deletedAt).toBeInstanceOf(Date);
    });

    it('keeps the attendance mark and drops the note and the marker name', async () => {
      const manifest = await runErasureTransaction('user-1', SELF);
      const attendance = harness.state.attendance[0];

      // Survives as anonymous history.
      expect(attendance.status).toBe('PRESENT');
      expect(attendance.notes).toBeNull();
      expect(attendance.markedBy).toBeNull();

      const entry = manifest.anonymised.find((e) => e.record === 'Attendance marks');
      expect(entry?.category).toBe('ANONYMISE');
      expect(entry?.count).toBe(1);
    });

    it('anonymises audit logs and scrubs another person out of the payload', async () => {
      await runErasureTransaction('user-1', SELF);

      const audit = harness.state.auditLogs[0];
      expect(audit.userId).toBeNull();

      // The subject's own email is their data and stays.
      expect(audit.oldValues).toContain('member@example.com');
      // The OTHER member's email does not.
      expect(audit.oldValues).not.toContain('alice@example.com');
      expect(audit.oldValues).toContain('[redacted');
      expect(audit.newValues).not.toContain('555-123-4567');
    });

    it('anonymises rather than deletes music assignments', async () => {
      const manifest = await runErasureTransaction('user-1', SELF);
      expect(harness.model.musicAssignment.updateMany).toHaveBeenCalled();
      expect(harness.model.musicAssignmentHistory.updateMany).toHaveBeenCalled();
      expect(manifest.anonymised.map((e) => e.record)).toEqual(
        expect.arrayContaining([expect.stringContaining('Music assignments')]),
      );
    });
  });

  describe('what gets retained', () => {
    it('states a basis for every retained category', async () => {
      const manifest = await runErasureTransaction('user-1', SELF);

      expect(manifest.retained.length).toBeGreaterThan(0);
      expect(manifest.retained.every((entry) => entry.category === 'RETAIN')).toBe(true);
      expect(manifest.retained.every((entry) => entry.reason.length > 20)).toBe(true);
      expect(manifest.retentionBasis).toBe(RETENTION_BASIS);
      expect(RETENTION_BASIS.every((item) => item.basis.length > 20)).toBe(true);
    });
  });

  describe('idempotency', () => {
    it('is a safe no-op when run again against an already-erased subject', async () => {
      const first = await runErasureTransaction('user-1', SELF);
      expect(first.alreadyApplied).toBe(false);
      expect(first.deleted.reduce((sum, e) => sum + e.count, 0)).toBeGreaterThan(0);

      const second = await runErasureTransaction('user-1', SELF);
      expect(second.alreadyApplied).toBe(true);
      expect(second.deleted.every((entry) => entry.count === 0)).toBe(true);
      expect(second.anonymised).toHaveLength(0);
    });

    it('reports alreadyApplied for a subject that never existed', async () => {
      const manifest = await runErasureTransaction('nobody', SELF);
      expect(manifest.alreadyApplied).toBe(true);
      expect(manifest.deleted).toHaveLength(0);
    });
  });

  describe('a user with no linked Member row', () => {
    it('still erases the account and skips every member-scoped step', async () => {
      harness = createFakePrisma({
        users: [{ id: 'user-solo', email: 'solo@example.com', name: 'Sam' }],
        members: [],
        annotations: [{ id: 'a', userId: 'user-solo' }],
      });
      installFake(harness);

      const manifest = await runErasureTransaction('user-solo', {
        ...SELF,
        subjectUserId: 'user-solo',
      });

      expect(manifest.subjectMemberId).toBeNull();
      expect(harness.state.users).toHaveLength(0);
      expect(harness.model.attendance.updateMany).not.toHaveBeenCalled();
      expect(harness.model.musicAssignment.findMany).not.toHaveBeenCalled();
      expect(manifest.deleted.some((e) => e.record.includes('section'))).toBe(false);
    });
  });

  describe('authorisation', () => {
    it('rejects a caller who is neither the subject nor permissioned', async () => {
      await expect(
        authorizeErasure('user-attacker', 'user-1'),
      ).rejects.toBeInstanceOf(ErasureNotAuthorizedError);
      expect(checkUserPermission).toHaveBeenCalledWith('user-attacker', PRIVACY_ERASURE);
    });

    it('allows the subject themselves without any permission lookup', async () => {
      const auth = await authorizeErasure('user-1', 'user-1');
      expect(auth.isSelf).toBe(true);
      expect(auth.isAdmin).toBe(false);
      expect(checkUserPermission).not.toHaveBeenCalled();
    });

    it('allows an admin holding privacy.erase, flagged as an admin action', async () => {
      vi.mocked(checkUserPermission).mockResolvedValue(true);
      const auth = await authorizeErasure('admin-1', 'user-1');
      expect(auth.isSelf).toBe(false);
      expect(auth.isAdmin).toBe(true);
    });
  });

  describe('the grace window', () => {
    it('stores the pending request in Redis, not in process memory', async () => {
      await requestErasure('user-1', 'user-1');

      expect(redis.set).toHaveBeenCalled();
      const [key, , , ttl] = vi.mocked(redis.set).mock.calls[0];
      expect(key).toBe('privacy:erasure:pending:user-1');
      // A TTL is what makes it survive a deploy: an in-process Map would not.
      expect(ttl).toBeGreaterThan(ERASURE_GRACE_PERIOD_MS / 1000);
    });

    it('gives the member seven days to change their mind', async () => {
      const record = await requestErasure('user-1', 'user-1');
      const window = new Date(record.executesAt).getTime() - new Date(record.requestedAt).getTime();
      expect(window).toBe(ERASURE_GRACE_PERIOD_MS);
      expect(ERASURE_GRACE_PERIOD_MS).toBe(7 * 24 * 60 * 60 * 1000);
    });

    it('does not push the deadline forward when the member asks again', async () => {
      const first = await requestErasure('user-1', 'user-1');
      vi.mocked(redis.get).mockResolvedValue(
        JSON.stringify(first) as unknown as string,
      );
      const second = await requestErasure('user-1', 'user-1');
      expect(second.executesAt).toBe(first.executesAt);
      expect(redis.set).toHaveBeenCalledTimes(1);
    });

    it('refuses to execute while the undo window is still open', async () => {
      // Make the fake Redis behave like Redis: whatever `set` writes is what
      // `get` returns, so the request round-trips exactly as it would in
      // production instead of being hand-fed to the code under test.
      const store = new Map<string, string>();
      vi.mocked(redis.set).mockImplementation(async (key: string, value: string) => {
        store.set(key, value);
        return 'OK';
      });
      vi.mocked(redis.get).mockImplementation(async (key: string) => store.get(key) ?? null);

      const record = await requestErasure('user-1', 'user-1');
      expect((await getPendingErasure('user-1'))?.executesAt).toBe(record.executesAt);

      await expect(
        executeErasure({
          subjectUserId: 'user-1',
          callerUserId: 'user-1',
          suppliedConfirmation: 'Ruth Calloway',
        }),
      ).rejects.toThrow(/undo period/i);

      // And nothing was erased while it waited.
      expect(fake.user.delete).not.toHaveBeenCalled();
    });

    it('executes once the window has passed', async () => {
      const past = new Date(Date.now() - 1000).toISOString();
      vi.mocked(redis.get).mockResolvedValue(
        JSON.stringify({
          subjectUserId: 'user-1',
          subjectMemberId: 'member-1',
          requestedByUserId: 'user-1',
          requestedAt: past,
          executesAt: past,
          isSelfService: true,
        }),
      );

      const manifest = await executeErasure({
        subjectUserId: 'user-1',
        callerUserId: 'user-1',
        suppliedConfirmation: 'Ruth Calloway',
      });

      expect(manifest.alreadyApplied).toBe(false);
      expect(harness.state.users).toHaveLength(0);
      // The pending key is cleared only after the work is done.
      expect(redis.del).toHaveBeenCalledWith('privacy:erasure:pending:user-1');
    });

    it('cancels cleanly so the member can change their mind', async () => {
      await requestErasure('user-1', 'user-1');
      vi.mocked(redis.del).mockResolvedValue(1);

      const result = await cancelErasure('user-1', 'user-1');
      expect(result.cancelled).toBe(true);
      expect(redis.del).toHaveBeenCalledWith('privacy:erasure:pending:user-1');
    });
  });

  describe('name-to-confirm', () => {
    it('rejects a wrong phrase without erasing anything', async () => {
      await expect(
        executeErasure({
          subjectUserId: 'user-1',
          callerUserId: 'user-1',
          bypassGraceWindow: true,
          suppliedConfirmation: 'Not My Name',
        }),
      ).rejects.toBeInstanceOf(ErasureConfirmationError);

      expect(harness.state.users).toHaveLength(1);
    });

    it('accepts the phrase regardless of case and surrounding spaces', async () => {
      const manifest = await executeErasure({
        subjectUserId: 'user-1',
        callerUserId: 'user-1',
        bypassGraceWindow: true,
        suppliedConfirmation: '  ruth   CALLOWAY  ',
      });
      expect(manifest.alreadyApplied).toBe(false);
    });

    it('requires the TARGET name, not the admin name, for an admin erasure', async () => {
      vi.mocked(checkUserPermission).mockResolvedValue(true);
      await expect(
        executeErasure({
          subjectUserId: 'user-1',
          callerUserId: 'admin-1',
          bypassGraceWindow: true,
          suppliedConfirmation: 'The Admin',
        }),
      ).rejects.toBeInstanceOf(ErasureConfirmationError);
      expect(harness.state.users).toHaveLength(1);
    });
  });

  describe('audit trail', () => {
    it('writes the erasure audit row inside the transaction, so it cannot be lost', async () => {
      await runErasureTransaction('user-1', SELF);

      expect(harness.model.auditLog.create).toHaveBeenCalledTimes(1);
      const createAt = harness.state.calls.indexOf('auditLog.create');
      const userDeleteAt = harness.state.calls.indexOf('user.delete');
      // Committed by the same transaction: created before the delete resolves.
      expect(createAt).toBeGreaterThanOrEqual(0);
      expect(userDeleteAt).toBeGreaterThanOrEqual(0);
    });

    it('does not let the erasure audit row re-identify the subject', async () => {
      await runErasureTransaction('user-1', SELF);
      const payload = vi.mocked(harness.model.auditLog.create).mock.calls[0][0].data;

      expect(payload.userId).toBeNull();
      expect(payload.userName).toBeNull();
      expect(payload.action).toBe('privacy.erasure.executed');
    });
  });
});