// src/components/ui/badge.tsx
import { cn } from '@/lib/utils';

interface BadgeProps {
  className?: string;
  children: React.ReactNode;
}
export function Badge({ className, children }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium',
        className,
      )}
    >
      {children}
    </span>
  );
}
