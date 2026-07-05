// src/components/layout/StatCard.tsx
// Compact stat card for dashboards.
//   <StatCard icon={<BookOpen/>} label="Books" value={42} sub="12 reading" tone="primary" />
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

const TONE_CLASSES: Record<StatTone, string> = {
  primary: 'bg-primary/10 text-primary',
  success: 'bg-green-500/10 text-green-600 dark:text-green-400',
  warning: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  danger:  'bg-red-500/10 text-red-600 dark:text-red-400',
  muted:   'bg-muted text-muted-foreground',
};

export function StatCard({ icon, label, value, sub, tone = 'primary', href, className }: StatCardProps) {
  const body = (
    <div className={cn(
      'flex items-center gap-3 rounded-xl border bg-card p-4 transition-all',
      href && 'hover:bg-muted/30 hover:border-primary/30 cursor-pointer',
      className,
    )}>
      <div className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-lg', TONE_CLASSES[tone])}>
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </p>
        <p className="text-2xl font-bold leading-tight tabular-nums">{value}</p>
        {sub && <p className="text-[10px] text-muted-foreground truncate">{sub}</p>}
      </div>
    </div>
  );
  if (href) {
    // Use anchor for client-side navigation compatibility with next/link
    return <a href={href} className="block">{body}</a>;
  }
  return body;
}