/**
 * Centralized Stand Access Control
 *
 * Single source of truth for every "can this user do X in the stand?" decision.
 * All API routes and pages must use these helpers rather than inline queries.
 *
 * Policy:
 *   - Privileged roles (DIRECTOR, SUPER_ADMIN, ADMIN, STAFF) → always access
 *   - Librarians → global library access (they run the music library)
 *   - Active members → can access published events (policy: any_member)
 *   - RSVP policy: requires attendance/RSVP record
 *   - Library mode (pieces, no event) → assignment-scoped, see below
 *   - Section leaders → can write SECTION-layer annotations for their section
 *   - Non-members / no session → denied (returns 404 non-enumerating)
 *
 * Piece ("library mode") access is NOT open to every active member. It is
 * delegated to @/lib/music/access, the single source of truth: global roles get
 * everything, and everybody else needs an active MusicAssignment for the piece.
 * Part-level scoping (sibling parts, conductor scores) is enforced there too.
 */

import { prisma } from '@/lib/db';
import { getUserRoles } from '@/lib/auth/permissions';
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth/config';
import { headers } from 'next/headers';
import type { RoleType } from '@prisma/client';
import { getStandSettings } from './settings';
import { canAccessMusicPiece } from '@/lib/music/access';

// ─── Constants ────────────────────────────────────────────────────────────────

const PRIVILEGED_ROLE_TYPES = [
  'DIRECTOR', 'SUPER_ADMIN', 'ADMIN', 'STAFF',
] as const;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StandAccessContext {
  userId: string;
  roles: string[];
  isPrivileged: boolean;
  isDirector: boolean;
  isLibrarian: boolean;
  isSectionLeader: boolean;
  userSectionIds: string[];
  memberId: string | null;
}

// ─── Session Helper ───────────────────────────────────────────────────────────

export async function getStandSession(): Promise<
  { user: { id: string; name?: string | null; email?: string | null } } | NextResponse
> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return session;
}

// ─── Access Context Builder ───────────────────────────────────────────────────

export async function buildAccessContext(userId: string): Promise<StandAccessContext> {
  const [roles, member] = await Promise.all([
    getUserRoles(userId),
    prisma.member.findFirst({
      where: { userId },
      select: { id: true, sections: { select: { sectionId: true, isLeader: true } } },
    }),
  ]);

  const isPrivileged = roles.some((r) => (PRIVILEGED_ROLE_TYPES as readonly string[]).includes(r));
  const isDirector = isPrivileged;
  const isLibrarian = roles.includes('LIBRARIAN') || isPrivileged;
  const isSectionLeader =
    roles.includes('SECTION_LEADER') || (member?.sections.some((s) => s.isLeader) ?? false);
  const userSectionIds = member?.sections.map((s) => s.sectionId) ?? [];

  return { userId, roles, isPrivileged, isDirector, isLibrarian, isSectionLeader, userSectionIds, memberId: member?.id ?? null };
}

// ─── Event Access ─────────────────────────────────────────────────────────────

/**
 * Can the user access a specific event's music stand?
 * Reads accessPolicy from unified SystemSetting store.
 */
