// src/components/ui/button.tsx
import { cn } from '@/lib/utils';
import { ButtonHTMLAttributes, forwardRef } from 'react';

const variants = {
  // Primary is now chrome-yellow on ink — the reference-manual accent.
  // No `shadow` — the manual has hairlines, not Material elevation.
  default: 'bg-primary text-primary-foreground hover:bg-accent border border-primary',
  outline: 'border border-border bg-card text-foreground hover:bg-muted',
  ghost: 'text-foreground hover:bg-muted',
  destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90 border border-destructive',
  secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80 border border-border',
  link: 'text-foreground underline-offset-4 hover:underline decoration-primary decoration-2 underline-offset-[3px]',
};
const sizes = {
  // Manual chrome is tighter than the SaaS default; default height 32 px.
  default: 'h-8 px-3 text-xs font-semibold uppercase tracking-[0.06em]',
  sm: 'h-7 px-2 text-[11px] font-semibold uppercase tracking-[0.06em]',
  lg: 'h-10 px-5 text-sm font-semibold uppercase tracking-[0.06em]',
  icon: 'h-8 w-8',
};

export type ButtonVariant = keyof typeof variants;
export type ButtonSize = keyof typeof sizes;

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

/**
 * Pure class-name helper used by composite components (AlertDialog,
 * Dialog, DropdownMenu) that need Button styling without rendering an
 * actual <button>. Returns the merged classes for `variant` + `size` only —
 * callers add base + utility classes themselves.
 */
export function buttonClasses(opts: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
} = {}): string {
  const { variant = 'default', size = 'default', className } = opts;
  return cn(
    // Reference-manual: tighter radius (2 px), no font-medium weight override
    // (variants carry weight), no `shadow` (hairlines only).
    'inline-flex items-center justify-center whitespace-nowrap',
    'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
    'disabled:pointer-events-none disabled:opacity-50',
    variants[variant],
    sizes[size],
    className,
  );
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'default', size = 'default', type = 'button', ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={buttonClasses({ variant, size, className })}
      {...props}
    />
  ),
);
Button.displayName = 'Button';
