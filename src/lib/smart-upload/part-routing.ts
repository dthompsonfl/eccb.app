/**
 * Part Routing — resolve a committed MusicPart to the members who should play it.
 *
 * The product requirement is that a librarian uploads one full score and
 * "everything just happens": the parts are cut, committed, and delivered to the
 * right players with no manual admin step. `commit.ts` creates the piece, the
 * files and the parts; this module is the missing last mile — it turns those
 * parts into `MusicAssignment` rows so each player actually sees their own part
 * in "My Music" and the Digital Music Stand.
 *
 * Why this is a pure module with a thin DB adapter
 * ------------------------------------------------
 * Routing correctness is entirely a function of (a) how a part label canonicalises
 * and (b) what the roster says, so both are expressed as pure functions that can
 * be unit-tested against real labels with no database. `loadRoster` /
 * `applyRouting` are the only impure parts.
 *
 * Canonicalisation is mandatory, not cosmetic
 * ------------------------------------------
 * The roster stores whatever name an admin typed into the Instrument table. The
 * seed writes `B♭ Clarinet` (U+266D), `French Horn`, `Mallets`; the smart-upload
 * normalizer emits `Bb Clarinet` (ASCII), `Horn`, `Mallet Percussion`. Exact string
 * equality between the two would silently route *nothing*, which looks identical
 * to "routing is broken". Every comparison here therefore goes through
 * `canonicalInstrumentKey` on BOTH sides.
 *
 * Chairs
 * ------
 * Concert-band parts are per-desk ("1st Clarinet", "2nd Clarinet"). When one
 * instrument has several parts and several players, chairs are handed out in
 * chair order so 1st chair goes to the alphabetically-first player. That is a
 * convention, not a fact, so it is deterministic and documented rather than
 * random — and it is stable across re-commits, which is what makes routing
 * idempotent.
 *
 * Unroutable parts
 * ----------------
 * A part that no active member plays is NEVER fanned out to a whole section on a
 * guess and NEVER silently dropped. It is returned in `unroutedParts` so commit
 * can surface it to a human. Guessing here means either handing a bassoon part to
 * a flautist (a musician is handed music they cannot play) or silently losing it
 * (a section has no music at the concert with no explanation). Both are worse
 * than a named gap in an admin list.
 */

import type { Prisma } from '@prisma/client';
import {
  CANONICAL_INSTRUMENTS,
  findByFuzzyMatch,
} from './canonical-instruments';

// =============================================================================
// Types
// =============================================================================

/** One active member's playable instruments, as recorded in the roster. */
export interface RosterMember {
  memberId: string;
  firstName: string;
  lastName: string;
  /** Instrument names exactly as stored in `Instrument.name`. */
  instrumentNames: string[];
  /** Section names, used only to explain *why* a part is unroutable. */
  sectionNames: string[];
}

/** A committed part, reduced to what routing needs. */
export interface RoutablePart {
  partId: string;
  partName: string;
  /** Canonical (chair-prefixed) instrument label, e.g. "1st Bb Clarinet". */
  instrumentLabel: string;
  /** Section label as recorded on the part, e.g. "Woodwinds". */
  section?: string | null;
}

export type RoutingReason =
  /** No active member plays this instrument. */
  | 'NO_MEMBER_FOR_INSTRUMENT'
  /** Score-type parts (conductor score) are staff material, not a player desk. */
  | 'SCORE_NOT_A_DESK'
  /** The label could not be canonicalised to any known instrument. */
  | 'UNKNOWN_INSTRUMENT';

export interface UnroutedPart {
  partId: string;
  partName: string;
  instrumentLabel: string;
  /** Canonical instrument name, or null when the label is unrecognisable. */
  canonicalInstrument: string | null;
  reason: RoutingReason;
  /** Human-readable explanation for the admin review list. */
  detail: string;
}

export interface PartAssignment {
  partId: string;
  partName: string;
  memberId: string;
  memberName: string;
  /** Canonical instrument both sides agreed on. */
  canonicalInstrument: string;
  /** Desk this member was given, when the part carried a chair. */
  chair: string | null;
}

export interface RoutingPlan {
  assignments: PartAssignment[];
  unroutedParts: UnroutedPart[];
}

// =============================================================================
// Canonicalisation
// =============================================================================

/**
 * Instruments that share a desk in a concert band.
 *
 * A cornet part goes to the trumpet player. Flugelhorn likewise. This is standard
 * band practice, not a fuzzy guess — without it a score with cornet parts would
 * report "no member for instrument" on a band whose only brass player is a
 * trumpeter, which is both wrong and alarming to a librarian.
 *
 * Keyed by canonical name; values are the canonical name the desk is reported under.
 */
