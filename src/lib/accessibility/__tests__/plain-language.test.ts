/**
 * Plain-language enum mapping.
 *
 * The whole point of this module is that no member ever reads a database
 * value. These tests pin that contract, including the "never returns a raw
 * enum" guarantee for unknown input — the fallback is what protects a member
 * when the database grows a value the UI has never seen.
 */

import { describe, it, expect } from 'vitest';
import {
  announcementTypeLabel,
  attendanceStatusLabel,
  difficultyLabel,
  eventTypeLabel,
  memberStatusLabel,
} from '../plain-language';

/** Anything screaming-snake-case is a database value leaking into the UI. */
function looksLikeRawEnum(value: string): boolean {
  return /^[A-Z][A-Z0-9_]*$/.test(value.trim());
}

describe('eventTypeLabel', () => {
  it('translates the known event types', () => {
    expect(eventTypeLabel('REHEARSAL')).toBe('Rehearsal');
    expect(eventTypeLabel('CONCERT')).toBe('Concert');
    expect(eventTypeLabel('MEETING')).toBe('Band meeting');
  });

  it('never leaks a raw enum for an unknown value', () => {
    expect(looksLikeRawEnum(eventTypeLabel('SOMETHING_NEW'))).toBe(false);
    expect(looksLikeRawEnum(eventTypeLabel(''))).toBe(false);
    expect(looksLikeRawEnum(eventTypeLabel(null))).toBe(false);
    expect(looksLikeRawEnum(eventTypeLabel(undefined))).toBe(false);
  });
});

describe('announcementTypeLabel', () => {
  it('translates the known announcement types', () => {
    expect(announcementTypeLabel('INFO')).toBe('Notice');
    expect(announcementTypeLabel('WARNING')).toBe('Please note');
    expect(announcementTypeLabel('URGENT')).toBe('Urgent');
    expect(announcementTypeLabel('EVENT')).toBe('Event');
  });

  it('never leaks a raw enum', () => {
    expect(looksLikeRawEnum(announcementTypeLabel('URGENT_ISH'))).toBe(false);
    expect(looksLikeRawEnum(announcementTypeLabel(null))).toBe(false);
  });
});

describe('difficultyLabel', () => {
  it('describes difficulty in words rather than a grade number', () => {
    expect(difficultyLabel('GRADE_1')).toBe('Easy');
    expect(difficultyLabel('GRADE_6')).toBe('Very hard');
  });

  it('never leaks a raw enum', () => {
    expect(looksLikeRawEnum(difficultyLabel('GRADE_9'))).toBe(false);
  });

  it('returns an empty string when there is no difficulty', () => {
    // The badge is omitted entirely in that case; empty means "render nothing".
    expect(difficultyLabel(null)).toBe('');
    expect(difficultyLabel(undefined)).toBe('');
  });
});

describe('attendanceStatusLabel', () => {
  it('uses the words a member would actually say', () => {
    expect(attendanceStatusLabel('PRESENT')).toBe('Came');
    expect(attendanceStatusLabel('ABSENT')).toBe('Missed');
    expect(attendanceStatusLabel('EXCUSED')).toBe('Told us in advance');
  });

  it('never leaks a raw enum', () => {
    expect(looksLikeRawEnum(attendanceStatusLabel('TELEPORTED'))).toBe(false);
    expect(looksLikeRawEnum(attendanceStatusLabel(null))).toBe(false);
  });
});

describe('memberStatusLabel', () => {
  it('never leaks a raw enum', () => {
    expect(looksLikeRawEnum(memberStatusLabel('ACTIVE'))).toBe(false);
    expect(looksLikeRawEnum(memberStatusLabel(null))).toBe(false);
    expect(looksLikeRawEnum(memberStatusLabel('WEIRD_NEW_STATE'))).toBe(false);
  });
});

describe('every mapping', () => {
  const helpers = [
    eventTypeLabel,
    announcementTypeLabel,
    attendanceStatusLabel,
    memberStatusLabel,
  ] as const;

  it('returns a non-empty string for every input', () => {
    for (const helper of helpers) {
      for (const input of ['REHEARSAL', 'CONCERT', 'INFO', 'ACTIVE', 'PRESENT', 'MYSTERY']) {
        expect(helper(input).length).toBeGreaterThan(0);
      }
    }
  });

  it('does not return an underscore-joined string for an unknown value', () => {
    for (const helper of helpers) {
      expect(helper('TOTALLY_UNKNOWN')).not.toContain('_');
    }
  });
});