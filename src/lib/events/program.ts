/**
 * Concert program domain logic (pure — no Prisma, no Next.js).
 *
 * The persisted order lives on `EventMusic.sortOrder`. Everything a printed
 * program, the public program page and the PDF need is derived here so all
 * three renderings are guaranteed to agree, and so the rules are unit
 * testable without a database.
 *
 * Runtime rules (deliberately conservative):
 *  - `MusicPiece.duration` is stored in MINUTES (see the admin music form).
 *  - A piece contributes to the total only when its duration is a finite
 *    number greater than zero. A null duration — or a nonsensical 0/negative
 *    value — is reported as UNKNOWN. We never estimate.
 *  - If any piece is unknown the total is a LOWER BOUND and says so.
 */

/** A performer credited on a program item, resolved from the existing
 *  `MusicAssignment` rows plus `Section` membership. */
export interface ProgramPerformer {
  memberId: string;
  name: string;
  partName: string | null;
  sectionNames: string[];
}

/** Raw program item as stored in the database. */
export interface ProgramItemInput {
  /** `EventMusic.id` */
  id: string;
  sortOrder: number;
  pieceId: string;
  title: string;
  subtitle: string | null;
  composer: string | null;
  arranger: string | null;
  /** `MusicPiece.duration` in minutes, or null when unknown. */
  duration: number | null;
  notes: string | null;
  performers: ProgramPerformer[];
}

/** A program item after ordering, numbering and runtime labelling. */
export interface ProgramItem extends ProgramItemInput {
  /** 1-based position in the running order. */
  position: number;
  durationKnown: boolean;
  /** Human label for the duration, or the unknown marker. */
  durationLabel: string;
}

export interface ProgramRuntime {
  pieceCount: number;
  /** Sum of the durations that ARE known, in minutes. */
  knownMinutes: number;
  /** How many pieces have no usable duration. */
  unknownCount: number;
  /** Known minutes; equals `knownMinutes`. Null only when there are no pieces. */
  totalMinutes: number | null;
  /** True when at least one piece duration is unknown. */
  isLowerBound: boolean;
  /** Ready-to-print label, e.g. "1 hr 5 min" or "at least 45 min". */
  label: string;
}

export interface ProgramGroup {
  name: string;
  memberIds: string[];
}

export interface ProgramEventInfo {
  id: string;
  title: string;
  /** False means public program routes will 404 until an admin publishes. */
  isPublished: boolean;
  description: string | null;
  /** Pre-formatted by the caller so this module stays timezone-free. */
  dateLabel: string;
  timeLabel: string;
  venueLabel: string | null;
  dressCode: string | null;
}

export interface ProgramDocument {
  event: ProgramEventInfo;
  items: ProgramItem[];
  runtime: ProgramRuntime;
  /** Distinct sections represented in the program, in name order. */
  groups: ProgramGroup[];
  /** Program-level note rendered under the title. */
  note: string | null;
}

/** Rendered wherever a duration is missing. Never replaced with a number. */
export const UNKNOWN_DURATION_LABEL = 'Unknown';

/** Format a whole number of minutes. Minutes < 60 stay in minutes. */
export function formatMinutes(minutes: number): string {
  if (!Number.isFinite(minutes)) return UNKNOWN_DURATION_LABEL;
  const total = Math.round(minutes);
  if (total < 60) return `${total} min`;
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
}

/**
 * A duration counts only when it is a finite number greater than zero.
 * Anything else is unknown: 0 minutes is not a real performance length and
 * must not silently deflate the total.
 */
export function isKnownDuration(duration: number | null | undefined): duration is number {
  return typeof duration === 'number' && Number.isFinite(duration) && duration > 0;
}

/**
 * Deterministic running order: `sortOrder` ascending, ties broken by
 * `EventMusic.id` so two rows that share a sortOrder never swap between
 * renders or between a reload and the print view.
 */
