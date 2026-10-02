'use client';

import * as React from 'react';
import { Type } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import { useTextScale } from '@/components/accessibility/text-scale-context';
import {
  TEXT_SCALE_LABELS,
  TEXT_SCALE_OPTIONS,
  TEXT_SCALE_VALUES,
  type TextScale,
} from '@/lib/accessibility/text-scale';
import { cn } from '@/lib/utils';

/** Preview glyph size per option, so the control previews itself. */
const PREVIEW_CLASS: Record<TextScale, string> = {
  small: 'text-xs',
  medium: 'text-sm',
  large: 'text-lg',
  xlarge: 'text-2xl',
};

/**
 * The "make the words bigger" control.
 *
 * A popover of four radio buttons rather than an icon that cycles: for someone
 * who has never used a computer, a hidden toggle is unfindable, while four
 * visibly different sizes with names ("Small", "Medium", "Large", "Extra large")
 * is self-describing and needs no instructions.
 */
export function TextSizeControl(): React.ReactElement {
  const { scale, setScale } = useTextScale();
  const [open, setOpen] = React.useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Text size. Now ${TEXT_SCALE_LABELS[scale]}. Choose a different size.`}
        >
          <Type className="h-5 w-5" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-4">
        <div className="space-y-3">
          <div>
            <p className="text-sm font-semibold">How big should the words be?</p>
            <p className="text-sm text-muted-foreground">
              Pick a size. It stays this way on this device.
            </p>
          </div>
          <RadioGroup
            value={scale}
            onValueChange={(value: string) => setScale(value as TextScale)}
            aria-label="Text size"
          >
            {TEXT_SCALE_OPTIONS.map((option) => (
              <div key={option} className="flex items-center gap-3 py-1">
                <RadioGroupItem value={option} id={`text-scale-${option}`} />
                <Label
                  htmlFor={`text-scale-${option}`}
                  className="flex cursor-pointer items-baseline gap-2 font-normal"
                >
                  <span>{TEXT_SCALE_LABELS[option]}</span>
                  <span
                    aria-hidden="true"
                    className={cn('leading-none text-muted-foreground', PREVIEW_CLASS[option])}
                  >
                    Aa
                  </span>
                  <span className="sr-only">
                    {Math.round(TEXT_SCALE_VALUES[option] * 100)} percent of normal size
                  </span>
                </Label>
              </div>
            ))}
          </RadioGroup>
        </div>
      </PopoverContent>
    </Popover>
  );
}