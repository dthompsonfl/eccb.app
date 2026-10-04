/**
 * Tests for attendance read authorization.
 *
 * THE DEFECT THESE EXIST FOR
 * --------------------------
 * Every attendance read path failed OPEN on a missing lookup:
 *
 *   per-member:   if (member && targetMember) { checkSectionOverlap() }
 *   bulk/export:  if (member) { where.member = { sections: { some: … } } }
 *
 * A caller holding only `attendance.view.section` (or `.own`) who had NO
 * `Member` row skipped the guard entirely and reached the UNSCOPED query. The
 * CSV export additionally selects `member.email`, so one GET returned every
 * member's name, section and email address.
 *
 * A guard that only denies when it can prove the caller is wrong is not a guard.
 * These tests pin the fail-CLOSED behaviour, and each was mutation-checked:
 * restoring the `if (member)` shape makes them fail.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

const mockCheckUserPermission = vi.fn();
const mockMemberFindFirst = vi.fn();
const mockMemberFindUnique = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    member: {
      findFirst: (...args: unknown[]) => mockMemberFindFirst(...args),
      findUnique: (...args: unknown[]) => mockMemberFindUnique(...args),
    },
  },
}));

vi.mock('@/lib/auth/permissions', () => ({
  checkUserPermission: (...args: unknown[]) => mockCheckUserPermission(...args),
}));

import {
  canReadMemberAttendance,
  resolveAttendanceFilter,
  resolveAttendanceScope,
  getCallerSectionScope,
} from '../access';

const USER = 'user-1';

/** Grant a specific set of attendance permissions to the caller. */
function grant(...perms: string[]) {
  mockCheckUserPermission.mockImplementation((_userId: string, perm: string) =>
    Promise.resolve(perms.includes(perm)),
  );
}

/** Give the caller a Member profile in the given sections. */
function callerProfile(sectionIds: string[], memberId = 'member-self') {
  mockMemberFindFirst.mockResolvedValue({
    id: memberId,
    sections: sectionIds.map((sectionId) => ({ sectionId })),
  });
}

/** No Member profile at all — the trigger for the original fail-open. */
function noCallerProfile() {
  mockMemberFindFirst.mockResolvedValue(null);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveAttendanceScope', () => {
  it('grants unrestricted access to attendance.view.all', async () => {
    grant('attendance.view.all');
    await expect(resolveAttendanceScope(USER)).resolves.toEqual({
      allowed: true,
      scope: 'all',
    });
  });

  it('DENIES a section-scoped caller with NO member profile (the fail-open case)', async () => {
    grant('attendance.view.section');
    noCallerProfile();

    const result = await resolveAttendanceScope(USER);
    // Previously this returned the whole band.
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe('no-member-profile');
  });

  it('DENIES a section-scoped caller who belongs to no section', async () => {
    grant('attendance.view.section');
    callerProfile([]);

    const result = await resolveAttendanceScope(USER);
    expect(result.allowed).toBe(false);
  });

  it('grants section scope listing exactly the caller sections', async () => {
    grant('attendance.view.section');
    callerProfile(['sec-a', 'sec-b']);

    await expect(resolveAttendanceScope(USER)).resolves.toEqual({
      allowed: true,
      scope: 'section',
      sectionIds: ['sec-a', 'sec-b'],
    });
  });

  it('DENIES an own-scoped caller with no member profile', async () => {
    grant('attendance.view.own');
    noCallerProfile();

    const result = await resolveAttendanceScope(USER);
    expect(result.allowed).toBe(false);
  });

  it('denies a caller with no attendance permission at all', async () => {
    grant();
    const result = await resolveAttendanceScope(USER);
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe('no-attendance-permission');
  });
});

