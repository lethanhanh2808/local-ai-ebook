// src/components/ui/sheet.tsx
//
// Sheet primitive (UI Polish 2026-07-06) — a side panel built on the
// hand-rolled <Dialog> substrate. Used for the Audio drawer, analyzer
// panel, voice debug overlay, and full-screen AudiobookPlayer mount.
//
// Same focus-trap / ESC / scroll-lock / focus-restore semantics as
// <Dialog>. Difference: panel slides in from a side instead of fading
// in from the centre, with a width prop.
//
// Usage:
//   <Sheet open={open} onOpenChange={setOpen} side="right" width={480}
//          title="Audio" closeOnBackdrop={false}>
//     <SheetBody>...</SheetBody>
//   </Sheet>

'use client';

import { cn } from '@/lib/utils';
import { X } from 'lucide-react';
import {
  HTMLAttributes,
  ReactNode,
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useRef,
} from 'react';
import { createPortal } from 'react-dom';

export type SheetSide = 'left' | 'right' | 'top' | 'bottom';

interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: ReactNode;
  description?: ReactNode;
  /** Side the sheet slides in from. Default `right`. */
  side?: SheetSide;
  /** Width (px, rem, or any CSS length) for left/right sheets. Default 28rem. */
  width?: string;
  /** Height (px, rem, or any CSS length) for top/bottom sheets. Default 28rem. */
  height?: string;
  /** Render at full viewport size on the chosen axis. Default false. */
  fullScreen?: boolean;
  /** Close when backdrop is clicked. Default true. */
  closeOnBackdrop?: boolean;
  className?: string;
  children?: ReactNode;
}

const sideClasses: Record<SheetSide, string> = {
  right: 'inset-y-0 right-0',
  left: 'inset-y-0 left-0',
  top: 'inset-x-0 top-0',
  bottom: 'inset-x-0 bottom-0',
};

const slideInClasses: Record<SheetSide, string> = {
  right: 'slide-in-from-right',
  left: 'slide-in-from-left',
  top: 'slide-in-from-top',
  bottom: 'slide-in-from-bottom',
};

export function Sheet({
  open,
  onOpenChange,
  title,
  description,
  side = 'right',
  width = '28rem',
  height = '28rem',
  fullScreen = false,
  closeOnBackdrop = true,
  className,
  children,
}: SheetProps) {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    queueMicrotask(() => panelRef.current?.focus());

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return;
      }
      if (e.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusables = panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
      const prev = previousFocusRef.current;
      if (prev && typeof prev.focus === 'function') {
        queueMicrotask(() => prev.focus());
      }
    };
  }, [open, close]);

  if (!open) return null;
  if (typeof document === 'undefined') return null;

  const dimensionStyle =
    side === 'left' || side === 'right'
      ? { width: fullScreen ? '100vw' : width, maxWidth: '100vw' }
      : { height: fullScreen ? '100vh' : height, maxHeight: '100vh' };

  return createPortal(
    <div
      role="presentation"
      className="fixed inset-0 z-[60] flex"
    >
      <div
        aria-hidden
        onClick={() => closeOnBackdrop && close()}
        className="absolute inset-0 bg-background/80 backdrop-blur-sm animate-in fade-in-0"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        style={dimensionStyle}
        className={cn(
          'relative z-10 flex flex-col border border-border bg-card text-card-foreground shadow-2xl outline-none',
          sideClasses[side],
          'animate-in duration-200',
          slideInClasses[side],
          side === 'left' || side === 'right' ? 'h-full' : 'w-full',
          className,
        )}
      >
        {(title || closeOnBackdrop !== false) && (
          <div className="flex items-start justify-between gap-4 border-b border-border p-4">
            <div className="flex flex-col gap-1">
              {title && (
                <h2
                  id={titleId}
                  className="text-base font-semibold leading-none tracking-tight"
                >
                  {title}
                </h2>
              )}
              {description && (
                <p id={descriptionId} className="text-sm text-muted-foreground">
                  {description}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={close}
              aria-label="Close"
              className={cn(
                'rounded-md p-1 text-muted-foreground transition-colors',
                'hover:bg-muted hover:text-foreground',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              )}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}
        {children}
      </div>
    </div>,
    document.body,
  );
}

export const SheetBody = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn('flex-1 overflow-y-auto p-4', className)}
      {...props}
    />
  ),
);
SheetBody.displayName = 'SheetBody';

export const SheetFooter = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        'flex items-center justify-end gap-2 border-t border-border bg-muted/30 p-4',
        className,
      )}
      {...props}
    />
  ),
);
SheetFooter.displayName = 'SheetFooter';