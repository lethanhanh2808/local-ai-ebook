// src/components/layout/PageHeader.tsx
// Shared page header used by every page for a consistent look.
//   <PageHeader title="Library" description="..." icon={<BookOpen/>} actions={...} />
'use client';

import { cn } from '@/lib/utils';
import Link from 'next/link';
import type { ReactNode } from 'react';

export interface PageHeaderBreadcrumb {
  label: string;
  /** Optional link target. When omitted the crumb renders as plain text. */
  href?: string;
}

interface PageHeaderProps {
  title: string;
  description?: string;
  icon?: ReactNode;
  actions?: ReactNode;
  /** Optional eyebrow text shown above the title (e.g. "Library"). */
  eyebrow?: string;
  /** Optional breadcrumb trail rendered above the title row. */
  breadcrumbs?: PageHeaderBreadcrumb[];
  className?: string;
}

export function PageHeader({
  title,
  description,
  icon,
  actions,
  eyebrow,
  breadcrumbs,
  className,
}: PageHeaderProps) {
  return (
    <div className={cn('flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 mb-6', className)}>
      <div className="min-w-0 flex-1">
        {breadcrumbs && breadcrumbs.length > 0 && (
          <nav
            aria-label="Breadcrumb"
            className="mb-2 flex flex-wrap items-center gap-1 text-xs text-muted-foreground"
          >
            {breadcrumbs.map((c, i) => (
              <span key={`${c.label}-${i}`} className="flex items-center gap-1">
                {i > 0 && <span aria-hidden="true">/</span>}
                {c.href ? (
                  <Link
                    href={c.href}
                    className="hover:text-foreground transition-colors"
                  >
                    {c.label}
                  </Link>
                ) : (
                  <span>{c.label}</span>
                )}
              </span>
            ))}
          </nav>
        )}
        {eyebrow && (
          <p className="text-[10px] font-bold uppercase tracking-widest text-primary mb-1.5">
            {eyebrow}
          </p>
        )}
        <div className="flex items-center gap-2.5">
          {icon && (
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary shrink-0">
              {icon}
            </div>
          )}
          <div className="min-w-0">
            <h1 className="text-2xl font-bold tracking-tight truncate">{title}</h1>
            {description && (
              <p className="text-sm text-muted-foreground mt-0.5">{description}</p>
            )}
          </div>
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}