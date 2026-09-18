// src/components/ui/button.tsx
// Button primitive for the East-Asian paper visual world (DESIGN.md).
//
// The world has one accent — vermilion (朱砂 cinnabar). Buttons that take
// an action use vermilion ground with cream ink; outline and ghost
// variants stay in sumi ink so the surface hierarchy is clear. No pillowy
// corners, no shadows, no gradients. Default height 32 px to keep the
// reference-manual tightness.
import { cn } from '@/lib/utils';
import { ButtonHTMLAttributes, forwardRef } from 'react';

const variants = {
  // Primary = brush: vermilion ground, cream text, 1-px sumi-edge border.
  default:
    'bg-primary text-primary-foreground border border-primary hover:bg-primary/90',
  outline:
    'border border-border bg-transparent text-foreground hover:bg-secondary hover:border-foreground/30',
  ghost:
    'bg-transparent text-foreground hover:bg-secondary border border-transparent',
  destructive:
    'bg-destructive text-destructive-foreground border border-destructive hover:bg-destructive/90',
  secondary:
    'bg-secondary text-secondary-foreground border border-border hover:bg-secondary/80',
  link:
    'text-foreground underline-offset-4 hover:underline decoration-primary decoration-2 underline-offset-[3px]',
};
const sizes = {
  // Slightly tighter than the SaaS default so the chrome stays in scale
  // with the paper-ground cards.
  default: 'h-8 px-3 text-[12px] font-semibold tracking-[0.04em]',
  sm: 'h-7 px-2.5 text-[11px] font-semibold tracking-[0.04em]',
  lg: 'h-10 px-5 text-sm font-semibold tracking-[0.04em]',
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
    // East-Asian paper: tight 2-px corners, no shadows (paper has
    // hairlines, not Material elevation), uppercase tracking on every
    // size variant except icon.
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
