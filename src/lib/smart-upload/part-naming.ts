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
 * Build a safe filesystem filename from a display name.
 *
 * E.g. "American Patrol 1st Bb Clarinet" → "American_Patrol_1st_Bb_Clarinet.pdf"
 */
export function buildPartFilename(displayName: string): string {
  return (
    displayName
      .trim()
      .replace(/[/\\:*?"<>|']/g, '') // remove filesystem-unsafe chars
      .replace(/\s+/g, '_')         // spaces → underscores
      .replace(/_{2,}/g, '_')       // collapse multiple underscores
      .slice(0, 200) +              // max 200 chars before extension
    '.pdf'
  );
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
  const base = displayName
    .trim()
    .replace(/[^a-zA-Z0-9\-_ ]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_{2,}/g, '_')
    .slice(0, 120); // shortened to leave room for the suffix

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
