// src/components/ui/callout.tsx
//
// Callout primitive (UI Polish 2026-07-06) — colored informational
// banner. Replaces 4+ ad-hoc banner implementations in /convert,
// /settings, ServiceHealth, EbookReader, MetadataModal.
//
// Uses existing --badge-* tokens so we don't add new theme vars.
//
// Usage:
//   <Callout variant="warning" title="Worker offline">
//     Restart the worker to process pending conversions.
//   </Callout>

import { cn } from '@/lib/utils';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Info,
  type LucideIcon,
} from 'lucide-react';
import { HTMLAttributes, ReactNode } from 'react';

export type CalloutVariant = 'info' | 'success' | 'warning' | 'danger';

const variantStyles: Record<CalloutVariant, { box: string; icon: LucideIcon }> = {
  info: {
    box: 'border-blue-500/40 bg-blue-500/10 text-blue-900 dark:text-blue-200',
    icon: Info,
  },
  success: {
    box: 'border-success/40 bg-success/10 text-emerald-900 dark:text-emerald-200',
    icon: CheckCircle2,
  },
  warning: {
    box: 'border-bible-pending-border bg-bible-pending-bg/60 text-amber-900 dark:text-amber-200',
    icon: AlertTriangle,
  },
  danger: {
    box: 'border-destructive/40 bg-destructive/10 text-red-900 dark:text-red-200',
    icon: AlertCircle,
  },
};

export interface CalloutProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  variant?: CalloutVariant;
  title?: ReactNode;
  icon?: LucideIcon | false;
}

export function Callout({
  variant = 'info',
  title,
  icon,
  className,
  children,
  ...props
}: CalloutProps) {
  const style = variantStyles[variant];
  const Icon = icon === false ? null : icon ?? style.icon;
  return (
    <div
      role="note"
      className={cn(
        'flex items-start gap-3 rounded-lg border border-border p-4 text-sm',
        style.box,
        className,
      )}
      {...props}
    >
      {Icon && (
        <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      )}
      <div className="flex-1 space-y-1">
        {title && <p className="font-medium leading-none">{title}</p>}
        {children && (
          <div className="text-sm leading-relaxed [&_p]:leading-relaxed">
            {children}
          </div>
        )}
      </div>
    </div>
  );
}