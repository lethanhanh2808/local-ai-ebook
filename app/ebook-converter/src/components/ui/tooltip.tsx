// src/components/ui/tooltip.tsx
// Tooltip primitive (UI Polish 2026-07-06).
//
// Hover/focus tooltip. Wraps a child and shows a small bubble on
// hover or focus-within. No portal — keeps the bubble within the
// parent's stacking context, which is fine for these short labels.
//
// No new deps. Uses tailwindcss-animate for fade-in.

'use client';

import { cn } from '@/lib/utils';
import {
  cloneElement,
  isValidElement,
  ReactElement,
  ReactNode,
  useId,
  useState,
} from 'react';

export interface TooltipProps {
  /** Tooltip body. */
  content: ReactNode;
  /** Side of the trigger. Default `top`. */
  side?: 'top' | 'bottom' | 'left' | 'right';
  /** Wrapped trigger element. Must accept ref + onFocus/onBlur. */
  children: ReactElement;
  className?: string;
}

const sideClasses: Record<NonNullable<TooltipProps['side']>, string> = {
  top: 'bottom-full left-1/2 -translate-x-1/2 mb-2',
  bottom: 'top-full left-1/2 -translate-x-1/2 mt-2',
  left: 'right-full top-1/2 -translate-y-1/2 mr-2',
  right: 'left-full top-1/2 -translate-y-1/2 ml-2',
};

export function Tooltip({ content, side = 'top', children, className }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const id = useId();

  if (!isValidElement(children)) {
    throw new Error('<Tooltip> expects a single React element as its child.');
  }

  // Inject aria-describedby + event handlers onto the child. We
  // intentionally don't replace the child's ref — focus handling is
  // delegated to native onFocus/onBlur which React merges.
  const enhanced = cloneElement(children as ReactElement<Record<string, unknown>>, {
    'aria-describedby': open ? id : undefined,
    onMouseEnter: ((prev: ((e: React.MouseEvent) => void) | undefined) => (e: React.MouseEvent) => {
      prev?.(e);
      setOpen(true);
    })((children.props as { onMouseEnter?: (e: React.MouseEvent) => void }).onMouseEnter),
    onMouseLeave: ((prev: ((e: React.MouseEvent) => void) | undefined) => (e: React.MouseEvent) => {
      prev?.(e);
      setOpen(false);
    })((children.props as { onMouseLeave?: (e: React.MouseEvent) => void }).onMouseLeave),
    onFocus: ((prev: ((e: React.FocusEvent) => void) | undefined) => (e: React.FocusEvent) => {
      prev?.(e);
      setOpen(true);
    })((children.props as { onFocus?: (e: React.FocusEvent) => void }).onFocus),
    onBlur: ((prev: ((e: React.FocusEvent) => void) | undefined) => (e: React.FocusEvent) => {
      prev?.(e);
      setOpen(false);
    })((children.props as { onBlur?: (e: React.FocusEvent) => void }).onBlur),
  } as Record<string, unknown>);

  return (
    <span className={cn('relative inline-flex', className)}>
      {enhanced}
      <span
        role="tooltip"
        id={id}
        hidden={!open}
        className={cn(
          'pointer-events-none absolute z-30 max-w-xs whitespace-nowrap rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md',
          'animate-in fade-in-0',
          sideClasses[side],
        )}
      >
        {content}
      </span>
    </span>
  );
}