// src/components/ui/separator.tsx
//
// Separator primitive (UI Polish 2026-07-06) — wraps
// @radix-ui/react-separator. Use horizontally between rows in menus,
// or vertically between columns.

'use client';

import * as SeparatorPrimitive from '@radix-ui/react-separator';
import { cn } from '@/lib/utils';
import { forwardRef, ComponentPropsWithoutRef, ElementRef } from 'react';

export const Separator = forwardRef<
  ElementRef<typeof SeparatorPrimitive.Root>,
  ComponentPropsWithoutRef<typeof SeparatorPrimitive.Root>
>(
  (
    { className, orientation = 'horizontal', decorative = true, ...props },
    ref,
  ) => (
    <SeparatorPrimitive.Root
      ref={ref}
      decorative={decorative}
      orientation={orientation}
      className={cn(
        'shrink-0 bg-border',
        orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px',
        className,
      )}
      {...props}
    />
  ),
);
Separator.displayName = SeparatorPrimitive.Root.displayName;