// src/components/nav/AppNav.tsx
// Top navigation (UI Polish 2026-07-06).
//
// Adds:
//   - Mobile menu (hamburger visible < md; slide-down panel with
//     nav links; ESC closes; scroll lock when open).
//   - aria-current="page" on active nav link.
//   - More pronounced active-state border + subtle background.
//
// Sticky z-40 stays below Dialog (z-60) and Toaster (z-50), so
// modals and toasts layer on top as intended.
'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  BookOpen,
  LayoutDashboard,
  BookMarked,
  BarChart3,
  Library,
  Upload,
  Settings as SettingsIcon,
  Menu,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { ThemeToggle } from '@/components/ui/theme-toggle';
import { ServiceHealth } from '@/components/status/ServiceHealth';

const NAV_ITEMS = [
  { href: '/',         label: 'Dashboard', icon: LayoutDashboard },
  { href: '/convert',  label: 'Convert',   icon: Upload },
  { href: '/library',  label: 'Library',   icon: Library },
  { href: '/shelves',  label: 'Shelves',   icon: BookMarked },
  { href: '/stats',    label: 'Stats',     icon: BarChart3 },
  { href: '/settings', label: 'Settings',  icon: SettingsIcon },
];

export function AppNav() {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  // ESC closes the mobile menu.
  useEffect(() => {
    if (!mobileOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileOpen(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [mobileOpen]);

  // Lock body scroll while mobile menu is open.
  useEffect(() => {
    if (!mobileOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [mobileOpen]);

  // Close mobile menu on route change.
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  const isActive = (href: string) =>
    href === '/' ? pathname === '/' : pathname.startsWith(href);

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-3 px-4">
        {/* Brand */}
        <Link href="/" className="flex items-center gap-2.5 shrink-0">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-primary to-primary/70 text-primary-foreground shadow-sm">
            <BookOpen className="h-4 w-4" />
          </div>
          <div className="hidden sm:flex flex-col leading-tight">
            <span className="text-sm font-semibold tracking-tight">Ebook Manager</span>
            <span className="text-[10px] text-muted-foreground">Convert · Organize · Read</span>
          </div>
        </Link>

        {/* Desktop nav (≥ md) */}
        <nav className="hidden md:flex items-center gap-0.5 ml-2" aria-label="Primary">
          {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
            const active = isActive(href);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  active
                    ? 'bg-primary/10 text-primary shadow-sm'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                <Icon className="h-4 w-4" />
                <span>{label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <ServiceHealth className="hidden sm:inline-flex" />
          <span className="hidden lg:flex items-center gap-1.5 rounded-full bg-primary/10 px-2.5 py-0.5 text-xs text-primary font-medium">
            AI · Vietnamese Voice · OMLX
          </span>
          <ThemeToggle />
          {/* Hamburger (< md) */}
          <button
            type="button"
            aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={mobileOpen}
            aria-controls="mobile-nav"
            onClick={() => setMobileOpen((o) => !o)}
            className="md:hidden rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </div>

      {/* Mobile menu (< md) — slide-down panel */}
      {mobileOpen && (
        <div
          id="mobile-nav"
          className="md:hidden border-t border-border bg-background animate-in slide-in-from-top-2 fade-in-0"
        >
          <nav className="mx-auto max-w-7xl px-4 py-3 flex flex-col gap-1" aria-label="Mobile">
            {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
              const active = isActive(href);
              return (
                <Link
                  key={href}
                  href={href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    active
                      ? 'bg-primary/10 text-primary'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  <Icon className="h-4 w-4" />
                  <span>{label}</span>
                </Link>
              );
            })}
          </nav>
        </div>
      )}
    </header>
  );
}