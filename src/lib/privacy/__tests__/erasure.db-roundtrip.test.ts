/**
 * REAL DATABASE round-trip test for the Art. 17 erasure flow.
 *
 * Every other erasure test uses a fake Prisma. This one talks to the actual
 * MariaDB, because the single most dangerous claim in the flow is a FOREIGN KEY
 * claim — `Annotation_userId_fkey` is `ON DELETE RESTRICT` — and a hand-written
 * fake can only ever be as faithful as the author's belief about MySQL.
 *
 * Two properties are proven here that a mock cannot prove:
 *
 *   1. A naive `prisma.user.delete` really IS rejected by the database when the
 *      subject has annotations. If this ever stops being true, the ordering
 *      constraint in `runErasureTransaction` is no longer load-bearing and the
 *      code should be simplified rather than left defending a phantom.
 *
 *   2. `runErasureTransaction` completes against real FKs, real cascades and
 *      real `SET NULL` clauses, leaving the attendance history intact and the
 *      Member row anonymised.
 *
 * It is self-cleaning: everything it creates is deleted in `afterAll`, and every
 * row uses a `__gdpr-rt-<random>` marker so it can never collide with band data.
 * If no database is reachable the suite is skipped rather than failed, because a
 * developer's machine without a running MariaDB should not see a red build.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';

/**
 * A REAL Prisma client, wired up by hand.
 *
 * `@/lib/db` deliberately returns `{}` under vitest (see the NODE_ENV==='test'
 * branch in src/lib/db/index.ts) so that the rest of the suite can mock it, and
 * the global test setup points DATABASE_URL at a placeholder Postgres URL. So
 * importing it here would silently hand back an empty object and every assertion
 * below would "pass" without touching a database — the exact false-green this
 * file exists to rule out.
 *
 * Instead we read the developer's real DATABASE_URL out of .env and build a
 * client ourselves, then hand it to the module under test by mocking
 * `@/lib/db` with it. If the database cannot be reached the suite FAILS rather
 * than skipping; see the reachability assertion below.
 */
function readRealDatabaseUrl(): string | undefined {
  try {
    const contents = readFileSync('.env', 'utf8');
    const match = /^DATABASE_URL\s*=\s*["']?([^"'\n]+)["']?/m.exec(contents);
    return match?.[1];
  } catch {
    return undefined;
  }
}

