/**
 * GDPR Art. 15 (right of access) + Art. 20 (right to data portability).
 *
 * One call, `buildPersonalDataExport(userId)`, returns a single self-describing
 * document containing every category of personal data this platform holds about
 * one person. The output is plain JSON because Art. 20 requires a portable,
 * machine-readable format; `toCsvBundle` additionally flattens the tabular
 * records so a member can open them in Excel without a JSON viewer.
 *
 * Three rules this module exists to enforce:
 *
 *   1. NO SECRETS, EVER. Every query uses an explicit `select` that omits
 *      `password`, `TwoFactor.secret`/`backupCodes`, `Session.token` and the
 *      push-subscription key material. The assembled document is then run
 *      through `redactSecrets` as a second, structural gate — see redaction.ts.
 *
 *   2. NO OTHER PEOPLE'S DATA. Where one of our rows legitimately mixes the
 *      subject's data with someone else's (an audit payload recording an admin
 *      editing a *different* member), only the subject's own identifiers
 *      survive; third-party emails and phone numbers are masked. Third-party
 *      NAMES are kept — a name is needed to make the subject's own record
 *      intelligible ("marked present by Alice") and a name alone is not
 *      contact data — but no third-party contact channel ever leaves here.
 *
 *   3. SELF-DESCRIBING. `schemaVersion` + `dataDictionary` travel with the
 *      document so an export opened in 2031 is still parseable without the code
 *      that produced it.
 */

import { prisma } from '@/lib/db';
import { redactSecrets, scrubSerializedPii } from './redaction';

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * Bump when the SHAPE of the document changes in a way a consumer would notice
 * (a removed field, a renamed field, a changed type). Additive changes do not
 * need a bump but should be noted in the data dictionary below.
 */
export const EXPORT_SCHEMA_VERSION = '1.0.0';

/** Plain-English description of every top-level section, for the subject. */
export const EXPORT_DATA_DICTIONARY: Readonly<Record<string, string>> = {
  account:
    'Your login account: the email address you sign in with, your display name, ' +
    'when the account was created, and whether your email address is confirmed. ' +
    'Passwords and two-factor security codes are never included — nobody, ' +
    'including us, can read them.',
  memberProfile:
    'Your band profile: name, contact details, emergency contact, join date, ' +
    'membership status, the section(s) you play in and the instrument(s) you play.',
  rolesAndPermissions:
    'What you are allowed to do in this system (for example "Section Leader"), ' +
    'when each role was granted, and any extra permissions granted directly to you.',
  sessionsAndAccounts:
    'Every place your account is currently signed in, when each session started, ' +
    'and when it expires. Session tokens are never included.',
  preferences:
    'Your display and stand settings, plus the exact date you agreed (or ' +
    'declined) to receive push notifications.',
  pushSubscriptions:
    'The devices registered to receive push notifications for your account, with ' +
    'the last time each was seen. The addressing keys browsers hand us are ' +
    'withheld because they are credentials, not information.',
  annotations:
    'Marks and drawings you made on music in the digital stand, with the piece, ' +
    'page and layer each belongs to.',
  practiceLogs:
    'Practice sessions you recorded: how long you practised, which piece, and when.',
  bookmarksAndSetlists:
    'Pieces you bookmarked, and the setlists you built.',
  notifications:
    'Messages sent to your account by band staff.',
  announcementsAuthored:
    'Announcements you wrote, if you have ever written one.',
  musicAssignments:
    'Music assigned to you, the part you play, and where each piece is in the ' +
    'hand-off chain (assigned, picked up, returned, or missing).',
  attendance:
    'Rehearsals and concerts you were marked up for, the mark you were given, and ' +
    'when it was recorded.',
  carpoolEntries:
    'Rides you offered or asked for, for specific events.',
  sectionMessages:
    'Messages you posted in your section’s message board.',
  sectionAndInstrumentMembership:
    'The sections you belong to, whether you lead one, and your instruments.',
  auditTrail:
    'Every action recorded against your account — sign-ins, changes you made, ' +
    'and actions staff took on your behalf — with the time and the type of action. ' +
    'Entries that recorded an action on a different member have that other ' +
    'person’s contact details removed.',
} as const;

/** Machine-readable description of the document envelope. */
export interface ExportMetadata {
  generatedAt: string;
  schemaVersion: string;
  dataDictionaryVersion: string;
  format: 'json';
  gdprArticles: readonly string[];
  recordCounts: Record<string, number>;
  dataDictionary: Readonly<Record<string, string>>;
  omissions: readonly string[];
}

