/**
 * Authorization for attendance reads.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every attendance read path had the same defect, in two shapes:
 *
 *   1. Per-member reads:
 *        if (member && targetMember) { /* check *\/ }
 *      A section-scoped caller with NO `Member` row skipped the check entirely
 *      and fell through to `where: { memberId }` — the requested member's
 *      attendance, including event titles, dates and free-text notes.
 *
 *   2. Bulk reads / CSV exports:
 *        if (member) { where.member = { sections: { some: … } } }
 *      A section-scoped caller with no `Member` row left `where` UNSCOPED and
 *      exported the whole band — including each member's email address — in a
 *      single request.
 *
 * The bug class is fail-OPEN on a missing lookup. A guard that only denies when
 * it can prove the caller is wrong is not a guard. Both shapes are replaced here
 * by one function that always returns a decision, so the logic is testable in
 * isolation and cannot drift between the route and the server action.
 *
 * The rule, stated once:
 *   - `attendance.view.all`   → unrestricted.
 *   - `attendance.view.section` → restricted to the caller's own sections.
 *     With NO member profile the caller belongs to no section, so they can see
 *     NOBODY's attendance. That is a deny, not a fallback to unrestricted.
 */

import { prisma } from '@/lib/db';
import {
  ATTENDANCE_VIEW_ALL,
  ATTENDANCE_VIEW_OWN,
  ATTENDANCE_VIEW_SECTION,
} from '@/lib/auth/permission-constants';
import { checkUserPermission } from '@/lib/auth/permissions';

export interface AttendanceAccessContext {
  userId: string;
}

export type AttendanceDenialReason =
  | 'not-authenticated'
  | 'no-attendance-permission'
  | 'no-member-profile'
  | 'not-own-record'
  | 'outside-section';

export interface SectionIdsFor {
  memberId: string;
  sectionIds: string[];
}

/** Resolve the caller's own `Member` row plus their section memberships. */
export async function getCallerSectionScope(
  userId: string,
): Promise<SectionIdsFor | null> {
  const member = await prisma.member.findFirst({
    where: { userId },
    include: { sections: true },
  });
  if (!member) return null;
  return {
    memberId: member.id,
    sectionIds: member.sections.map((s) => s.sectionId),
  };
}

export type AttendanceAccessDecision =
  | { allowed: true; scope: 'all' }
  | { allowed: true; scope: 'section'; sectionIds: string[] }
  | { allowed: true; scope: 'own'; memberId: string }
  | { allowed: false; reason: AttendanceDenialReason };

/**
 * Decide what attendance the caller may read, in bulk.
 *
 * Returns the WIDEST scope the caller is entitled to. Callers must apply the
 * returned scope to their query — never to their assumptions about it.
 */
export async function resolveAttendanceScope(
  userId: string,
): Promise<AttendanceAccessDecision> {
  const [hasAll, hasSection, hasOwn] = await Promise.all([
    checkUserPermission(userId, ATTENDANCE_VIEW_ALL),
    checkUserPermission(userId, ATTENDANCE_VIEW_SECTION),
    checkUserPermission(userId, ATTENDANCE_VIEW_OWN),
  ]);

  if (hasAll) return { allowed: true, scope: 'all' };

  if (hasSection) {
    const caller = await getCallerSectionScope(userId);
    // Fail CLOSED: no member profile means no sections, so this is an empty
    // section scope — which matches nobody, rather than everybody.
    if (!caller) return { allowed: false, reason: 'no-member-profile' };
    if (caller.sectionIds.length === 0) return { allowed: false, reason: 'outside-section' };
    return { allowed: true, scope: 'section', sectionIds: caller.sectionIds };
  }

  if (hasOwn) {
    const caller = await getCallerSectionScope(userId);
    // Own-scope without a profile cannot identify "own".
    if (!caller) return { allowed: false, reason: 'no-member-profile' };
    return { allowed: true, scope: 'own', memberId: caller.memberId };
  }

  return { allowed: false, reason: 'no-attendance-permission' };
}

/**
 * Decide whether the caller may read ONE member's attendance record.
 *
 * `targetMemberId` must be a real, resolvable member. A caller with
 * `attendance.view.own` may only read their own; a caller with
 * `attendance.view.section` may read a member who shares a section with them.
 */
export async function canReadMemberAttendance(
  userId: string,
  targetMemberId: string,
): Promise<{ allowed: true } | { allowed: false; reason: AttendanceDenialReason }> {
  const decision = await resolveAttendanceScope(userId);
  if (!decision.allowed) return { allowed: false, reason: decision.reason };
  if (decision.scope === 'all') return { allowed: true };

  if (decision.scope === 'own') {
    if (decision.memberId === targetMemberId) return { allowed: true };
    return { allowed: false, reason: 'not-own-record' };
  }

  // Section scope: the target must exist and share a section with the caller.
  const target = await prisma.member.findUnique({
    where: { id: targetMemberId },
    include: { sections: true },
  });
  if (!target) return { allowed: false, reason: 'no-member-profile' };

  const shares = target.sections.some((s) => decision.sectionIds.includes(s.sectionId));
  return shares ? { allowed: true } : { allowed: false, reason: 'outside-section' };
}

/**
 * Build the Prisma `where` fragment that confines a bulk attendance query to
 * the caller's scope, as a single tagged result.
 *
 * Returns `unrestricted` for `attendance.view.all`, `denied` when the caller has
 * no usable scope, and otherwise an ALWAYS-present filter. Crucially, a caller
 * with section scope but no member profile is denied rather than handed an
 * empty filter, and there is no path that returns "no filter" by accident.
 *
 * Prefer this over the older three-way return: `'denied' in x` does not narrow
 * away `undefined`, which is a footgun at every call site.
 */
export type AttendanceScopeFilter =
  | { kind: 'denied'; reason: AttendanceDenialReason }
  | { kind: 'unrestricted' }
  | { kind: 'scoped'; filter: Record<string, unknown> };

export async function resolveAttendanceFilter(
  userId: string,
): Promise<AttendanceScopeFilter> {
  const decision = await resolveAttendanceScope(userId);
  if (!decision.allowed) return { kind: 'denied', reason: decision.reason };
  if (decision.scope === 'all') return { kind: 'unrestricted' };

  if (decision.scope === 'own') {
    return { kind: 'scoped', filter: { memberId: decision.memberId } };
  }

  return {
    kind: 'scoped',
    filter: { member: { sections: { some: { sectionId: { in: decision.sectionIds } } } } },
  };
}
