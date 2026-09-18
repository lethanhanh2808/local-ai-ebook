// src/components/ui/card.tsx
// Lightweight Card primitive (UI Polish 2026-07-06, re-skinned for the
// reference-manual visual world 2026-09-18).
//
// Single source of truth for the paper-ground shell pattern used by every
// page. Variants:
//
//   <Card>            — base card (paper ground, hairline border, acetate shadow)
//   <CardHeader>      — top region, padded, used with CardTitle/Description
//   <CardTitle>       — section title (chrome-yellow accent on the active
//                       section's eyebrow via CardEyebrow)
//   <CardDescription> — muted subtitle
//   <CardContent>     — body
//   <CardFooter>      — bottom actions row
//   <CardAction>      — top-right action (icon button / link)
//
// All slots compose. `className` is appended so callers can override.
// No new dependencies; uses cn() + Tailwind.

import { cn } from '@/lib/utils';
import { HTMLAttributes, forwardRef } from 'react';

export const Card = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        // Reference-manual: paper ground, hairline border, single short
        // shadow (acetate leaf), 2-px corners. No Material elevation.
        'border border-border bg-card text-card-foreground shadow-acetate',
        'transition-colors',
        className,
      )}
      {...props}
    />
  ),
);
Card.displayName = 'Card';

export const CardHeader = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn('flex flex-col gap-1 px-4 pt-4 pb-3', className)}
      {...props}
    />
  ),
);
CardHeader.displayName = 'CardHeader';

export const CardTitle = forwardRef<HTMLHeadingElement, HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h3
      ref={ref}
      className={cn('text-[14px] font-semibold leading-tight tracking-[-0.01em]', className)}
      {...props}
    />
  ),
);
CardTitle.displayName = 'CardTitle';

/**
 * Chrome-yellow eyebrow that sits above a CardTitle. Structural accent —
 * the title of the section currently in view. Reserve for the most
 * important header on a page (typically one per visible card).
 */
export const CardEyebrow = forwardRef<HTMLHeadingElement, HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <p
      ref={ref}
      className={cn(
        'text-[10px] font-semibold uppercase tracking-[0.12em] text-primary leading-none',
        className,
      )}
      {...props}
    />
  ),
);
CardEyebrow.displayName = 'CardEyebrow';

export const CardDescription = forwardRef<HTMLParagraphElement, HTMLAttributes<HTMLParagraphElement>>(
  ({ className, ...props }, ref) => (
    <p
      ref={ref}
      className={cn('text-[12px] text-muted-foreground leading-snug', className)}
      {...props}
    />
  ),
);
CardDescription.displayName = 'CardDescription';

export const CardContent = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('px-4 pb-4', className)} {...props} />
  ),
);
CardContent.displayName = 'CardContent';

export const CardFooter = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        'flex items-center justify-between gap-3 border-t border-border px-4 py-3',
        className,
      )}
      {...props}
    />
  ),
);
CardFooter.displayName = 'CardFooter';

/** Top-right action slot (icon button or short link). */
export const CardAction = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn('absolute right-3 top-3 flex items-center gap-1', className)}
      {...props}
    />
  ),
);
CardAction.displayName = 'CardAction';