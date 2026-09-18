// src/components/ui/seal-stamp.tsx
//
// <SealStamp> — the one structural accent of the East-Asian paper visual
// world (DESIGN.md). A 40×40 vermilion block with hand-cut relief and a
// two-character label (or single chữ Hán). Animates once on mount with a
// 220 ms ink-press fade — never thereafter. The seam edge is a 1-px
// darker vermilion rule at the bottom of the square (the carved
// character relief).
//
// Three sizes:
//
//   sm — 32 px, used in section markers and stat cards
//   md — 40 px, default, used at chapter breaks
//   lg — 56 px, used on the page header anchor
//
// The label prop is the two-character seal text (e.g. "文學" or "Thư
// Viện"). When omitted, the stamp is decorative (aria-hidden).
'use client';

import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

type SealSize = 'sm' | 'md' | 'lg';

interface SealStampProps {
  /** Optional two-character seal label. Omit for a decorative stamp. */
  label?: ReactNode;
  /** Accessible label — required when `label` is omitted but the stamp
   *  carries semantic meaning (e.g. "Trang chủ"). When `label` is a
   *  visible string the aria-label falls back to it. */
  'aria-label'?: string;
  className?: string;
  size?: SealSize;
}

const SIZE: Record<SealSize, { box: string; text: string }> = {
  sm: { box: 'h-8 w-8',  text: 'text-[10px] leading-none' },
  md: { box: 'h-10 w-10', text: 'text-[12px] leading-none' },
  lg: { box: 'h-14 w-14', text: 'text-[16px] leading-none' },
};

export function SealStamp({
  label,
  'aria-label': ariaLabel,
  className,
  size = 'md',
}: SealStampProps) {
  const dim = SIZE[size];
  // If no label, the stamp is decorative. When label IS provided we
  // expose an aria-label so screen readers do not read the CJK glyph.
  const decorative = label === undefined;
  const finalAria = decorative ? undefined : ariaLabel ?? (typeof label === 'string' ? label : undefined);

  return (
    <span
      role={decorative ? undefined : 'img'}
      aria-hidden={decorative ? 'true' : undefined}
      aria-label={finalAria}
      className={cn(
        'seal-stamp inline-flex items-center justify-center font-semibold select-none seal-press',
        dim.box,
        dim.text,
        className,
      )}
    >
      {label}
    </span>
  );
}
