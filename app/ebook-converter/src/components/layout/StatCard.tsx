// src/components/layout/StatCard.tsx
//
// Compact stat cell used in dashboards. Re-skinned for the reference-manual
// visual world (DESIGN.md):
//
//   - No rounded-xl SaaS card. A stat cell is a paper rectangle with a
//     single 3-px top bar whose colour conveys tone (chrome-yellow = the
//     primary manual accent; destructive = the seam colour; muted = a
//     hairline).
//   - Icon sits beside the label, not in a tinted pill.
//   - Numerals are tabular so columns align in a row of stats.
'use client';

import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

export type StatTone = 'primary' | 'success' | 'warning' | 'danger' | 'muted';

interface StatCardProps {
  icon: ReactNode;
  label: string;
  value: string | number;
  sub?: string;
  tone?: StatTone;
  /** Render as a link to this href. */
  href?: string;
  className?: string;
}

// Top-bar colour per tone. Hairline tone has no bar at all.
const TONE_BAR: Record<StatTone, string> = {
  primary: 'border-t-primary',
  success: 'border-t-emerald-500',
  warning: 'border-t-amber-500',
  danger:  'border-t-destructive',
  muted:   'border-t-transparent',
};

export function StatCard({ icon, label, value, sub, tone = 'primary', href, className }: StatCardProps) {
  const body = (
    <div className={cn(
      'flex items-center gap-3 border border-border border-t-[3px] bg-card px-4 py-3 shadow-acetate transition-colors',
      href && 'hover:border-foreground/40 cursor-pointer',
      TONE_BAR[tone],
      className,
    )}>
      <div className="flex h-7 w-7 shrink-0 items-center justify-center text-foreground">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground leading-tight">
          {label}
        </p>
        <p className="text-[20px] font-semibold leading-tight tnum">{value}</p>
        {sub && <p className="text-[10px] text-muted-foreground truncate mt-0.5">{sub}</p>}
      </div>
    </div>
  );
  if (href) {
    // Use anchor for client-side navigation compatibility with next/link
    return <a href={href} className="block">{body}</a>;
  }
  return body;
}
