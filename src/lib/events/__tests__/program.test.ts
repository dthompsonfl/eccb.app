import { describe, it, expect } from 'vitest';
import {
  UNKNOWN_DURATION_LABEL,
  buildProgramDocument,
  buildProgramItems,
  buildProgramLines,
  computeProgramRuntime,
  formatMinutes,
  isKnownDuration,
  sortProgramItems,
  type ProgramEventInfo,
  type ProgramItemInput,
} from '../program';

function item(overrides: Partial<ProgramItemInput> & { id: string }): ProgramItemInput {
  return {
    sortOrder: 0,
    pieceId: `piece-${overrides.id}`,
    title: `Title ${overrides.id}`,
    subtitle: null,
    composer: null,
    arranger: null,
    duration: 5,
    notes: null,
    performers: [],
    ...overrides,
  };
}

const event: ProgramEventInfo = {
  id: 'event-1',
  title: 'Spring Concert',
  isPublished: true,
  description: 'An evening of band music.',
  dateLabel: 'Saturday, May 3, 2026',
  timeLabel: '7:00 pm – 9:00 pm',
  venueLabel: 'Municipal Auditorium, Daphne',
  dressCode: 'Concert black',
};

describe('formatMinutes', () => {
  it('keeps sub-hour values in minutes and promotes to hours', () => {
    expect(formatMinutes(45)).toBe('45 min');
    expect(formatMinutes(60)).toBe('1 hr');
    expect(formatMinutes(65)).toBe('1 hr 5 min');
    expect(formatMinutes(0)).toBe('0 min');
  });
});

describe('isKnownDuration', () => {
  it('rejects null, zero, negative and non-finite durations', () => {
    expect(isKnownDuration(null)).toBe(false);
    expect(isKnownDuration(0)).toBe(false);
    expect(isKnownDuration(-3)).toBe(false);
    expect(isKnownDuration(Number.NaN)).toBe(false);
    expect(isKnownDuration(Number.POSITIVE_INFINITY)).toBe(false);
  });

  it('accepts a positive finite duration', () => {
    expect(isKnownDuration(0.5)).toBe(true);
    expect(isKnownDuration(12)).toBe(true);
  });
});

describe('sortProgramItems — deterministic persisted order', () => {
  it('orders by sortOrder ascending', () => {
    const sorted = sortProgramItems([
      item({ id: 'b', sortOrder: 2 }),
      item({ id: 'a', sortOrder: 0 }),
      item({ id: 'c', sortOrder: 1 }),
    ]);
    expect(sorted.map((i) => i.id)).toEqual(['a', 'c', 'b']);
  });

  it('breaks sortOrder ties by id so equal values never swap', () => {
    const input = [
      item({ id: 'zeta', sortOrder: 1 }),
      item({ id: 'alpha', sortOrder: 1 }),
      item({ id: 'mid', sortOrder: 0 }),
    ];
    // Any input permutation must resolve to the same sequence.
    const expected = ['mid', 'alpha', 'zeta'];
    expect(sortProgramItems(input).map((i) => i.id)).toEqual(expected);
    expect(sortProgramItems([...input].reverse()).map((i) => i.id)).toEqual(expected);
    expect(sortProgramItems([input[1], input[2], input[0]]).map((i) => i.id)).toEqual(expected);
  });

  it('does not mutate the caller array', () => {
    const input = [item({ id: 'b', sortOrder: 1 }), item({ id: 'a', sortOrder: 0 })];
    const copy = [...input];
    sortProgramItems(input);
    expect(input).toEqual(copy);
  });
});

describe('buildProgramItems', () => {
  it('numbers positions from 1 in persisted order and labels known durations', () => {
    const items = buildProgramItems([
      item({ id: 'second', sortOrder: 1, duration: 7, title: 'Second' }),
      item({ id: 'first', sortOrder: 0, duration: 4, title: 'First' }),
    ]);
    expect(items.map((i) => [i.position, i.title])).toEqual([
      [1, 'First'],
      [2, 'Second'],
    ]);
    expect(items[0].durationKnown).toBe(true);
    expect(items[0].durationLabel).toBe('4 min');
  });

  it('labels a missing duration Unknown instead of estimating', () => {
    const items = buildProgramItems([item({ id: 'x', duration: null })]);
    expect(items[0].durationKnown).toBe(false);
    expect(items[0].durationLabel).toBe(UNKNOWN_DURATION_LABEL);
  });

  it('treats a zero duration as unknown rather than as a real length', () => {
    const items = buildProgramItems([item({ id: 'x', duration: 0 })]);
    expect(items[0].durationKnown).toBe(false);
    expect(items[0].durationLabel).toBe(UNKNOWN_DURATION_LABEL);
  });
});

