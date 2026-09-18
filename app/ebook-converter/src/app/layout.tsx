// src/app/layout.tsx
import type { Metadata } from 'next';
import './globals.css';
import { AppNav } from '@/components/nav/AppNav';
import { ToastProvider, Toaster } from '@/components/ui/toast';
import { ThemeProvider } from '@/components/theme/ThemeProvider';
import { AppAuthGate } from '@/components/auth/AppAuthGate';

export const metadata: Metadata = {
  title: 'Ebook Manager – Convert, Organize & Read your EPUB library',
  description:
    'Manage your ebook library: convert and repair files with local AI (OMLX), organize with shelves, listen with VieNeu-TTS voice synthesis. Optimized for Vietnamese content.',
};

// Inline script: sets dark class before hydration to prevent flash
const THEME_SCRIPT = `
try {
  const t = localStorage.getItem('theme');
  const dark = t === 'dark' || ((!t || t === 'system') && window.matchMedia('(prefers-color-scheme: dark)').matches);
  if (dark) document.documentElement.classList.add('dark');
} catch (e) {}
`;

// East-Asian paper direction (DESIGN.md). Noto Serif SC carries the
// Song/Mincho-style stroke contrast; Noto Sans SC is the fallback for
// inline sans tags (metadata, tabular numerals). Be Vietnam Pro is the
// primary Latin/Vietnamese face — designed for Vietnamese typography
// first (proper tone-mark positioning, circumflex/breve weights), with
// clean Latin fallback for English titles. The app's content is mostly
// Vietnamese novels, so this MUST come before Noto Serif SC in the
// stack or the chrome will render with Noto's CJK-glyph-mapped Latin
// (visible diacritic-positioning quirks on ộ, ề, ứ).
//
// Loaded as a single stylesheet from Google Fonts, preconnected to
// remove the extra DNS round-trip before first paint.
const PAPER_FONTS_HREF =
  'https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:ital,wght@0,400;0,500;0,600;0,700;1,400;1,600&family=Noto+Sans+SC:wght@400;500;600;700&family=Noto+Serif+SC:wght@400;500;600;700&display=swap';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="vi" suppressHydrationWarning>
      <head>
        {/* eslint-disable-next-line @next/next/no-before-interactive-script-outside-document */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link rel="stylesheet" href={PAPER_FONTS_HREF} />
      </head>
      <body className="min-h-screen bg-paper-deep antialiased">
        <ThemeProvider>
          <ToastProvider>
            <a
              href="#main-content"
              className="fixed left-3 top-3 z-[100] -translate-y-20 border border-foreground/30 bg-card px-3 py-2 text-sm font-medium text-foreground shadow-acetate transition-transform focus:translate-y-0"
            >
              Bỏ qua điều hướng
            </a>
            <AppAuthGate>
              <AppNav />
              {/* Full-width, full-height canvas for every page. The
                  `bg-paper-deep` extends to the bottom of the viewport
                  even when content is short, so the folio-on-desk raise
                  from DESIGN.md holds on every route. The
                  `min-h-[calc(100vh-3.5rem)]` subtracts the sticky nav
                  (h-14 = 3.5rem) so the canvas + content stack to the
                  viewport edge without horizontal scroll. Individual
                  pages still bound their own content column with
                  `max-w-canvas` (1800 px) or narrower. */}
              <main
                id="main-content"
                tabIndex={-1}
                className="min-h-[calc(100vh-3.5rem)] bg-paper-deep"
              >
                {children}
              </main>
            </AppAuthGate>
            <Toaster />
          </ToastProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
