export interface NotificationPreferences {
  eventReminders: boolean;
  musicAssignments: boolean;
  announcements: boolean;
}

export const DEFAULT_NOTIFICATION_PREFERENCES: Readonly<NotificationPreferences> = {
  eventReminders: true,
  musicAssignments: true,
  announcements: true,
};

export type NotificationPreferenceKey = keyof NotificationPreferences;

export function parseUserPreferenceSettings(
  raw: unknown,
): Record<string, unknown> {
  if (!raw) return {};

  // Prisma stores this field as JSON text today, but accepting an already
  // parsed object makes the merge path tolerant of legacy callers/tests and
  // future storage migrations without discarding unrelated preferences.
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return { ...(raw as Record<string, unknown>) };
  }

  if (typeof raw !== 'string') return {};

  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function getNotificationPreferences(
  raw: string | null | undefined,
): NotificationPreferences {
  const settings = parseUserPreferenceSettings(raw);
  const candidate =
    settings.notifications &&
    typeof settings.notifications === 'object' &&
    !Array.isArray(settings.notifications)
      ? (settings.notifications as Record<string, unknown>)
      : {};

  return {
    eventReminders:
      typeof candidate.eventReminders === 'boolean'
        ? candidate.eventReminders
        : DEFAULT_NOTIFICATION_PREFERENCES.eventReminders,
    musicAssignments:
      typeof candidate.musicAssignments === 'boolean'
        ? candidate.musicAssignments
        : DEFAULT_NOTIFICATION_PREFERENCES.musicAssignments,
    announcements:
      typeof candidate.announcements === 'boolean'
        ? candidate.announcements
        : DEFAULT_NOTIFICATION_PREFERENCES.announcements,
  };
}

export function serializeNotificationPreferences(
  raw: string | null | undefined,
  preferences: NotificationPreferences,
): string {
  const settings = parseUserPreferenceSettings(raw);
  return JSON.stringify({
    ...settings,
    notifications: {
      ...(settings.notifications &&
      typeof settings.notifications === 'object' &&
      !Array.isArray(settings.notifications)
        ? (settings.notifications as Record<string, unknown>)
        : {}),
      ...preferences,
    },
  });
}

export function isNotificationPreferenceEnabled(
  raw: string | null | undefined,
  key: NotificationPreferenceKey,
): boolean {
  return getNotificationPreferences(raw)[key];
}
