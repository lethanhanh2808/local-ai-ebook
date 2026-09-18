// src/components/nav/AppNav.tsx
// Top navigation for the East-Asian paper visual world (DESIGN.md).
//
// The nav is a full-width "manuscript band" — the same aged-paper canvas
// as the rest of the viewport, with a 1-px ink hairline along its bottom
// edge (the page-rule). Inside the band:
//
//   • Brand: a vermilion seal stamp on the left + "Ebook Manager" in
//     Noto Serif SC. No gradient tile, no pill.
//   • Primary nav: each item is a brushed-serif label with an icon; the
//     active item gets a vermilion bottom rule (replacing the chrome-
//     yellow of the reference-manual world). No tinted pill.
//   • Right side: ServiceHealth, AI Voice chip, Account menu, ThemeToggle,
//     mobile hamburger.
//
// Mobile menu (< md) slides down as a panel with the same paper ground.
// Active item gets a vermilion left rule.
//
// Sticky z-40 stays below Dialog (z-60) and Toaster (z-50).
'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
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
  LogOut,
  ShieldCheck,
  Mic,
  UserCircle2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { ThemeToggle } from '@/components/ui/theme-toggle';
import { ServiceHealth } from '@/components/status/ServiceHealth';
import { Button } from '@/components/ui/button';
import { SealStamp } from '@/components/ui/seal-stamp';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

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
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [sessionUser, setSessionUser] = useState<{ username: string; role: string; name: string } | null>(null);

  useEffect(() => {
    if (pathname === '/login') return;

    let cancelled = false;
    const loadUser = async () => {
      try {
        const res = await fetch('/api/auth/me', { cache: 'no-store' });
        if (!res.ok) {
          setSessionUser(null);
          return;
        }
        const data = await res.json().catch(() => null);
        if (!cancelled && data?.ok && data.user) setSessionUser(data.user);
      } catch {
        if (!cancelled) setSessionUser(null);
      }
    };
    void loadUser();
    return () => { cancelled = true; };
  }, [pathname]);

  const handleLogout = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch {
      // noop
    }
    setSessionUser(null);
    router.push('/login');
    router.refresh();
  };

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
    href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);

  if (pathname === '/login') return null;

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      {/* Full-width band — no max-width cap. The inner flex line centres its
          own content with `px-6` so the canvas under it stays visible. */}
      <div className="flex h-14 items-center gap-2 px-4 sm:px-6">
        {/* Brand — vermilion seal stamp + brushed-serif wordmark. */}
        <Link href="/" aria-label="Ebook Manager — trang chủ" className="flex shrink-0 items-center gap-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <SealStamp label="書" size="md" aria-label="Ebook Manager" />
          <div className="hidden sm:flex flex-col leading-tight">
            <span className="text-[15px] font-semibold tracking-[-0.01em]">Ebook Manager</span>
            <span className="text-[10px] text-muted-foreground tracking-[0.16em] uppercase">Thư viện số</span>
          </div>
        </Link>

        {/* Desktop nav (≥ md) — active item gets a vermilion bottom rule. */}
        <nav className="hidden md:flex items-stretch gap-0 ml-4" aria-label="Primary">
          {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
            const active = isActive(href);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-1.5 px-3 h-14 text-[12px] font-medium tracking-[0.04em] transition-colors border-b-2',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  active
                    ? 'border-b-primary text-foreground'
                    : 'border-b-transparent text-muted-foreground hover:text-foreground hover:bg-secondary/40',
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                <span>{label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
          <ServiceHealth className="hidden sm:inline-flex" />

          <button
            type="button"
            aria-label="AI Voice"
            title="AI Voice · OMLX"
            className="hidden items-center gap-1.5 border border-border bg-card px-2 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:inline-flex"
          >
            <Mic className="h-3.5 w-3.5 text-primary" />
            <span>AI Voice</span>
          </button>

          {sessionUser ? (
            <div className="hidden items-center sm:flex">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label="Account menu"
                    className="inline-flex items-center gap-1.5 border border-border bg-card px-2 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <UserCircle2 className="h-3.5 w-3.5 text-primary" />
                    <span className="uppercase tracking-[0.16em]">{sessionUser.role || 'ADMIN'}</span>
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-[10rem]">
                  <div className="px-2 py-1.5 text-xs text-muted-foreground">
                    {sessionUser.name || sessionUser.username || 'Administrator'}
                  </div>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={handleLogout} className="gap-2">
                    <LogOut className="h-3.5 w-3.5" />
                    Sign out
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ) : (
            <Link href="/login" className="hidden sm:inline-flex items-center gap-1.5 border border-border bg-card px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-secondary">
              <ShieldCheck className="h-3.5 w-3.5" />
              Sign in
            </Link>
          )}

          <ThemeToggle />
          {/* Hamburger (< md) */}
          <button
            type="button"
            aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={mobileOpen}
            aria-controls="mobile-nav"
            onClick={() => setMobileOpen((o) => !o)}
            className="md:hidden p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </div>

      {/* Mobile menu (< md) — slide-down panel. Active = vermilion left rule. */}
      {mobileOpen && (
        <div
          id="mobile-nav"
          className="md:hidden border-t border-border bg-background animate-in slide-in-from-top-2 fade-in-0"
        >
          <nav className="flex flex-col gap-0.5 px-4 py-3" aria-label="Mobile">
            {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
              const active = isActive(href);
              return (
                <Link
                  key={href}
                  href={href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex items-center gap-3 px-3 py-2.5 text-sm font-medium transition-colors border-l-2',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    active
                      ? 'border-l-primary bg-card text-foreground'
                      : 'border-l-transparent text-muted-foreground hover:bg-secondary/40 hover:text-foreground',
                  )}
                >
                  <Icon className="h-4 w-4" />
                  <span>{label}</span>
                </Link>
              );
            })}
            {sessionUser ? (
              <>
                <div className="mt-2 flex items-center gap-2 border border-border bg-card px-3 py-2 text-sm text-foreground">
                  <UserCircle2 className="h-4 w-4 text-primary" />
                  <span>{sessionUser.name || sessionUser.username || 'Administrator'}</span>
                  <span className="ml-auto uppercase text-[10px] tracking-[0.16em] text-primary">{sessionUser.role || 'ADMIN'}</span>
                </div>
                <button
                  type="button"
                  onClick={handleLogout}
                  className="mt-1 flex items-center gap-3 px-3 py-2.5 text-sm font-medium text-muted-foreground hover:bg-secondary/40 hover:text-foreground border-l-2 border-l-transparent"
                >
                  <LogOut className="h-4 w-4" />
                  <span>Sign out</span>
                </button>
              </>
            ) : (
              <Link
                href="/login"
                className="mt-2 flex items-center gap-3 px-3 py-2.5 text-sm font-medium text-muted-foreground hover:bg-secondary/40 hover:text-foreground border-l-2 border-l-transparent"
              >
                <ShieldCheck className="h-4 w-4" />
                <span>Sign in</span>
              </Link>
            )}
          </nav>
        </div>
      )}
    </header>
  );
}
