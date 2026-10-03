/**
 * Feature Flags — simple runtime feature gating.
 *
 * For production kill-switches the admin can set environment variables
 * or (future) update DB/Redis settings. Currently uses env vars with
 * sensible defaults.
 *
 * Usage:
 *   import { isFeatureEnabled, FEATURES } from '@/lib/feature-flags';
 *   if (!isFeatureEnabled(FEATURES.MUSIC_STAND)) { notFound(); }
 */

/** Known feature flag keys */
export const FEATURES = {
  /** Master toggle for the Digital Music Stand */
  MUSIC_STAND: 'FEATURE_MUSIC_STAND',
  /** Practice timer / practice log tracking */
  PRACTICE_TRACKING: 'FEATURE_PRACTICE_TRACKING',
  /** Real-time WebSocket sync (vs polling-only) */
  STAND_WEBSOCKET_SYNC: 'FEATURE_STAND_WEBSOCKET_SYNC',
  /** Audio-synced score playback (planned) */
  STAND_AUDIO_SYNC: 'FEATURE_STAND_AUDIO_SYNC',
  /** Offline PWA caching for stand PDFs */
  STAND_OFFLINE: 'FEATURE_STAND_OFFLINE',
} as const;

export type FeatureKey = (typeof FEATURES)[keyof typeof FEATURES];

/**
 * Defaults — all features that should be ON unless explicitly disabled.
 * Set the env var to 'false' or '0' to disable.
 */
const DEFAULTS: Record<string, boolean> = {
  [FEATURES.MUSIC_STAND]: true,
  [FEATURES.PRACTICE_TRACKING]: true,
  // Realtime WebSocket sync is the supported default posture; the standalone
  // `ENABLE_WEBSOCKETS=false` switch is the opt-out. Defaulting this to false
  // made the no-rows settings fallback serve realtimeMode=polling.
  [FEATURES.STAND_WEBSOCKET_SYNC]: true,
  [FEATURES.STAND_AUDIO_SYNC]: false,
  [FEATURES.STAND_OFFLINE]: false,
};

/**
 * Check if a feature is enabled.
 *
 * Resolution order:
 * 1. Environment variable (e.g. FEATURE_MUSIC_STAND=false)
 * 2. Hard-coded default (see DEFAULTS above)
 * 3. true (unknown flags default to enabled)
 */
export function isFeatureEnabled(flag: FeatureKey): boolean {
  const envValue = process.env[flag];

  if (envValue !== undefined) {
    return envValue !== 'false' && envValue !== '0';
  }

  return DEFAULTS[flag] ?? true;
}
