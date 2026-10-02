import { describe, expect, it } from 'vitest';
import {
  getNotificationPreferences,
  isNotificationPreferenceEnabled,
  parseUserPreferenceSettings,
  serializeNotificationPreferences,
} from '@/lib/notifications/preferences';

describe('notification preferences', () => {
  it('defaults all delivery classes to enabled', () => {
    expect(getNotificationPreferences(null)).toEqual({
      eventReminders: true,
      musicAssignments: true,
      announcements: true,
    });
  });

  it('preserves unrelated stand preferences when saving notification settings', () => {
    const raw = JSON.stringify({
      tunerSettings: { a440: 442 },
      selectedParts: { pieceA: 'partA' },
    });

    const serialized = serializeNotificationPreferences(raw, {
      eventReminders: false,
      musicAssignments: true,
      announcements: false,
    });
    const parsed = parseUserPreferenceSettings(serialized);

    expect(parsed.tunerSettings).toEqual({ a440: 442 });
    expect(parsed.selectedParts).toEqual({ pieceA: 'partA' });
    expect(parsed.notifications).toEqual({
      eventReminders: false,
      musicAssignments: true,
      announcements: false,
    });
  });

  it('fails safe to defaults when legacy otherSettings JSON is malformed', () => {
    expect(isNotificationPreferenceEnabled('{not-json', 'announcements')).toBe(true);
  });
});
