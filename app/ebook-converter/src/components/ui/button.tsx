// src/components/ui/button.tsx
import { cn } from '@/lib/utils';
import { ButtonHTMLAttributes, forwardRef } from 'react';

const variants = {
  default: 'bg-primary text-primary-foreground hover:bg-primary/90 shadow',
  outline: 'border border-input bg-background hover:bg-accent hover:text-accent-foreground',
  ghost: 'hover:bg-accent hover:text-accent-foreground',
  destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
  secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
};
const sizes = {
  default: 'h-9 px-4 py-2 text-sm',
  sm: 'h-8 px-3 text-xs rounded-md',
  lg: 'h-10 px-6 text-base',
  icon: 'h-9 w-9',
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof variants;
  size?: keyof typeof sizes;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'default', size = 'default', ...props }, ref) => (
    <button
      ref={ref}
      className={cn(
        'inline-flex items-center justify-center whitespace-nowrap rounded-md font-medium',
        'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        'disabled:pointer-events-none disabled:opacity-50',
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  ),
);
Button.displayName = 'Button';
