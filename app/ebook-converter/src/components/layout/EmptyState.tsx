// src/components/layout/EmptyState.tsx
// Friendly empty-state shown when a list has no items.
//   <EmptyState icon={<BookOpen/>} title="No books yet" hint="Convert one to get started"
//    action={<Button>Upload</Button>} />
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
      'flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed bg-card/50 px-6 py-16 text-center',
      className,
    )}>
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted text-muted-foreground">
        {icon}
      </div>
      <div>
        <p className="text-sm font-semibold">{title}</p>
        {hint && <p className="text-xs text-muted-foreground mt-1 max-w-xs mx-auto">{hint}</p>}
      </div>
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

// Loading skeleton used while data is fetching. Pass a custom shape or use the default.
export function LoadingSkeleton({ rows = 6, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('space-y-2', className)}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-20 animate-pulse rounded-xl bg-muted" />
      ))}
    </div>
  );
}