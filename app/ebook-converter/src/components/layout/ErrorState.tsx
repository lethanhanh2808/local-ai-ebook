// src/components/layout/ErrorState.tsx
//
// Error display companion to <EmptyState>. Re-skinned for the
// reference-manual visual world (DESIGN.md) — the "honest stops" raise
// from the depot-blind world:
//
//   When something is wrong, the row halts mid-step. The label is split
//   across a 1-px vertical seam; the upper half stays ink, the lower half
//   stays ink, but the seam itself is destructive colour. There is no
//   apologetic pill icon, no blush background. The row just stopped, and
//   you can see why.
//
//   Retrying is a button (the user must act), not an automatic retry. The
//   "DETAILS" disclosure is a chrome-yellow tab you press to lift the
//   acetate leaf and see the raw error — the only chrome-yellow surface
//   in an error state, which makes the diagnostic action discoverable.
import { useState } from 'react';
import { RefreshCw, ChevronDown, ChevronUp } from 'lucide-react';
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
        // Paper ground + hairline + the seam at the top edge. No tint.
        'flex flex-col gap-3 border border-border bg-card px-6 py-8 shadow-acetate',
        // A 3-px destructive "STOP" bar at the top — a single structural
        // colour, no icon backdrop.
        'border-t-[3px] border-t-destructive',
        className,
      )}
    >
      {/* Title row, clipped across a seam — depot-blind discipline. */}
      <div className="flex items-baseline gap-2">
        <span
          aria-hidden="true"
          className="inline-block h-4 w-[2px] bg-destructive"
        />
        <p className="text-sm font-semibold tracking-tight">{title}</p>
      </div>

      {message && (
        <p className="text-xs text-muted-foreground leading-snug max-w-prose pl-4">
          {message}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2 pl-4">
        {onRetry && (
          <Button size="sm" variant="outline" onClick={onRetry} disabled={retrying}>
            <RefreshCw className={cn('h-3.5 w-3.5', retrying && 'animate-spin')} />
            {retrying ? 'Đang thử lại…' : 'Thử lại'}
          </Button>
        )}
        {hasDetails && (
          <button
            type="button"
            onClick={() => setShowDetails((v) => !v)}
            className={cn(
              'inline-flex items-center gap-1 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.08em]',
              'bg-primary text-primary-foreground border border-primary hover:bg-accent hover:text-accent-foreground transition-colors',
            )}
          >
            {showDetails ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            {showDetails ? 'Ẩn chi tiết' : 'Chi tiết'}
          </button>
        )}
      </div>

      {hasDetails && showDetails && (
        <pre className="max-h-32 overflow-auto border border-border bg-muted px-3 py-2 text-[10px] font-mono text-muted-foreground whitespace-pre-wrap break-words">
          {details}
        </pre>
      )}
    </div>
  );
}