export async function canAccessEvent(userId: string, eventId: string): Promise<boolean> {
  const privilegedRole = await prisma.userRole.findFirst({
    where: {
      userId,
      role: { type: { in: PRIVILEGED_ROLE_TYPES as unknown as RoleType[] } },
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    select: { id: true },
  });
  if (privilegedRole) return true;

  const member = await prisma.member.findFirst({
    where: { userId, status: 'ACTIVE' },
    select: { id: true },
  });
  if (!member) return false;

  const event = await prisma.event.findFirst({
    where: { id: eventId, isPublished: true },
    select: { id: true },
  });
  if (!event) return false;

  // If rsvp_only policy: must have an accepted attendance record
  const settings = await getStandSettings();
  if (settings.accessPolicy === 'rsvp_only') {
    const attendance = await prisma.attendance.findFirst({
      where: {
        eventId,
        member: { userId },
        status: { in: ['PRESENT', 'LATE'] },
      },
      select: { id: true },
    });
    return !!attendance;
  }

  return true; // any_member
}

/**
 * Can the user access a specific music piece (library mode)?
 *
 * Delegated to @/lib/music/access so the Stand and the download routes share one
 * policy: global-access roles (incl. LIBRARIAN) see everything; every other
 * member needs an active MusicAssignment for the piece. Part-level restrictions
 * (sibling parts, conductor scores) are enforced by the file-level helper
 * `authorizeMusicFileAccess` and by the Stand file proxy.
 */
export async function canAccessPiece(userId: string, pieceId: string): Promise<boolean> {
  return canAccessMusicPiece(userId, pieceId);
}

// ─── File Access ──────────────────────────────────────────────────────────────

export async function canAccessFile(
  userId: string,
  storageKey: string,
  scope: { eventId?: string; pieceId?: string }
): Promise<boolean> {
  if (!scope.eventId && !scope.pieceId) return false;
  if (scope.eventId) return canAccessEvent(userId, scope.eventId);
  if (scope.pieceId) return canAccessPiece(userId, scope.pieceId);
  return false;
}

// ─── Annotation Access ────────────────────────────────────────────────────────

export function canWriteLayer(
  ctx: StandAccessContext,
  layer: 'PERSONAL' | 'SECTION' | 'DIRECTOR',
  targetSectionId?: string | null
): boolean {
  switch (layer) {
    case 'PERSONAL': return true;
    case 'SECTION':
      if (ctx.isDirector) return true;
      if (!ctx.isSectionLeader) return false;
      // section leaders may write to their own section; if no specific section
      // is supplied we allow any of their sections.
      if (!targetSectionId) return ctx.userSectionIds.length > 0;
      return ctx.userSectionIds.includes(targetSectionId);
    case 'DIRECTOR': return ctx.isDirector;
    default: return false;
  }
}

export function annotationVisibilityFilter(
  ctx: StandAccessContext,
  musicId: string | string[]
): Record<string, unknown> {
  const musicFilter = Array.isArray(musicId) ? { musicId: { in: musicId } } : { musicId };
  if (ctx.isDirector) return musicFilter;
  return {
    ...musicFilter,
    OR: [
      { layer: 'PERSONAL', userId: ctx.userId },
      { layer: 'SECTION', ...(ctx.userSectionIds.length > 0 ? { sectionId: { in: ctx.userSectionIds } } : { sectionId: '__none__' }) },
      { layer: 'DIRECTOR' },
    ],
  };
}

// ─── API Guard Helpers ────────────────────────────────────────────────────────

/**
 * Combined session + active-member guard for API routes.
 * Returns the access context on success, or a NextResponse (401/404) on failure.
 */
export async function requireStandAccess(): Promise<StandAccessContext | NextResponse> {
  const session = await getStandSession();
  if (session instanceof NextResponse) return session;

  const ctx = await buildAccessContext(session.user.id);
  if (!ctx.memberId && !ctx.isPrivileged) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  return ctx;
}

/**
 * Combined session + event access guard. Returns 404 (non-enumerating) if unauthorized.
 */
export async function requireEventStandAccess(
  eventId: string
): Promise<StandAccessContext | NextResponse> {
  const session = await getStandSession();
  if (session instanceof NextResponse) return session;

  const [ctx, hasAccess] = await Promise.all([
    buildAccessContext(session.user.id),
    canAccessEvent(session.user.id, eventId),
  ]);
  if (!hasAccess) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return ctx;
}

/**
 * Session + piece access guard (library mode). Returns 404 if unauthorized.
 */
export async function requirePieceLibraryAccess(
  pieceId: string
): Promise<StandAccessContext | NextResponse> {
  const session = await getStandSession();
  if (session instanceof NextResponse) return session;

  const [ctx, hasAccess] = await Promise.all([
    buildAccessContext(session.user.id),
    canAccessPiece(session.user.id, pieceId),
  ]);
  if (!hasAccess) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return ctx;
}

/**
 * Assert a user can write the given annotation layer. Returns error response or null.
 */
export function assertCanWriteLayer(
  ctx: StandAccessContext,
  layer: 'PERSONAL' | 'SECTION' | 'DIRECTOR',
  sectionId?: string | null
): NextResponse | null {
  if (!canWriteLayer(ctx, layer, sectionId)) {
    // provide a little more context for diagnostics/tests
    return NextResponse.json({ error: `Forbidden: insufficient layer permissions (${layer.toLowerCase()})` }, { status: 403 });
  }
  return null;
}

/** Backwards-compat alias */
export const requireEventAccess = requireEventStandAccess;
