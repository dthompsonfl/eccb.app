'use client';

import * as React from 'react';
import { toast } from 'sonner';
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
import { cn } from '@/lib/utils';

/** Minimum hit area. A shaky hand misses a 28px icon button; it does not miss 44. */
const TOUCH_TARGET = 'min-w-[44px] min-h-[44px]';

export interface ConfirmActionButtonProps {
  /** What is about to be destroyed, phrased for a person: "Spring Concert setlist". */
  itemName: string;
  /**
   * The confirmation prompt. Say what will happen AND that it can be undone,
   * because a member who is unsure should be able to act without fear.
   */
  confirmTitle: string;
  confirmDescription: string;
  /** The button that arms the dialog. */
  children: React.ReactNode;
  /** Perform the destructive action. May be async. */
  onConfirm: () => void | Promise<void>;
  /**
   * Optional undo. When supplied, a toast offers to put the item back.
   * Prefer this over a bare confirm wherever the work can be re-created:
   * for this audience an undo is kinder than a permission slip.
   */
  onUndo?: () => void | Promise<void>;
  /** Label for the undo affordance in the toast, e.g. "Put it back". */
  undoLabel?: string;
  /** Toast shown after the action succeeds. */
  successMessage?: string;
  /** Extra classes for the trigger button. */
  className?: string;
  /** Accessible name for an icon-only trigger. */
  'aria-label'?: string;
  variant?: 'default' | 'ghost' | 'outline' | 'destructive';
  size?: 'default' | 'sm' | 'lg' | 'icon' | 'icon-sm' | 'icon-lg';
}

/**
 * A destructive action that cannot happen by accident.
 *
 * Before this existed, "remove bookmark", "delete setlist" and "delete carpool
 * entry" fired on a single tap of a 28px icon — one brush of a sleeve and the
 * work was gone, with no way back and no confirmation that it had happened.
 *
 * Two layers, because one is not enough for this audience:
 *   1. An explicit confirm naming the item, so nothing is destroyed by a mis-tap.
 *   2. An undo toast when `onUndo` is given, so a member who confirms out of
 *      habit is not stuck — the recovery does not require understanding what
 *      went wrong first.
 *
 * The undo toast runs long (10s) and is dismissible; sonner renders it with a
 * real button, so it is reachable by keyboard as well as by tap.
 */
export function ConfirmActionButton({
  itemName,
  confirmTitle,
  confirmDescription,
  children,
  onConfirm,
  onUndo,
  undoLabel = 'Put it back',
  successMessage,
  className,
  variant = 'ghost',
  size = 'icon',
  'aria-label': ariaLabel,
}: ConfirmActionButtonProps): React.ReactElement {
  const [isBusy, setIsBusy] = React.useState(false);
  // Guards against a double-tap on the confirm button firing onConfirm twice.
  const inFlightRef = React.useRef(false);

  const handleConfirm = React.useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setIsBusy(true);
    try {
      await onConfirm();
      if (successMessage) {
        if (onUndo) {
          toast.success(successMessage, {
            duration: 10_000,
            action: {
              label: undoLabel,
              onClick: () => {
                void Promise.resolve(onUndo()).then(() => {
                  toast.success('Put back.');
                });
              },
            },
          });
        } else {
          toast.success(successMessage);
        }
      }
    } catch (error) {
      console.error(`[ConfirmActionButton] ${itemName} failed:`, error);
      toast.error('That did not work. Nothing was changed — please try again.');
    } finally {
      inFlightRef.current = false;
      setIsBusy(false);
    }
  }, [itemName, onConfirm, onUndo, successMessage, undoLabel]);

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          variant={variant}
          size={size}
          className={cn(TOUCH_TARGET, className)}
          disabled={isBusy}
          aria-label={ariaLabel}
        >
          {children}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{confirmTitle}</AlertDialogTitle>
          <AlertDialogDescription>{confirmDescription}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <AlertDialogAction onClick={handleConfirm}>
            {isBusy ? 'Working...' : 'Yes, remove it'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

ConfirmActionButton.displayName = 'ConfirmActionButton';

export default ConfirmActionButton;