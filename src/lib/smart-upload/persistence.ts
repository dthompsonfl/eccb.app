import { deepCloneJSON } from '@/lib/json';

/**
 * Structured Smart Upload fields are stored as LongText columns in Prisma.
 * Prisma expects strings for those columns, while the application needs typed
 * objects/arrays at the edges. Keep all serialization here so workers, review
 * routes, and commit logic cannot drift.
 */
const STRUCTURED_SESSION_JSON_FIELDS = new Set([
  'extractedMetadata',
  'parsedParts',
  'cuttingInstructions',
  'tempFiles',
  'llmModelParams',
  'strategyHistory',
  'secondPassResult',
  'adjudicatorResult',
]);

export function parseSmartUploadJsonField<T>(
  value: unknown,
  fallback: T,
): T {
  if (value === null || value === undefined) {
    return fallback;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return fallback;
    }

    try {
      return JSON.parse(trimmed) as T;
    } catch {
      return fallback;
    }
  }

  if (typeof value === 'object') {
    return value as T;
  }

  return fallback;
}

export function parseSmartUploadJsonArray<T>(value: unknown): T[] {
  const parsed = parseSmartUploadJsonField<unknown>(value, []);
  return Array.isArray(parsed) ? (parsed as T[]) : [];
}

/**
 * Merge a newly produced list of temp storage keys into the keys a session
 * already tracks.
 *
 * `SmartUploadSession.tempFiles` is the ONLY index of a session's temporary
 * objects: `cleanupSmartUploadTempFiles` (reject / re-process) and commit both
 * key strictly off it and never enumerate the `smart-upload/` storage prefix.
 * A re-split therefore must ADD its keys, never replace the list — replacing it
 * drops the earlier objects on the floor where nothing can ever find or delete
 * them again. Duplicate keys (a re-split that reuses a key) must not be written
 * twice either, since cleanup deletes by iterating this list.
 *
 * Order is stable: existing keys first, then genuinely new keys in arrival
 * order. Accepts the persisted JSON text as well as an array, and drops
 * blank/non-string junk so nothing unusable reaches the LongText column.
 */
export function accumulateTempFiles(
  existing: unknown,
  incoming: readonly unknown[] | null | undefined,
): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();

  for (const source of [existing, incoming]) {
    for (const entry of parseSmartUploadJsonArray<unknown>(source)) {
      if (typeof entry !== 'string') continue;
      const key = entry.trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(key);
    }
  }

  return merged;
}

/**
 * Canonical Smart Upload part storage key.
 *
 * Split/re-processing variants get their own subdirectory (the codebase already
 * namespaces them as `heal/` in the processor and `resplit/` in the review
 * route) so a later pass can never silently overwrite an earlier pass's object
 * for the same session + slug. Persisted `storageKey` values are absolute
 * strings and nothing parses them by prefix, so the variant is a storage-layout
 * concern only — no data migration is implied by changing it.
 */
export function buildSmartUploadPartKey(
  sessionId: string,
  slug: string,
  variant?: string | null,
): string {
  const namespace = variant ? `${variant.replace(/^\/+|\/+$/g, '')}/` : '';
  return `smart-upload/${sessionId}/parts/${namespace}${slug}.pdf`;
}

export function serializeSmartUploadJsonField(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    try {
      JSON.parse(trimmed);
      return trimmed;
    } catch {
      return JSON.stringify(trimmed);
    }
  }

  return JSON.stringify(deepCloneJSON(value));
}

export function serializeSmartUploadSessionData<T extends Record<string, unknown>>(data: T): T {
  const serialized: Record<string, unknown> = { ...data };

  for (const field of STRUCTURED_SESSION_JSON_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(data, field) && data[field] !== undefined) {
      serialized[field] = serializeSmartUploadJsonField(data[field]);
    }
  }

  return serialized as T;
}

export function getSmartUploadStructuredFieldNames(): string[] {
  return [...STRUCTURED_SESSION_JSON_FIELDS];
}