const DESK_EQUIVALENTS: Readonly<Record<string, string>> = {
  Cornet: 'Trumpet',
  Flugelhorn: 'Trumpet',
};

/** Canonical names that represent staff material rather than a player desk. */
const SCORE_CANONICAL_NAMES: ReadonlySet<string> = new Set([
  'Full Score',
  'Condensed Score',
]);

/**
 * Reduce any instrument label to a stable routing key.
 *
 * Strips a leading chair ordinal, resolves aliases and OCR noise through the
 * canonical registry, then folds desk-equivalents onto one key. Returns `null`
 * for labels that match no known instrument — the caller must treat that as
 * unroutable, never as a pass-through string to compare against.
 */
export function canonicalInstrumentKey(label: string): string | null {
  const trimmed = (label ?? '').trim();
  if (!trimmed) return null;

  const match = findByFuzzyMatch(trimmed);
  if (!match) return null;

  return DESK_EQUIVALENTS[match.name] ?? match.name;
}

/**
 * Split a canonical part label into its chair and its canonical instrument.
 *
 * `normalizeInstrumentLabel` produces chair-prefixed names ("1st Bb Clarinet"),
 * so the chair has to come back off before the instrument can be canonicalised.
 */
export function splitChair(label: string): {
  chair: string | null;
  instrumentLabel: string;
} {
  const trimmed = (label ?? '').trim();
  const chairMatch = /^(1st|2nd|3rd|4th|Aux|Solo)\s+/i.exec(trimmed);
  if (!chairMatch) return { chair: null, instrumentLabel: trimmed };
  return {
    chair: chairMatch[1],
    instrumentLabel: trimmed.slice(chairMatch[0].length).trim(),
  };
}

/** Seat order for chairs. Unchaired parts sort last (they are shared, not seated). */
const CHAIR_ORDER: readonly string[] = ['1st', '2nd', '3rd', '4th', 'Solo', 'Aux'];

function isScoreLabel(label: string): boolean {
  const canonical = canonicalInstrumentKey(label);
  return canonical !== null && SCORE_CANONICAL_NAMES.has(canonical);
}

function memberDisplayName(member: RosterMember): string {
  return `${member.firstName} ${member.lastName}`.trim();
}

// =============================================================================
// Pure planner
// =============================================================================

/**
 * Decide which member plays which part.
 *
 * Pure: the same roster and parts always yield the same plan, which is what makes
 * a re-commit after a crash converge instead of drifting.
 */