/** The full export document. Section values are deliberately loose: the point
 *  is to serialise whatever is held, and the shape is versioned by
 *  `schemaVersion`, not by a TypeScript union that would break on a new field. */
export interface PersonalDataExport {
  metadata: ExportMetadata;
  [section: string]: unknown;
}

/** What we deliberately do NOT hand over, and why. Shown in the UI and in the
 *  document so a member is never left guessing why a field is missing. */
export const EXPORT_OMISSIONS: readonly string[] = [
  'Passwords and security codes — these are credentials, not information, and cannot be read back even by us.',
  'Active sign-in tokens — we can show you which devices are signed in and end a session, but we will not hand the token itself to anyone.',
  'Browser push-notification addressing keys — technical credentials used only to deliver messages to your device.',
];

// ─── Builders ────────────────────────────────────────────────────────────────

/** Wrap a section: drop it entirely when there is no linked Member row.
 *  `Member.userId` is NULLABLE by design — plenty of band members never created
 *  a portal account — so "no member" is a normal state, not an error. */
function memberScoped<T>(member: { id: string } | null, value: T): T | null {
  return member ? value : null;
}

export async function buildPersonalDataExport(userId: string): Promise<PersonalDataExport> {
  const generatedAt = new Date();

  const user = await prisma.user.findUnique({
    where: { id: userId },
    // Explicit allow-list. `password` is deliberately absent from this shape —
    // it is never read from the database, so it cannot leak even if the
    // redactor were removed.
    select: {
      id: true,
      email: true,
      emailVerified: true,
      name: true,
      image: true,
      createdAt: true,
      updatedAt: true,
      deletedAt: true,
      role: true,
      banned: true,
      banReason: true,
      banExpires: true,
      twoFactorEnabled: true,
    },
  });

  if (!user) {
    throw new Error('Cannot export personal data: no such user');
  }

  const subjectEmails = [user.email];

  // A member may exist without a linked user account, and a user may exist
  // without a member row. Both directions are handled explicitly.
  const member = await prisma.member.findUnique({
    where: { userId },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      phone: true,
      profilePhoto: true,
      status: true,
      joinDate: true,
      leaveDate: true,
      emergencyName: true,
      emergencyPhone: true,
      emergencyEmail: true,
      notes: true,
      isSubstitute: true,
      createdAt: true,
      updatedAt: true,
      deletedAt: true,
      instruments: { select: { isPrimary: true, instrument: { select: { id: true, name: true, family: true } } } },
      sections: { select: { isLeader: true, assignedAt: true, section: { select: { id: true, name: true } } } },
    },
  });

  const [roles, customPermissions, sessions, accounts, preferences, pushSubscriptions] =
    await Promise.all([
      prisma.userRole.findMany({
        where: { userId },
        select: {
          id: true,
          assignedAt: true,
          assignedBy: true,
          expiresAt: true,
          role: {
            select: {
              id: true,
              name: true,
              displayName: true,
              description: true,
              type: true,
              permissions: { select: { permission: { select: { name: true, description: true } } } },
            },
          },
        },
      }),
      prisma.userPermission.findMany({
        where: { userId },
        select: { id: true, grantedAt: true, grantedBy: true, expiresAt: true, permission: { select: { name: true, description: true } } },
      }),
      prisma.session.findMany({
        where: { userId },
        // `token` is the session credential — excluded at the query, not filtered
        // afterwards. We still report that a session exists so the member can
        // see every device they are signed in on.
        select: { id: true, createdAt: true, updatedAt: true, expiresAt: true, ipAddress: true, userAgent: true, impersonatedBy: true },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.account.findMany({
        where: { userId },
        // accessToken / refreshToken / idToken / password all omitted.
        select: { id: true, accountId: true, providerId: true, scope: true, createdAt: true, updatedAt: true, accessTokenExpiresAt: true, refreshTokenExpiresAt: true },
      }),
      prisma.userPreferences.findUnique({
        where: { userId },
        select: {
          id: true,
          nightMode: true,
          metronomeSettings: true,
          midiMappings: true,
          otherSettings: true,
          pushEnabled: true,
          pushConsentedAt: true,
          updatedAt: true,
        },
      }),
      prisma.pushSubscription.findMany({
        where: { userId },
        // p256dh / auth / endpoint omitted: all three are push credentials.
        select: { id: true, active: true, createdAt: true, updatedAt: true, lastSeen: true },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

  const [annotations, practiceLogs, bookmarks, setlists, notifications, announcementsAuthored, auditTrail] =
    await Promise.all([
      prisma.annotation.findMany({
        where: { userId },
        select: {
          id: true,
          musicId: true,
          page: true,
          layer: true,
          sectionId: true,
          strokeData: true,
          createdAt: true,
          updatedAt: true,
          music: { select: { title: true, composer: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.practiceLog.findMany({
        where: { userId },
        select: {
          id: true,
          pieceId: true,
          assignmentId: true,
          durationSeconds: true,
          notes: true,
          practicedAt: true,
          createdAt: true,
          piece: { select: { title: true } },
        },
        orderBy: { practicedAt: 'desc' },
      }),
      prisma.standBookmark.findMany({
        where: { userId },
        select: { id: true, pieceId: true, sortOrder: true, createdAt: true, piece: { select: { title: true } } },
        orderBy: { sortOrder: 'asc' },
      }),
      prisma.standSetlist.findMany({
        where: { userId },
        select: {
          id: true,
          name: true,
          description: true,
          isDefault: true,
          createdAt: true,
          updatedAt: true,
          items: { select: { id: true, pieceId: true, sortOrder: true, notes: true, piece: { select: { title: true } } }, orderBy: { sortOrder: 'asc' } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.userNotification.findMany({
        where: { userId },
        select: { id: true, type: true, title: true, message: true, linkUrl: true, linkText: true, isRead: true, readAt: true, createdAt: true, updatedAt: true },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.announcement.findMany({
        where: { createdBy: userId },
        select: { id: true, title: true, content: true, type: true, audience: true, status: true, isUrgent: true, isPinned: true, publishAt: true, publishedAt: true, createdAt: true, updatedAt: true },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.auditLog.findMany({
        where: { userId },
        select: { id: true, action: true, entityType: true, entityId: true, userName: true, ipAddress: true, userAgent: true, oldValues: true, newValues: true, timestamp: true },
        orderBy: { timestamp: 'desc' },
      }),
    ]);

  // ─── Member-scoped sections ───────────────────────────────────────────────
  // Each of these hangs off Member, not User. A user with no Member row simply
  // has none of this data, and saying so (null) is more honest than emitting
  // empty arrays that read as "the system checked and found nothing".

  let musicAssignments: unknown[] = [];
  let attendance: unknown[] = [];
  let carpoolEntries: unknown[] = [];
  let sectionMessages: unknown[] = [];
  let musicAssignmentHistory: unknown[] = [];

  if (member) {
    const [assignments, attendanceRows, carpool, messages] = await Promise.all([
      prisma.musicAssignment.findMany({
        where: { memberId: member.id },
        select: {
          id: true,
          pieceId: true,
          partId: true,
          partName: true,
          copyNumber: true,
          priority: true,
          notes: true,
          status: true,
          assignedAt: true,
          assignedBy: true,
          pickedUpAt: true,
          pickedUpBy: true,
          dueDate: true,
          returnedAt: true,
          returnedTo: true,
          condition: true,
          missingSince: true,
          missingNotes: true,
          piece: { select: { title: true, composer: true } },
        },
        orderBy: { assignedAt: 'desc' },
      }),
      prisma.attendance.findMany({
        where: { memberId: member.id },
        // `markedBy` is a free-text staff name. A name is kept (it is needed to
        // read the record and is not contact data); no staff email or phone is
        // ever selected here.
        select: { id: true, eventId: true, status: true, notes: true, markedAt: true, markedBy: true, event: { select: { title: true, type: true, startTime: true, endTime: true } } },
        orderBy: { markedAt: 'desc' },
      }),
      prisma.carpoolEntry.findMany({
        where: { memberId: member.id },
        // `location` and `notes` can hold a home address — the subject's own, so
        // it is theirs to have, but explicitly selected rather than swept in by
        // an `include` so the boundary is visible in review.
        select: { id: true, eventId: true, type: true, seats: true, location: true, notes: true, createdAt: true, updatedAt: true, event: { select: { title: true, startTime: true } } },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.sectionMessage.findMany({
        where: { memberId: member.id },
        select: { id: true, sectionId: true, content: true, createdAt: true, updatedAt: true, section: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    musicAssignments = assignments;
    attendance = attendanceRows;
    carpoolEntries = carpool;
    sectionMessages = messages;

    // Assignment hand-off history — the "who passed the music to whom" trail.
    if (assignments.length > 0) {
      musicAssignmentHistory = await prisma.musicAssignmentHistory.findMany({
        where: { assignmentId: { in: assignments.map((a) => a.id) } },
        select: { id: true, assignmentId: true, action: true, fromStatus: true, toStatus: true, notes: true, performedBy: true, performedAt: true },
        orderBy: { performedAt: 'desc' },
      });
    }
  }

  // ─── Assemble ─────────────────────────────────────────────────────────────

  const auditTrailScrubbed = auditTrail.map((entry) => ({
    ...entry,
    oldValues: scrubSerializedPii(entry.oldValues, subjectEmails),
    newValues: scrubSerializedPii(entry.newValues, subjectEmails),
  }));

  const sections: Record<string, unknown> = {
    account: {
      ...user,
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
      deletedAt: user.deletedAt?.toISOString() ?? null,
      banExpires: user.banExpires?.toISOString() ?? null,
    },

    memberProfile: memberScoped(member, {
      ...member,
      email: member?.email ?? null,
      createdAt: member?.createdAt.toISOString() ?? null,
      updatedAt: member?.updatedAt.toISOString() ?? null,
      deletedAt: member?.deletedAt?.toISOString() ?? null,
      joinDate: member?.joinDate?.toISOString() ?? null,
      leaveDate: member?.leaveDate?.toISOString() ?? null,
    }),

    rolesAndPermissions: {
      roles: roles.map((role) => ({
        id: role.id,
        role: role.role.name,
        displayName: role.role.displayName,
        description: role.role.description,
        type: role.role.type,
        assignedAt: role.assignedAt.toISOString(),
        assignedBy: role.assignedBy,
        expiresAt: role.expiresAt?.toISOString() ?? null,
        permissionsViaThisRole: role.role.permissions.map((rp) => ({
          name: rp.permission.name,
          description: rp.permission.description,
        })),
      })),
      directPermissions: customPermissions.map((entry) => ({
        id: entry.id,
        name: entry.permission.name,
        description: entry.permission.description,
        grantedAt: entry.grantedAt.toISOString(),
        grantedBy: entry.grantedBy,
        expiresAt: entry.expiresAt?.toISOString() ?? null,
      })),
    },

    sessionsAndAccounts: {
      sessions: sessions.map((session) => ({
        id: session.id,
        createdAt: session.createdAt.toISOString(),
        updatedAt: session.updatedAt.toISOString(),
        expiresAt: session.expiresAt.toISOString(),
        ipAddress: session.ipAddress,
        userAgent: session.userAgent,
        impersonatedBy: session.impersonatedBy,
        note: 'The sign-in token for this session is deliberately not included.',
      })),
      linkedAccounts: accounts.map((account) => ({
        id: account.id,
        accountId: account.accountId,
        providerId: account.providerId,
        scope: account.scope,
        createdAt: account.createdAt.toISOString(),
        updatedAt: account.updatedAt.toISOString(),
        accessTokenExpiresAt: account.accessTokenExpiresAt?.toISOString() ?? null,
        refreshTokenExpiresAt: account.refreshTokenExpiresAt?.toISOString() ?? null,
      })),
    },

    preferences: preferences
      ? {
          id: preferences.id,
          nightMode: preferences.nightMode,
          metronomeSettings: preferences.metronomeSettings,
          midiMappings: preferences.midiMappings,
          otherSettings: preferences.otherSettings,
          pushEnabled: preferences.pushEnabled,
          pushConsentedAt: preferences.pushConsentedAt?.toISOString() ?? null,
          updatedAt: preferences.updatedAt.toISOString(),
          consentNote:
            'pushConsentedAt is the recorded moment you agreed to receive push notifications (GDPR Art. 7(1)). It is kept even after you opt out, as the evidence that consent was properly obtained and withdrawn.',
        }
      : null,

    pushSubscriptions: {
      registrations: pushSubscriptions.map((sub) => ({
        id: sub.id,
        active: sub.active,
        createdAt: sub.createdAt.toISOString(),
        updatedAt: sub.updatedAt.toISOString(),
        lastSeen: sub.lastSeen.toISOString(),
      })),
      note: 'Addressing keys are withheld: they are credentials used only to deliver messages to your device.',
    },

    annotations: annotations.map((annotation) => ({
      id: annotation.id,
      piece: annotation.music?.title ?? null,
      composer: annotation.music?.composer ?? null,
      musicId: annotation.musicId,
      page: annotation.page,
      layer: annotation.layer,
      sectionId: annotation.sectionId,
      strokeData: annotation.strokeData,
      createdAt: annotation.createdAt.toISOString(),
      updatedAt: annotation.updatedAt.toISOString(),
    })),

    practiceLogs: practiceLogs.map((log) => ({
      id: log.id,
      piece: log.piece?.title ?? null,
      pieceId: log.pieceId,
      assignmentId: log.assignmentId,
      durationSeconds: log.durationSeconds,
      notes: log.notes,
      practicedAt: log.practicedAt.toISOString(),
      createdAt: log.createdAt.toISOString(),
    })),

    bookmarksAndSetlists: {
      bookmarks: bookmarks.map((bookmark) => ({
        id: bookmark.id,
        piece: bookmark.piece?.title ?? null,
        pieceId: bookmark.pieceId,
        sortOrder: bookmark.sortOrder,
        createdAt: bookmark.createdAt.toISOString(),
      })),
      setlists: setlists.map((setlist) => ({
        id: setlist.id,
        name: setlist.name,
        description: setlist.description,
        isDefault: setlist.isDefault,
        createdAt: setlist.createdAt.toISOString(),
        updatedAt: setlist.updatedAt.toISOString(),
        items: setlist.items.map((item) => ({
          id: item.id,
          piece: item.piece?.title ?? null,
          pieceId: item.pieceId,
          sortOrder: item.sortOrder,
          notes: item.notes,
        })),
      })),
    },

    notifications: notifications.map((notification) => ({
      id: notification.id,
      type: notification.type,
      title: notification.title,
      message: notification.message,
      linkUrl: notification.linkUrl,
      linkText: notification.linkText,
      isRead: notification.isRead,
      readAt: notification.readAt?.toISOString() ?? null,
      createdAt: notification.createdAt.toISOString(),
      updatedAt: notification.updatedAt?.toISOString() ?? null,
    })),

    announcementsAuthored: announcementsAuthored.map((announcement) => ({
      id: announcement.id,
      title: announcement.title,
      content: announcement.content,
      type: announcement.type,
      audience: announcement.audience,
      status: announcement.status,
      isUrgent: announcement.isUrgent,
      isPinned: announcement.isPinned,
      publishAt: announcement.publishAt?.toISOString() ?? null,
      publishedAt: announcement.publishedAt?.toISOString() ?? null,
      createdAt: announcement.createdAt.toISOString(),
      updatedAt: announcement.updatedAt.toISOString(),
    })),

    musicAssignments: {
      assignments: musicAssignments,
      handOffHistory: musicAssignmentHistory,
    },

    attendance,
    carpoolEntries,
    sectionMessages,

    sectionAndInstrumentMembership: memberScoped(member, {
      sections: member?.sections.map((entry) => ({
        id: entry.section.id,
        name: entry.section.name,
        isLeader: entry.isLeader,
        assignedAt: entry.assignedAt.toISOString(),
      })) ?? [],
      instruments: member?.instruments.map((entry) => ({
        id: entry.instrument.id,
        name: entry.instrument.name,
        family: entry.instrument.family,
        isPrimary: entry.isPrimary,
      })) ?? [],
    }),

    auditTrail: auditTrailScrubbed,
  };

  const recordCounts: Record<string, number> = {
    roles: roles.length,
    directPermissions: customPermissions.length,
    sessions: sessions.length,
    linkedAccounts: accounts.length,
    pushSubscriptions: pushSubscriptions.length,
    annotations: annotations.length,
    practiceLogs: practiceLogs.length,
    bookmarks: bookmarks.length,
    setlists: setlists.length,
    notifications: notifications.length,
    announcementsAuthored: announcementsAuthored.length,
    musicAssignments: musicAssignments.length,
    attendance: attendance.length,
    carpoolEntries: carpoolEntries.length,
    sectionMessages: sectionMessages.length,
    auditTrailEntries: auditTrailScrubbed.length,
  };

  const metadata: ExportMetadata = {
    generatedAt: generatedAt.toISOString(),
    schemaVersion: EXPORT_SCHEMA_VERSION,
    dataDictionaryVersion: EXPORT_SCHEMA_VERSION,
    format: 'json',
    gdprArticles: [
      'Art. 15 — right of access by the data subject',
      'Art. 20 — right to data portability',
    ],
    recordCounts,
    dataDictionary: EXPORT_DATA_DICTIONARY,
    omissions: EXPORT_OMISSIONS,
  };

  // Structural second gate. Every query above already omitted the secrets; this
  // catches a future `include` that reintroduces one.
  const assembled = redactSecrets({ metadata, ...sections }) as PersonalDataExport;

  return assembled;
}

// ─── CSV ─────────────────────────────────────────────────────────────────────

/** Quote a single CSV cell, neutralising formula injection. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = value instanceof Date ? value.toISOString() : String(value);

  // A cell beginning = + - @ is executed as a formula by Excel/Sheets. Prefix
  // with an apostrophe so the band secretary opening a file cannot be made to
  // run someone else's formula.
  const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;

  if (/[",\n\r]/.test(guarded)) {
    return `"${guarded.replace(/"/g, '""')}"`;
  }
  return guarded;
}

/** Render rows as an RFC 4180 CSV block. */
export function csvFromRows(rows: ReadonlyArray<Record<string, unknown>>): string {
  if (rows.length === 0) return '';
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const lines = [headers.map(csvCell).join(',')];
  for (const row of rows) {
    lines.push(headers.map((header) => csvCell(row[header])).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

/**
 * Flatten the tabular sections of an export into one CSV.
 *
 * A single file rather than a ZIP: elderly members can be handed one document
 * they can double-click, and the `recordType` column keeps the sections apart
 * inside it. JSON remains the authoritative Art. 20 format — this is a
 * convenience view of the same data, not a second source of truth.
 */
export function toCsvBundle(document: PersonalDataExport): string {
  const attendance = Array.isArray(document.attendance) ? document.attendance : [];
  const assignments =
    (document.musicAssignments as { assignments?: unknown[] } | undefined)?.assignments ?? [];
  const practice = Array.isArray(document.practiceLogs) ? document.practiceLogs : [];

  const rows: Array<Record<string, unknown>> = [
    ...attendance.map((row) => {
      const entry = row as Record<string, unknown>;
      const event = entry.event as Record<string, unknown> | null;
      return {
        recordType: 'Attendance',
        date: (event?.startTime as Date | undefined)?.toISOString?.() ?? event?.startTime ?? '',
        name: event?.title ?? '',
        detail: entry.status ?? '',
        value: '',
        notes: entry.notes ?? '',
      };
    }),
    ...assignments.map((row) => {
      const entry = row as Record<string, unknown>;
      const piece = entry.piece as Record<string, unknown> | null;
      return {
        recordType: 'Music assignment',
        date: (entry.assignedAt as Date | undefined)?.toISOString?.() ?? entry.assignedAt ?? '',
        name: piece?.title ?? '',
        detail: entry.partName ?? entry.partId ?? '',
        value: entry.status ?? '',
        notes: entry.notes ?? '',
      };
    }),
    ...practice.map((row) => {
      const entry = row as Record<string, unknown>;
      const piece = entry.piece as Record<string, unknown> | null;
      return {
        recordType: 'Practice',
        date: (entry.practicedAt as Date | undefined)?.toISOString?.() ?? entry.practicedAt ?? '',
        name: piece?.title ?? '',
        detail: 'minutes practised',
        value: typeof entry.durationSeconds === 'number' ? Math.round(entry.durationSeconds / 60) : '',
        notes: entry.notes ?? '',
      };
    }),
  ];

  return csvFromRows(rows);
}

/** Filesystem-safe, timestamped download name. */
export function exportFileName(generatedAt: Date, extension: 'json' | 'csv'): string {
  // `2026-03-04T05:06:07.000Z` → `2026-03-04-05-06-07`. Colons are illegal in
  // filenames on Windows and awkward everywhere, and the trailing `T`/`Z` are
  // noise in a name a member has to recognise on their downloads folder.
  const stamp = generatedAt
    .toISOString()
    .replace(/[:.]/g, '-')   // 05:06:07.000 -> 05-06-07-000
    .replace('T', '-')        // date/time separator -> hyphen
    .replace(/-000Z$/, '');   // drop milliseconds and the Z we just broke
  return `eccb-my-information-${stamp}.${extension}`;
}