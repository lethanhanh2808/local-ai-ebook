// src/components/ui/badge.tsx
import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

/**
 * Semantic badge variants. Free-form strings are also accepted so call sites
 * can use ad-hoc utility class tokens (e.g. "status-queued") without losing
 * the variant prop in the type signature.
 */
export type BadgeVariant =
  | 'default'
  | 'secondary'
  | 'destructive'
  | 'outline'
  | 'success'
  | 'warning'
  | 'info'
  | 'muted'
  // Status / source tokens — kept as plain strings on purpose so feature
  // code can introduce new tokens without re-exporting them here.
  | (string & {});

interface BadgeProps {
  className?: string;
  children: ReactNode;
  variant?: BadgeVariant;
}
export function Badge({ className, children, variant }: BadgeProps) {
  const base =
    'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium';
  // When callers pass semantic variants we apply utility classes; for free-form
  // tokens (e.g. "status-queued") we expect the caller to have added the
  // matching utility classes via className. We still emit the base classes so
  // shape (rounding, padding) is always consistent.
  const variantClass = (() => {
    switch (variant) {
      case 'secondary':
        return 'bg-secondary text-secondary-foreground';
      case 'destructive':
        return 'bg-destructive text-destructive-foreground';
      case 'outline':
        return 'border border-input text-foreground';
      case 'success':
        return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300';
      case 'warning':
        return 'bg-amber-500/15 text-amber-700 dark:text-amber-300';
      case 'info':
        return 'bg-sky-500/15 text-sky-700 dark:text-sky-300';
      case 'muted':
        return 'bg-muted text-muted-foreground';
      default:
        return 'bg-primary text-primary-foreground';
    }
  })();
  return <span className={cn(base, variantClass, className)}>{children}</span>;
}