export function planPartRouting(
  parts: readonly RoutablePart[],
  roster: readonly RosterMember[],
): RoutingPlan {
  const assignments: PartAssignment[] = [];
  const unroutedParts: UnroutedPart[] = [];

  // ── Index the roster by canonical instrument ─────────────────────────────
  const byInstrument = new Map<string, RosterMember[]>();
  for (const member of roster) {
    // A member appears once per playable instrument. De-duplicate so a member
    // listed twice for the same desk cannot be seated at it twice.
    const seen = new Set<string>();
    for (const name of member.instrumentNames) {
      const key = canonicalInstrumentKey(name);
      if (!key || seen.has(key)) continue;
      seen.add(key);

      const bucket = byInstrument.get(key);
      if (bucket) {
        if (!bucket.some((m) => m.memberId === member.memberId)) bucket.push(member);
      } else {
        byInstrument.set(key, [member]);
      }
    }
  }

  // Deterministic order: the seating order must not depend on DB row order, or
  // two runs of the same upload would hand the chairs out differently.
  for (const bucket of byInstrument.values()) {
    bucket.sort((a, b) =>
      memberDisplayName(a).localeCompare(memberDisplayName(b), 'en') ||
      a.memberId.localeCompare(b.memberId),
    );
  }

  // ── Group parts by instrument so chairs can be dealt in order ────────────
  const groups = new Map<string, RoutablePart[]>();
  for (const part of parts) {
    const { chair, instrumentLabel } = splitChair(part.instrumentLabel);
    const canonical = canonicalInstrumentKey(instrumentLabel);

    if (!canonical) {
      unroutedParts.push({
        partId: part.partId,
        partName: part.partName,
        instrumentLabel: part.instrumentLabel,
        canonicalInstrument: null,
        reason: 'UNKNOWN_INSTRUMENT',
        detail: `"${part.instrumentLabel}" does not match any known instrument. Set the member's instrument in their profile, or assign this part by hand.`,
      });
      continue;
    }

    if (SCORE_CANONICAL_NAMES.has(canonical) || isScoreLabel(part.instrumentLabel)) {
      unroutedParts.push({
        partId: part.partId,
        partName: part.partName,
        instrumentLabel: part.instrumentLabel,
        canonicalInstrument: canonical,
        reason: 'SCORE_NOT_A_DESK',
        detail: `"${part.partName}" is a score, not a player part. Staff see it through their library access.`,
      });
      continue;
    }

    const bucket = groups.get(canonical);
    const entry: RoutablePart = { ...part, instrumentLabel: `${chair ? `${chair} ` : ''}${canonical}` };
    if (bucket) bucket.push(entry);
    else groups.set(canonical, [entry]);
  }

  for (const [canonical, group] of groups) {
    const candidates = byInstrument.get(canonical) ?? [];

    if (candidates.length === 0) {
      for (const part of group) {
        const sections = describeSectionsFor(roster, canonical);
        unroutedParts.push({
          partId: part.partId,
          partName: part.partName,
          instrumentLabel: part.instrumentLabel,
          canonicalInstrument: canonical,
          reason: 'NO_MEMBER_FOR_INSTRUMENT',
          detail:
            `No active member plays ${canonical}.` +
            (sections ? ` The ${sections} section has no rostered ${canonical} player either.` : '') +
            ' Assign this part by hand, or add a player to that section.',
        });
      }
      continue;
    }

    // Seat the chairs. Parts are dealt in CHAIR order, never in the order they
    // happened to arrive: a re-split or a retry can present the same desks in a
    // different order, and seating by arrival would hand 1st chair to whichever
    // part the pipeline happened to emit first. Sorting by chair rank is what
    // makes routing converge across re-commits.
    const seated = new Map<string, string>(); // memberId -> chair

    const chairRank = (chair: string): number => {
      const index = CHAIR_ORDER.indexOf(
        CHAIR_ORDER.find((c) => c.toLowerCase() === chair.toLowerCase()) ?? '',
      );
      return index === -1 ? CHAIR_ORDER.length : index;
    };

    const ordered = [...group].sort((a, b) => {
      const rankDelta =
        chairRank(splitChair(a.instrumentLabel).chair ?? '') -
        chairRank(splitChair(b.instrumentLabel).chair ?? '');
      if (rankDelta !== 0) return rankDelta;
      return a.partId.localeCompare(b.partId);
    });

    for (const part of ordered) {
      const { chair } = splitChair(part.instrumentLabel);

      if (!chair) {
        // A generic part for the desk (no chair): every candidate on the desk
        // gets it. A single "Bb Clarinet" part really is a combined part.
        for (const member of candidates) {
          assignments.push({
            partId: part.partId,
            partName: part.partName,
            memberId: member.memberId,
            memberName: memberDisplayName(member),
            canonicalInstrument: canonical,
            chair: null,
          });
        }
        continue;
      }

      const chairKey = chair.toLowerCase();
      const alreadySeated = [...seated.entries()].find(
        ([, takenChair]) => takenChair.toLowerCase() === chairKey,
      );

      if (alreadySeated) {
        // Two parts claiming the same chair: the first keeps it.
        unroutedParts.push({
          partId: part.partId,
          partName: part.partName,
          instrumentLabel: part.instrumentLabel,
          canonicalInstrument: canonical,
          reason: 'NO_MEMBER_FOR_INSTRUMENT',
          detail: `"${part.instrumentLabel}" duplicates an existing ${canonical} chair, which is already held. Assign this part by hand.`,
        });
        continue;
      }

      const free = candidates.find((m) => !seated.has(m.memberId));
      if (!free) {
        unroutedParts.push({
          partId: part.partId,
          partName: part.partName,
          instrumentLabel: part.instrumentLabel,
          canonicalInstrument: canonical,
          reason: 'NO_MEMBER_FOR_INSTRUMENT',
          detail: `All ${candidates.length} rostered ${canonical} player(s) already hold a chair, but "${part.partName}" needs ${chair}. Add another player or assign by hand.`,
        });
        continue;
      }

      seated.set(free.memberId, chair);
      assignments.push({
        partId: part.partId,
        partName: part.partName,
        memberId: free.memberId,
        memberName: memberDisplayName(free),
        canonicalInstrument: canonical,
        chair,
      });
    }
  }

  return { assignments, unroutedParts };
}

