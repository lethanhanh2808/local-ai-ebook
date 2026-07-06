// src/components/ui/textarea.tsx
// Textarea primitive (UI Polish 2026-07-06).
//
// Multi-line input with the same focus / disabled / aria-invalid
// styling as Input. Adds optional `autoResize` (rows grow to fit
// content up to a maxRows ceiling) — opt-in because not every
// multi-line field should grow (e.g. fixed-height book descriptions).

import { cn } from '@/lib/utils';
import { TextareaHTMLAttributes, forwardRef, useEffect, useRef } from 'react';

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** Grow to fit content. Pass `maxRows` to cap the height. */
  autoResize?: boolean;
  /** Maximum rows when autoResize is enabled. */
  maxRows?: number;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, autoResize, maxRows = 10, onInput, ...props }, ref) => {
    const innerRef = useRef<HTMLTextAreaElement | null>(null);

    // Bridge outer ref to inner so callers still get the DOM node.
    const setRefs = (node: HTMLTextAreaElement | null) => {
      innerRef.current = node;
      if (typeof ref === 'function') ref(node);
      else if (ref) (ref as React.MutableRefObject<HTMLTextAreaElement | null>).current = node;
    };

    useEffect(() => {
      if (!autoResize) return;
      const el = innerRef.current;
      if (!el) return;
      const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 20;
      const maxHeight = lineHeight * maxRows;
      const resize = () => {
        el.style.height = 'auto';
        el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
      };
      resize();
      el.addEventListener('input', resize);
      return () => el.removeEventListener('input', resize);
    }, [autoResize, maxRows]);

    return (
      <textarea
        ref={setRefs}
        className={cn(
          'flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm',
          'transition-colors',
          'placeholder:text-muted-foreground',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
          'disabled:cursor-not-allowed disabled:opacity-50',
          'aria-[invalid=true]:border-destructive aria-[invalid=true]:ring-1 aria-[invalid=true]:ring-destructive',
          autoResize && 'resize-none overflow-hidden',
          className,
        )}
        onInput={(e) => {
          onInput?.(e);
        }}
        {...props}
      />
    );
  },
);
Textarea.displayName = 'Textarea';