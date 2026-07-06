// src/components/ui/input.tsx
// Input primitive (UI Polish 2026-07-06).
//
// Hand-rolled <input> with consistent focus ring, disabled, and
// aria-invalid styling. Use the `aria-invalid` attribute on the host
// to switch the ring to destructive.
//
// No new deps. Mirror Button pattern at src/components/ui/button.tsx.

import { cn } from '@/lib/utils';
import { InputHTMLAttributes, forwardRef } from 'react';

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, type = 'text', ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      className={cn(
        'flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm',
        'transition-colors',
        'placeholder:text-muted-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'aria-[invalid=true]:border-destructive aria-[invalid=true]:ring-1 aria-[invalid=true]:ring-destructive',
        // Hide the browser number-input spinners — we add our own controls
        // where needed; the spinners look out of place in dark themes.
        type === 'number' && 'appearance-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';