// src/components/ui/badge.tsx
// Badge primitive for the East-Asian paper visual world (DESIGN.md).
//
// Square 2-px corners, hairline border, uppercase tracking. Reads like a
// chapter tag or a manuscript label rather than a SaaS pill. The default
// variant is vermilion — the one accent in the world.
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
  // East-Asian paper: square 2-px corners, hairline border, uppercase
  // tracking. The default = vermilion seal tab — the structural accent.
  const base =
    'inline-flex items-center px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] border';
  // When callers pass semantic variants we apply utility classes; for free-form
  // tokens (e.g. "status-queued") we expect the caller to have added the
  // matching utility classes via className. We still emit the base classes so
  // shape (rounding, padding) is always consistent.
  const variantClass = (() => {
    switch (variant) {
      case 'secondary':
        return 'bg-secondary text-secondary-foreground border-border';
      case 'destructive':
        return 'bg-destructive/10 text-destructive border-destructive/40';
      case 'outline':
        return 'bg-transparent text-foreground border-border';
      case 'success':
        return 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30';
      case 'warning':
        return 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30';
      case 'info':
        return 'bg-sky-500/10 text-sky-700 dark:text-sky-300 border-sky-500/30';
      case 'muted':
        return 'bg-muted text-muted-foreground border-border';
      default:
        // default = the vermilion seal tab — the structural accent.
        return 'bg-primary text-primary-foreground border-primary';
    }
  })();
  return <span className={cn(base, variantClass, className)}>{children}</span>;
}
