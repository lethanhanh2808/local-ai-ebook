// src/components/layout/PageHeader.tsx
// Shared page header for the East-Asian paper visual world (DESIGN.md).
//
//   <PageHeader title="Library" description="..." icon={<BookOpen/>} actions={...} />
//
// The header sits on the full-width paper canvas, anchored by a 1-px ink
// rule under the title row. The title is brushed serif, with a small
// vermilion seal-style tab on the left if an icon is provided. Spacing is
// generous on the top and tight below the rule — the leaf lies flat on
// the desk.
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
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-primary mb-2">
            {eyebrow}
          </p>
        )}
        <div className="flex items-center gap-3">
          {icon && (
            // Icon sits on a vermilion seal-style tab: a small vermilion
            // square with the icon in cream. Reads as a chapter marker
            // rather than a circular SaaS backdrop.
            <div className="flex h-8 w-8 shrink-0 items-center justify-center bg-primary text-primary-foreground">
              {icon}
            </div>
          )}
          <div className="min-w-0">
            <h1 className="text-[22px] font-semibold leading-tight tracking-[-0.01em] truncate">
              {title}
            </h1>
            {description && (
              <p className="text-[12px] text-muted-foreground mt-1 leading-snug">{description}</p>
            )}
          </div>
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}
