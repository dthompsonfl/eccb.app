/**
 * Redis-backed shared state for the Digital Music Stand sync subsystem.
 *
 * WHY THIS EXISTS
 * ---------------
 * The stand sync endpoint used to hold the director's page-turn state and the
 * player presence roster in two module-level `Map`s. That state is:
 *
 *   1. NOT DURABLE  — it is wiped on every deploy / restart / worker recycle, so
 *      the band silently falls back to "nobody knows what page we are on".
 *   2. NOT SHARED   — in any multi-process deployment (Next.js standalone with
 *      a cluster, or more than one app instance behind a load balancer) the
 *      director's POST lands in process A's heap while the player polling
 *      process B sees nothing. This breaks the core promise of the stand:
 *      "the director annotates once and every player sees it".
 *
 * Both problems are fixed by making Redis the single source of truth. Redis is
 * already a hard dependency of this app (ioredis singleton in `@/lib/redis`,
 * BullMQ queues, stand settings cache), so this adds no new infrastructure.
 *
 * KEY SCHEME
 * ----------
 *   eccb:stand:sync:state:<eventId>          JSON string  (see StandSyncState)
 *   eccb:stand:sync:presence:<eventId>        Redis hash  field = userId
 *
 * Presence uses a hash rather than one key per user so that the roster can be
 * read with a single O(N) HGETALL instead of an SCAN; N is the size of one
 * rehearsal, so this is cheap.
 *
 * TTLs (documented policy)
 * -------------------------
 *   • STAND_STATE_TTL_SECONDS = 6h.
 *     A rehearsal or concert never runs longer than this, and every director
 *     write refreshes the TTL, so an actively-used stand never expires mid-event.
 *     The TTL exists only to reap state for events that ended months ago; a
 *     missing key is reported to clients as "no state yet", never as page 1.
 *   • PRESENCE_TTL_SECONDS = 30s, deliberately equal to
 *     ACTIVE_PRESENCE_WINDOW_MS. Presence is a heartbeat: the client's polling
 *     loop refreshes it. If a player closes their laptop the key expires within
 *     exactly the window the old code used, so the roster semantics are
 *     unchanged. Entries are additionally filtered on `lastSeen` when read so
 *     the window holds even if a heartbeat is delayed.
 *
 * FAILURE POLICY (deliberate: fail SAFE and LOUD, never silently degrade)
 * -----------------------------------------------------------------------
 * There is intentionally NO process-local fallback. A local fallback would
 * reintroduce exactly the split-brain bug this module exists to remove: a
 * director's command would appear to succeed against the local Map while every
 * other process — and every player — saw stale state. A believable wrong answer
 * during a concert is far worse than an explicit error.
 *
 * So every Redis failure throws {@link StandStateUnavailableError}, which the
 * route converts to HTTP 503 with a plain-language message. Clients surface
 * "sync temporarily unavailable" and players fall back to their own PDF page,
 * which is exactly what already happens today when the network drops. No
 * fabricated `success: true` is ever returned.
 */

import { redis } from '@/lib/redis';
import { logger } from '@/lib/logger';
import { z } from 'zod';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Namespace for every key this module owns. */
export const STAND_SYNC_KEY_PREFIX = 'eccb:stand:sync:';

/** Presence window, mirrored from the sync route's polling contract (30s). */
export const ACTIVE_PRESENCE_WINDOW_MS = 30_000;

/** Presence hash TTL — matches ACTIVE_PRESENCE_WINDOW_MS exactly. */
export const PRESENCE_TTL_SECONDS = Math.round(ACTIVE_PRESENCE_WINDOW_MS / 1000);

/** Stand state TTL — see module header. */
export const STAND_STATE_TTL_SECONDS = 6 * 60 * 60;

/** Canonical, versioned Redis keys. Exported so tests and diagnostics agree. */
export const standSyncKeys = {
  state: (eventId: string): string => `${STAND_SYNC_KEY_PREFIX}state:${eventId}`,
  presence: (eventId: string): string => `${STAND_SYNC_KEY_PREFIX}presence:${eventId}`,
} as const;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StandSyncState {
  eventId: string;
  musicId?: string;
  currentPage?: number;
  currentPieceIndex?: number;
  nightMode?: boolean;
  lastUpdated: string;
}

export interface StandPresenceEntry {
  userId: string;
  name: string;
  section?: string;
  eventId: string;
  lastSeen: string;
}

/** Fields a director is allowed to change. */
export type StandStateUpdate = Partial<
  Pick<StandSyncState, 'musicId' | 'currentPage' | 'currentPieceIndex' | 'nightMode'>
>;

// ─── Schemas ──────────────────────────────────────────────────────────────────

/** Validates anything read back out of Redis before it reaches a client. */
export const standSyncStateSchema = z.object({
  eventId: z.string().min(1),
  musicId: z.string().optional(),
  currentPage: z.number().int().positive().optional(),
  currentPieceIndex: z.number().int().min(0).optional(),
  nightMode: z.boolean().optional(),
  lastUpdated: z.string().datetime(),
});

