// src/components/ui/error-state.tsx
//
// ErrorState primitive (UI Polish 2026-07-06) — error analog of
// <EmptyState>. Used wherever a list/grid surface catches fetch
// errors and would otherwise render as silently empty.
//
// Usage:
//   <ErrorState
//     title="Couldn't load books"
//     message={err.message}
//     onRetry={refetch}
//   />

'use client';

import { cn } from '@/lib/utils';
import { AlertCircle, RefreshCw } from 'lucide-react';
import { Button } from './button';

export interface ErrorStateProps {
  title?: string;
  message?: string;
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
}

export function ErrorState({
  title = 'Something went wrong',
  message,
  onRetry,
  retryLabel = 'Try again',
  className,
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-destructive/40 bg-destructive/5 p-8 text-center',
        className,
      )}
    >
      <AlertCircle className="h-8 w-8 text-destructive" aria-hidden />
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        {message && (
          <p className="text-xs text-muted-foreground">{message}</p>
        )}
      </div>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw className="mr-2 h-3.5 w-3.5" />
          {retryLabel}
        </Button>
      )}
    </div>
  );
}