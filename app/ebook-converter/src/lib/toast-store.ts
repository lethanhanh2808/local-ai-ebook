// src/lib/toast-store.ts
// Toast pub/sub store (UI Polish 2026-07-06).
//
// Tiny store implemented with `useSyncExternalStore` so React 18
// components can subscribe without a re-render storm. No zustand —
// we don't need atoms, only a tiny FIFO queue with auto-dismiss.
//
// Each toast has:
//   id — unique
//   variant — 'default' | 'success' | 'error' | 'info' | 'warning'
//   title — required short label
//   description — optional longer text
//   duration — auto-dismiss in ms (default 4000; null = sticky)
//   action — optional { label, onClick } for inline confirm/undo

'use client';

import { useSyncExternalStore } from 'react';

export type ToastVariant = 'default' | 'success' | 'error' | 'info' | 'warning';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface Toast {
  id: string;
  variant: ToastVariant;
  title: string;
  description?: string;
  duration: number | null;
  action?: ToastAction;
  createdAt: number;
}

let toasts: Toast[] = [];
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function snapshot(): Toast[] {
  return toasts;
}

// We hand back a frozen array reference so React's bailout (===)
// works when the queue hasn't changed.
function getSnapshot(): Toast[] {
  return toasts;
}

// SSR-safe no-op subscriber. On the server, useSyncExternalStore is
// called once with a different snapshot to detect hydration mismatch;
// we return [] which is fine.
function getServerSnapshot(): Toast[] {
  return EMPTY;
}

const EMPTY: Toast[] = [];

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `t${Date.now().toString(36)}${idCounter}`;
}

export function pushToast(t: Omit<Toast, 'id' | 'createdAt' | 'duration'> & { id?: string; duration?: number | null }): string {
  const toast: Toast = {
    id: t.id ?? nextId(),
    createdAt: Date.now(),
    duration: t.duration ?? 4000,
    variant: t.variant ?? 'default',
    title: t.title,
    description: t.description,
    action: t.action,
  };
  toasts = [...toasts, toast];
  emit();
  if (toast.duration != null) {
    setTimeout(() => dismissToast(toast.id), toast.duration);
  }
  return toast.id;
}

export function dismissToast(id: string): void {
  const before = toasts.length;
  toasts = toasts.filter((t) => t.id !== id);
  if (toasts.length !== before) emit();
}

export function clearToasts(): void {
  if (toasts.length === 0) return;
  toasts = [];
  emit();
}

/** Subscribe to the toast queue. Returns the current snapshot. */
export function useToasts(): Toast[] {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}