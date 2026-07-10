// src/components/ui/alert-dialog.tsx
//
// AlertDialog primitive (UI Polish 2026-07-06). Distinct from <Dialog> in
// that backdrop click is NOT a cancel by default and focus is forced
// onto the Cancel button — matches Radix's `AlertDialog` semantics but
// built on top of our existing hand-rolled Dialog primitive so we don't
// pull in `@radix-ui/react-alert-dialog`.
//
// Usage:
//   <ConfirmDialog
//     open={open}
//     onOpenChange={setOpen}
//     title="Stop worker?"
//     description="This will halt the conversion queue."
//     confirmLabel="Stop"
//     variant="danger"
//     onConfirm={stopWorker}
//   />

'use client';

import { cn } from '@/lib/utils';
import { buttonClasses } from './button';
import { Dialog, DialogBody, DialogFooter } from './dialog';
import { ReactNode } from 'react';

// Re-export Dialog parts for consumers that want to hand-roll an alert
// (e.g. custom body content rather than a ConfirmDialog wrapper).
export { Dialog as AlertDialogRoot, DialogBody as AlertDialogBody, DialogFooter as AlertDialogFooter };

/** Convenience wrapper — declarative API for the common "confirm before doing X" pattern. */
export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel?: ReactNode;
  cancelLabel?: ReactNode;
  variant?: 'default' | 'danger';
  onConfirm: () => void;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'default',
  onConfirm,
}: ConfirmDialogProps) {
  // Backdrop click does NOT auto-cancel here — alert dialogs need an
  // explicit choice. closeOnBackdrop=false enforces that.
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      closeOnBackdrop={false}
      widthClass="max-w-md"
    >
      <DialogBody className="space-y-2">
        <h2 className="text-lg font-semibold leading-none tracking-tight">{title}</h2>
        {description && (
          <p className="text-sm text-muted-foreground">{description}</p>
        )}
      </DialogBody>
      <DialogFooter>
        <button
          type="button"
          onClick={() => onOpenChange(false)}
          className={cn(buttonClasses({ variant: 'outline' }), 'mt-2 sm:mt-0')}
        >
          {cancelLabel}
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className={cn(
            buttonClasses({ variant: variant === 'danger' ? 'destructive' : 'default' }),
          )}
        >
          {confirmLabel}
        </button>
      </DialogFooter>
    </Dialog>
  );
}