describe('canReadMemberAttendance', () => {
  it('allows attendance.view.all to read anyone', async () => {
    grant('attendance.view.all');
    await expect(canReadMemberAttendance(USER, 'anyone')).resolves.toEqual({ allowed: true });
  });

  it('DENIES section scope with no member profile instead of reading through', async () => {
    // THE headline regression: this used to fall through to an unscoped read.
    grant('attendance.view.section');
    noCallerProfile();

    const result = await canReadMemberAttendance(USER, 'victim');
    expect(result.allowed).toBe(false);
  });

  it('allows a section peer', async () => {
    grant('attendance.view.section');
    callerProfile(['sec-a']);
    mockMemberFindUnique.mockResolvedValue({
      id: 'target',
      sections: [{ sectionId: 'sec-a' }, { sectionId: 'sec-z' }],
    });

    await expect(canReadMemberAttendance(USER, 'target')).resolves.toEqual({ allowed: true });
  });

  it('denies a member in a different section', async () => {
    grant('attendance.view.section');
    callerProfile(['sec-a']);
    mockMemberFindUnique.mockResolvedValue({
      id: 'target',
      sections: [{ sectionId: 'sec-z' }],
    });

    const result = await canReadMemberAttendance(USER, 'target');
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe('outside-section');
  });

  it('denies a non-existent target rather than defaulting to allow', async () => {
    grant('attendance.view.section');
    callerProfile(['sec-a']);
    mockMemberFindUnique.mockResolvedValue(null);

    await expect(canReadMemberAttendance(USER, 'ghost')).resolves.toMatchObject({
      allowed: false,
    });
  });

  it('own-scope may read only self', async () => {
    grant('attendance.view.own');
    callerProfile(['sec-a'], 'member-self');

    await expect(canReadMemberAttendance(USER, 'member-self')).resolves.toEqual({ allowed: true });

    const other = await canReadMemberAttendance(USER, 'someone-else');
    expect(other.allowed).toBe(false);
    if (!other.allowed) expect(other.reason).toBe('not-own-record');
  });
});

describe('resolveAttendanceFilter', () => {
  it('is UNRESTRICTED for attendance.view.all (export is unrestricted)', async () => {
    grant('attendance.view.all');
    await expect(resolveAttendanceFilter(USER)).resolves.toEqual({ kind: 'unrestricted' });
  });

  it('returns the INNER relation filter for section scope', async () => {
    // Callers assign this to `where.member`, so it must NOT be wrapped in
    // another `member` key — that produced `where.member.member.sections`.
    grant('attendance.view.section');
    callerProfile(['sec-a', 'sec-b']);

    const result = await resolveAttendanceFilter(USER);
    expect(result.kind).toBe('scoped');
    if (result.kind === 'scoped') {
      expect(result.member).toEqual({
        sections: { some: { sectionId: { in: ['sec-a', 'sec-b'] } } },
      });
      expect(result.member).not.toHaveProperty('member');
    }
  });

  it('DENIES rather than reporting unrestricted when no profile exists', async () => {
    // The export path: previously `where` stayed unscoped and leaked the band.
    grant('attendance.view.section');
    noCallerProfile();

    const result = await resolveAttendanceFilter(USER);
    expect(result.kind).toBe('denied');
    // Explicitly: it must NOT be 'unrestricted', which would mean "no filter".
    expect(result.kind).not.toBe('unrestricted');
  });

  it('returns a memberId filter for own scope', async () => {
    grant('attendance.view.own');
    callerProfile(['sec-a'], 'member-self');

    // Own-scope is expressed as a member relation so callers can keep using the
    // same `where.member` assignment shape.
    await expect(resolveAttendanceFilter(USER)).resolves.toEqual({
      kind: 'scoped',
      member: { id: 'member-self' },
    });
  });
});

describe('getCallerSectionScope', () => {
  it('returns null when the caller has no Member row', async () => {
    noCallerProfile();
    await expect(getCallerSectionScope(USER)).resolves.toBeNull();
  });

  it('returns the member id and section ids when present', async () => {
    callerProfile(['sec-a'], 'member-self');
    await expect(getCallerSectionScope(USER)).resolves.toEqual({
      memberId: 'member-self',
      sectionIds: ['sec-a'],
    });
  });
});
