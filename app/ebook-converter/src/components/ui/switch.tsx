// src/components/ui/switch.tsx
// Switch primitive (UI Polish 2026-07-06).
//
// Role=switch + aria-checked toggle. Built on a native <button> for
// correct keyboard semantics (Space/Enter toggle), wrapped in a
// label-able container. The visual is a track+thumb that animates
// between checked and unchecked positions using tailwindcss-animate.
//
// `peer` sibling classes let <Label peer-disabled:cursor-not-allowed>
// disable the whole row when the parent fieldset is disabled.

import { cn } from '@/lib/utils';
import { ButtonHTMLAttributes, forwardRef } from 'react';

export interface SwitchProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'> {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  /** Accessible label for the control (screen readers + tooltip). */
  label?: string;
}

export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(
  ({ className, checked, onCheckedChange, label, disabled, ...props }, ref) => (
    <button
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label ?? (typeof props['aria-label'] === 'string' ? props['aria-label'] : undefined)}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        'peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent',
        'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        'disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'bg-primary' : 'bg-input',
        className,
      )}
      {...props}
    >
      <span
        aria-hidden
        className={cn(
          'pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform',
          checked ? 'translate-x-4' : 'translate-x-0',
        )}
      />
    </button>
  ),
);
Switch.displayName = 'Switch';