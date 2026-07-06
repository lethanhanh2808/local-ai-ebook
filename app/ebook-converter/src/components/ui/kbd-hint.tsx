// src/components/ui/kbd-hint.tsx
//
// KbdHint primitive (UI Polish 2026-07-06).
//
// Renders one or more keys as compact key-cap pills. Used in the
// reader toolbar tooltips and the keyboard-shortcuts overlay so the
// visual language for shortcuts stays consistent.
//
//   <KbdHint keys={['Ctrl', 'K']} />        →  Ctrl + K
//   <KbdHint>Esc</KbdHint>                  →  Esc   (single key, no +)
//
// Pairs naturally with <Tooltip> — wrap a toolbar icon button's title
// in <Tooltip content={<>Open <KbdHint>T</KbdHint></>}> to surface
// the shortcut inline.
//
// Honours prefers-reduced-motion + forced-colors via data-* attrs
// (inherits from root <html>).

import { cn } from '@/lib/utils';
import { Fragment, HTMLAttributes } from 'react';

interface KbdHintProps extends HTMLAttributes<HTMLSpanElement> {
  /** Array of keys joined by " + ". Omit to use children as a single key. */
  keys?: string[];
}

export function KbdHint({ keys, children, className, ...props }: KbdHintProps) {
  const items = keys ?? (typeof children === 'string' ? [children] : []);

  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 align-baseline',
        className,
      )}
      {...props}
    >
      {items.map((k, i) => (
        <Fragment key={`${k}-${i}`}>
          {i > 0 && <span className="text-[10px] text-muted-foreground mx-0.5">+</span>}
          <kbd
            className={cn(
              'inline-flex items-center justify-center min-w-[1.4em] px-1.5 h-5',
              'rounded border border-border bg-muted text-foreground/80',
              'font-mono text-[10px] font-medium leading-none',
              'shadow-[inset_0_-1px_0_hsl(var(--border))]',
            )}
            aria-label={`Phím ${k}`}
          >
            {k}
          </kbd>
        </Fragment>
      ))}
    </span>
  );
}