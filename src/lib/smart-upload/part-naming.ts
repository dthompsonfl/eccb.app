/**
 * Part Naming Utility
 *
 * Normalises instrument label strings from LLM output into canonical names
 * and builds human-readable display names + safe filenames.
 *
 * Uses canonical-instruments.ts as the single source of truth for instrument
 * data (aliases, transpositions, sections). This module adds chair inference,
 * part-type inference, and filename/display-name generation on top.
 *
 * Examples:
 *   normalizeInstrumentLabel("Clarinet 1")     → { instrument: "Bb Clarinet", chair: "1st", transposition: "Bb" }
 *   buildPartDisplayName("American Patrol", …) → "American Patrol 1st Bb Clarinet"
 *   buildPartFilename("American Patrol 1st Bb Clarinet") → "American_Patrol_1st_Bb_Clarinet.pdf"
 */

import {
  findByFuzzyMatch,
  getSectionForLabel,
  getTranspositionForLabel,
} from './canonical-instruments';
import type { InstrumentSection, Transposition } from './canonical-instruments';

// =============================================================================
// Types
// =============================================================================

export interface NormalisedInstrument {
  /** Canonical instrument name (e.g. "Bb Clarinet", "1st Flute") */
  instrument: string;
  /** Chair designation if present */
  chair: '1st' | '2nd' | '3rd' | '4th' | 'Aux' | 'Solo' | null;
  /** Concert-pitch transposition key */
  transposition: Transposition;
  /** Instrument family / section */
  section: InstrumentSection;
  /** Optional inferred source-part type */
  partType?: 'FULL_SCORE' | 'CONDUCTOR_SCORE' | 'CONDENSED_SCORE' | 'PART';
}

// =============================================================================
// Chair Inference
// =============================================================================

const CHAIR_PATTERNS: Array<{ pattern: RegExp; chair: NormalisedInstrument['chair'] }> = [
  { pattern: /\b(1st|first|i\b|1)\b/i, chair: '1st' },
  { pattern: /\b(2nd|second|ii\b|2)\b/i, chair: '2nd' },
  { pattern: /\b(3rd|third|iii\b|3)\b/i, chair: '3rd' },
  { pattern: /\b(4th|fourth|iv\b|4)\b/i, chair: '4th' },
  { pattern: /\b(aux|auxiliary)\b/i, chair: 'Aux' },
  { pattern: /\b(solo)\b/i, chair: 'Solo' },
];

const CHAIR_NORMALIZATION_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  {
    pattern: /\bclarinet\s+in\s+bb\s*(i{1,3}|iv|1|2|3|4)\b/i,
    replacement: '$1 Bb Clarinet',
  },
  {
    pattern: /\bbb\s+clarinet\s*(i{1,3}|iv|1|2|3|4)\b/i,
    replacement: '$1 Bb Clarinet',
  },
  {
    pattern: /\bclarinet\s*(i{1,3}|iv|1|2|3|4)\s+in\s+bb\b/i,
    replacement: '$1 Bb Clarinet',
  },
];

function normaliseRomanChairToken(token: string): string {
  const lower = token.toLowerCase();
  if (lower === 'i' || lower === '1') return '1st';
  if (lower === 'ii' || lower === '2') return '2nd';
  if (lower === 'iii' || lower === '3') return '3rd';
  if (lower === 'iv' || lower === '4') return '4th';
  return token;
}

function normalizeChairPhrases(raw: string): string {
  let normalized = raw.trim().replace(/\s+/g, ' ');

  for (const { pattern, replacement } of CHAIR_NORMALIZATION_PATTERNS) {
    normalized = normalized.replace(pattern, (_, chairToken: string) => {
      return replacement.replace('$1', normaliseRomanChairToken(chairToken));
    });
  }

  return normalized;
}

function inferChair(raw: string): NormalisedInstrument['chair'] {
  for (const { pattern, chair } of CHAIR_PATTERNS) {
    if (pattern.test(raw)) return chair;
  }
  return null;
}

function inferPartType(raw: string): NormalisedInstrument['partType'] {
  const lower = raw.toLowerCase();
  if (/\bconductor\b/.test(lower)) return 'CONDUCTOR_SCORE';
  if (/\bcondensed\s+score\b/.test(lower)) return 'CONDENSED_SCORE';
  if (/\b(full\s+score|score)\b/.test(lower)) return 'FULL_SCORE';
  return 'PART';
}

// =============================================================================
// Main Normalizer — delegates to canonical-instruments.ts
// =============================================================================

/**
 * Normalise a raw instrument label from LLM or OCR output.
 * Extracts chair, canonical base instrument name, transposition, and section.
 *
 * Uses the canonical instruments registry for instrument resolution instead
 * of duplicating mappings.
 */