export function sortProgramItems(items: ProgramItemInput[]): ProgramItemInput[] {
  return [...items].sort((a, b) => {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Aggregate runtimes across program items. */
export function computeProgramRuntime(items: ProgramItemInput[]): ProgramRuntime {
  let knownMinutes = 0;
  let unknownCount = 0;

  for (const item of items) {
    if (isKnownDuration(item.duration)) {
      knownMinutes += item.duration;
    } else {
      unknownCount += 1;
    }
  }

  const isLowerBound = unknownCount > 0;
  const totalMinutes = items.length === 0 ? null : knownMinutes;

  let label: string;
  if (items.length === 0) {
    label = 'No pieces scheduled';
  } else if (knownMinutes === 0) {
    label = UNKNOWN_DURATION_LABEL;
  } else if (isLowerBound) {
    label = `at least ${formatMinutes(knownMinutes)}`;
  } else {
    label = formatMinutes(knownMinutes);
  }

  return {
    pieceCount: items.length,
    knownMinutes,
    unknownCount,
    totalMinutes,
    isLowerBound,
    label,
  };
}

/** Apply deterministic order, 1-based positions and duration labels. */
export function buildProgramItems(items: ProgramItemInput[]): ProgramItem[] {
  return sortProgramItems(items).map((item, index) => ({
    ...item,
    position: index + 1,
    durationKnown: isKnownDuration(item.duration),
    durationLabel: isKnownDuration(item.duration)
      ? formatMinutes(item.duration)
      : UNKNOWN_DURATION_LABEL,
  }));
}

/** Distinct sections among the credited performers, alphabetically. */
export function buildProgramGroups(items: ProgramItem[]): ProgramGroup[] {
  const byName = new Map<string, Set<string>>();

  for (const item of items) {
    for (const performer of item.performers) {
      for (const sectionName of performer.sectionNames) {
        const existing = byName.get(sectionName);
        if (existing) {
          existing.add(performer.memberId);
        } else {
          byName.set(sectionName, new Set([performer.memberId]));
        }
      }
    }
  }

  return [...byName.entries()]
    .map(([name, memberIds]) => ({ name, memberIds: [...memberIds].sort() }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Assemble the full program document from persisted rows. */
export function buildProgramDocument(
  event: ProgramEventInfo,
  inputs: ProgramItemInput[]
): ProgramDocument {
  const items = buildProgramItems(inputs);
  return {
    event,
    items,
    runtime: computeProgramRuntime(inputs),
    groups: buildProgramGroups(items),
    note: null,
  };
}

/** One line of program text. Used by the PDF writer and by tests. */
export interface ProgramLine {
  text: string;
  /** Relative emphasis for the PDF writer. */
  style: 'title' | 'heading' | 'body' | 'muted' | 'duration';
}

/**
 * Flatten a program to ordered text lines. The order here IS the program
 * order, so this doubles as the assertion surface for "the generated program
 * contains the ordered pieces".
 */
export function buildProgramLines(program: ProgramDocument): ProgramLine[] {
  const lines: ProgramLine[] = [];

  lines.push({ text: program.event.title, style: 'title' });
  if (program.event.dateLabel) {
    lines.push({ text: program.event.dateLabel, style: 'heading' });
  }
  if (program.event.timeLabel) {
    lines.push({ text: program.event.timeLabel, style: 'heading' });
  }
  if (program.event.venueLabel) {
    lines.push({ text: program.event.venueLabel, style: 'heading' });
  }
  if (program.event.description) {
    lines.push({ text: program.event.description, style: 'body' });
  }
  if (program.event.dressCode) {
    lines.push({ text: `Dress code: ${program.event.dressCode}`, style: 'muted' });
  }

  lines.push({ text: 'Program', style: 'heading' });

  if (program.items.length === 0) {
    lines.push({ text: 'No pieces scheduled for this concert.', style: 'body' });
  }

  for (const item of program.items) {
    lines.push({ text: `${item.position}. ${item.title}`, style: 'body' });
    if (item.subtitle) {
      lines.push({ text: item.subtitle, style: 'muted' });
    }
    const credits: string[] = [];
    if (item.composer) credits.push(item.composer);
    if (item.arranger) credits.push(`arr. ${item.arranger}`);
    if (credits.length > 0) {
      lines.push({ text: credits.join(' / '), style: 'muted' });
    }
    for (const performer of item.performers) {
      const part = performer.partName ? ` — ${performer.partName}` : '';
      const sections =
        performer.sectionNames.length > 0 ? ` [${performer.sectionNames.join(', ')}]` : '';
      lines.push({ text: `${performer.name}${part}${sections}`, style: 'muted' });
    }
    if (item.notes) {
      lines.push({ text: item.notes, style: 'muted' });
    }
    lines.push({ text: item.durationLabel, style: 'duration' });
  }

  lines.push({ text: `Total running time: ${program.runtime.label}`, style: 'heading' });
  if (program.runtime.isLowerBound) {
    lines.push({
      text: `${program.runtime.unknownCount} piece${
        program.runtime.unknownCount === 1 ? '' : 's'
      } of unknown length — total is a minimum.`,
      style: 'muted',
    });
  }

  if (program.groups.length > 0) {
    lines.push({ text: 'Performing Groups', style: 'heading' });
    for (const group of program.groups) {
      lines.push({
        text: `${group.name} (${group.memberIds.length})`,
        style: 'body',
      });
    }
  }

  return lines;
}
