// src/components/theme/ThemeProvider.tsx
// React theme provider (UI Polish 2026-07-06).
//
// Replaces the DOM-class mutation pattern in src/components/ui/theme-toggle.tsx
// with a proper context provider that:
//   - Exposes useTheme() returning {theme, setTheme, resolvedTheme}
//   - Subscribes to matchMedia('(prefers-color-scheme: dark)') so the
//     UI tracks the OS preference live (not just on mount).
//   - Cross-tab sync via the 'storage' event.
//   - Honors prefers-reduced-motion and forced-colors via data-* attrs.
//
// The pre-hydration inline <script> in src/app/layout.tsx:16-29 is
// preserved to prevent flash — it sets `dark` on <html> before React
// hydrates. The provider takes over once mounted and reconciles.

'use client';

import {
  ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

export type ThemeMode = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

interface ThemeContextValue {
  /** User's preference (light / dark / system). */
  theme: ThemeMode;
  /** What the UI is actually rendering right now. */
  resolvedTheme: ResolvedTheme;
  setTheme: (next: ThemeMode) => void;
}

const STORAGE_KEY = 'theme';

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readStoredTheme(): ThemeMode {
  if (typeof window === 'undefined') return 'system';
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (v === 'light' || v === 'dark') return v;
    if (v === 'system') return 'system';
    // Legacy values: 'true' / 'false' / absent.
    if (v === 'true') return 'dark';
    if (v === 'false') return 'light';
    return 'system';
  } catch {
    return 'system';
  }
}

function systemPrefersDark(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function resolveTheme(theme: ThemeMode): ResolvedTheme {
  return theme === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : theme;
}

function applyTheme(resolved: ResolvedTheme) {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle('dark', resolved === 'dark');
}

function applyAccessibilityModes() {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  // prefers-reduced-motion
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  root.dataset.motion = reduceMotion ? 'reduced' : 'auto';
  // forced-colors (Windows High Contrast, etc.)
  const forced = window.matchMedia('(forced-colors: active)').matches;
  if (forced) root.dataset.forcedColors = 'active';
  else delete root.dataset.forcedColors;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  // Start with 'system' to match SSR; reconcile after mount.
  const [theme, setThemeState] = useState<ThemeMode>('system');
  const [systemDark, setSystemDark] = useState<boolean>(false);

  // Mount: read storage + matchMedia, reconcile <html> class.
  useEffect(() => {
    const stored = readStoredTheme();
    setThemeState(stored);
    setSystemDark(systemPrefersDark());
    applyAccessibilityModes();
    // Apply the resolved theme so any consumer reading the
    // documentElement class sees a consistent state.
    applyTheme(resolveTheme(stored));
  }, []);

  // Track live OS preference changes (only meaningful when theme='system').
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => {
      setSystemDark(e.matches);
      if (theme === 'system') {
        applyTheme(e.matches ? 'dark' : 'light');
      }
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme]);

  // Cross-tab sync: when another tab writes 'theme', reconcile.
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return;
      const next = readStoredTheme();
      setThemeState(next);
      applyTheme(resolveTheme(next));
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, []);

  // Track prefers-reduced-motion live.
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const forcedMq = window.matchMedia('(forced-colors: active)');
    const handler = () => applyAccessibilityModes();
    mq.addEventListener('change', handler);
    forcedMq.addEventListener('change', handler);
    return () => {
      mq.removeEventListener('change', handler);
      forcedMq.removeEventListener('change', handler);
    };
  }, []);

  const setTheme = useCallback((next: ThemeMode) => {
    setThemeState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch { /* ignore quota / private mode */ }
    applyTheme(resolveTheme(next));
  }, []);

  const resolvedTheme: ResolvedTheme = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme;

  const value = useMemo<ThemeContextValue>(() => ({
    theme,
    resolvedTheme,
    setTheme,
  }), [theme, resolvedTheme, setTheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme() must be used inside <ThemeProvider>.');
  }
  return ctx;
}
