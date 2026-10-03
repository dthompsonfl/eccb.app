/**
 * Export tests — Art. 15 / Art. 20.
 *
 * The two tests that matter most are the negative ones: that a password hash
 * cannot reach the output, and that another member's email address cannot ride
 * along inside the subject's audit trail. Both are asserted against the FULL
 * serialised document, not against the shape we expect, because the whole
 * point is that something unexpected slipped in.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    member: { findUnique: vi.fn() },
    userRole: { findMany: vi.fn().mockResolvedValue([]) },
    userPermission: { findMany: vi.fn().mockResolvedValue([]) },
    session: { findMany: vi.fn().mockResolvedValue([]) },
    account: { findMany: vi.fn().mockResolvedValue([]) },
    userPreferences: { findUnique: vi.fn().mockResolvedValue(null) },
    pushSubscription: { findMany: vi.fn().mockResolvedValue([]) },
    annotation: { findMany: vi.fn().mockResolvedValue([]) },
    practiceLog: { findMany: vi.fn().mockResolvedValue([]) },
    standBookmark: { findMany: vi.fn().mockResolvedValue([]) },
    standSetlist: { findMany: vi.fn().mockResolvedValue([]) },
    userNotification: { findMany: vi.fn().mockResolvedValue([]) },
    announcement: { findMany: vi.fn().mockResolvedValue([]) },
    auditLog: { findMany: vi.fn().mockResolvedValue([]) },
    musicAssignment: { findMany: vi.fn().mockResolvedValue([]) },
    musicAssignmentHistory: { findMany: vi.fn().mockResolvedValue([]) },
    attendance: { findMany: vi.fn().mockResolvedValue([]) },
    carpoolEntry: { findMany: vi.fn().mockResolvedValue([]) },
    sectionMessage: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

import { prisma } from '@/lib/db';
import {
  buildPersonalDataExport,
  csvCell,
  EXPORT_OMISSIONS,
  EXPORT_SCHEMA_VERSION,
  exportFileName,
  toCsvBundle,
} from '@/lib/privacy/export';
import { findSecretFieldPaths, redactSecrets, SECRET_FIELD_DENYLIST } from '@/lib/privacy/redaction';

const PASSWORD_HASH = '$2b$12$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN';
const SESSION_TOKEN = 'aVeryLongSessionTokenValueThatMustNeverLeak000000';
const TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const PUSH_AUTH = 'ElRW5e1q0lW4rQ8xZ0kVn2pYtHcMbN3s';
const THIRD_PARTY_EMAIL = 'alice.woodward@example.org';
const SUBJECT_EMAIL = 'ruth.calloway@example.com';

function seedUser(overrides: Record<string, unknown> = {}): void {
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    id: 'user-1',
    email: SUBJECT_EMAIL,
    emailVerified: true,
    name: 'Ruth Calloway',
    image: '/uploads/ruth.jpg',
    createdAt: new Date('2024-01-15T10:00:00Z'),
    updatedAt: new Date('2026-02-01T10:00:00Z'),
    deletedAt: null,
    role: null,
    banned: false,
    banReason: null,
    banExpires: null,
    twoFactorEnabled: true,
    ...overrides,
  } as never);
}

function seedMember(overrides: Record<string, unknown> = {}): void {
  vi.mocked(prisma.member.findUnique).mockResolvedValue({
    id: 'member-1',
    firstName: 'Ruth',
    lastName: 'Calloway',
    email: SUBJECT_EMAIL,
    phone: '555-123-4567',
    profilePhoto: '/uploads/ruth.jpg',
    status: 'ACTIVE',
    joinDate: new Date('2024-01-20T10:00:00Z'),
    leaveDate: null,
    emergencyName: 'Frank Calloway',
    emergencyPhone: '555-987-6543',
    emergencyEmail: 'frank@example.com',
    notes: 'Prefers second flute',
    isSubstitute: false,
    createdAt: new Date('2024-01-20T10:00:00Z'),
    updatedAt: new Date('2026-02-01T10:00:00Z'),
    deletedAt: null,
    instruments: [{ isPrimary: true, instrument: { id: 'i1', name: 'Flute', family: 'Woodwind' } }],
    sections: [
      { isLeader: false, assignedAt: new Date('2024-01-20T10:00:00Z'), section: { id: 's1', name: 'Woodwinds' } },
    ],
    ...overrides,
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  seedUser();
  seedMember();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('GDPR Art. 15/20 data export', () => {
  describe('secrets', () => {
    it('never emits a password hash, session token, 2FA secret or push key', async () => {
      // Make every source table return the most dangerous shape it could
      // possibly return. A password hash must not survive even if a future
      // `include:` reintroduces the column.
      (prisma.session.findMany as never as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: 'sess-1',
          token: SESSION_TOKEN,
          password: PASSWORD_HASH,
          createdAt: new Date(),
          updatedAt: new Date(),
          expiresAt: new Date(),
          ipAddress: '203.0.113.9',
          userAgent: 'Mozilla/5.0',
          impersonatedBy: null,
        },
      ]);
      (prisma.account.findMany as never as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: 'acc-1',
          accountId: 'acc-1',
          providerId: 'credential',
          scope: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          accessTokenExpiresAt: null,
          refreshTokenExpiresAt: null,
          accessToken: 'at_leaked',
          refreshToken: 'rt_leaked',
          idToken: 'it_leaked',
          password: PASSWORD_HASH,
        },
      ]);
      (prisma.pushSubscription.findMany as never as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: 'push-1',
          active: true,
          createdAt: new Date(),
          updatedAt: new Date(),
          lastSeen: new Date(),
          endpoint: `https://fcm.googleapis.com/fcm/send/${SESSION_TOKEN}`,
          p256dh: PUSH_AUTH,
          auth: PUSH_AUTH,
        },
      ]);
      (prisma.userPreferences.findUnique as never as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'pref-1',
        nightMode: true,
        metronomeSettings: '{"bpm":120}',
        midiMappings: null,
        otherSettings: null,
        pushEnabled: true,
        pushConsentedAt: new Date('2025-03-01T12:00:00Z'),
        updatedAt: new Date(),
      });

      const document = await buildPersonalDataExport('user-1');
      const serialised = JSON.stringify(document);

      expect(serialised).not.toContain(PASSWORD_HASH);
      expect(serialised).not.toContain('$2b$12$');
      expect(serialised).not.toContain(SESSION_TOKEN);
      expect(serialised).not.toContain(TOTP_SECRET);
      expect(serialised).not.toContain(PUSH_AUTH);
      expect(serialised).not.toContain('at_leaked');
      expect(serialised).not.toContain('rt_leaked');
      expect(serialised).not.toContain('it_leaked');
    });

    it('leaves no denylisted key anywhere in the assembled document', async () => {
      const document = await buildPersonalDataExport('user-1');
      expect(findSecretFieldPaths(document)).toEqual([]);
    });

    it('never even SELECTS a secret column', async () => {
      await buildPersonalDataExport('user-1');

      // The primary defence: the query excludes them, rather than relying on
      // the redactor to catch them afterwards.
      const userSelect = (prisma.user.findUnique as ReturnType<typeof vi.fn>).mock.calls[0][0].select;
      expect(Object.keys(userSelect)).not.toContain('password');

      const sessionSelect = (prisma.session.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0].select;
      expect(Object.keys(sessionSelect)).not.toContain('token');

      const accountSelect = (prisma.account.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0].select;
      for (const leaked of ['accessToken', 'refreshToken', 'idToken', 'password']) {
        expect(Object.keys(accountSelect)).not.toContain(leaked);
      }

      const pushSelect = (prisma.pushSubscription.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0].select;
      for (const leaked of ['endpoint', 'p256dh', 'auth']) {
        expect(Object.keys(pushSelect)).not.toContain(leaked);
      }
    });

    it('redacts a denylisted key even if a caller hands one in', () => {
      const scrubbed = redactSecrets({ nested: { password: 'hunter2', keep: 'visible' } });
      expect(JSON.stringify(scrubbed)).not.toContain('hunter2');
      expect((scrubbed as { nested: { keep: string } }).nested.keep).toBe('visible');
    });

    it('covers the obvious credential names in its denylist', () => {
      for (const field of ['password', 'token', 'secret', 'backupcodes', 'apikey', 'p256dh']) {
        expect(SECRET_FIELD_DENYLIST).toContain(field);
      }
    });
  });

  describe('third-party data', () => {
    it('does not leak another member’s email address out of the audit trail', async () => {
      (prisma.auditLog.findMany as never as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: 'audit-1',
          // An admin edited a DIFFERENT member — that member's email is in here.
          action: 'member.update',
          entityType: 'Member',
          entityId: 'member-9',
          userName: 'Ruth Calloway',
          ipAddress: '203.0.113.9',
          userAgent: 'Mozilla/5.0',
          oldValues: JSON.stringify({ email: THIRD_PARTY_EMAIL, phone: '555-222-3333' }),
          newValues: JSON.stringify({ firstName: 'Alice', lastName: 'Woodward' }),
          timestamp: new Date('2026-01-04T09:00:00Z'),
        },
      ]);

      const document = await buildPersonalDataExport('user-1');
      const serialised = JSON.stringify(document);

      expect(serialised).not.toContain(THIRD_PARTY_EMAIL);
      expect(serialised).not.toContain('555-222-3333');
      // The audit ENTRY itself is the subject's data and must survive.
      expect(serialised).toContain('member.update');
    });

    it('keeps the subject’s own email inside their audit trail', async () => {
      (prisma.auditLog.findMany as never as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: 'audit-2',
          action: 'account.email_change',
          entityType: 'User',
          entityId: 'user-1',
          userName: 'Ruth Calloway',
          ipAddress: null,
          userAgent: null,
          oldValues: JSON.stringify({ email: 'ruth.old@example.com' }),
          newValues: JSON.stringify({ email: SUBJECT_EMAIL }),
          timestamp: new Date('2026-01-04T09:00:00Z'),
        },
      ]);

      const document = await buildPersonalDataExport('user-1');
      expect(JSON.stringify(document)).toContain(SUBJECT_EMAIL);
    });

    it('keeps a third party’s NAME, because a name is needed to read the record', async () => {
      (prisma.attendance.findMany as never as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: 'att-1',
          eventId: 'ev-1',
          status: 'PRESENT',
          notes: null,
          markedAt: new Date('2026-01-04T09:00:00Z'),
          markedBy: 'Alice Woodward',
          event: { title: 'Spring Concert', type: 'CONCERT', startTime: new Date(), endTime: new Date() },
        },
      ]);

      const document = await buildPersonalDataExport('user-1');
      expect(JSON.stringify(document)).toContain('Alice Woodward');
    });
  });

  describe('coverage', () => {
    it('includes every category of record the platform holds', async () => {
      const document = await buildPersonalDataExport('user-1');
      for (const section of [
        'account',
        'memberProfile',
        'rolesAndPermissions',
        'sessionsAndAccounts',
        'preferences',
        'pushSubscriptions',
        'annotations',
        'practiceLogs',
        'bookmarksAndSetlists',
        'notifications',
        'announcementsAuthored',
        'musicAssignments',
        'attendance',
        'carpoolEntries',
        'sectionMessages',
        'sectionAndInstrumentMembership',
        'auditTrail',
      ]) {
        expect(document).toHaveProperty(section);
      }
    });

    it('is self-describing: generatedAt, schema version, dictionary, counts, omissions', async () => {
      const document = await buildPersonalDataExport('user-1');

      expect(document.metadata.schemaVersion).toBe(EXPORT_SCHEMA_VERSION);
      expect(Date.parse(document.metadata.generatedAt)).not.toBeNaN();
      expect(document.metadata.format).toBe('json');
      expect(Object.keys(document.metadata.dataDictionary).length).toBeGreaterThan(10);
      expect(document.metadata.recordCounts).toHaveProperty('attendance');
      // Compared by value: the assembled document has been through the
      // structural redactor, so identity is not preserved.
      expect(document.metadata.omissions).toEqual([...EXPORT_OMISSIONS]);
      expect(document.metadata.gdprArticles.join(' ')).toContain('Art. 15');
      expect(document.metadata.gdprArticles.join(' ')).toContain('Art. 20');
    });

    it('explains each omitted field in plain language rather than silently dropping it', () => {
      for (const omission of EXPORT_OMISSIONS) {
        expect(omission.length).toBeGreaterThan(30);
      }
    });

    it('reports the push consent timestamp as an Art. 7(1) record', async () => {
      (prisma.userPreferences.findUnique as never as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'pref-1',
        nightMode: false,
        metronomeSettings: null,
        midiMappings: null,
        otherSettings: null,
        pushEnabled: true,
        pushConsentedAt: new Date('2025-03-01T12:00:00Z'),
        updatedAt: new Date(),
      });

      const document = await buildPersonalDataExport('user-1');
      const preferences = document.preferences as { pushConsentedAt: string; consentNote: string };

      expect(preferences.pushConsentedAt).toBe('2025-03-01T12:00:00.000Z');
      expect(preferences.consentNote).toContain('Art. 7(1)');
    });

    it('serialises every Date as an ISO string so the document is portable', async () => {
      const document = await buildPersonalDataExport('user-1');
      const account = document.account as Record<string, unknown>;
      expect(typeof account.createdAt).toBe('string');
      expect(account.createdAt as string).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe('a user with no linked Member row', () => {
    it('exports null for member-scoped sections rather than failing', async () => {
      vi.mocked(prisma.member.findUnique).mockResolvedValue(null);

      const document = await buildPersonalDataExport('user-1');

      expect(document.memberProfile).toBeNull();
      expect(document.sectionAndInstrumentMembership).toBeNull();
      expect(document.attendance).toEqual([]);
      expect(document.account).toMatchObject({ id: 'user-1' });
    });

    it('does not query member-scoped tables at all', async () => {
      vi.mocked(prisma.member.findUnique).mockResolvedValue(null);
      await buildPersonalDataExport('user-1');
      expect(prisma.musicAssignment.findMany).not.toHaveBeenCalled();
      expect(prisma.sectionMessage.findMany).not.toHaveBeenCalled();
    });
  });

  describe('an unknown user', () => {
    it('throws rather than emitting an empty document', async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
      await expect(buildPersonalDataExport('ghost')).rejects.toThrow(/no such user/i);
    });
  });
});

describe('CSV rendering', () => {
  it('quotes and escapes correctly', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('has,comma')).toBe('"has,comma"');
    expect(csvCell('has "quote"')).toBe('"has ""quote"""');
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
    expect(csvCell(null)).toBe('');
  });

  it('neutralises spreadsheet formula injection', () => {
    // A member-supplied field beginning with = would otherwise execute in Excel.
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('-2+3')).toBe("'-2+3");
  });

  it('flattens attendance, assignments and practice into one labelled table', () => {
    const csv = toCsvBundle({
      metadata: { generatedAt: new Date().toISOString() },
      attendance: [
        {
          status: 'PRESENT',
          markedAt: new Date('2026-01-04T09:00:00Z'),
          notes: null,
          event: { title: 'Spring Concert', startTime: new Date('2026-01-04T19:00:00Z') },
        },
      ],
      musicAssignments: {
        assignments: [
          {
            status: 'ASSIGNED',
            assignedAt: new Date('2026-01-01T09:00:00Z'),
            partName: '2nd Flute',
            notes: null,
            piece: { title: 'Symphony No. 2' },
          },
        ],
      },
      practiceLogs: [
        {
          durationSeconds: 1800,
          practicedAt: new Date('2026-01-02T09:00:00Z'),
          notes: null,
          piece: { title: 'Symphony No. 2' },
        },
      ],
    } as never);

    expect(csv).toContain('recordType');
    expect(csv).toContain('Attendance');
    expect(csv).toContain('Spring Concert');
    expect(csv).toContain('Music assignment');
    expect(csv).toContain('2nd Flute');
    expect(csv).toContain('Practice');
    // 1800 seconds rendered as minutes — an elderly member should not have to
    // do arithmetic.
    expect(csv).toContain('30');
  });

  it('produces a valid file name', () => {
    const name = exportFileName(new Date('2026-03-04T05:06:07.000Z'), 'json');
    expect(name).toMatch(/^eccb-my-information-2026-03-04-05-06-07\.json$/);
    expect(name).not.toContain(':');
  });
});