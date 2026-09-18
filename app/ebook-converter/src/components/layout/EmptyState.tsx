// src/components/layout/EmptyState.tsx
//
// Empty-state and loading-skeleton primitives. Re-skinned for the
// reference-manual visual world (DESIGN.md):
//   - Paper ground, hairline border, acetate shadow — no dashed SaaS look.
//   - Icon sits on a small chrome-yellow tab marker rather than a tinted
//     circle, so the accent reads structural instead of decorative.
//   - Skeleton rows are paper-coloured, no animation (the manual does not
//     shimmer; rows just aren't there yet).
'use client';

import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

interface EmptyStateProps {
  icon: ReactNode;
  title: string;
  hint?: string;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ icon, title, hint, action, className }: EmptyStateProps) {
  return (
    <div className={cn(
      'flex flex-col items-center justify-center gap-3 border border-border bg-card px-6 py-16 text-center shadow-acetate',
      className,
    )}>
      <div className="flex h-10 w-10 items-center justify-center border-l-[3px] border-l-primary pl-2 text-foreground">
        {icon}
      </div>
      <div>
        <p className="text-sm font-semibold">{title}</p>
        {hint && <p className="text-xs text-muted-foreground mt-1 max-w-xs mx-auto leading-snug">{hint}</p>}
      </div>
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

// Loading skeleton — paper-coloured rows, no shimmer. The absence of motion
// is intentional: a reference manual doesn't shimmer while pages load; the
// row simply isn't there yet.
export function LoadingSkeleton({ rows = 6, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('space-y-1.5', className)}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-5 bg-muted" />
      ))}
    </div>
  );
}
