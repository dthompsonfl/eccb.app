/**
 * Part Routing — Canonicalisation and chair seating
 *
 * These are the assertions that decide whether "upload and everything happens"
 * actually delivers music to players. The failures they guard against are all
 * silent — a part that reaches nobody looks exactly like a correct commit.
 */
import { describe, it, expect } from 'vitest';
import {
  canonicalInstrumentKey,
  splitChair,
  planPartRouting,
  type RosterMember,
  type RoutablePart,
} from '../part-routing';

const member = (
  memberId: string,
  lastName: string,
  instrumentNames: string[],
  sectionNames: string[] = [],
): RosterMember => ({
  memberId,
  firstName: 'Pat',
  lastName,
  instrumentNames,
  sectionNames,
});

const part = (
  partId: string,
  instrumentLabel: string,
  partName = instrumentLabel,
): RoutablePart => ({ partId, partName, instrumentLabel });

describe('canonicalInstrumentKey', () => {
  it('maps aliases and transposition suffixes onto one instrument', () => {
    // The three labels the audit asked about must agree, otherwise a Trumpet
    // part in one score and a Tpt part in another go to different people.
    expect(canonicalInstrumentKey('Trumpet in Bb')).toBe('Trumpet');
    expect(canonicalInstrumentKey('Tpt')).toBe('Trumpet');
    expect(canonicalInstrumentKey('Trumpet')).toBe('Trumpet');
  });

  it('folds Cornet onto the Trumpet desk', () => {
    // Cornet is a separate Instrument row in the seed, but it shares a desk with
    // Trumpet in concert band. Without this a cornet part would report
    // "no member for instrument" on a band full of trumpet players.
    expect(canonicalInstrumentKey('Cornet')).toBe('Trumpet');
    expect(canonicalInstrumentKey('Cornet in Bb')).toBe('Trumpet');
  });

  it('matches the roster spelling against the normalized spelling', () => {
    // Seed stores U+266D and "French Horn"; the normalizer emits ASCII "Bb" and
    // "Horn". These are the same instruments and must produce the same key.
    expect(canonicalInstrumentKey('B\u266d Clarinet')).toBe(
      canonicalInstrumentKey('Bb Clarinet'),
    );
    expect(canonicalInstrumentKey('French Horn')).toBe(canonicalInstrumentKey('Horn'));
    expect(canonicalInstrumentKey('Mallets')).toBe(
      canonicalInstrumentKey('Mallet Percussion'),
    );
  });

  it('returns null for labels matching no instrument', () => {
    expect(canonicalInstrumentKey('')).toBeNull();
    expect(canonicalInstrumentKey('Kazoo Section')).toBeNull();
  });
});

describe('splitChair', () => {
  it('separates a leading chair from the instrument', () => {
    expect(splitChair('1st Bb Clarinet')).toEqual({
      chair: '1st',
      instrumentLabel: 'Bb Clarinet',
    });
    expect(splitChair('Bb Clarinet')).toEqual({
      chair: null,
      instrumentLabel: 'Bb Clarinet',
    });
  });
});

