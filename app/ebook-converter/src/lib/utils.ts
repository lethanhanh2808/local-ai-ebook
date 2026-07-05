// src/lib/utils.ts
import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export function formatDate(d: string | Date): string {
  return new Date(d).toLocaleString('vi-VN', {
    dateStyle: 'short',
    timeStyle: 'short',
  });
}

/** Format milliseconds as `1h 23m 45s` / `12m 34s` / `56s`. */
export function formatDuration(ms: number | null | undefined): string {
  if (!ms || ms < 0) return '0s';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs > 0 ? `${m}m ${rs}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}

export const STATUS_COLORS: Record<string, string> = {
  queued:     'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300',
  processing: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  completed:  'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  failed:     'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
  cancelled:  'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
};
