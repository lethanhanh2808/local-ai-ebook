// src/app/page.tsx — Dashboard (home)
//
// Focused, single-screen overview. Three sections only:
//   1. Welcome bar (greeting + inline stats + 2 quick actions)
//   2. Continue reading (the main focal point)
//   3. Recently added (compact list)
//
// Heavy features moved to their own pages:
//   - Upload / conversion → /convert
//   - Settings / AI providers → /settings
//   - Full library → /library
//   - Shelves, stats → /shelves, /stats
'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  BookOpen, Library, Upload, ArrowRight, BookCheck, Clock,
  Flame, Sparkles, Plus, RefreshCw, Loader2, Settings as SettingsIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/layout/PageHeader';
import { EmptyState, LoadingSkeleton } from '@/components/layout/EmptyState';
import { cn, formatBytes, formatDate } from '@/lib/utils';
import type { BookSummary } from '@/components/library/BookCard';

interface Stats {
  total: number;
  reading: number;
  read: number;
  favorites: number;
}

export default function Dashboard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [continueReading, setContinueReading] = useState<BookSummary[]>([]);
  const [recent, setRecent] = useState<BookSummary[]>([]);
  const [aiProvider, setAiProvider] = useState<string>('omlx-local');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [books, settings] = await Promise.all([
        fetch('/api/library?limit=200').then((r) => r.json()).catch(() => []) as Promise<BookSummary[]>,
        fetch('/api/settings').then((r) => r.json()).catch(() => ({ aiProvider: 'omlx-local' })),
      ]);
      const total = books.length;
      const read = books.filter((b) => b.readStatus === 'read').length;
      const readingCount = books.filter((b) => b.readStatus === 'reading').length;
      const favorites = books.filter((b) => b.isFavorite).length;

      // Continue reading: progress 1-99%, sorted desc
      const inProgress = books
        .filter((b) => b.readProgress > 0 && b.readProgress < 100)
        .sort((a, b) => b.readProgress - a.readProgress)
        .slice(0, 4);

      // Recently added (latest 6)
      const recentBooks = [...books]
        .sort((a, b) => new Date(b.addedAt).getTime() - new Date(a.addedAt).getTime())
        .slice(0, 6);

      setStats({ total, reading: readingCount, read, favorites });
      setContinueReading(inProgress);
      setRecent(recentBooks);
      setAiProvider(settings.aiProvider ?? 'omlx-local');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const providerLabel: Record<string, string> = {
    'omlx-local': 'OMLX local',
    'minimax-cloud': 'MiniMax',
    'openai': 'OpenAI',
    'custom': 'Custom',
  };

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:py-8 space-y-6">
      {/* ── 1. Welcome bar (compact, single row) ─────────────────────────── */}
      <section className="relative overflow-hidden rounded-2xl border border-border bg-gradient-to-br from-primary/8 via-primary/3 to-transparent p-5 sm:p-6">
        <div className="relative z-10 flex flex-col gap-4">
          {/* Top row: greeting + actions */}
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <Sparkles className="h-3.5 w-3.5 text-primary" />
                <span className="text-[10px] font-bold uppercase tracking-widest text-primary">
                  Dashboard
                </span>
              </div>
              <h1 className="text-xl sm:text-2xl font-bold tracking-tight">
                Chào mừng trở lại 👋
              </h1>
              <p className="text-sm text-muted-foreground mt-1">
                {stats
                  ? `Thư viện có ${stats.total} cuốn sách${stats.reading ? `, đang đọc dở ${stats.reading} cuốn` : ''}.`
                  : 'Đang tải thư viện…'}
              </p>
            </div>
            <div className="flex flex-wrap gap-2 shrink-0">
              <Link href="/convert">
                <Button>
                  <Upload className="h-4 w-4 mr-1.5" /> Thêm sách
                </Button>
              </Link>
              <Link href="/library">
                <Button variant="outline">
                  <Library className="h-4 w-4 mr-1.5" /> Mở thư viện
                </Button>
              </Link>
            </div>
          </div>

          {/* Inline stats strip */}
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 pt-3 border-t border-primary/10">
            <InlineStat
              icon={<BookOpen className="h-3.5 w-3.5" />}
              label="Tổng"
              value={stats?.total}
              href="/library"
              loading={loading}
            />
            <InlineStat
              icon={<Clock className="h-3.5 w-3.5" />}
              label="Đang đọc"
              value={stats?.reading}
              tone="warning"
              href="/library?status=reading"
              loading={loading}
            />
            <InlineStat
              icon={<BookCheck className="h-3.5 w-3.5" />}
              label="Đã đọc"
              value={stats?.read}
              tone="success"
              href="/library?status=read"
              loading={loading}
            />
            <InlineStat
              icon={<Flame className="h-3.5 w-3.5" />}
              label="Yêu thích"
              value={stats?.favorites}
              tone="danger"
              href="/library?favorites=1"
              loading={loading}
            />
            <div className="ml-auto flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <Sparkles className="h-3 w-3" />
              <span>AI: {providerLabel[aiProvider] ?? aiProvider}</span>
              <Link href="/settings" className="ml-1 text-primary hover:underline">Cài đặt</Link>
            </div>
          </div>
        </div>
        <div className="absolute -right-12 -top-12 h-40 w-40 rounded-full bg-primary/10 blur-3xl pointer-events-none" />
        <div className="absolute -right-24 -bottom-12 h-48 w-48 rounded-full bg-primary/5 blur-3xl pointer-events-none" />
      </section>

      {/* ── 2. Continue reading (the main focal point) ───────────────────── */}
      <section>
        <PageHeader
          eyebrow="Tiếp tục"
          title="Đang đọc dở"
          icon={<Clock className="h-4 w-4" />}
          actions={
            continueReading.length > 0 && (
              <Link href="/library?status=reading">
                <Button size="sm" variant="ghost">
                  Xem tất cả <ArrowRight className="h-3.5 w-3.5 ml-1" />
                </Button>
              </Link>
            )
          }
        />
        {loading ? (
          <LoadingSkeleton rows={2} />
        ) : continueReading.length === 0 ? (
          <EmptyState
            icon={<BookOpen className="h-6 w-6" />}
            title="Chưa có sách đang đọc dở"
            hint="Mở một cuốn sách từ thư viện và bắt đầu đọc để tiến độ hiển thị ở đây."
            action={
              stats?.total
                ? <Link href="/library"><Button size="sm" variant="outline"><Library className="h-3.5 w-3.5 mr-1.5" />Mở thư viện</Button></Link>
                : <Link href="/convert"><Button size="sm"><Upload className="h-3.5 w-3.5 mr-1.5" />Upload sách đầu tiên</Button></Link>
            }
          />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {continueReading.map((book) => (
              <ContinueReadingCard key={book.id} book={book} />
            ))}
          </div>
        )}
      </section>

      {/* ── 3. Recently added (compact horizontal scroll on mobile) ──────── */}
      <section>
        <PageHeader
          eyebrow="Mới"
          title="Thêm gần đây"
          icon={<Plus className="h-4 w-4" />}
          actions={
            recent.length > 0 && (
              <Link href="/library">
                <Button size="sm" variant="ghost">
                  Xem tất cả <ArrowRight className="h-3.5 w-3.5 ml-1" />
                </Button>
              </Link>
            )
          }
        />
        {loading ? (
          <LoadingSkeleton rows={2} />
        ) : recent.length === 0 ? (
          <EmptyState
            icon={<Sparkles className="h-6 w-6" />}
            title="Thư viện trống"
            hint="Upload file EPUB, HTML hoặc TXT đầu tiên để bắt đầu xây dựng thư viện."
            action={
              <Link href="/convert">
                <Button size="sm"><Upload className="h-3.5 w-3.5 mr-1.5" />Upload ngay</Button>
              </Link>
            }
          />
        ) : (
          <div className="flex gap-3 overflow-x-auto pb-2 sm:grid sm:grid-cols-3 md:grid-cols-6 sm:overflow-visible sm:pb-0">
            {recent.map((book) => (
              <RecentBookCard key={book.id} book={book} />
            ))}
          </div>
        )}
      </section>

      {/* Footer with quick section links (single row) */}
      <footer className="border-t border-border pt-5 flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>Ebook Manager · OMLX + Vietnamese Voice</span>
        <div className="flex items-center gap-3">
          <Link href="/shelves" className="hover:text-foreground transition-colors">Shelves</Link>
          <Link href="/stats" className="hover:text-foreground transition-colors">Thống kê</Link>
          <Link href="/settings" className="hover:text-foreground transition-colors flex items-center gap-1">
            <SettingsIcon className="h-3 w-3" /> Settings
          </Link>
        </div>
      </footer>
    </div>
  );
}

