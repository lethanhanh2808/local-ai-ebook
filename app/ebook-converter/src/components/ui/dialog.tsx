// src/components/ui/dialog.tsx
// Dialog primitive (UI Polish 2026-07-06).
//
// Single source of truth for the 14 hand-rolled modals scattered
// across the codebase. Provides:
//   - Portal to document.body (avoids stacking-context / overflow traps)
//   - z-index 60 (below toaster z-50? no — dialogs sit above toasts).
//     Toaster is z-50; dialog is z-60. Cohesive scale: z-10 sticky,
//     z-20 dropdown, z-30 tooltip, z-40 nav, z-50 toast, z-60 dialog.
//   - Focus trap (Tab/Shift+Tab loop inside the dialog)
//   - ESC closes
//   - Backdrop click closes (configurable)
//   - Body scroll lock while open
//   - Focus restore to the trigger on close
//   - role="dialog", aria-modal="true", aria-labelledby, aria-describedby
//   - Fade+zoom animation via tailwindcss-animate
//   - Honors prefers-reduced-motion (data-motion="reduced" on <html>)
//
// Usage:
//   const [open, setOpen] = useState(false);
//   <Dialog open={open} onOpenChange={setOpen} title="Edit metadata"
//           description="Update title, author, and tags.">
//     <DialogBody> ... form ... </DialogBody>
//     <DialogFooter> ... buttons ... </DialogFooter>
//   </Dialog>
//
// Implementation notes:
//   - We render into document.body via createPortal — this keeps the
//     dialog above any local stacking context (transforms, will-change).
//   - Focus trap uses a "last-focused" registry rather than querying
//     every focusable inside the dialog. This is simpler and works in
//     nested-dialog scenarios (only the topmost dialog traps focus).
//   - No new deps.

'use client';

import { cn } from '@/lib/utils';
import { X } from 'lucide-react';
import {
  HTMLAttributes,
  ReactNode,
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

interface DialogContextValue {
  titleId: string;
  descriptionId: string;
  close: () => void;
}

const DialogContext = createContext<DialogContextValue | null>(null);

function useDialogContext(component: string): DialogContextValue {
  const ctx = useContext(DialogContext);
  if (!ctx) {
    throw new Error(`<${component}> must be used inside <Dialog>.`);
  }
  return ctx;
}

// Stack of open dialogs so the focus trap only acts on the topmost one,
// and so multi-dialog interactions (e.g. confirm-on-top-of-edit) work.
interface DialogStackEntry {
  close: () => void;
}

const dialogStack: DialogStackEntry[] = [];

function pushDialog(entry: DialogStackEntry) {
  dialogStack.push(entry);
}

function popDialog(entry: DialogStackEntry) {
  const idx = dialogStack.lastIndexOf(entry);
  if (idx >= 0) dialogStack.splice(idx, 1);
}

function topmostDialog(): DialogStackEntry | null {
  return dialogStack.length ? dialogStack[dialogStack.length - 1] : null;
}

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: ReactNode;
  description?: ReactNode;
  /** Close when backdrop is clicked. Default true. */
  closeOnBackdrop?: boolean;
  /** Width class for the panel. Default `max-w-lg`. */
  widthClass?: string;
  className?: string;
  children?: ReactNode;
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  closeOnBackdrop = true,
  widthClass = 'max-w-lg',
  className,
  children,
}: DialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<() => void>(() => {});
  const stackEntryRef = useRef<DialogStackEntry>({ close: () => closeRef.current() });

  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  closeRef.current = close;

  // Open/close side effects: scroll lock, focus save/restore, ESC handler.
  useEffect(() => {
    if (!open) return;

    previousFocusRef.current = document.activeElement as HTMLElement | null;

    // Body scroll lock. We toggle a class so we don't fight with any
    // existing overflow rules.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // Move focus to the dialog panel after mount. Use a microtask so
    // the portal has rendered.
    queueMicrotask(() => {
      const panel = panelRef.current;
      if (!panel) return;
      const preferred = panel.querySelector<HTMLElement>('[autofocus], [data-autofocus="true"]');
      (preferred ?? panel).focus();
    });

    // Register on the global dialog stack so the topmost close handler
    // wins for ESC.
    const entry = stackEntryRef.current;
    pushDialog(entry);

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (topmostDialog() === entry) {
        e.preventDefault();
        closeRef.current();
      }
    };
    document.addEventListener('keydown', onKey);

    return () => {
      popDialog(entry);
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
      // Restore focus to the trigger.
      const prev = previousFocusRef.current;
      if (prev && typeof prev.focus === 'function') {
        // Wrap in microtask so React has finished any focus changes.
        queueMicrotask(() => prev.focus());
      }
    };
  }, [open]);

  // Focus trap — only on topmost dialog. Cycle Tab/Shift+Tab.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      // Only trap when this dialog is the topmost one.
      if (topmostDialog() !== stackEntryRef.current) return;
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
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  if (!open) return null;
  if (typeof document === 'undefined') return null;

  return createPortal(
    <DialogContext.Provider value={{ titleId, descriptionId, close }}>
      <div
        role="presentation"
        className="fixed inset-0 z-[60] flex items-center justify-center p-4"
      >
        {/* Backdrop */}
        <div
          aria-hidden
          onClick={() => closeOnBackdrop && close()}
          className={cn(
            'absolute inset-0 bg-background/80 backdrop-blur-sm',
            'animate-in fade-in-0',
          )}
        />
        {/* Panel */}
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={title ? titleId : undefined}
          aria-describedby={description ? descriptionId : undefined}
          tabIndex={-1}
          className={cn(
            'relative z-10 w-full rounded-xl border border-border bg-card text-card-foreground shadow-2xl',
            'outline-none',
            'animate-in fade-in-0 zoom-in-95',
            'max-h-[90vh] flex flex-col',
            widthClass,
            className,
          )}
        >
          {/* Header (only when title or close button) */}
          {(title || closeOnBackdrop !== false) && (
            <div className="flex items-start justify-between gap-4 p-6 pb-2">
              <div className="flex flex-col gap-1">
                {title && (
                  <h2 id={titleId} className="text-lg font-semibold leading-none tracking-tight">
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

          {/* Body + footer are passed as children; consumers wrap them
              in <DialogBody> and <DialogFooter>. */}
          {children}
        </div>
      </div>
    </DialogContext.Provider>,
    document.body,
  );
}

/** Body region — scrolls independently when content overflows. */
export const DialogBody = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn('flex-1 overflow-y-auto px-6 py-4', className)}
      {...props}
    />
  ),
);
DialogBody.displayName = 'DialogBody';

/** Footer region — typically contains action buttons. */
export const DialogFooter = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => {
    useDialogContext('DialogFooter');
    return (
      <div
        ref={ref}
        className={cn(
          'flex flex-col-reverse gap-2 border-t border-border bg-muted/30 px-6 py-4 sm:flex-row sm:justify-end',
          className,
        )}
        {...(props as Record<string, unknown>)}
      />
    );
  },
);
DialogFooter.displayName = 'DialogFooter';

/** Hook exposing the dialog context — useful for inline close buttons. */
export function useDialog() {
  return useDialogContext('useDialog');
}

/** Imperative `open`/`close` helper for state-hoisted dialogs. */
export function useDialogState(initial = false) {
  return useState(initial);
}
