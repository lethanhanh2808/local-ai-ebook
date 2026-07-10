// src/components/ui/toast.tsx
// Toaster + useToast (UI Polish 2026-07-06).
//
// Renders the active toast queue in a fixed bottom-right stack and
// exposes a `useToast()` hook for ergonomic pushToast calls.
//
// Variants: default | success | error | info | warning
//
// Replaces:
//   - window.alert(...)   → toast.error(...) / toast.success(...)
//   - window.confirm(...) → two-step toast with [Cancel] [Confirm]
//     action buttons; confirm fires the destructive action explicitly,
//     it never auto-executes.
//
// No new deps. Mount <Toaster /> once in src/app/layout.tsx.

'use client';

import { cn } from '@/lib/utils';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import {
  ReactNode,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import {
  ToastVariant,
  Toast as ToastModel,
  clearToasts,
  dismissToast,
  pushToast,
  useToasts,
} from '@/lib/toast-store';

interface ToastApi {
  (variant: ToastVariant, title: string, opts?: ToastOpts): string;
  success: (title: string, opts?: ToastOpts) => string;
  error: (title: string, opts?: ToastOpts) => string;
  info: (title: string, opts?: ToastOpts) => string;
  warning: (title: string, opts?: ToastOpts) => string;
  dismiss: (id: string) => void;
  clear: () => void;
  /** Two-step confirm. Renders a sticky toast with Cancel + Confirm
   *  buttons; onConfirm is invoked when the user clicks Confirm.
   *  Never auto-executes — the user must explicitly confirm. */
  confirm: (params: {
    title: string;
    description?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    destructive?: boolean;
    onConfirm: () => void;
  }) => string;
}

export interface ToastOpts {
  description?: string;
  duration?: number | null;
  action?: { label: string; onClick: () => void };
}

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const full = useMemo<ToastApi>(() => {
    const api = ((variant: ToastVariant, title: string, opts: ToastOpts = {}) => pushToast({
      variant,
      title,
      description: opts.description,
      duration: opts.duration,
      action: opts.action,
    })) as ToastApi;

    const notify = (variant: ToastVariant) => (title: string, opts: ToastOpts = {}) => pushToast({
      variant,
      title,
      description: opts.description,
      duration: opts.duration,
      action: opts.action,
    });

    api.success = notify('success');
    api.error = notify('error');
    api.info = notify('info');
    api.warning = notify('warning');
    api.dismiss = dismissToast;
    api.clear = clearToasts;
    api.confirm = ({ title, description, confirmLabel = 'Confirm', destructive = false, onConfirm }) => pushToast({
      variant: destructive ? 'error' : 'info',
      title,
      description,
      duration: null,
      action: { label: confirmLabel, onClick: onConfirm },
    });
    return api;
  }, []);

  return <ToastContext.Provider value={full}>{children}</ToastContext.Provider>;
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast() must be used inside <ToastProvider>.');
  }
  return ctx;
}

// ─── Toaster (UI) ───────────────────────────────────────────────────

const ICONS: Record<ToastVariant, ReactNode> = {
  default: null,
  success: <CheckCircle2 className="h-5 w-5 text-emerald-500" aria-hidden />,
  error: <XCircle className="h-5 w-5 text-destructive" aria-hidden />,
  info: <Info className="h-5 w-5 text-sky-500" aria-hidden />,
  warning: <AlertTriangle className="h-5 w-5 text-amber-500" aria-hidden />,
};

const BORDER: Record<ToastVariant, string> = {
  default: 'border-border',
  success: 'border-emerald-500/40',
  error: 'border-destructive/40',
  info: 'border-sky-500/40',
  warning: 'border-amber-500/40',
};

function ToastItem({ toast }: { toast: ToastModel }) {
  const [exiting, setExiting] = useState(false);

  const handleDismiss = () => {
    setExiting(true);
    // Match fade-out animation length before unmount.
    setTimeout(() => dismissToast(toast.id), 150);
  };

  return (
    <div
      role={toast.variant === 'error' ? 'alert' : 'status'}
      aria-live={toast.variant === 'error' ? 'assertive' : 'polite'}
      className={cn(
        'pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-lg border border-border bg-card p-4 shadow-lg',
        BORDER[toast.variant],
        exiting ? 'animate-out fade-out-0 slide-out-to-right-full' : 'animate-in slide-in-from-right-full fade-in-0',
      )}
    >
      <span className="mt-0.5 shrink-0">{ICONS[toast.variant]}</span>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium leading-tight">{toast.title}</p>
        {toast.description && (
          <p className="mt-1 text-xs text-muted-foreground">{toast.description}</p>
        )}
        {toast.action && (
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => {
                toast.action?.onClick();
                handleDismiss();
              }}
              className={cn(
                'inline-flex items-center rounded-md px-2.5 py-1 text-xs font-medium',
                'bg-primary text-primary-foreground hover:bg-primary/90',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              )}
            >
              {toast.action.label}
            </button>
            <button
              type="button"
              onClick={handleDismiss}
              className={cn(
                'inline-flex items-center rounded-md px-2.5 py-1 text-xs font-medium',
                'border border-input bg-background hover:bg-accent',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              )}
            >
              Dismiss
            </button>
          </div>
        )}
      </div>
      <button
        type="button"
        aria-label="Dismiss notification"
        onClick={handleDismiss}
        className={cn(
          'shrink-0 rounded-md p-1 text-muted-foreground',
          'hover:bg-muted hover:text-foreground',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        )}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

export function Toaster() {
  const toasts = useToasts();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  if (!mounted || typeof document === 'undefined') return null;

  return createPortal(
    <div
      aria-label="Notifications"
      className="pointer-events-none fixed bottom-4 left-4 right-4 z-50 flex max-h-screen flex-col-reverse gap-2 sm:bottom-6 sm:left-auto sm:right-6 sm:w-full sm:max-w-sm"
    >
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </div>,
    document.body,
  );
}
