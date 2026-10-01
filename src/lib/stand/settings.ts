/**
 * Stand Settings — DB-backed global settings via SystemSetting table.
 *
 * Persisted using namespaced keys ("stand.*") with Redis caching.
 * This is the single source of truth for:
 *   - Kill switch (stand.enabled)
 *   - Realtime mode, offline, practice tracking, etc.
 *   - Admin settings UI (/api/stand/settings)
 *   - Member config endpoint (/api/stand/config)
 *   - All stand pages and API routes
 */

import { prisma } from '@/lib/db';
import { redis } from '@/lib/redis';
import { isFeatureEnabled, FEATURES } from '@/lib/feature-flags';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StandGlobalSettings {
  enabled: boolean;
  realtimeMode: 'polling' | 'websocket' | 'off';
  maxStrokeDataBytes: number;
  maxAnnotationsPerPage: number;
  /**
   * NOT IMPLEMENTED. There is no working PWA: `public/sw.js` deliberately
   * unregisters itself and `public/manifest.json` uses `display: "browser"`,
   * so nothing is cached for offline use. Nothing reads this flag outside its
   * own unit test. Kept in the schema only so an existing SystemSetting row
   * does not break loading. Either implement offline support or delete these
   * three fields — do not surface an admin toggle for them.
   */
  offlineEnabled: boolean;
  practiceTrackingEnabled: boolean;
  /** NOT IMPLEMENTED. No audio link editor exists. See `offlineEnabled`. */
  audioSyncEnabled: boolean;
  defaultAutoTurnDelay: number;
  maxPdfSizeBytes: number;
  maxFileSizeMb: number;
  /** NOT IMPLEMENTED. No offline annotation queue exists. See `offlineEnabled`. */
  allowOfflineSync: boolean;
  accessPolicy: 'any_member' | 'rsvp_only';
  maintenanceMessage: string | null;
  pollingIntervalMs: number;
  websocketEnabled: boolean;
  websocketPort: number;
}

/** Allowlist — only these keys can be written by the admin form */
export const STAND_SETTING_KEYS: Array<keyof StandGlobalSettings> = [
  'enabled', 'realtimeMode', 'maxStrokeDataBytes', 'maxAnnotationsPerPage',
  'offlineEnabled', 'practiceTrackingEnabled', 'audioSyncEnabled',
  'defaultAutoTurnDelay', 'maxPdfSizeBytes', 'maxFileSizeMb',
  'allowOfflineSync', 'accessPolicy', 'maintenanceMessage', 'pollingIntervalMs',
  'websocketPort',
];

const DEFAULT_SETTINGS: StandGlobalSettings = {
  enabled: true,
  realtimeMode: process.env.ENABLE_WEBSOCKETS === 'true' ? 'websocket' : 'polling',
  maxStrokeDataBytes: 512_000,
  maxAnnotationsPerPage: 100,
  offlineEnabled: false,
  practiceTrackingEnabled: true,
  audioSyncEnabled: false,
  defaultAutoTurnDelay: 3_000,
  maxPdfSizeBytes: 50_000_000,
  maxFileSizeMb: 50,
  allowOfflineSync: false,
  accessPolicy: 'any_member',
  maintenanceMessage: null,
  pollingIntervalMs: 5_000,
  websocketEnabled: process.env.ENABLE_WEBSOCKETS === 'true',
  websocketPort: parseInt(process.env.SOCKET_PORT || '3005', 10),
};

const KEY_PREFIX = 'stand.';
const CACHE_KEY = 'stand:global-settings:v2';
const CACHE_TTL = 300;

function toSystemKey(field: string): string {
  return `${KEY_PREFIX}${field}`;
}

function parseSettingValue(field: keyof StandGlobalSettings, raw: string): unknown {
  const def = DEFAULT_SETTINGS[field];
  if (typeof def === 'boolean') return raw === 'true';
  if (typeof def === 'number') { const n = Number(raw); return Number.isFinite(n) ? n : def; }
  if (def === null) return raw === '' ? null : raw;
  return raw;
}

// ─── Getters ──────────────────────────────────────────────────────────────────

