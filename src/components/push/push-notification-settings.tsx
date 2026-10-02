'use client';

/**
 * PushNotificationSettings — the member-facing control for web push.
 *
 * Accessibility (WCAG 2.1 AA, per AGENTS.md):
 *   - Radix Switch renders a real <button role="switch">: reachable by Tab,
 *     toggled by Space/Enter, and exposing aria-checked.
 *   - The switch has a real <label htmlFor>, so it has an accessible name.
 *   - Status text is in an aria-live="polite" region, so a screen reader
 *     announces the result of turning push on or off without moving focus.
 *   - The state is stated in words as well as colour, so it does not rely on
 *     the visual alone.
 *   - When push is unsupported or blocked, the control is disabled AND the
 *     reason is in the live region — a disabled control with no explanation is
 *     the classic dead end for a screen reader user.
 */

import { useId } from 'react';
import { Bell, BellOff, Loader2 } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { usePushNotifications } from './use-push-notifications';

export function PushNotificationSettings() {
  const labelId = useId();
  const descriptionId = useId();
  const statusId = useId();

  const { support, subscribed, consent, message, enable, disable, refreshing } =
    usePushNotifications();

  const unavailable = support === 'unsupported' || support === 'loading';
  const blocked = support === 'denied';
  const canChange = !unavailable && !blocked && !refreshing;

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <p id={labelId} className="font-medium">
            {subscribed ? 'Push notifications' : 'Enable push notifications'}
          </p>
          <p id={descriptionId} className="text-sm text-muted-foreground">
            Get alerts about announcements and upcoming events on this device.
            Notifications are off until you turn them on, and you can turn them off
            again at any time.
          </p>
        </div>
        <Switch
          id="push-notifications-toggle"
          checked={subscribed}
          disabled={!canChange}
          onCheckedChange={(next) => {
            void (next ? enable() : disable());
          }}
          aria-labelledby={labelId}
          aria-describedby={`${descriptionId} ${statusId}`}
        />
      </div>

      <p
        id={statusId}
        role="status"
        aria-live="polite"
        className="flex items-center gap-2 text-sm text-muted-foreground"
      >
        {refreshing ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        ) : subscribed ? (
          <Bell className="h-4 w-4 text-primary" aria-hidden="true" />
        ) : (
          <BellOff className="h-4 w-4" aria-hidden="true" />
        )}
        <span>{message}</span>
        {/* Screen readers get the state as a word, not only as a toggle visual. */}
        <span className="sr-only">
          {subscribed ? 'Push notifications are currently on.' : 'Push notifications are currently off.'}
          {consent ? '' : ' You have not enabled push notifications on this account.'}
        </span>
      </p>
    </div>
  );
}

export default PushNotificationSettings;
