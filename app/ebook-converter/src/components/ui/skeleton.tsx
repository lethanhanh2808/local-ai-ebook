// src/components/ui/skeleton.tsx
// Skeleton primitive (UI Polish 2026-07-06).
//
// Generic placeholder. Use <Skeleton className="h-4 w-32" /> for a
// 16-px-tall, 128-px-wide shimmer block. Animated with a subtle
// pulse via tailwind's `animate-pulse`. Wraps a styled <span> so it
// can be inline within text without disrupting layout.
//
// <PanelSkeleton /> is a thicker 64-px-tall placeholder used for
// lazy-loaded reader panels (AudiobookPlayer, ReadAloudPanel,
// VoiceDebugPanel, CharacterBible).

import { cn } from '@/lib/utils';
import { HTMLAttributes } from 'react';

export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden
      className={cn('animate-pulse rounded-md bg-muted', className)}
      {...props}
    />
  );
}

/** Pre-shaped skeleton for lazy-loaded reader panels (UI Polish). */
export function PanelSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn('flex flex-col gap-2 p-6', className)} aria-hidden>
      <Skeleton className="h-5 w-1/3" />
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-4 w-1/2" />
    </div>
  );
}