export async function getStandSettings(): Promise<StandGlobalSettings> {
  try {
    const cached = await redis.get(CACHE_KEY);
    if (cached) return { ...DEFAULT_SETTINGS, ...(JSON.parse(cached as string) as Partial<StandGlobalSettings>) };
  } catch { /* Redis unavailable */ }

  try {
    const rows = await prisma.systemSetting.findMany({
      where: { key: { startsWith: KEY_PREFIX } },
      select: { key: true, value: true },
    });
    if (rows.length > 0) {
      const partial: Partial<StandGlobalSettings> = {};
      for (const row of rows) {
        const field = row.key.slice(KEY_PREFIX.length) as keyof StandGlobalSettings;
        if (field in DEFAULT_SETTINGS) {
          (partial as Record<string, unknown>)[field] = parseSettingValue(field, row.value);
        }
      }
      if (partial.offlineEnabled !== undefined) partial.allowOfflineSync = partial.offlineEnabled;
      if (partial.maxPdfSizeBytes !== undefined) partial.maxFileSizeMb = Math.round((partial.maxPdfSizeBytes as number) / 1_000_000);
      if (partial.realtimeMode !== undefined) partial.websocketEnabled = partial.realtimeMode === 'websocket';
      const merged = { ...DEFAULT_SETTINGS, ...partial };
      try { await redis.set(CACHE_KEY, JSON.stringify(merged), 'EX', CACHE_TTL); } catch { /* ignore */ }
      return merged;
    }
  } catch { /* DB unavailable */ }

  return {
    ...DEFAULT_SETTINGS,
    enabled: isFeatureEnabled(FEATURES.MUSIC_STAND),
    practiceTrackingEnabled: isFeatureEnabled(FEATURES.PRACTICE_TRACKING),
    offlineEnabled: isFeatureEnabled(FEATURES.STAND_OFFLINE),
    allowOfflineSync: isFeatureEnabled(FEATURES.STAND_OFFLINE),
    audioSyncEnabled: isFeatureEnabled(FEATURES.STAND_AUDIO_SYNC),
    realtimeMode: isFeatureEnabled(FEATURES.STAND_WEBSOCKET_SYNC) ? 'websocket' : 'polling',
    websocketEnabled: isFeatureEnabled(FEATURES.STAND_WEBSOCKET_SYNC),
  };
}

export async function isStandEnabled(): Promise<boolean> {
  const s = await getStandSettings();
  return s.enabled;
}

// ─── Setters (Admin) ──────────────────────────────────────────────────────────

export async function updateStandSettings(
  updates: Partial<StandGlobalSettings>,
  updatedBy?: string
): Promise<StandGlobalSettings> {
  const allowed = new Set(STAND_SETTING_KEYS as string[]);
  const filtered = Object.fromEntries(
    Object.entries(updates).filter(([k]) => allowed.has(k))
  ) as Partial<StandGlobalSettings>;

  // Sync aliases
  if (filtered.maxFileSizeMb !== undefined && filtered.maxPdfSizeBytes === undefined)
    filtered.maxPdfSizeBytes = filtered.maxFileSizeMb * 1_000_000;
  if (filtered.maxPdfSizeBytes !== undefined && filtered.maxFileSizeMb === undefined)
    filtered.maxFileSizeMb = Math.round(filtered.maxPdfSizeBytes / 1_000_000);
  if (filtered.allowOfflineSync !== undefined && filtered.offlineEnabled === undefined)
    filtered.offlineEnabled = filtered.allowOfflineSync;
  if (filtered.offlineEnabled !== undefined && filtered.allowOfflineSync === undefined)
    filtered.allowOfflineSync = filtered.offlineEnabled;
  if (filtered.realtimeMode !== undefined)
    filtered.websocketEnabled = filtered.realtimeMode === 'websocket';

  await Promise.all(
    Object.entries(filtered).map(([field, value]) =>
      prisma.systemSetting.upsert({
        where: { key: toSystemKey(field) },
        create: { key: toSystemKey(field), value: value === null ? '' : String(value), description: `Music Stand — ${field}`, updatedBy: updatedBy ?? null },
        update: { value: value === null ? '' : String(value), updatedBy: updatedBy ?? null },
      })
    )
  );

  try { await redis.del(CACHE_KEY); } catch { /* ignore */ }
  return getStandSettings();
}
