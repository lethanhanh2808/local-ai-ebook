// src/components/layout/EmptyState.tsx
//
// Empty-state and loading-skeleton primitives. Re-skinned for the
// East-Asian paper visual world (DESIGN.md):
//
//   - The empty surface sits on aged-paper-card ground with the kozo
//     fibre grain visible. Hairline rule on every edge. Paper-leaf shadow.
//   - Icon is stamped on a vermilion seal tab (40 px square), not a
//     tinted circle. The seal is the only saturated colour on the page in
//     an empty state — it is what the reader sees first.
//   - Skeleton rows are paper-coloured (slightly darker than the card
//     ground). They do NOT shimmer; the leaf simply is not there yet.
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
      'flex flex-col items-center justify-center gap-4 bg-card px-6 py-20 text-center border border-border shadow-acetate',
      className,
    )}>
      <div className="flex h-10 w-10 items-center justify-center bg-primary text-primary-foreground seal-press">
        {icon}
      </div>
      <div>
        <p className="text-base font-semibold tracking-[-0.01em]">{title}</p>
        {hint && <p className="text-xs text-muted-foreground mt-2 max-w-sm mx-auto leading-relaxed">{hint}</p>}
      </div>
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

// Loading skeleton — paper-coloured rows, no shimmer. The absence of motion
// is intentional: a manuscript does not shimmer while pages load; the row
// simply isn't there yet.
export function LoadingSkeleton({ rows = 6, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('space-y-2 border border-border bg-card px-5 py-4 shadow-acetate', className)}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-4 bg-secondary/60" />
      ))}
    </div>
  );
}
