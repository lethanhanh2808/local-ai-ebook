// src/components/layout/BackLink.tsx
//
// BackLink primitive (UI Polish 2026-07-06) — a standardised "← Back
// to …" affordance. Used by /shelves/[id], EpubEditor, and any
// future nested-resource screens. Wraps <Link> from next/link with
// a chevron icon + label and an accessible name.

import { ChevronLeft } from 'lucide-react';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import { ReactNode } from 'react';

export interface BackLinkProps {
  href: string;
  children: ReactNode;
  className?: string;
}

export function BackLink({ href, children, className }: BackLinkProps) {
  return (
    <Link
      href={href}
      className={cn(
        'inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors',
        'hover:text-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm',
        className,
      )}
    >
      <ChevronLeft className="h-4 w-4" aria-hidden />
      <span>{children}</span>
    </Link>
  );
}