export const standPresenceEntrySchema = z.object({
  userId: z.string().min(1),
  name: z.string(),
  section: z.string().optional(),
  eventId: z.string().min(1),
  lastSeen: z.string().datetime(),
});

// ─── Failure ──────────────────────────────────────────────────────────────────

/** Thrown for every Redis read/write failure. Mapped to HTTP 503 by the route. */
export class StandStateUnavailableError extends Error {
  readonly operation: string;

  constructor(operation: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Stand sync state unavailable during ${operation}: ${detail}`);
    this.name = 'StandStateUnavailableError';
    this.operation = operation;
  }
}

function fail(operation: string, cause: unknown): never {
  logger.error('Stand sync Redis operation failed', { operation, error: cause });
  throw new StandStateUnavailableError(operation, cause);
}

// ─── Stand state ──────────────────────────────────────────────────────────────

/**
 * Read the current stand state for an event.
 * Returns null when no state has been written yet (NOT an error — a stand that
 * has not been driven yet legitimately has no page).
 */
export async function getStandState(eventId: string): Promise<StandSyncState | null> {
  let raw: string | null;
  try {
    raw = await redis.get(standSyncKeys.state(eventId));
  } catch (error) {
    return fail('getStandState', error);
  }

  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    // Corrupt payload: refuse to serve it rather than guess a page number.
    return fail('getStandState.parse', error);
  }

  const result = standSyncStateSchema.safeParse(parsed);
  if (!result.success) {
    logger.error('Stand sync state failed schema validation', {
      eventId,
      issues: result.error.issues,
    });
    throw new StandStateUnavailableError('getStandState.validate', result.error);
  }

  return result.data;
}

/**
 * Merge `updates` into the event's stand state and persist it with a fresh TTL.
 * Read-modify-write is acceptable here: writers are directors, who issue page
 * turns one at a time, and the last write is authoritative by design.
 */
export async function updateStandState(
  eventId: string,
  updates: StandStateUpdate
): Promise<StandSyncState> {
  const existing = await getStandState(eventId);

  const next: StandSyncState = {
    ...(existing ?? { eventId }),
    eventId,
    ...updates,
    lastUpdated: new Date().toISOString(),
  };

  try {
    await redis.set(
      standSyncKeys.state(eventId),
      JSON.stringify(next),
      'EX',
      STAND_STATE_TTL_SECONDS
    );
  } catch (error) {
    return fail('updateStandState', error);
  }

  return next;
}

// ─── Presence ─────────────────────────────────────────────────────────────────

/** Heartbeat: (re)record that `userId` is currently looking at this event's stand. */
export async function touchPresence(entry: Omit<StandPresenceEntry, 'lastSeen'>): Promise<void> {
  const payload: StandPresenceEntry = { ...entry, lastSeen: new Date().toISOString() };
  const key = standSyncKeys.presence(entry.eventId);

  try {
    await redis
      .multi()
      .hset(key, entry.userId, JSON.stringify(payload))
      .expire(key, PRESENCE_TTL_SECONDS)
      .exec();
  } catch (error) {
    fail('touchPresence', error);
  }
}

/** Explicit sign-off; falls back to the TTL if the key is already gone. */
export async function clearPresence(eventId: string, userId: string): Promise<void> {
  try {
    await redis.hdel(standSyncKeys.presence(eventId), userId);
  } catch (error) {
    fail('clearPresence', error);
  }
}

/**
 * All users seen inside ACTIVE_PRESENCE_WINDOW_MS for this event.
 * Stale fields are pruned on read so a delayed heartbeat cannot keep a ghost on
 * the roster, and so the hash cannot grow without bound within its TTL.
 */
export async function getActivePresence(eventId: string): Promise<StandPresenceEntry[]> {
  const key = standSyncKeys.presence(eventId);

  let raw: Record<string, string>;
  try {
    raw = await redis.hgetall(key);
  } catch (error) {
    return fail('getActivePresence', error);
  }

  const cutoff = Date.now() - ACTIVE_PRESENCE_WINDOW_MS;
  const active: StandPresenceEntry[] = [];
  const staleFields: string[] = [];

  for (const [userId, value] of Object.entries(raw)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch (error) {
      logger.warn('Discarding unparseable stand presence entry', { eventId, userId, error });
      staleFields.push(userId);
      continue;
    }

    const result = standPresenceEntrySchema.safeParse(parsed);
    if (!result.success) {
      logger.warn('Discarding schema-invalid stand presence entry', { eventId, userId });
      staleFields.push(userId);
      continue;
    }

    const entry = result.data;
    if (Date.parse(entry.lastSeen) <= cutoff) {
      staleFields.push(userId);
      continue;
    }
    active.push(entry);
  }

  if (staleFields.length > 0) {
    try {
      await redis.hdel(key, ...staleFields);
    } catch (error) {
      // Pruning is an optimisation; the read already produced the correct list.
      logger.warn('Failed to prune stale stand presence entries', { eventId, error });
    }
  }

  return active;
}