'use client';

/**
 * Status Display Component
 *
 * Displays status messages, errors, and success states during the setup process.
 */

import { AlertCircle, CheckCircle2, Info, Loader2 } from 'lucide-react';

import { cn } from '@/lib/utils';

type StatusType = 'loading' | 'success' | 'error' | 'info';

interface StatusDisplayProps {
  type: StatusType;
  title: string;
  message: string;
  className?: string;
  action?: {
    label: string;
    onClick: () => void;
  };
}

const statusConfig = {
  loading: {
    icon: Loader2,
    iconClass: 'text-primary animate-spin',
    containerClass: 'bg-primary/10 border-primary/30',
    titleClass: 'text-white',
    messageClass: 'text-slate-300',
  },
  success: {
    icon: CheckCircle2,
    iconClass: 'text-green-500',
    containerClass: 'bg-green-500/10 border-green-500/30',
    titleClass: 'text-green-400',
    messageClass: 'text-slate-300',
  },
  error: {
    icon: AlertCircle,
    iconClass: 'text-red-500',
    containerClass: 'bg-red-500/10 border-red-500/30',
    titleClass: 'text-red-400',
    messageClass: 'text-slate-300',
  },
  info: {
    icon: Info,
    iconClass: 'text-primary-light',
    containerClass: 'bg-primary/10 border-primary/30',
    titleClass: 'text-primary-light',
    messageClass: 'text-slate-300',
  },
};

export function StatusDisplay({
  type,
  title,
  message,
  className,
  action,
}: StatusDisplayProps): React.ReactElement {
  const config = statusConfig[type];
  const Icon = config.icon;

  return (
    <div
      className={cn(
        'flex items-start gap-3 rounded-lg border p-4',
        config.containerClass,
        className,
      )}
      role={type === 'error' ? 'alert' : 'status'}
      aria-live={type === 'error' ? 'assertive' : 'polite'}
    >
      <Icon className={cn('h-5 w-5 shrink-0 mt-0.5', config.iconClass)} aria-hidden="true" />
      <div className="flex-1 space-y-1">
        <p className={cn('font-medium text-sm', config.titleClass)}>{title}</p>
        <p className={cn('text-sm', config.messageClass)}>{message}</p>
        {action && (
          <button
            type="button"
            onClick={action.onClick}
            className="text-sm font-medium text-primary-light hover:text-primary-light/80 underline-offset-4 hover:underline transition-colors"
          >
            {action.label}
          </button>
        )}
      </div>
    </div>
  );
}
