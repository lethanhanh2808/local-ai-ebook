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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="vi" suppressHydrationWarning>
      <head>
        {/* eslint-disable-next-line @next/next/no-before-interactive-script-outside-document */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-screen bg-background font-sans antialiased">
        <ThemeProvider>
          <ToastProvider>
            <a
              href="#main-content"
              className="fixed left-3 top-3 z-[100] -translate-y-20 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground shadow-lg transition-transform focus:translate-y-0"
            >
              Bỏ qua điều hướng
            </a>
            <AppAuthGate>
              <AppNav />
              <main id="main-content" tabIndex={-1}>{children}</main>
            </AppAuthGate>
            <Toaster />
          </ToastProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
