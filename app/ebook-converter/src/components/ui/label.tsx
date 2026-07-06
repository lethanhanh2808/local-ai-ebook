// src/components/ui/label.tsx
// Label primitive (UI Polish 2026-07-06).
//
// <label htmlFor=…> with peer-disabled styling and a focus-within ring
// to indicate which control it controls. Pairs with Input/Textarea.

import { cn } from '@/lib/utils';
import { LabelHTMLAttributes, forwardRef } from 'react';

export const Label = forwardRef<HTMLLabelElement, LabelHTMLAttributes<HTMLLabelElement>>(
  ({ className, ...props }, ref) => (
    <label
      ref={ref}
      className={cn(
        'text-sm font-medium leading-none',
        'peer-disabled:cursor-not-allowed peer-disabled:opacity-70',
        className,
      )}
      {...props}
    />
  ),
);
Label.displayName = 'Label';