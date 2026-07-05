// src/components/ui/progress.tsx
import { cn } from '@/lib/utils';

interface ProgressProps {
  value: number; // 0-100
  className?: string;
  indicatorClassName?: string;
}
export function Progress({ value, className, indicatorClassName }: ProgressProps) {
  return (
    <div
      className={cn('relative h-2 w-full overflow-hidden rounded-full bg-secondary', className)}
    >
      <div
        className={cn('h-full bg-primary transition-all duration-500 ease-out', indicatorClassName)}
        style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
      />
    </div>
  );
}
