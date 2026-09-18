// src/components/layout/ErrorState.tsx
//
// Error display companion to <EmptyState>. Re-skinned for the East-Asian
// paper visual world (DESIGN.md):
//
//   When something is wrong, the leaf halts mid-step. A 2-px vermilion
//   rule cuts the top edge — the only saturated colour on the surface —
//   and the label sits beneath a small inked seam (the "stop" glyph in
//   the manuscript margin). No apologetic pill icon, no blush background.
//
//   Retrying is an outline button (the user must act), not an automatic
//   retry. The "Chi tiết" disclosure is the same vermilion tab used
//   elsewhere for the diagnostic action — discoverable without being
//   loud.
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
        // Aged-paper ground + hairline + the seam at the top edge. No tint.
        'flex flex-col gap-3 bg-card border border-border px-6 py-7 shadow-acetate',
        // A 2-px vermilion "stop" rule at the top — the only structural
        // colour on an error surface.
        'border-t-[2px] border-t-destructive',
        className,
      )}
    >
      <div className="flex items-baseline gap-2">
        <span
          aria-hidden="true"
          className="inline-block h-4 w-[2px] bg-destructive"
        />
        <p className="text-[14px] font-semibold tracking-tight">{title}</p>
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
              'inline-flex items-center gap-1 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em]',
              'bg-primary text-primary-foreground border border-primary hover:bg-primary/90 transition-colors',
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
