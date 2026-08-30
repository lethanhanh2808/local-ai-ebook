export type Theme = 'light' | 'dark' | 'sepia';
export type Font = 'serif' | 'sans' | 'mono';
export type Layout = 'spread' | 'scroll';

export interface ReaderSettings {
  theme: Theme;
  font: Font;
  fontSize: number;
  lineHeight: number;
  width: number;
  layout: Layout;
  indent: number;
  padTop: number;
  padBottom: number;
  padInline: number;
}

export const DEFAULT_SETTINGS: ReaderSettings = {
  // Indent = 0 → Vietnamese novel style: every paragraph flush-left, blank
  // line between them. Classic book style (indent=1.5) is still selectable
  // from the Reading Settings indent chip group.
  theme: 'dark',
  font: 'serif',
  fontSize: 18,
  lineHeight: 1.85,
  width: 820,
  layout: 'spread',
  indent: 0,
  padTop: 56,
  padBottom: 96,
  padInline: 56,
};

export const INDENT_PRESETS = [
  { em: 0, label: 'None' },
  { em: 1, label: '1em' },
  { em: 1.5, label: '1.5em' },
  { em: 2, label: '2em' },
];

export const THEMES = [
  { id: 'light' as Theme, label: 'Light', bg: '#fafaf9', text: '#1c1c1e' },
  { id: 'sepia' as Theme, label: 'Sepia', bg: '#f4ede4', text: '#3b2f20' },
  { id: 'dark' as Theme, label: 'Dark', bg: '#1a1a2e', text: '#e2e2e8' },
];

// Map `settings.theme` to token-backed Tailwind classes. Sepia has its
// own bespoke palette because it must look distinctly warm/sepia even
// when the surrounding app is in light or dark mode; the light + dark
// branches reuse the `--reader-*` tokens defined in src/app/theme.css.
type ReaderSurfaceKey = 'header' | 'panel' | 'divider' | 'muted' | 'active' | 'hover' | 'input' | 'btnBorder';
export function readerSurface(theme: Theme, key: ReaderSurfaceKey): string {
  switch (theme) {
    case 'dark':
      switch (key) {
        case 'header': return 'bg-[hsl(var(--reader-paper))]/95 border-[hsl(var(--reader-divider))] text-[hsl(var(--reader-ink))]';
        case 'panel': return 'bg-[hsl(var(--reader-paper))] border-[hsl(var(--reader-divider))] text-[hsl(var(--reader-ink))]';
        case 'divider': return 'border-[hsl(var(--reader-divider))]';
        case 'muted': return 'text-[hsl(var(--reader-ink-soft))]';
        case 'active': return 'bg-blue-900/50 text-blue-200 border-blue-700';
        case 'hover': return 'hover:bg-white/5';
        case 'input': return 'border-[#3a3a5a] bg-[#1a1a2e]';
        case 'btnBorder': return 'hsl(var(--reader-divider))';
      }
      break;
    case 'sepia':
      switch (key) {
        case 'header': return 'bg-[#ede0ce]/95 border-[#c8b89a] text-[#3b2f20]';
        case 'panel': return 'bg-[#ede0ce] border-[#c8b89a] text-[#3b2f20]';
        case 'divider': return 'border-[#c8b89a]';
        case 'muted': return 'text-[#8a7a65]';
        case 'active': return 'bg-[#a07840]/20 text-[#5a3a1c] border-[#a07840]';
        case 'hover': return 'hover:bg-[#a07840]/10';
        case 'input': return 'border-[#c8b89a] bg-[#f4ede4]';
        case 'btnBorder': return '#c8b89a';
      }
      break;
    case 'light':
    default:
      switch (key) {
        case 'header': return 'bg-white/95 border-gray-200 text-gray-900';
        case 'panel': return 'bg-white border-gray-200 text-gray-900';
        case 'divider': return 'border-gray-200';
        case 'muted': return 'text-gray-500';
        case 'active': return 'bg-blue-100 text-blue-700 border-blue-300';
        case 'hover': return 'hover:bg-gray-100';
        case 'input': return 'border-gray-200 bg-white';
        case 'btnBorder': return '#e2e2e2';
      }
      break;
  }

  return 'bg-white border-gray-200 text-gray-900';
}

export const FONTS = [
  { id: 'serif' as Font, sample: 'Georgia', stack: 'Georgia,serif' },
  { id: 'sans' as Font, sample: 'Helvetica', stack: 'Inter,sans-serif' },
  { id: 'mono' as Font, sample: 'Mono', stack: 'monospace' },
];

export const WIDTHS = [
  { px: 640, label: 'Narrow' },
  { px: 820, label: 'Medium' },
  { px: 1040, label: 'Wide' },
  { px: 9999, label: 'Full' },
];
