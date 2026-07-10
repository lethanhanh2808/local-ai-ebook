// src/components/ui/progress.tsx
import { cn } from '@/lib/utils';

interface ProgressProps {
  /** Numeric progress 0-100. Omit for an indeterminate "shimmer" bar. */
  value?: number;
  /** Optional caption rendered next to (or above) the bar. */
  label?: string;
  /** Accessible name when no visible label is rendered. */
  ariaLabel?: string;
  className?: string;
  indicatorClassName?: string;
}
export function Progress({ value, className, indicatorClassName, label, ariaLabel }: ProgressProps) {
  const isIndeterminate = value === undefined;
  const pct = isIndeterminate ? 100 : Math.min(100, Math.max(0, value));
  return (
    <div className={cn('w-full', className)}>
      {label && (
        <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
          <span>{label}</span>
          {!isIndeterminate && <span>{Math.round(pct)}%</span>}
        </div>
      )}
      <div
        role="progressbar"
        aria-label={ariaLabel ?? label ?? 'Tiến độ'}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={isIndeterminate ? undefined : Math.round(pct)}
        aria-valuetext={isIndeterminate ? 'Đang xử lý' : `${Math.round(pct)}%`}
        className={cn(
          'relative h-2 w-full overflow-hidden rounded-full bg-secondary',
          isIndeterminate && 'animate-pulse',
        )}
      >
        <div
          className={cn(
            'h-full bg-primary transition-all duration-500 ease-out',
            isIndeterminate && 'w-1/3 animate-[progress-shimmer_1.2s_ease-in-out_infinite]',
            indicatorClassName,
          )}
          style={isIndeterminate ? undefined : { width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
