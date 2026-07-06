// src/components/theme/useTheme.ts
// Re-export the theme hook from its canonical location. Components
// can import `useTheme` from either path — both resolve to the
// same provider.

export { useTheme, ThemeProvider } from './ThemeProvider';
export type { ThemeMode, ResolvedTheme } from './ThemeProvider';