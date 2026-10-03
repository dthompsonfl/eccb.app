import { describe, it, expect, afterEach } from 'vitest';
import { isFeatureEnabled, FEATURES } from '@/lib/feature-flags';

describe('Feature Flags', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore original env
    process.env = { ...originalEnv };
  });

  it('should return true for MUSIC_STAND by default', () => {
    delete process.env[FEATURES.MUSIC_STAND];
    expect(isFeatureEnabled(FEATURES.MUSIC_STAND)).toBe(true);
  });

  it('should return true for PRACTICE_TRACKING by default', () => {
    delete process.env[FEATURES.PRACTICE_TRACKING];
    expect(isFeatureEnabled(FEATURES.PRACTICE_TRACKING)).toBe(true);
  });

  it('should return true for STAND_WEBSOCKET_SYNC by default', () => {
    // Realtime WebSocket sync is the supported posture. This default was `false`,
    // which made the no-rows settings fallback in `@/lib/stand/settings` serve
    // realtimeMode=polling even on a deployment configured for realtime.
    delete process.env[FEATURES.STAND_WEBSOCKET_SYNC];
    expect(isFeatureEnabled(FEATURES.STAND_WEBSOCKET_SYNC)).toBe(true);
  });

  it('should disable STAND_WEBSOCKET_SYNC when env var is "false"', () => {
    process.env[FEATURES.STAND_WEBSOCKET_SYNC] = 'false';
    expect(isFeatureEnabled(FEATURES.STAND_WEBSOCKET_SYNC)).toBe(false);
  });

  it('should return false for STAND_AUDIO_SYNC by default', () => {
    delete process.env[FEATURES.STAND_AUDIO_SYNC];
    expect(isFeatureEnabled(FEATURES.STAND_AUDIO_SYNC)).toBe(false);
  });

  it('should return false for STAND_OFFLINE by default', () => {
    delete process.env[FEATURES.STAND_OFFLINE];
    expect(isFeatureEnabled(FEATURES.STAND_OFFLINE)).toBe(false);
  });

  it('should disable a flag when env var is "false"', () => {
    process.env[FEATURES.MUSIC_STAND] = 'false';
    expect(isFeatureEnabled(FEATURES.MUSIC_STAND)).toBe(false);
  });

  it('should disable a flag when env var is "0"', () => {
    process.env[FEATURES.MUSIC_STAND] = '0';
    expect(isFeatureEnabled(FEATURES.MUSIC_STAND)).toBe(false);
  });

  it('should enable a flag when env var is "true"', () => {
    process.env[FEATURES.STAND_WEBSOCKET_SYNC] = 'true';
    expect(isFeatureEnabled(FEATURES.STAND_WEBSOCKET_SYNC)).toBe(true);
  });

  it('should enable a flag when env var is "1"', () => {
    process.env[FEATURES.STAND_OFFLINE] = '1';
    expect(isFeatureEnabled(FEATURES.STAND_OFFLINE)).toBe(true);
  });

  it('should enable a flag when env var is any non-false string', () => {
    process.env[FEATURES.STAND_AUDIO_SYNC] = 'yes';
    expect(isFeatureEnabled(FEATURES.STAND_AUDIO_SYNC)).toBe(true);
  });
});
