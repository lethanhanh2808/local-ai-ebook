// src/components/ui/tooltip.tsx
// Tooltip primitive (UI Polish 2026-07-06).
//
// Hover/focus tooltip. Wraps a child and shows a small bubble on
// hover or focus-within. The bubble is rendered through a React portal at
// document.body with `position: fixed`, so it escapes `overflow-hidden`
// ancestors (e.g. the Card wrappers in UploadZone) and always paints on
// top of sibling sections.
//
// No new deps. Uses tailwindcss-animate for fade-in.

'use client';

import { cn } from '@/lib/utils';
import {
  cloneElement,
  isValidElement,
  ReactElement,
  ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

export interface TooltipProps {
  /** Tooltip body. */
  content: ReactNode;
  /** Side of the trigger. Default `top`. */
  side?: 'top' | 'bottom' | 'left' | 'right';
  /** Wrapped trigger element. Must accept ref + onFocus/onBlur. */
  children: ReactElement;
  className?: string;
}

type Coords = { top: number; left: number };

export function Tooltip({ content, side = 'top', children, className }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [coords, setCoords] = useState<Coords>({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLElement | null>(null);
  const bubbleRef = useRef<HTMLElement | null>(null);
  const id = useId();

  useEffect(() => setMounted(true), []);

  // Recompute position whenever the tooltip opens or the viewport resizes /
  // scrolls, so the fixed-position bubble stays glued to its trigger. The
  // bubble is measured (not assumed a fixed width) so short tooltips stay
  // compact and long ones are clamped to the viewport.
  const reposition = useCallback(() => {
    const el = triggerRef.current;
    const bubble = bubbleRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const gap = 8;
    const bw = bubble?.offsetWidth ?? 0;
    const bh = bubble?.offsetHeight ?? 0;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let top = r.top;
    let left = r.left;
    switch (side) {
      case 'top':
        top = r.top - gap - bh;
        left = r.left + r.width / 2 - bw / 2;
        break;
      case 'bottom':
        top = r.bottom + gap;
        left = r.left + r.width / 2 - bw / 2;
        break;
      case 'left':
        top = r.top + r.height / 2 - bh / 2;
        left = r.left - gap - bw;
        break;
      case 'right':
        top = r.top + r.height / 2 - bh / 2;
        left = r.right + gap;
        break;
    }
    // Clamp inside the viewport so the bubble never spills off-screen.
    left = Math.max(8, Math.min(left, vw - bw - 8));
    top = Math.max(8, Math.min(top, vh - bh - 8));
    setCoords({ top, left });
  }, [side]);

  useLayoutEffect(() => {
    if (!open) return;
    reposition();
    const onScroll = () => reposition();
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open, reposition]);

  if (!isValidElement(children)) {
    throw new Error('<Tooltip> expects a single React element as its child.');
  }

  // Inject aria-describedby + event handlers onto the child. We also capture
  // the DOM node via ref so we can position the portal bubble against it.
  const enhanced = cloneElement(children as ReactElement<Record<string, unknown>>, {
    ref: (node: HTMLElement | null) => { triggerRef.current = node; },
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

  // Position is computed in `reposition` (centred over the trigger and
  // clamped to the viewport), so no CSS transform is needed.
  return (
    <span className={cn('relative inline-flex', className)}>
      {enhanced}
      {mounted && open && typeof document !== 'undefined' && createPortal(
        <span
          ref={(node: HTMLElement | null) => { bubbleRef.current = node; }}
          role="tooltip"
          id={id}
          style={{ position: 'fixed', top: coords.top, left: coords.left }}
          className={cn(
            'pointer-events-none z-[100] w-fit max-w-[30rem] max-h-[3.75rem] overflow-hidden whitespace-normal break-words rounded-md border border-border bg-popover px-3 py-2 text-xs leading-snug text-popover-foreground shadow-md',
            'animate-in fade-in-0',
          )}
        >
          {content}
        </span>,
        document.body,
      )}
    </span>
  );
}