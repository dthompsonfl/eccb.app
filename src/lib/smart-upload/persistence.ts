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