/** Best-effort "which sections exist at all" note for an unroutable instrument. */
function describeSectionsFor(
  roster: readonly RosterMember[],
  canonical: string,
): string | null {
  const family = CANONICAL_INSTRUMENTS.find((i) => i.name === canonical)?.section;
  if (!family) return null;

  const sections = new Set<string>();
  for (const member of roster) {
    for (const name of member.sectionNames) {
      if (name.trim().toLowerCase() === family.toLowerCase()) sections.add(name.trim());
    }
  }
  return sections.size > 0 ? [...sections].join('/') : null;
}

// =============================================================================
// DB adapter
// =============================================================================

/**
 * Load the active roster needed for routing.
 *
 * Deliberately `status: 'ACTIVE'` and `deletedAt: null`: a departed or
 * soft-deleted member must not be handed a new part. Existing assignments for
 * such a member are left untouched — revoking access is a librarian decision,
 * not a side effect of an upload.
 */
export async function loadRoutingRoster(): Promise<RosterMember[]> {
  const { prisma } = await import('@/lib/db');

  const members = await prisma.member.findMany({
    where: { status: 'ACTIVE', deletedAt: null },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      instruments: { select: { instrument: { select: { name: true } } } },
      sections: { select: { section: { select: { name: true } } } },
    },
  });

  return members.map((m) => ({
    memberId: m.id,
    firstName: m.firstName,
    lastName: m.lastName,
    instrumentNames: m.instruments.map((i) => i.instrument.name),
    sectionNames: m.sections.map((s) => s.section.name),
  }));
}

export interface ApplyRoutingResult extends RoutingPlan {
  /** Assignments that already existed and were left alone. */
  alreadyAssigned: number;
}

/**
 * Create the `MusicAssignment` rows for a committed piece.
 *
 * Idempotent by construction: assignments are read back for the piece first and
 * only genuinely-new (member, part) pairs are inserted. Re-running a commit after
 * a crash therefore converges on the same set instead of duplicating rows —
 * which matters because `MusicAssignment` has no unique constraint covering
 * (pieceId, memberId, partId) and `skipDuplicates` would silently do nothing.
 *
 * Must run inside the commit transaction so a failure rolls the assignments back
 * with the parts they point at.
 */
export async function applyRouting(
  tx: Pick<Prisma.TransactionClient, 'musicAssignment' | 'musicAssignmentHistory'>,
  args: {
    pieceId: string;
    parts: readonly RoutablePart[];
    roster: readonly RosterMember[];
    assignedBy: string;
  },
): Promise<ApplyRoutingResult> {
  const plan = planPartRouting(args.parts, args.roster);

  if (plan.assignments.length === 0) {
    return { ...plan, alreadyAssigned: 0 };
  }

  const partIds = plan.assignments.map((a) => a.partId);
  const existing = await tx.musicAssignment.findMany({
    where: { pieceId: args.pieceId, partId: { in: partIds } },
    select: { id: true, memberId: true, partId: true },
  });

  const taken = new Set(
    existing.map((row) => `${row.memberId}:${row.partId ?? ''}`),
  );

  const fresh = plan.assignments.filter(
    (a) => !taken.has(`${a.memberId}:${a.partId}`),
  );
  const alreadyAssigned = plan.assignments.length - fresh.length;

  for (const assignment of fresh) {
    const created = (await tx.musicAssignment.create({
      data: {
        pieceId: args.pieceId,
        memberId: assignment.memberId,
        partId: assignment.partId,
        partName: assignment.partName,
        assignedBy: args.assignedBy,
        notes:
          assignment.chair !== null
            ? `Auto-routed by Smart Upload: ${assignment.chair} chair ${assignment.canonicalInstrument}.`
            : `Auto-routed by Smart Upload: ${assignment.canonicalInstrument}.`,
      },
      select: { id: true },
    })) as { id: string };

    // Match the history trail the manual assignment actions write, so the
    // librarian's assignment log tells the same story for both paths.
    await tx.musicAssignmentHistory.create({
      data: {
        assignmentId: created.id,
        action: 'ASSIGNED',
        toStatus: 'ASSIGNED',
        notes:
          assignment.chair !== null
            ? `Auto-routed by Smart Upload: ${assignment.chair} chair ${assignment.canonicalInstrument}.`
            : `Auto-routed by Smart Upload: ${assignment.canonicalInstrument}.`,
        performedBy: args.assignedBy,
      },
    });
  }

  return { ...plan, alreadyAssigned };
}