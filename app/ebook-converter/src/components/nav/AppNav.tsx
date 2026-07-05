// src/components/nav/AppNav.tsx
// Top navigation for the Ebook Manager app.
// Brand is "Ebook Manager". Sections: Dashboard, Convert, Library, Shelves, Stats, Settings.
'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { BookOpen, LayoutDashboard, BookMarked, BarChart3, Sparkles, Library, Upload, Settings as SettingsIcon } from 'lucide-react';
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

  return (
    <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
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

        {/* Nav */}
        <nav className="flex items-center gap-0.5 ml-2">
          {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
            const active = href === '/' ? pathname === '/' : pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                className={cn(
                  'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                  active
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                <Icon className="h-4 w-4" />
                <span className="hidden md:inline">{label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <ServiceHealth className="hidden sm:inline-flex" />
          <span className="hidden sm:flex items-center gap-1.5 rounded-full bg-primary/10 px-2.5 py-0.5 text-xs text-primary font-medium">
            <Sparkles className="h-3 w-3" />
            AI · VieNeu · OMLX
          </span>
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
