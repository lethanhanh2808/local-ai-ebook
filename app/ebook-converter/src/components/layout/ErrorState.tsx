// src/components/layout/ErrorState.tsx
//
// Error display companion to <EmptyState>. Renders when a list-fetch
// failed. Surfaces the message, a retry button, and a details toggle
// for the raw error (useful in dev; hidden in prod).
//
// Usage:
//   const { data, error, refetch } = useXxx();
//   if (error) return <ErrorState onRetry={refetch} message={error} />;

import { useState } from 'react';
import { AlertCircle, RefreshCw, ChevronDown, ChevronUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface ErrorStateProps {
  /** Short human-readable summary. */
  title?: string;
  /** Longer description shown under the title. */
  message?: string;
  /** Raw error (typically Error.message) revealed in the details toggle. */
  details?: string;
  /** Click handler for the retry button. If omitted, retry is hidden. */
  onRetry?: () => void;
  /** When true, retry button shows a spinner and is disabled. */
  retrying?: boolean;
  className?: string;
}

export function ErrorState({
  title = 'Có lỗi xảy ra',
  message,
  details,
  onRetry,
  retrying = false,
  className,
}: ErrorStateProps) {
  const [showDetails, setShowDetails] = useState(false);
  const hasDetails = Boolean(details && details !== message);

  return (
    <div
      role="alert"
      aria-live="polite"
      className={cn(
        'flex flex-col items-center justify-center gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-8 text-center',
        className,
      )}
    >
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
        <AlertCircle className="h-6 w-6" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-semibold">{title}</p>
        {message && <p className="text-xs text-muted-foreground max-w-sm">{message}</p>}
      </div>
      {onRetry && (
        <Button size="sm" variant="outline" onClick={onRetry} disabled={retrying}>
          <RefreshCw className={cn('h-3.5 w-3.5', retrying && 'animate-spin')} />
          {retrying ? 'Đang thử lại…' : 'Thử lại'}
        </Button>
      )}
      {hasDetails && (
        <div className="w-full max-w-md text-left">
          <button
            type="button"
            onClick={() => setShowDetails((v) => !v)}
            className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
          >
            {showDetails ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            {showDetails ? 'Ẩn chi tiết' : 'Xem chi tiết'}
          </button>
          {showDetails && (
            <pre className="mt-2 max-h-32 overflow-auto rounded-md border bg-muted/50 p-2 text-[10px] font-mono text-muted-foreground whitespace-pre-wrap break-words">
              {details}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}