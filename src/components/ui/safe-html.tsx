'use client';

import React, { useMemo } from 'react';
import { sanitizeHtml } from '@/lib/safe-html';
import { cn } from '@/lib/utils';

interface SafeHtmlProps {
  html: string;
  className?: string;
  as?: React.ElementType;
}

/**
 * A component that safely renders HTML by sanitizing it with a strict whitelist.
 * Use this instead of dangerouslySetInnerHTML directly.
 */
export function SafeHtml({
  html,
  className,
  as: Component = 'div'
}: SafeHtmlProps) {
  const sanitized = useMemo(() => sanitizeHtml(html), [html]);

  return (
    <Component
      className={cn(className)}
      dangerouslySetInnerHTML={{ __html: sanitized }}
    />
  );
}