function buildRealClient(): PrismaClient | null {
  const url = readRealDatabaseUrl();
  if (!url) return null;

  const normalised = url.replace(/^(mariadb|postgresql|postgres):\/\//, 'mysql://');
  const parsed = new URL(normalised);
  if (!parsed.protocol.startsWith('mysql')) return null;

  return new PrismaClient({
    adapter: new PrismaMariaDb({
      host: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : 3306,
      user: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
      database: parsed.pathname.replace(/^\//, ''),
      connectionLimit: 2,
    }),
    log: ['error'],
  });
}

// `vi.mock` factories are hoisted above every top-level declaration, so the
// real client is published on globalThis and read back through a getter — the
// same pattern the repo's own redis/prisma singletons use. The client itself is
// built inside the factory, where `beforeAll` has not yet run but the module
// imports it needs are available.
vi.mock('@/lib/db', () => {
  const client = buildRealClient();
  if (!client) {
    throw new Error(
      '[privacy db round-trip] could not build a real Prisma client — no usable DATABASE_URL in .env',
    );
  }
  (globalThis as { __privacyRealPrisma?: PrismaClient }).__privacyRealPrisma = client;
  return {
    get prisma() {
      return (globalThis as { __privacyRealPrisma?: PrismaClient }).__privacyRealPrisma;
    },
  };
});

import { prisma } from '@/lib/db';
import { runErasureTransaction } from '@/lib/privacy/erasure';
import { buildPersonalDataExport } from '@/lib/privacy/export';

const MARKER = `__gdpr-rt-${randomUUID().slice(0, 8)}`;
const PASSWORD_HASH = `$2b$12$${MARKER}${'x'.repeat(40)}`;

const SUBJECT_USER_ID = `${MARKER}-user`;
const SUBJECT_MEMBER_ID = `${MARKER}-member`;
const PIECE_ID = `${MARKER}-piece`;
const EVENT_ID = `${MARKER}-event`;
const OTHER_EMAIL = `${MARKER}-other@example.com`;

const SELF = {
  callerUserId: SUBJECT_USER_ID,
  subjectUserId: SUBJECT_USER_ID,
  isSelf: true,
  isAdmin: false,
};

/**
 * Whether the live DB was reachable. Only the guard test consults it; every
 * other test runs unconditionally, so a broken connection fails loudly rather
 * than reporting a green run that proved nothing.
 */
let databaseReachable = false;

async function canReachDatabase(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  databaseReachable = await canReachDatabase();

  await prisma.user.create({
    data: {
      id: SUBJECT_USER_ID,
      email: `${MARKER}@example.com`,
      name: 'Round Trip',
      password: PASSWORD_HASH,
      emailVerified: true,
      twoFactorEnabled: true,
    },
  });

  await prisma.twoFactor.create({
    data: {
      id: `${MARKER}-2fa`,
      userId: SUBJECT_USER_ID,
      secret: `${MARKER}-totp-secret`,
      backupCodes: `${MARKER}-backup-codes`,
    },
  });

  await prisma.session.create({
    data: {
      id: `${MARKER}-session`,
      userId: SUBJECT_USER_ID,
      token: `${MARKER}-live-session-token`,
      expiresAt: new Date(Date.now() + 86_400_000),
      ipAddress: '203.0.113.7',
      userAgent: 'RoundTrip/1.0',
    },
  });

  await prisma.pushSubscription.create({
    data: {
      id: `${MARKER}-push`,
      userId: SUBJECT_USER_ID,
      endpoint: `https://push.example.com/${MARKER}`,
      p256dh: `${MARKER}-p256dh`,
      auth: `${MARKER}-push-auth`,
    },
  });

  await prisma.userPreferences.create({
    data: {
      id: `${MARKER}-prefs`,
      userId: SUBJECT_USER_ID,
      pushEnabled: true,
      pushConsentedAt: new Date('2025-03-01T12:00:00Z'),
    },
  });

  await prisma.member.create({
    data: {
      id: SUBJECT_MEMBER_ID,
      userId: SUBJECT_USER_ID,
      firstName: 'Round',
      lastName: 'Trip',
      email: `${MARKER}-member@example.com`,
      phone: '555-123-4567',
      emergencyName: 'Emergency Contact',
      emergencyPhone: '555-987-6543',
      emergencyEmail: `${MARKER}-emergency@example.com`,
      notes: 'Distinctive note that must not survive erasure',
      status: 'ACTIVE',
    },
  });

  await prisma.event.create({
    data: {
      id: EVENT_ID,
      title: `${MARKER} rehearsal`,
      type: 'REHEARSAL',
      startTime: new Date('2026-01-04T19:00:00Z'),
      endTime: new Date('2026-01-04T21:00:00Z'),
      isPublished: true,
    },
  });

  await prisma.attendance.create({
    data: {
      id: `${MARKER}-attendance`,
      eventId: EVENT_ID,
      memberId: SUBJECT_MEMBER_ID,
      status: 'PRESENT',
      notes: 'Distinctive attendance note that must not survive erasure',
      markedBy: 'Round Trip Marker',
      markedAt: new Date('2026-01-04T19:05:00Z'),
    },
  });

  await prisma.musicPiece.create({
    data: {
      id: PIECE_ID,
      title: `${MARKER} march`,
    },
  });

  await prisma.musicAssignment.create({
    data: {
      id: `${MARKER}-assignment`,
      pieceId: PIECE_ID,
      memberId: SUBJECT_MEMBER_ID,
      partName: '2nd Flute',
      status: 'LOST',
      notes: 'Distinctive assignment note that must not survive erasure',
      assignedBy: 'Round Trip Assigner',
    },
  });

  // A third party whose email must never surface in the subject's export.
  await prisma.auditLog.create({
    data: {
      id: `${MARKER}-audit`,
      userId: SUBJECT_USER_ID,
      userName: 'Round Trip',
      ipAddress: '203.0.113.7',
      userAgent: 'RoundTrip/1.0',
      action: 'member.update',
      entityType: 'Member',
      entityId: 'some-other-member',
      oldValues: JSON.stringify({ email: OTHER_EMAIL }),
      newValues: JSON.stringify({ email: `${MARKER}@example.com` }),
    },
  });

  // The FK-heavy case: two annotations authored by the subject.
  await prisma.annotation.createMany({
    data: [
      {
        id: `${MARKER}-ann-1`,
        musicId: PIECE_ID,
        page: 1,
        layer: 'PERSONAL',
        strokeData: JSON.stringify([{ x: 1, y: 2 }]),
        userId: SUBJECT_USER_ID,
      },
      {
        id: `${MARKER}-ann-2`,
        musicId: PIECE_ID,
        page: 2,
        layer: 'PERSONAL',
        strokeData: JSON.stringify([{ x: 3, y: 4 }]),
        userId: SUBJECT_USER_ID,
      },
    ],
  });
});

afterAll(async () => {
  if (!databaseReachable) return; // nothing was created, nothing to clean up
  try {
    // Order matters: children before parents, since some of these FKs RESTRICT.
    await prisma.annotation.deleteMany({ where: { id: { startsWith: MARKER } } });
    await prisma.auditLog.deleteMany({ where: { id: { startsWith: MARKER } } });
    await prisma.attendance.deleteMany({ where: { id: { startsWith: MARKER } } });
    await prisma.musicAssignment.deleteMany({ where: { id: { startsWith: MARKER } } });
    await prisma.musicPiece.deleteMany({ where: { id: { startsWith: MARKER } } });
    await prisma.event.deleteMany({ where: { id: { startsWith: MARKER } } });
    await prisma.member.deleteMany({ where: { id: { startsWith: MARKER } } });
    await prisma.pushSubscription.deleteMany({ where: { id: { startsWith: MARKER } } });
    await prisma.userPreferences.deleteMany({ where: { id: { startsWith: MARKER } } });
    await prisma.session.deleteMany({ where: { id: { startsWith: MARKER } } });
    await prisma.twoFactor.deleteMany({ where: { id: { startsWith: MARKER } } });
    await prisma.user.deleteMany({ where: { id: { startsWith: MARKER } } });
  } catch (error) {
    console.warn('[privacy db round-trip] cleanup failed:', error);
  }
  await prisma.$disconnect();
});

describe('erasure against a real database', () => {
  it('was actually connected to a live database, not silently skipped', async () => {
    // A suite that quietly no-ops when the DB is down is worse than no suite:
    // it reports green while proving nothing. If the machine running
    // `npm run test:run` has no MariaDB, say so loudly here.
    if (!databaseReachable) {
      throw new Error(
        'This suite requires a live database. Start MariaDB, or exclude ' +
          'erasure.db-roundtrip.test.ts from your vitest run if you have none.',
      );
    }
    expect(await prisma.annotation.count({ where: { id: { startsWith: MARKER } } })).toBe(2);
  }, 30_000);

  it('confirms the FK constraint really does block a naive user delete', async () => {
    const before = await prisma.annotation.count({ where: { userId: SUBJECT_USER_ID } });
    expect(before).toBe(2);

    // If this SUCCEEDS, the DB no longer RESTRICTs and the ordering in
    // runErasureTransaction is defending a constraint that is not there. The
    // assertions after it are then proving less than they claim to.
    await expect(
      prisma.user.delete({ where: { id: SUBJECT_USER_ID } }),
    ).rejects.toThrow();
  }, 30_000);

  it('exports without leaking any secret stored for the subject', async () => {
    const document = await buildPersonalDataExport(SUBJECT_USER_ID);
    const serialised = JSON.stringify(document);

    // Real values read out of real rows — not fixtures invented for the test.
    expect(serialised).not.toContain(PASSWORD_HASH);
    expect(serialised).not.toContain(`${MARKER}-live-session-token`);
    expect(serialised).not.toContain(`${MARKER}-totp-secret`);
    expect(serialised).not.toContain(`${MARKER}-backup-codes`);
    expect(serialised).not.toContain(`${MARKER}-p256dh`);
    expect(serialised).not.toContain(`${MARKER}-push-auth`);
    expect(serialised).not.toContain(`https://push.example.com/${MARKER}`);

    // The subject's own data really is there, so the assertions above mean
    // something.
    expect(serialised).toContain('Round');
    expect(serialised).toContain('2nd Flute');
    expect(serialised).toContain('PRESENT');
  }, 30_000);

  it('does not leak the third party’s email through the audit trail', async () => {
    const document = await buildPersonalDataExport(SUBJECT_USER_ID);
    const serialised = JSON.stringify(document);

    expect(serialised).not.toContain(OTHER_EMAIL);
    // But the subject's own audit entry survives, third party scrubbed.
    expect(serialised).toContain('member.update');
  }, 30_000);

  it('erases the FK-heavy subject without a constraint violation', async () => {
    const manifest = await runErasureTransaction(SUBJECT_USER_ID, SELF);

    expect(manifest.alreadyApplied).toBe(false);
    expect(manifest.subjectMemberId).toBe(SUBJECT_MEMBER_ID);

    // The user row is really gone.
    expect(await prisma.user.findUnique({ where: { id: SUBJECT_USER_ID } })).toBeNull();

    // Annotations deleted first, so RESTRICT never fired.
    expect(await prisma.annotation.count({ where: { userId: SUBJECT_USER_ID } })).toBe(0);

    // Credentials and endpoints gone.
    expect(await prisma.session.count({ where: { userId: SUBJECT_USER_ID } })).toBe(0);
    expect(await prisma.twoFactor.count({ where: { userId: SUBJECT_USER_ID } })).toBe(0);
    expect(await prisma.pushSubscription.count({ where: { userId: SUBJECT_USER_ID } })).toBe(0);
    expect(await prisma.userPreferences.count({ where: { userId: SUBJECT_USER_ID } })).toBe(0);

    // Manifest agrees with the database.
    const annotationEntry = manifest.deleted.find((entry) => entry.record.includes('Annotations'));
    expect(annotationEntry?.count).toBe(2);
  }, 30_000);

  it('anonymises the member row but keeps the attendance history', async () => {
    const member = await prisma.member.findUnique({ where: { id: SUBJECT_MEMBER_ID } });
    expect(member).not.toBeNull();
    expect(member?.firstName).toBe('Erased');
    expect(member?.lastName).toBe('Member');
    expect(member?.email).toBeNull();
    expect(member?.phone).toBeNull();
    expect(member?.emergencyName).toBeNull();
    expect(member?.emergencyPhone).toBeNull();
    expect(member?.emergencyEmail).toBeNull();
    expect(member?.notes).toBeNull();
    expect(member?.userId).toBeNull();
    expect(member?.deletedAt).not.toBeNull();

    // The row survived precisely so this row still exists.
    const attendance = await prisma.attendance.findUnique({
      where: { id: `${MARKER}-attendance` },
    });
    expect(attendance).not.toBeNull();
    expect(attendance?.status).toBe('PRESENT');
    expect(attendance?.notes).toBeNull();
    expect(attendance?.markedBy).toBeNull();
  }, 30_000);

  it('anonymises the music assignment but keeps the hand-off record', async () => {
    const assignment = await prisma.musicAssignment.findUnique({
      where: { id: `${MARKER}-assignment` },
    });
    expect(assignment).not.toBeNull();
    expect(assignment?.status).toBe('LOST');
    expect(assignment?.partName).toBe('2nd Flute');
    expect(assignment?.notes).toBeNull();
    expect(assignment?.assignedBy).toBeNull();
  }, 30_000);

  it('anonymises the audit rows and scrubs the third party out of them', async () => {
    const audit = await prisma.auditLog.findUnique({ where: { id: `${MARKER}-audit` } });
    expect(audit).not.toBeNull();
    // The SET NULL clause handled userId when the user row went.
    expect(audit?.userId).toBeNull();
    expect(audit?.userName).toBeNull();
    expect(audit?.ipAddress).toBeNull();
    expect(audit?.oldValues).not.toContain(OTHER_EMAIL);
    expect(audit?.oldValues).toContain('[redacted');
  }, 30_000);

  it('leaves an erasure audit row an auditor can find', async () => {
    const trail = await prisma.auditLog.findMany({
      where: { action: 'privacy.erasure.executed', entityId: SUBJECT_USER_ID },
    });
    expect(trail.length).toBeGreaterThanOrEqual(1);
    // It must not re-identify the subject it just erased.
    expect(trail[0].userId).toBeNull();
  }, 30_000);

  it('is idempotent when run again against the erased subject', async () => {
    const second = await runErasureTransaction(SUBJECT_USER_ID, SELF);
    expect(second.alreadyApplied).toBe(true);
    expect(second.deleted.every((entry) => entry.count === 0)).toBe(true);

    // And the retained history was not double-attacked.
    const attendance = await prisma.attendance.findUnique({
      where: { id: `${MARKER}-attendance` },
    });
    expect(attendance?.status).toBe('PRESENT');
  }, 30_000);
});