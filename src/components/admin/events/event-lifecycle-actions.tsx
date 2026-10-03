'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { toast } from 'sonner';
import { Ban, Trash2 } from 'lucide-react';

import { deleteEvent, updateEventStatus } from '@/app/(admin)/admin/events/actions';

interface EventLifecycleActionsProps {
  eventId: string;
  eventTitle: string;
  isCancelled: boolean;
  /**
   * True when the event already has attendance or programme content.
   *
   * Deleting an event cascades to its attendance rows, its RSVP-linked music
   * links and its programme — the historical record a section leader relies on.
   * The button explains that rather than deleting silently.
   */
  hasHistory: boolean;
}

/**
 * Cancel / reinstate / delete for an event.
 *
 * `updateEventStatus` and `deleteEvent` have existed in `actions.ts` for the
 * whole life of the app with no caller, while TODO.md recorded Event CRUD as
 * "verified complete". An admin could open an event, see it marked CANCELLED or
 * SCHEDULED, and have no way to change it — and no way to remove an event that
 * was created by mistake. This wires the two existing actions rather than
 * rewriting them.
 *
 * Cancel is preferred over delete: it preserves the attendance history, which is
 * exactly what the reports read.
 */
export function EventLifecycleActions({
  eventId,
  eventTitle,
  isCancelled,
  hasHistory,
}: EventLifecycleActionsProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const handleStatusChange = (status: 'SCHEDULED' | 'CANCELLED') => {
    startTransition(async () => {
      const result = await updateEventStatus(eventId, status);
      if (result.success) {
        toast.success(
          status === 'CANCELLED'
            ? `"${eventTitle}" is now marked cancelled.`
            : `"${eventTitle}" is back on the schedule.`,
        );
        router.refresh();
      } else {
        toast.error(result.error || 'Could not change the event status.');
      }
    });
  };

  const handleDelete = () => {
    startTransition(async () => {
      const result = await deleteEvent(eventId);
      if (result.success) {
        toast.success(`"${eventTitle}" was deleted.`);
        router.push('/admin/events');
        router.refresh();
      } else {
        toast.error(result.error || 'Could not delete the event.');
      }
    });
  };

  return (
    <div className="flex items-center gap-2">
      {isCancelled ? (
        <Button
          variant="outline"
          disabled={isPending}
          onClick={() => handleStatusChange('SCHEDULED')}
        >
          Put back on schedule
        </Button>
      ) : (
        <Button
          variant="outline"
          disabled={isPending}
          onClick={() => handleStatusChange('CANCELLED')}
        >
          <Ban className="mr-2 h-4 w-4" />
          Cancel event
        </Button>
      )}

      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button variant="destructive" disabled={isPending}>
            <Trash2 className="mr-2 h-4 w-4" />
            Delete
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete &quot;{eventTitle}&quot;?</AlertDialogTitle>
            <AlertDialogDescription>
              {hasHistory
                ? 'This event already has attendance or programme content. Deleting it also removes that history, and it cannot be undone. Cancelling the event instead keeps the history and only hides it from the public calendar.'
                : 'This cannot be undone. If you only want to take this event off the public calendar, cancelling it is safer.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep event</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>
              Yes, delete permanently
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

EventLifecycleActions.displayName = 'EventLifecycleActions';