// ── Inline stat (single row, no card) ─────────────────────────────────────
function InlineStat({
  icon, label, value, tone = 'primary', href, loading,
}: {
  icon: React.ReactNode;
  label: string;
  value: number | undefined;
  tone?: 'primary' | 'success' | 'warning' | 'danger';
  href?: string;
  loading?: boolean;
}) {
  const toneClass = {
    primary: 'text-foreground',
    success: 'text-green-600 dark:text-green-400',
    warning: 'text-amber-600 dark:text-amber-400',
    danger: 'text-rose-600 dark:text-rose-400',
  }[tone];
  const body = (
    <div className="flex items-center gap-2">
      <span className={cn('shrink-0', toneClass)}>{icon}</span>
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">{label}</span>
      <span className={cn('text-base font-bold tabular-nums leading-none', toneClass)}>
        {loading || value === undefined ? '—' : value}
      </span>
    </div>
  );
  if (href) {
    return <Link href={href} className="hover:opacity-70 transition-opacity">{body}</Link>;
  }
  return body;
}

// ── Continue reading card (medium size) ───────────────────────────────────
function ContinueReadingCard({ book }: { book: BookSummary }) {
  return (
    <Link href={`/library/${book.id}/read`} className="block group">
      <Card className="flex flex-col overflow-hidden transition-all hover:bg-muted/30 hover:border-primary/30 h-full">
        {/* Cover */}
        <div className="aspect-[2/3] w-full bg-muted overflow-hidden relative">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`/api/library/${book.id}/cover`} alt={book.title} className="h-full w-full object-cover"
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
          {/* Progress bar overlay */}
          <div className="absolute bottom-0 left-0 right-0 h-1 bg-foreground/15">
            <div className="h-full bg-primary" style={{ width: `${Math.min(100, Math.max(0, book.readProgress))}%` }} />
          </div>
        </div>
        <div className="p-3 flex-1 flex flex-col">
          <p className="text-sm font-semibold truncate group-hover:text-primary transition-colors">{book.title}</p>
          <p className="text-xs text-muted-foreground truncate">{book.author}</p>
          <div className="mt-auto pt-2 flex items-center justify-between text-[10px]">
            <span className="text-muted-foreground tabular-nums font-medium">{book.readProgress}% đã đọc</span>
            <ArrowRight className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
        </div>
      </Card>
    </Link>
  );
}

// ── Recent book card (compact, square-ish) ────────────────────────────────
function RecentBookCard({ book }: { book: BookSummary }) {
  return (
    <Link href={`/library/${book.id}/read`} className="block group shrink-0 w-32 sm:w-auto">
      <Card className="flex flex-col rounded-lg border overflow-hidden transition-all hover:bg-muted/30 hover:border-primary/30">
        <div className="aspect-[2/3] bg-muted overflow-hidden">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`/api/library/${book.id}/cover`} alt={book.title} className="h-full w-full object-cover"
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
        </div>
        <div className="p-2">
          <p className="text-xs font-semibold truncate">{book.title}</p>
          <p className="text-[10px] text-muted-foreground truncate">
            {formatDate(book.addedAt)}
          </p>
        </div>
      </Card>
    </Link>
  );
}
