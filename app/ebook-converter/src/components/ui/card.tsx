// src/components/ui/card.tsx
// Lightweight Card primitive.
//
// Single source of truth for the leaf-on-paper panel pattern used by every
// page. Re-skinned for the East-Asian paper visual world (DESIGN.md):
//
//   <Card>            — fresh-xuan card ground, single hairline rule, paper-
//                       leaf shadow. Tighter rounding than SaaS default.
//   <CardHeader>      — top region, padded, used with CardTitle/Description
//   <CardTitle>       — section title in Noto Serif SC
//   <CardDescription> — muted subtitle in sumi-soft ink
//   <CardContent>     — body
//   <CardFooter>      — bottom actions row, separated by a hairline rule
//   <CardAction>      — top-right action (icon button / link)
//   <CardEyebrow>     — vermilion tab marker; reserved for the most important
//                       header on a page. Use sparingly — one per visible card.
//
// All slots compose. `className` is appended so callers can override.

import { cn } from '@/lib/utils';
import { HTMLAttributes, forwardRef } from 'react';

export const Card = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        // East-Asian paper: fresh-xuan card ground, hairline rule, paper-
        // leaf shadow (defined in globals.css as .shadow-acetate).
        'bg-card text-card-foreground border border-border shadow-acetate',
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
      className={cn('flex flex-col gap-1 px-5 pt-5 pb-3', className)}
      {...props}
    />
  ),
);
CardHeader.displayName = 'CardHeader';

export const CardTitle = forwardRef<HTMLHeadingElement, HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h3
      ref={ref}
      className={cn(
        'text-[15px] font-semibold leading-tight tracking-[-0.01em] text-foreground',
        className,
      )}
      {...props}
    />
  ),
);
CardTitle.displayName = 'CardTitle';

/**
 * Vermilion eyebrow that sits above a CardTitle. The one saturated accent
 * in the paper world — use it where the section title is the strongest
 * signal on the page (typically once per visible card).
 */
export const CardEyebrow = forwardRef<HTMLHeadingElement, HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <p
      ref={ref}
      className={cn(
        'text-[10px] font-semibold uppercase tracking-[0.18em] text-primary leading-none',
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
    <div ref={ref} className={cn('px-5 pb-5', className)} {...props} />
  ),
);
CardContent.displayName = 'CardContent';

export const CardFooter = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        'flex items-center justify-between gap-3 border-t border-border px-5 py-3',
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
