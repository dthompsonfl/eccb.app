/**
 * Metadata Normalizer — Normalize raw extracted values before commit.
 *
 * Ensures downstream DB records are stable, searchable, and deterministic
 * regardless of LLM/OCR output variance. Keeps both raw and normalized
 * values so provenance is never lost.
 */

import {
  findByFuzzyMatch,
  getSectionForLabel,
  getTranspositionForLabel,
  type InstrumentSection,
  type Transposition,
} from './canonical-instruments';
import type { ExtractedMetadata, CuttingInstruction } from '../../types/smart-upload';

// =============================================================================
// Types
// =============================================================================

/**
 * A normalized metadata record that pairs raw LLM output with cleaned values.
 */
export interface NormalizedMetadata {
  title: NormalizedField<string>;
  subtitle: NormalizedField<string | undefined>;
  composer: NormalizedField<string | undefined>;
  arranger: NormalizedField<string | undefined>;
  publisher: NormalizedField<string | undefined>;
  ensembleType: NormalizedField<string | undefined>;
  confidenceScore: number;
  fileType: ExtractedMetadata['fileType'];
  isMultiPart: boolean;
  parts: NormalizedPart[];
}

export interface NormalizedField<T> {
  /** Original value from LLM/OCR */
  raw: T;
  /** Cleaned/normalized value */
  normalized: T;
}

export interface NormalizedPart {
  /** Raw instrument label from LLM */
  rawInstrument: string;
  /** Raw part name from LLM */
  rawPartName: string;
  /** Canonical instrument name */
  canonicalInstrument: string;
  /** Canonical section */
  section: InstrumentSection;
  /** Canonical transposition */
  transposition: Transposition;
  /** Chair designation (1st, 2nd, etc.) */
  chair: string | null;
  /** Page range [start, end] */
  pageRange: [number, number];
  /** Deterministic fingerprint for dedup */
  fingerprint: string;
}

// =============================================================================
// Text Normalization Primitives
// =============================================================================

/**
 * Normalize a title string: trim, collapse whitespace, title-case.
 */