describe('computeProgramRuntime', () => {
  it('sums known durations', () => {
    const runtime = computeProgramRuntime([
      item({ id: 'a', duration: 4 }),
      item({ id: 'b', duration: 6 }),
      item({ id: 'c', duration: 30 }),
    ]);
    expect(runtime.knownMinutes).toBe(40);
    expect(runtime.totalMinutes).toBe(40);
    expect(runtime.unknownCount).toBe(0);
    expect(runtime.isLowerBound).toBe(false);
    expect(runtime.label).toBe('40 min');
  });

  it('flags the total as a lower bound when any piece has no duration', () => {
    const runtime = computeProgramRuntime([
      item({ id: 'a', duration: 4 }),
      item({ id: 'b', duration: null }),
      item({ id: 'c', duration: 6 }),
    ]);
    expect(runtime.knownMinutes).toBe(10);
    expect(runtime.unknownCount).toBe(1);
    expect(runtime.isLowerBound).toBe(true);
    expect(runtime.label).toBe('at least 10 min');
    // The total is the sum of what IS known — the unknown piece adds nothing.
    expect(runtime.totalMinutes).toBe(10);
  });

  it('reports Unknown when no piece has a usable duration', () => {
    const runtime = computeProgramRuntime([
      item({ id: 'a', duration: null }),
      item({ id: 'b', duration: null }),
    ]);
    expect(runtime.knownMinutes).toBe(0);
    expect(runtime.unknownCount).toBe(2);
    expect(runtime.isLowerBound).toBe(true);
    expect(runtime.label).toBe(UNKNOWN_DURATION_LABEL);
  });

  it('handles an empty program', () => {
    const runtime = computeProgramRuntime([]);
    expect(runtime.pieceCount).toBe(0);
    expect(runtime.totalMinutes).toBeNull();
    expect(runtime.isLowerBound).toBe(false);
    expect(runtime.label).toBe('No pieces scheduled');
  });
});

describe('buildProgramDocument', () => {
  it('collects distinct performing groups from member sections', () => {
    const doc = buildProgramDocument(event, [
      item({
        id: 'a',
        sortOrder: 0,
        performers: [
          { memberId: 'm2', name: 'Ada', partName: 'Flute', sectionNames: ['Woodwinds'] },
          { memberId: 'm1', name: 'Bea', partName: null, sectionNames: ['Woodwinds', 'Brass'] },
        ],
      }),
      item({
        id: 'b',
        sortOrder: 1,
        performers: [
          { memberId: 'm3', name: 'Cy', partName: 'Tuba', sectionNames: ['Brass'] },
        ],
      }),
    ]);
    expect(doc.groups).toEqual([
      { name: 'Brass', memberIds: ['m1', 'm3'] },
      { name: 'Woodwinds', memberIds: ['m1', 'm2'] },
    ]);
  });
});

describe('buildProgramLines — generated program output', () => {
  it('emits the pieces in persisted order with 1-based numbering', () => {
    const doc = buildProgramDocument(event, [
      item({ id: 'a', sortOrder: 0, title: 'Fanfare' }),
      item({ id: 'b', sortOrder: 1, title: 'Symphony' }),
      item({ id: 'c', sortOrder: 2, title: 'Overture' }),
    ]);
    const body = buildProgramLines(doc)
      .map((l) => l.text)
      .filter((t) => /^\d+\. /.test(t));

    expect(body).toEqual(['1. Fanfare', '2. Symphony', '3. Overture']);
  });

  it('reverses the emitted order when sortOrder reverses — the output follows the data', () => {
    const forward = buildProgramLines(
      buildProgramDocument(event, [
        item({ id: 'a', sortOrder: 0, title: 'Fanfare' }),
        item({ id: 'b', sortOrder: 1, title: 'Symphony' }),
      ])
    ).map((l) => l.text);
    const reversed = buildProgramLines(
      buildProgramDocument(event, [
        item({ id: 'a', sortOrder: 1, title: 'Fanfare' }),
        item({ id: 'b', sortOrder: 0, title: 'Symphony' }),
      ])
    ).map((l) => l.text);

    const numbered = (lines: string[]) => lines.filter((t) => /^\d+\. /.test(t));
    expect(numbered(forward)).toEqual(['1. Fanfare', '2. Symphony']);
    expect(numbered(reversed)).toEqual(['1. Symphony', '2. Fanfare']);
  });

  it('includes the total runtime line and the lower-bound warning', () => {
    const doc = buildProgramDocument(event, [
      item({ id: 'a', sortOrder: 0, duration: 5, title: 'Known' }),
      item({ id: 'b', sortOrder: 1, duration: null, title: 'Mystery' }),
    ]);
    const texts = buildProgramLines(doc).map((l) => l.text);

    expect(texts).toContain('Total running time: at least 5 min');
    expect(texts.some((t) => t.includes('1 piece of unknown length'))).toBe(true);
    expect(texts.some((t) => t.includes('total is a minimum'))).toBe(true);
    // The unknown piece's own line is labelled, never given a number.
    expect(texts).toContain(UNKNOWN_DURATION_LABEL);
  });

  it('omits the lower-bound warning when every duration is known', () => {
    const doc = buildProgramDocument(event, [item({ id: 'a', duration: 5 })]);
    const texts = buildProgramLines(doc).map((l) => l.text);
    expect(texts).toContain('Total running time: 5 min');
    expect(texts.some((t) => t.includes('total is a minimum'))).toBe(false);
  });

  it('credits performers with their part and section', () => {
    const doc = buildProgramDocument(event, [
      item({
        id: 'a',
        title: 'Fanfare',
        composer: 'A. Composer',
        arranger: 'B. Arranger',
        performers: [
          { memberId: 'm1', name: 'Ada Lovelace', partName: '1st Flute', sectionNames: ['Woodwinds'] },
        ],
      }),
    ]);
    const texts = buildProgramLines(doc).map((l) => l.text);
    expect(texts).toContain('A. Composer / arr. B. Arranger');
    expect(texts).toContain('Ada Lovelace — 1st Flute [Woodwinds]');
  });

  it('states that the program is empty rather than printing a bogus total', () => {
    const doc = buildProgramDocument(event, []);
    const texts = buildProgramLines(doc).map((l) => l.text);
    expect(texts).toContain('No pieces scheduled for this concert.');
    expect(texts).toContain('Total running time: No pieces scheduled');
  });
});
