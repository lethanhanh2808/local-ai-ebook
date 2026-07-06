'use client';
// src/components/library/StatsView.tsx – Reading statistics dashboard
import { useCallback, useEffect, useState } from 'react';
import { BookOpen, CheckCircle2, Clock, Archive, Globe, BarChart3 } from 'lucide-react';
import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { ErrorState } from '@/components/layout/ErrorState';

interface Stats {
  total: number;
  byStatus: Array<{ readStatus: string; _count: number }>;
  byLanguage: Array<{ language: string; _count: number }>;
  recentlyRead: Array<{ id: string; title: string; lastRead: string | null; readProgress: number }>;
}

const STATUS_ICON: Record<string, React.ReactNode> = {
  reading: <BookOpen className="h-5 w-5 text-amber-500" />,
  read: <CheckCircle2 className="h-5 w-5 text-green-500" />,
  unread: <Clock className="h-5 w-5 text-muted-foreground" />,
  archived: <Archive className="h-5 w-5 text-muted-foreground/50" />,
};

const STATUS_COLOR: Record<string, string> = {
  reading: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  read: 'bg-green-500/10 text-green-600 dark:text-green-400',
  unread: 'bg-muted text-muted-foreground',
  archived: 'bg-muted/50 text-muted-foreground/50',
};

const LANG_LABEL: Record<string, string> = { vi: '🇻🇳 Vietnamese', en: '🇺🇸 English', mixed: '🌐 Mixed' };

export function StatsView() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchStats = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch('/api/stats');
      const d = await r.json();
      setStats(d as Stats);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void fetchStats(); }, [fetchStats]);

  if (loading) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-24 animate-pulse rounded-xl bg-muted" />)}
      </div>
    );
  }

  if (error) {
    return (
      <ErrorState
        onRetry={() => void fetchStats()}
        message={error}
        details={String(error)}
        retrying={loading}
      />
    );
  }

  if (!stats) return null;

  const statusMap = Object.fromEntries(stats.byStatus.map((s) => [s.readStatus, s._count]));
  const readPct = stats.total > 0 ? Math.round((statusMap.read ?? 0) / stats.total * 100) : 0;

  return (
    <div className="space-y-6">
      {/* Big number */}
      <Card className="rounded-2xl border border-border p-6 flex items-center gap-6">
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10">
          <BarChart3 className="h-8 w-8 text-primary" />
        </div>
        <div>
          <p className="text-4xl font-bold">{stats.total}</p>
          <p className="text-sm text-muted-foreground">Total books in library</p>
          <div className="mt-2 h-2 w-48 rounded-full bg-muted overflow-hidden">
            <div className="h-full bg-green-500 rounded-full transition-all" style={{ width: `${readPct}%` }} />
          </div>
          <p className="text-xs text-muted-foreground mt-1">{readPct}% read</p>
        </div>
      </Card>

      {/* Status breakdown */}
      <div>
        <h2 className="text-sm font-semibold text-muted-foreground mb-3 uppercase tracking-wide">By Reading Status</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {(['unread', 'reading', 'read', 'archived'] as const).map((s) => (
            <div key={s} className="p-4 flex items-center gap-3">
              {STATUS_ICON[s]}
              <div>
                <p className="text-xl font-bold">{statusMap[s] ?? 0}</p>
                <p className={`text-xs px-1.5 py-0.5 rounded-full font-medium capitalize inline-block mt-0.5 ${STATUS_COLOR[s]}`}>{s}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Language breakdown */}
      <div>
        <h2 className="text-sm font-semibold text-muted-foreground mb-3 uppercase tracking-wide">By Language</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          {stats.byLanguage.map((l) => (
            <div key={l.language} className="p-4 flex items-center gap-3">
              <Globe className="h-5 w-5 text-primary/70" />
              <div>
                <p className="text-xl font-bold">{l._count}</p>
                <p className="text-xs text-muted-foreground">{LANG_LABEL[l.language] ?? l.language}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Recently read */}
      {stats.recentlyRead.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-muted-foreground mb-3 uppercase tracking-wide">Recently Read</h2>
          <Card className="rounded-xl border border-border divide-y">
            {stats.recentlyRead.map((b) => (
              <Link key={b.id} href={`/library/${b.id}/read`} className="flex items-center gap-4 px-4 py-3 hover:bg-muted/50 transition-colors">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{b.title}</p>
                  <p className="text-xs text-muted-foreground">
                    {b.lastRead ? new Date(b.lastRead).toLocaleDateString() : ''}
                  </p>
                </div>
                <div className="shrink-0 flex items-center gap-2">
                  <div className="h-1.5 w-20 rounded-full bg-muted overflow-hidden">
                    <div className="h-full bg-primary rounded-full" style={{ width: `${b.readProgress}%` }} />
                  </div>
                  <span className="text-xs text-muted-foreground w-8 text-right">{b.readProgress}%</span>
                </div>
              </Link>
            ))}
          </Card>
        </div>
      )}

      {/* OPDS link */}
      <div className="rounded-xl border border-border bg-muted/30 p-4">
        <h2 className="text-sm font-semibold mb-1">OPDS Catalog</h2>
        <p className="text-xs text-muted-foreground mb-2">Connect your e-reader app (Koreader, Kindle, etc.) using the OPDS feed URL:</p>
        <code className="block rounded-lg bg-background border border-border px-3 py-2 text-xs font-mono text-primary select-all">
          {typeof window !== 'undefined' ? window.location.origin : ''}/api/opds
        </code>
      </div>
    </div>
  );
}