export function normalizeInstrumentLabel(raw: string): NormalisedInstrument {
  const normalizedRaw = normalizeChairPhrases(raw);
  const chair = inferChair(normalizedRaw);
  const partType = inferPartType(normalizedRaw);

  // Delegate instrument lookup to canonical-instruments.ts
  const match = findByFuzzyMatch(normalizedRaw);

  if (match) {
    const instrument = chair ? `${chair} ${match.name}` : match.name;
    return {
      instrument,
      chair,
      transposition: match.transposition,
      section: match.section,
      partType,
    };
  }

  // Fallback: use canonical helpers for section/transposition even if no match
  return {
    instrument: normalizedRaw.trim() || 'Unknown',
    chair,
    transposition: getTranspositionForLabel(normalizedRaw),
    section: getSectionForLabel(normalizedRaw),
    partType,
  };
}

// =============================================================================
// Display Name + Filename Builders
// =============================================================================

/**
 * Build a human-readable display name combining title and part.
 *
 * E.g. buildPartDisplayName("American Patrol", { instrument: "Bb Clarinet", chair: "1st" })
 *      → "American Patrol 1st Bb Clarinet"
 */
export function buildPartDisplayName(
  pieceTitle: string,
  part: Pick<NormalisedInstrument, 'instrument'>
): string {
  const title = pieceTitle.trim().replace(/\s+/g, ' ');
  const instrument = part.instrument.trim();
  return `${title} ${instrument}`.trim();
}

/**
 * Characters no mainstream filesystem accepts, plus the ASCII control range.
 * Removed outright (not replaced) so a title can never smuggle a path
 * separator or a NUL byte into an object key.
 */
