/**
 * Plain-language names for the band vocabulary.
 *
 * The database stores screaming-snake enum values because that is what a
 * database is good at. A member is not a database, and "CONCERT" on a card is
 * jargon leaking into the primary journey. These helpers translate once, here,
 * so every member-facing surface says the same thing.
 */

export const EVENT_TYPE_LABELS: Record<string, string> = {
  REHEARSAL: 'Rehearsal',
  CONCERT: 'Concert',
  MEETING: 'Band meeting',
  SOCIAL: 'Band social',
  OTHER: 'Band event',
};

export const ATTENDANCE_STATUS_LABELS: Record<string, string> = {
  PRESENT: 'Came',
  ABSENT: 'Missed',
  EXCUSED: 'Told us in advance',
  LATE: 'Came in late',
  LEFT_EARLY: 'Left early',
};

export const ANNOUNCEMENT_TYPE_LABELS: Record<string, string> = {
  INFO: 'Notice',
  WARNING: 'Please note',
  URGENT: 'Urgent',
  EVENT: 'Event',
};

/**
 * Music difficulty. The database says GRADE_1..GRADE_6; a member reads
 * "GRADE_4" as a school report, not as a guide to whether they can play it.
 */
export const DIFFICULTY_LABELS: Record<string, string> = {
  GRADE_1: 'Easy',
  GRADE_2: 'Fairly easy',
  GRADE_3: 'Medium',
  GRADE_4: 'Fairly hard',
  GRADE_5: 'Hard',
  GRADE_6: 'Very hard',
};

export const MEMBER_STATUS_LABELS: Record<string, string> = {
  ACTIVE: 'Playing in the band',
  INACTIVE: 'Not playing right now',
  LEAVE: 'Taking a break',
  PENDING: 'New — not confirmed yet',
  ALUMNI: 'Alumni member',
};

/** Never throws and never returns an empty string for an unknown value. */
export function eventTypeLabel(type: string | null | undefined): string {
  if (!type) return EVENT_TYPE_LABELS.OTHER;
  return EVENT_TYPE_LABELS[type] ?? EVENT_TYPE_LABELS.OTHER;
}

export function attendanceStatusLabel(status: string | null | undefined): string {
  if (!status) return 'Not marked yet';
  return ATTENDANCE_STATUS_LABELS[status] ?? status.replace(/_/g, ' ').toLowerCase();
}

export function memberStatusLabel(status: string | null | undefined): string {
  if (!status) return 'Not known yet';
  return MEMBER_STATUS_LABELS[status] ?? status.replace(/_/g, ' ').toLowerCase();
}

export function announcementTypeLabel(type: string | null | undefined): string {
  if (!type) return 'Notice';
  return ANNOUNCEMENT_TYPE_LABELS[type] ?? 'Notice';
}

export function difficultyLabel(difficulty: string | null | undefined): string {
  if (!difficulty) return '';
  return DIFFICULTY_LABELS[difficulty] ?? difficulty.replace(/_/g, ' ').toLowerCase();
}