describe('planPartRouting', () => {
  it('routes a part to the member who plays that instrument', () => {
    const plan = planPartRouting(
      [part('p1', 'Trumpet')],
      [member('m1', 'Alvarez', ['Trumpet'], ['Brass'])],
    );

    expect(plan.assignments).toHaveLength(1);
    expect(plan.assignments[0]).toMatchObject({
      partId: 'p1',
      memberId: 'm1',
      canonicalInstrument: 'Trumpet',
    });
    expect(plan.unroutedParts).toEqual([]);
  });

  it('routes across the roster/normalized spelling difference', () => {
    // This is the case that would otherwise look identical to "routing is broken".
    const plan = planPartRouting(
      [part('p1', 'Bb Clarinet')],
      [member('m1', 'Okafor', ['B\u266d Clarinet'], ['Woodwinds'])],
    );

    expect(plan.assignments.map((a) => a.memberId)).toEqual(['m1']);
  });

  it('seats chairs in order across several players', () => {
    const plan = planPartRouting(
      [part('p1', '1st Clarinet'), part('p2', '2nd Clarinet')],
      [
        member('m-zulu', 'Zhang', ['Bb Clarinet']),
        member('m-alpha', 'Alvarez', ['Bb Clarinet']),
      ],
    );

    // Deterministic by display name, not DB row order: Alvarez < Zhang.
    expect(plan.assignments).toHaveLength(2);
    expect(plan.assignments.find((a) => a.chair === '1st')?.memberId).toBe('m-alpha');
    expect(plan.assignments.find((a) => a.chair === '2nd')?.memberId).toBe('m-zulu');
  });

  it('gives an unchaired part to every player on the desk', () => {
    const plan = planPartRouting(
      [part('p1', 'Bb Clarinet')],
      [member('m1', 'A', ['Bb Clarinet']), member('m2', 'B', ['Bb Clarinet'])],
    );

    expect(plan.assignments.map((a) => a.memberId).sort()).toEqual(['m1', 'm2']);
  });

  it('SURFACES a part no member plays instead of dropping or guessing', () => {
    const plan = planPartRouting(
      [part('p1', 'Oboe')],
      [member('m1', 'Alvarez', ['Trumpet'], ['Brass'])],
    );

    expect(plan.assignments).toEqual([]);
    expect(plan.unroutedParts).toHaveLength(1);
    expect(plan.unroutedParts[0]).toMatchObject({
      partId: 'p1',
      reason: 'NO_MEMBER_FOR_INSTRUMENT',
      canonicalInstrument: 'Oboe',
    });
    expect(plan.unroutedParts[0].detail).toContain('No active member plays Oboe');
  });

  it('reports a surplus chair rather than double-seating a player', () => {
    const plan = planPartRouting(
      [part('p1', '1st Clarinet'), part('p2', '2nd Clarinet'), part('p3', '3rd Clarinet')],
      [member('m1', 'Only', ['Bb Clarinet'])],
    );

    expect(plan.assignments).toHaveLength(1);
    expect(plan.unroutedParts).toHaveLength(2);
    expect(plan.unroutedParts[0].detail).toContain('already hold a chair');
  });

  it('reports an unrecognised instrument label', () => {
    const plan = planPartRouting(
      [part('p1', 'Kazoo')],
      [member('m1', 'Alvarez', ['Trumpet'])],
    );

    expect(plan.assignments).toEqual([]);
    expect(plan.unroutedParts[0].reason).toBe('UNKNOWN_INSTRUMENT');
  });

  it('does not route a score to a player desk', () => {
    const plan = planPartRouting(
      [part('p-score', 'Full Score')],
      [member('m1', 'Conductor', ['Trumpet'])],
    );

    expect(plan.assignments).toEqual([]);
    expect(plan.unroutedParts[0].reason).toBe('SCORE_NOT_A_DESK');
  });

  it('never seats one member at two chairs of the same desk', () => {
    const plan = planPartRouting(
      [part('p1', '1st Clarinet'), part('p2', '2nd Clarinet')],
      [member('m1', 'Only', ['Bb Clarinet', 'Bb Clarinet'])],
    );

    const seated = plan.assignments.map((a) => a.memberId);
    expect(new Set(seated).size).toBe(seated.length);
  });

  it('is deterministic: same inputs produce the same plan', () => {
    const parts = [part('p1', '1st Clarinet'), part('p2', '2nd Clarinet')];
    const roster = [member('m1', 'B', ['Clarinet']), member('m2', 'A', ['Clarinet'])];

    const first = planPartRouting(parts, roster);
    const second = planPartRouting([...parts].reverse(), roster);

    // Reversing input order must not reshuffle the seating.
    expect(first.assignments.map((a) => [a.partId, a.memberId]).sort()).toEqual(
      second.assignments.map((a) => [a.partId, a.memberId]).sort(),
    );
  });
});