// Stripping control characters is the entire point of this pattern — a NUL
// or newline in a filename is exactly what we must remove.
// eslint-disable-next-line no-control-regex
const UNSAFE_FILENAME_CHARS = /[\u0000-\u001f\u007f/\\:*?"<>|']/g;

/**
 * Windows reserved device names. A file called `CON.pdf` or `NUL.pdf` cannot be
 * opened, renamed, or deleted in Explorer — it silently resolves to the device.
 * Matched case-insensitively against the stem before the extension.
 */
const WINDOWS_RESERVED_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/** Max characters in the stem, before `.pdf`. */
const MAX_FILENAME_STEM = 200;

/** Stem used when sanitising leaves nothing usable behind. */
const FALLBACK_FILENAME_STEM = 'Part';

/**
 * Reduce arbitrary text to a filesystem-safe, Windows-safe, macOS-safe stem.
 *
 * Pure and deterministic: the same input always yields the same stem, so
 * re-running a split produces byte-identical filenames and never drifts into
 * a `... (1).pdf` collision.
 */
export function sanitizePartFilenameStem(raw: string): string {
  // Order matters: strip unsafe chars, convert whitespace to underscores, then
  // deal with dots and trailing separators. Dot cleanup must run *after* the
  // whitespace pass, otherwise 'trailing.  ' leaves a dangling '_' behind.
  let stem = (typeof raw === 'string' ? raw : '')
    .replace(UNSAFE_FILENAME_CHARS, '')
    .replace(/\s+/g, '_')
    .replace(/_{2,}/g, '_')
    // Windows silently drops trailing dots and spaces, which would make the
    // on-disk name differ from the name we recorded in the database.
    .replace(/^\.+/, '')
    .replace(/[.\s]+$/, '')
    .replace(/_+$/, '')
    // '_' removal can expose a dot that was sitting just before it
    // ('trailing.  ' → 'trailing._' → 'trailing.'), so settle once more.
    .replace(/[.\s]+$/, '');

  if (stem.length > MAX_FILENAME_STEM) {
    stem = stem.slice(0, MAX_FILENAME_STEM).replace(/[.\s_]+$/, '');
  }

  if (stem.length === 0) return FALLBACK_FILENAME_STEM;

  // `CON.pdf` is undeletable on Windows, so escape the stem rather than the
  // name — a leading underscore keeps it readable and unreserved.
  if (WINDOWS_RESERVED_NAMES.has(stem.toLowerCase())) {
    stem = `_${stem}`;
  }

  return stem;
}

/**
 * Build a safe filesystem filename from a display name.
 *
 * E.g. "American Patrol 1st Bb Clarinet" → "American_Patrol_1st_Bb_Clarinet.pdf"
 *
 * The filename carries both the work title and the part name so a musician who
 * downloads a part and opens it outside the Digital Music Stand can identify it
 * instantly, and it is safe on Windows, macOS, and Linux.
 */
export function buildPartFilename(displayName: string): string {
  // Strip an existing extension first so re-naming an already-named part cannot
  // stack suffixes: 'Work - Flute.pdf' must stay 'Work - Flute.pdf', never
  // 'Work - Flute.pdf.pdf'.
  const stem = sanitizePartFilenameStem(
    (typeof displayName === 'string' ? displayName : '').replace(/\.pdf$/i, ''),
  );
  return `${stem}.pdf`;
}

/**
 * Build a storage-safe key segment (no spaces, limited chars).
 * Used for S3/MinIO object keys.
 *
 * Pass `partNumber` and/or `pageRange` to guarantee uniqueness when multiple
 * parts share the same display name (e.g. two "Bb Clarinet" parts in different
 * ranges). Without them, two parts with identical names would produce the same
 * object key and the second upload would silently overwrite the first.
 */
export function buildPartStorageSlug(
  displayName: string,
  opts?: { partNumber?: number; pageRange?: [number, number] },
): string {
  // Storage keys are stricter than download filenames: object keys are also
  // used in URLs and cache paths, so anything outside [A-Za-z0-9-_] goes. This
  // is the pre-existing contract and is kept. The stem sanitiser is still
  // applied first so an empty base (which would yield a key like `_p1`) and a
  // Windows reserved stem are handled consistently with the filename builder.
  const base =
    sanitizePartFilenameStem(displayName)
      .replace(/[^a-zA-Z0-9\-_]/g, '')
      .slice(0, 120)
      .replace(/[._-]+$/, '') || FALLBACK_FILENAME_STEM;

  const parts: string[] = [base];
  if (opts?.partNumber != null) {
    parts.push(`p${opts.partNumber}`);
  }
  if (opts?.pageRange != null) {
    parts.push(`pg${opts.pageRange[0]}-${opts.pageRange[1]}`);
  }
  return parts.join('_');
}

// =============================================================================
// Canonical Piece Title Resolution
// =============================================================================

/**
 * Titles that are not real titles. An OCR/LLM pass will happily return one of
 * these when it fails to read the title block, and committing
 * "Untitled_1st_Flute.pdf" is worse than falling back to the uploaded filename
 * because it looks canonical to a human reviewer.
 */
const NON_CANONICAL_TITLES = new Set([
  'untitled',
  'unknown',
  'none',
  'null',
  'n/a',
  'na',
  'document',
  'scan',
  'scanned',
  'page',
  'untitled piece',
  'untitled score',
]);

/** Where the committed piece/part name came from. Persisted for audit. */
export type TitleSource = 'extracted' | 'upload-filename';

export interface ResolvedPartTitle {
  /** The title used to build the part name. */
  title: string;
  /** Whether it came from extraction or from the uploaded filename. */
  source: TitleSource;
  /** Human-readable display name, e.g. "Lincolnshire Posy 1st Bb Clarinet". */
  displayName: string;
  /** Safe filename, e.g. "Lincolnshire_Posy_1st_Bb_Clarinet.pdf". */
  fileName: string;
  /** Storage-safe slug, unique per part. */
  slug: string;
}

/** True when a title string is usable as a canonical piece title. */
export function isCanonicalTitle(title: unknown): title is string {
  if (typeof title !== 'string') return false;
  const trimmed = title.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.length > 200) return false;
  if (NON_CANONICAL_TITLES.has(trimmed.toLowerCase())) return false;
  // A title made entirely of digits is a scan id, not a work name.
  if (/^\d+$/.test(trimmed)) return false;
  return true;
}

/**
 * Resolve the title to use for a part name, preferring the extracted canonical
 * piece title over the uploaded filename.
 *
 * The uploaded filename is only a fallback, and the caller is told which was
 * used so the fallback can be surfaced rather than being silent.
 */
export function resolvePartTitle(args: {
  /** Title from OCR/LLM extraction. */
  extractedTitle?: string | null;
  /** Original uploaded filename, e.g. "scan_00482.pdf". */
  uploadedFileName: string;
  /** Normalised instrument for this part. */
  part: Pick<NormalisedInstrument, 'instrument'>;
  partNumber?: number;
  pageRange?: [number, number];
}): ResolvedPartTitle {
  const { extractedTitle, uploadedFileName, part, partNumber, pageRange } = args;

  const useExtracted = isCanonicalTitle(extractedTitle);
  const title = useExtracted
    ? (extractedTitle as string)
    : uploadedFileName.replace(/\.(pdf|png|jpe?g|tiff?)$/i, '').trim();

  const displayName = buildPartDisplayName(title, part);

  return {
    title,
    source: useExtracted ? 'extracted' : 'upload-filename',
    displayName,
    fileName: buildPartFilename(displayName),
    slug: buildPartStorageSlug(displayName, { partNumber, pageRange }),
  };
}