export function normalizeTitle(raw: string | undefined | null): string {
  if (!raw) return '';
  return raw
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\w\S*/g, (word) => {
      // Don't capitalize common articles/prepositions mid-title
      const lower = word.toLowerCase();
      if (['a', 'an', 'the', 'and', 'but', 'or', 'for', 'nor', 'in', 'on', 'at', 'to', 'of'].includes(lower)) {
        return lower;
      }
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    // Ensure first character is capitalized
    .replace(/^./, (c) => c.toUpperCase());
}

/**
 * Normalize a person name: trim, collapse whitespace, proper case.
 * Handles "Last, First" → "First Last" conversion.
 */
export function normalizePersonName(raw: string | undefined | null): string {
  if (!raw) return '';
  let name = raw.trim().replace(/\s+/g, ' ');

  // Handle "Last, First" format
  if (name.includes(',')) {
    const [last, first] = name.split(',', 2).map((s) => s.trim());
    if (first && last) {
      name = `${first} ${last}`;
    }
  }

  // Proper-case each word
  return name.replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Normalize a publisher name: trim, collapse whitespace.
 */
export function normalizePublisher(raw: string | undefined | null): string {
  if (!raw) return '';
  return raw.trim().replace(/\s+/g, ' ');
}

/**
 * Normalize a chair number string to canonical form.
 */
export function normalizeChair(raw: string | number | undefined | null): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const str = String(raw).trim().toLowerCase();

  // Numeric
  if (/^1$/.test(str)) return '1st';
  if (/^2$/.test(str)) return '2nd';
  if (/^3$/.test(str)) return '3rd';
  if (/^4$/.test(str)) return '4th';

  // English ordinals
  if (/^1st$/i.test(str) || /^first$/i.test(str)) return '1st';
  if (/^2nd$/i.test(str) || /^second$/i.test(str)) return '2nd';
  if (/^3rd$/i.test(str) || /^third$/i.test(str)) return '3rd';
  if (/^4th$/i.test(str) || /^fourth$/i.test(str)) return '4th';

  // Roman numerals
  if (/^i$/i.test(str)) return '1st';
  if (/^ii$/i.test(str)) return '2nd';
  if (/^iii$/i.test(str)) return '3rd';
  if (/^iv$/i.test(str)) return '4th';

  // Special
  if (/^aux/i.test(str)) return 'Aux';
  if (/^solo/i.test(str)) return 'Solo';

  return str;
}

/**
 * Extract a chair designation from a part name string.
 * e.g. "1st Bb Clarinet" → "1st", "2nd Trombone" → "2nd", "Solo Cornet" → "Solo"
 * Returns null when no chair prefix is found.
 */
export function extractChairFromPartName(partName: string | undefined | null): string | null {
  if (!partName) return null;
  const str = partName.trim();
  // Ordinal prefixes (most to least specific to avoid false positives)
  if (/^(1st|first)\b/i.test(str)) return '1st';
  if (/^(2nd|second)\b/i.test(str)) return '2nd';
  if (/^(3rd|third)\b/i.test(str)) return '3rd';
  if (/^(4th|fourth)\b/i.test(str)) return '4th';
  if (/^aux\b/i.test(str)) return 'Aux';
  if (/^solo\b/i.test(str)) return 'Solo';
  // Roman numeral prefixes: "I Bb Clarinet", "II Trombone"
  if (/^i\b(?!\S)/i.test(str)) return '1st';
  if (/^ii\b/i.test(str)) return '2nd';
  if (/^iii\b/i.test(str)) return '3rd';
  if (/^iv\b/i.test(str)) return '4th';
  return null;
}
/**
 * Normalize a transposition key string to canonical form.
 */
export function normalizeTransposition(raw: string | undefined | null): Transposition {
  if (!raw) return 'C';
  const str = raw.trim().toLowerCase();
  if (/^(bb|b-flat|b♭)$/i.test(str)) return 'Bb';
  if (/^(eb|e-flat|e♭)$/i.test(str)) return 'Eb';
  if (/^f$/i.test(str)) return 'F';
  if (/^g$/i.test(str)) return 'G';
  if (/^d$/i.test(str)) return 'D';
  if (/^a$/i.test(str)) return 'A';
  return 'C';
}

/**
 * Normalize an instrument label using the canonical instruments registry.
 */
export function normalizeInstrument(raw: string): {
  canonicalName: string;
  section: InstrumentSection;
  transposition: Transposition;
} {
  const match = findByFuzzyMatch(raw);
  if (match) {
    return {
      canonicalName: match.name,
      section: match.section,
      transposition: match.transposition,
    };
  }
  return {
    canonicalName: raw.trim() || 'Unknown',
    section: getSectionForLabel(raw),
    transposition: getTranspositionForLabel(raw),
  };
}

// =============================================================================
// Part Fingerprint
// =============================================================================

/**
 * Generate a deterministic fingerprint for a part.
 * Same inputs always produce the same fingerprint, safe for dedup.
 */
export function generatePartFingerprint(
  sessionId: string,
  canonicalInstrument: string,
  chair: string | null,
  pageStart: number,
  pageEnd: number
): string {
  const parts = [
    sessionId,
    canonicalInstrument.toLowerCase().replace(/\s+/g, '-'),
    chair ?? 'no-chair',
    `p${pageStart}-${pageEnd}`,
  ];
  return parts.join('::');
}

// =============================================================================
// Full Metadata Normalization
// =============================================================================

/**
 * Normalize an entire ExtractedMetadata object into a NormalizedMetadata record.
 * Preserves raw values alongside normalized ones.
 *
 * @param sessionId  Used for fingerprinting
 * @param raw        The extracted metadata from LLM/OCR
 * @param cuttingInstructions  Optional override for cutting instructions
 * @param filename   Original upload filename — used as title fallback when LLM returns "Unknown Title"
 */
export function normalizeExtractedMetadata(
  sessionId: string,
  raw: ExtractedMetadata,
  cuttingInstructions?: CuttingInstruction[],
  filename?: string,
): NormalizedMetadata {
  const instructions = cuttingInstructions ?? raw.cuttingInstructions ?? [];

  // When the LLM couldn't identify a title, derive one from the filename
  // rather than leaving "Unknown Title" in the library.
  let effectiveTitle = raw.title;
  if (
    (!effectiveTitle || effectiveTitle === 'Unknown Title') &&
    filename
  ) {
    effectiveTitle = filename
      .replace(/\.pdf$/i, '')
      .replace(/_/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^\d+[\s._-]+/, '')
      .trim() || effectiveTitle;
  }

  const parts: NormalizedPart[] = instructions.map((ci) => {
    const { canonicalName, section, transposition } = normalizeInstrument(ci.instrument);
    // Prefer the explicit chair field (new in CuttingInstruction v2) over the old
    // partNumber-as-chair fallback. When neither is present, parse from partName.
    const chair =
      ci.chair !== undefined
        ? (ci.chair ?? null)
        : (extractChairFromPartName(ci.partName) ?? normalizeChair(ci.partNumber));

    return {
      rawInstrument: ci.instrument,
      rawPartName: ci.partName,
      canonicalInstrument: canonicalName,
      section,
      transposition,
      chair,
      pageRange: ci.pageRange,
      fingerprint: generatePartFingerprint(
        sessionId,
        canonicalName,
        chair,
        ci.pageRange[0],
        ci.pageRange[1]
      ),
    };
  });

  return {
    title: {
      raw: raw.title,
      normalized: normalizeTitle(effectiveTitle),
    },
    subtitle: {
      raw: raw.subtitle,
      normalized: raw.subtitle ? normalizeTitle(raw.subtitle) : undefined,
    },
    composer: {
      raw: raw.composer,
      normalized: raw.composer ? normalizePersonName(raw.composer) : undefined,
    },
    arranger: {
      raw: raw.arranger,
      normalized: raw.arranger ? normalizePersonName(raw.arranger) : undefined,
    },
    publisher: {
      raw: raw.publisher,
      normalized: raw.publisher ? normalizePublisher(raw.publisher) : undefined,
    },
    ensembleType: {
      raw: raw.ensembleType,
      normalized: raw.ensembleType?.trim(),
    },
    confidenceScore: raw.confidenceScore,
    fileType: raw.fileType,
    isMultiPart: raw.isMultiPart ?? false,
    parts,
  };
}

/**
 * Coerce an extracted copyright year into a plausible year.
 *
 * The extractor returns `number | string` and models routinely produce things
 * like "1977", "c. 1977", "1977-1980", or "19th century". A canonical Int column
 * must not receive garbage, so anything not a defensible 4-digit year (or a
 * range whose start is) becomes null rather than a misleading value.
 */
export function normalizeCopyrightYear(
  raw: number | string | undefined | null,
): number | null {
  if (raw == null) return null;

  if (typeof raw === "number") {
    return Number.isInteger(raw) && raw >= 1450 && raw <= 2200 ? raw : null;
  }

  const text = String(raw).trim();
  if (text === "") return null;

  // Take the first plausible 4-digit year in the string ("c. 1977", "1977-80").
  const match = text.match(/\b(1[4-9]\d{2}|20\d{2}|21\d{2})\b/);
  if (!match) return null;

  const year = Number.parseInt(match[1], 10);
  return year >= 1450 && year <= 2200 ? year : null;
}
