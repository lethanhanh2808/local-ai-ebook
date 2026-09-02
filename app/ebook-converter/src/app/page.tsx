// src/app/page.tsx — Dashboard (home)
//
// Focused, single-screen overview. Four sections only:
//   1. Welcome bar (greeting + inline stats + 2 quick actions + worker pill
//      + active-job pill + read-today streak + AI provider chip)
//   2. Continue reading (the main focal point)
//   3. Recently read (what you've been opening lately)
//   4. Recently added (compact list)
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
  Activity, Server, ListChecks, Calendar,
} from 'lucide-react';
import { buttonClasses } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/layout/PageHeader';
import { EmptyState, LoadingSkeleton } from '@/components/layout/EmptyState';
import { ErrorState } from '@/components/layout/ErrorState';
import { cn, formatDate } from '@/lib/utils';
import type { BookSummary } from '@/components/library/BookCard';

interface Stats {
  total: number;
  reading: number;
  read: number;
  favorites: number;
  /** Number of books opened today (Book.lastRead within the local day). */
  readToday: number;
}

interface WorkerStatus {
  online: boolean;
  lastSeenAt: string | null;
  redis: boolean;
  counts: {
    pending: number;
    queued: number;
    processing: number;
    completed: number;
    failed: number;
  };
  recommendation: string | null;
}

export default function Dashboard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [continueReading, setContinueReading] = useState<BookSummary[]>([]);
  const [recentlyRead, setRecentlyRead] = useState<BookSummary[]>([]);
  const [recent, setRecent] = useState<BookSummary[]>([]);
  const [aiProvider, setAiProvider] = useState<string>('omlx-local');
  const [worker, setWorker] = useState<WorkerStatus | null>(null);
  const [lastSyncAt, setLastSyncAt] = useState<Date | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Fan out in parallel: library, settings, worker status. Each is
      // independently best-effort — a failed settings fetch or a missing
      // worker endpoint must not blank the whole Dashboard.
      const [booksRes, settingsRes, workerRes] = await Promise.all([
        fetch('/api/library?limit=200'),
        fetch('/api/settings').catch(() => null),
        fetch('/api/worker/status').catch(() => null),
      ]);
      if (!booksRes.ok) throw new Error(`Không thể tải thư viện (HTTP ${booksRes.status})`);
      const books = await booksRes.json() as unknown;
      if (!Array.isArray(books)) throw new Error('Phản hồi thư viện không hợp lệ.');
      const settings = settingsRes && settingsRes.ok
        ? await settingsRes.json() as { aiProvider?: string }
        : { aiProvider: 'omlx-local' };
      const workerData: WorkerStatus | null = workerRes && workerRes.ok
        ? await workerRes.json() as WorkerStatus
        : null;

      const typedBooks = books as BookSummary[];
      const total = typedBooks.length;
      const read = typedBooks.filter((b) => b.readStatus === 'read').length;
      const readingCount = typedBooks.filter((b) => b.readStatus === 'reading').length;
      const favorites = typedBooks.filter((b) => b.isFavorite).length;

      // Books the user opened today (local calendar day, not UTC). Cheap to
      // compute from the already-loaded list — no extra fetch.
      const startOfToday = new Date();
      startOfToday.setHours(0, 0, 0, 0);
      const readToday = typedBooks.filter((b) => {
        if (!b.lastRead) return false;
        const t = new Date(b.lastRead).getTime();
        return t >= startOfToday.getTime();
      }).length;

      // Continue reading: progress 1-99%, sorted desc
      const inProgress = typedBooks
        .filter((b) => b.readProgress > 0 && b.readProgress < 100)
        .sort((a, b) => b.readProgress - a.readProgress)
        .slice(0, 4);

      // Recently READ (not added) — drives engagement. Excludes books never
      // opened. Falls back to "Continue reading" when the user hasn't opened
      // anything yet, so the section never looks empty if there IS reading
      // activity to show.
      const recentlyOpened = [...typedBooks]
        .filter((b) => b.lastRead)
        .sort((a, b) => new Date(b.lastRead!).getTime() - new Date(a.lastRead!).getTime())
        .slice(0, 5);
      const recentReadList = recentlyOpened.length > 0 ? recentlyOpened : inProgress.slice(0, 5);

      // Recently added (latest 6)
      const recentBooks = [...typedBooks]
        .sort((a, b) => new Date(b.addedAt).getTime() - new Date(a.addedAt).getTime())
        .slice(0, 6);

      setStats({ total, reading: readingCount, read, favorites, readToday });
      setContinueReading(inProgress);
      setRecentlyRead(recentReadList);
      setRecent(recentBooks);
      setAiProvider(settings.aiProvider ?? 'omlx-local');
      setWorker(workerData);
      setLastSyncAt(new Date());
    } catch (e) {
      setStats(null);
      setContinueReading([]);
      setRecentlyRead([]);
      setRecent([]);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // Convenience: number of jobs currently queued/processing (the ones the
  // user is actively waiting on). Surfaces as a pill on the welcome bar.
  const activeJobCount = worker
    ? worker.counts.processing + worker.counts.queued + worker.counts.pending
    : 0;
  const showActiveJobPill = activeJobCount > 0;

  useEffect(() => { void load(); }, [load]);

  // Light tick: refresh the "Cập nhật X trước" footer label every 30s so it
  // stays accurate while the user lingers on the Dashboard. We bump a
  // counter rather than mutate Date so React re-renders; cheap, no-op fetch.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 30_000);
    return () => window.clearInterval(id);
  }, []);

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
                {error
                  ? 'Không thể tải tổng quan thư viện.'
                  : stats
                  ? `Thư viện có ${stats.total} cuốn sách${stats.reading ? `, đang đọc dở ${stats.reading} cuốn` : ''}.`
                  : 'Đang tải thư viện…'}
              </p>
            </div>
            <div className="flex flex-wrap gap-2 shrink-0">
              <Link href="/convert" className={buttonClasses()}>
                <Upload className="h-4 w-4 mr-1.5" /> Thêm sách
              </Link>
              <Link href="/library" className={buttonClasses({ variant: 'outline' })}>
                <Library className="h-4 w-4 mr-1.5" /> Mở thư viện
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
            <InlineStat
              icon={<Calendar className="h-3.5 w-3.5" />}
              label="Hôm nay"
              value={stats?.readToday}
              tone={stats && stats.readToday > 0 ? 'success' : 'primary'}
              loading={loading}
            />
            <div className="ml-auto flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
              {/* Worker pill — surfaces pipeline health at a glance. The pill
                  is hidden entirely while we're still loading to avoid
                  flashing "offline" before the request completes. */}
              {worker !== null && (
                <WorkerPill worker={worker} />
              )}
              {/* Active-job pill — only appears when something is cooking.
                  Links to /convert where the JobList component renders the
                  live queue with per-job progress, cancel, and download. */}
              {showActiveJobPill && worker && (
                <Link
                  href="/convert"
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-primary/30 bg-primary/10 text-primary hover:bg-primary/15 transition-colors"
                  title={worker.counts.processing > 0
                    ? `Đang xử lý ${worker.counts.processing} job`
                    : `${activeJobCount} job đang chờ`}
                >
                  <Loader2 className="h-3 w-3 animate-spin" />
                  <span className="font-semibold tabular-nums">{activeJobCount}</span>
                  <span>job đang chạy</span>
                </Link>
              )}
              <span className="inline-flex items-center gap-1">
                <Sparkles className="h-3 w-3" />
                <span>AI: {providerLabel[aiProvider] ?? aiProvider}</span>
              </span>
              <Link href="/settings" className="text-primary hover:underline">Cài đặt</Link>
            </div>
          </div>
        </div>
        <div className="absolute -right-12 -top-12 h-40 w-40 rounded-full bg-primary/10 blur-3xl pointer-events-none" />
        <div className="absolute -right-24 -bottom-12 h-48 w-48 rounded-full bg-primary/5 blur-3xl pointer-events-none" />
      </section>

      {error ? (
        <ErrorState title="Không thể tải dashboard" message={error} details={error} onRetry={() => void load()} retrying={loading} />
      ) : (
      <>
      {/* ── 2. Continue reading (the main focal point) ───────────────────── */}
      <section>
        <PageHeader
          eyebrow="Tiếp tục"
          title="Đang đọc dở"
          icon={<Clock className="h-4 w-4" />}
          actions={
            continueReading.length > 0 && (
              <Link href="/library?status=reading" className={buttonClasses({ size: 'sm', variant: 'ghost' })}>
                Xem tất cả <ArrowRight className="h-3.5 w-3.5 ml-1" />
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
                ? <Link href="/library" className={buttonClasses({ size: 'sm', variant: 'outline' })}><Library className="h-3.5 w-3.5 mr-1.5" />Mở thư viện</Link>
                : <Link href="/convert" className={buttonClasses({ size: 'sm' })}><Upload className="h-3.5 w-3.5 mr-1.5" />Upload sách đầu tiên</Link>
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

      {/* ── 3. Recently read (what you've been opening lately) ───────────── */}
      <section>
        <PageHeader
          eyebrow="Hoạt động"
          title="Vừa đọc"
          icon={<Activity className="h-4 w-4" />}
          actions={
            recentlyRead.length > 0 && (
              <Link href="/stats" className={buttonClasses({ size: 'sm', variant: 'ghost' })}>
                Xem thống kê <ArrowRight className="h-3.5 w-3.5 ml-1" />
              </Link>
            )
          }
        />
        {loading ? (
          <LoadingSkeleton rows={1} />
        ) : recentlyRead.length === 0 ? (
          <EmptyState
            icon={<BookOpen className="h-6 w-6" />}
            title="Chưa có hoạt động đọc"
            hint="Mở một cuốn sách và bắt đầu đọc — lịch sử sẽ xuất hiện ở đây."
          />
        ) : (
          <ul className="divide-y divide-border rounded-xl border border-border bg-card overflow-hidden">
            {recentlyRead.map((book) => (
              <RecentlyReadRow key={book.id} book={book} />
            ))}
          </ul>
        )}
      </section>

      {/* ── 4. Recently added (compact horizontal scroll on mobile) ──────── */}
      <section>
        <PageHeader
          eyebrow="Mới"
          title="Thêm gần đây"
          icon={<Plus className="h-4 w-4" />}
          actions={
            recent.length > 0 && (
              <Link href="/library" className={buttonClasses({ size: 'sm', variant: 'ghost' })}>
                Xem tất cả <ArrowRight className="h-3.5 w-3.5 ml-1" />
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
              <Link href="/convert" className={buttonClasses({ size: 'sm' })}>
                <Upload className="h-3.5 w-3.5 mr-1.5" />Upload ngay
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
      </>
      )}

      {/* Footer with quick links */}
      <footer className="mt-8 border-t border-border pt-5 flex flex-wrap items-center justify-end gap-2 sm:gap-3">
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className={cn(
            'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors',
            'border border-border bg-background hover:bg-muted hover:border-primary/30',
            'disabled:opacity-60 disabled:cursor-not-allowed',
          )}
          title="Tải lại số liệu từ server"
        >
          {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          <span>Làm mới</span>
        </button>
        <span className="hidden sm:inline-block h-4 w-px bg-border" aria-hidden />
        <Link
          href="/shelves"
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          Shelves
        </Link>
        <Link
          href="/stats"
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          Thống kê
        </Link>
        <Link
          href="/settings"
          className="text-xs text-muted-foreground hover:text-foreground transition-colors inline-flex items-center gap-1"
        >
          <SettingsIcon className="h-3 w-3" />
          <span>Settings</span>
        </Link>
      </footer>
    </div>
  );
}

// Compact, human-readable "X ago" formatter for the footer sync indicator.
// Keeps re-renders cheap — just reads lastSyncAt once per minute, no timer.
function timeSince(date: Date): string {
  const sec = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (sec < 5) return 'vừa xong';
  if (sec < 60) return `${sec} giây trước`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} phút trước`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} giờ trước`;
  return date.toLocaleDateString();
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
          <img src={`/api/library/${book.id}/cover?v=${book.updatedAt ? new Date(book.updatedAt).getTime() : 0}`} alt={book.title} className="h-full w-full object-cover"
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
          <img src={`/api/library/${book.id}/cover?v=${book.updatedAt ? new Date(book.updatedAt).getTime() : 0}`} alt={book.title} className="h-full w-full object-cover"
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

// ── Worker status pill ────────────────────────────────────────────────────
// Shows pipeline health right on the Dashboard. Green = online, amber =
// processing but Redis missing, red = worker offline (with a "how to fix"
// hint in the title attribute).
function WorkerPill({ worker }: { worker: WorkerStatus }) {
  const hasFailed = worker.counts.failed > 0;
  let bgClass = 'bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/30';
  let icon = <Server className="h-3 w-3" />;
  let label = 'Worker online';
  let title = 'Worker đang chạy — sẵn sàng xử lý job.';

  if (!worker.online && !worker.redis) {
    bgClass = 'bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/30';
    label = 'Worker + Redis offline';
    title = worker.recommendation ?? 'Redis không khả dụng. Kiểm tra `redis-server` đang chạy.';
  } else if (!worker.online) {
    bgClass = 'bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30';
    label = 'Worker offline';
    title = worker.recommendation ?? 'Worker không chạy. Khởi động worker để xử lý conversion / audiobook.';
  } else if (hasFailed) {
    bgClass = 'bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30';
    label = `${worker.counts.failed} job lỗi`;
    title = `${worker.counts.failed} job thất bại gần đây. Mở /jobs để xem chi tiết.`;
  }

  return (
    <Link
      href="/convert"
      className={cn(
        'inline-flex items-center gap-1 px-2 py-0.5 rounded-full border transition-colors hover:opacity-80',
        bgClass,
      )}
      title={title}
    >
      {icon}
      <span className="font-semibold">{label}</span>
    </Link>
  );
}

// ── Recently-read row (compact list item) ────────────────────────────────
// Denser than a card — fits 5 items in a single column without scrolling.
// Progress dot on the left indicates how far through the book the user is.
function RecentlyReadRow({ book }: { book: BookSummary }) {
  return (
    <li>
      <Link
        href={`/library/${book.id}/read`}
        className="flex items-center gap-3 px-3 py-2.5 hover:bg-muted/40 transition-colors group"
      >
        <div className="relative h-10 w-7 shrink-0 rounded overflow-hidden bg-muted ring-1 ring-border">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/api/library/${book.id}/cover?v=${book.updatedAt ? new Date(book.updatedAt).getTime() : 0}`}
            alt={book.title}
            className="h-full w-full object-cover"
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
          />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium truncate group-hover:text-primary transition-colors">
            {book.title}
          </p>
          <p className="text-[11px] text-muted-foreground truncate">
            {book.author || 'Tác giả không rõ'}
            {book.lastRead && (
              <>
                <span className="mx-1">·</span>
                <span>{relativeLastRead(book.lastRead)}</span>
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <div className="hidden sm:flex items-center gap-1.5 text-[10px] text-muted-foreground tabular-nums">
            <ListChecks className="h-3 w-3" />
            <span>{Math.round(book.readProgress)}%</span>
          </div>
          <ArrowRight className="h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
        </div>
      </Link>
    </li>
  );
}

// Compact "X ago" for the recently-read list. Heavier than `timeSince`
// because it surfaces "yesterday" semantics that matter when scanning
// recent activity.
function relativeLastRead(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const diff = Date.now() - t;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'vừa đọc';
  if (min < 60) return `${min} phút trước`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} giờ trước`;
  const day = Math.floor(hr / 24);
  if (day === 1) return 'hôm qua';
  if (day < 7) return `${day} ngày trước`;
  const wk = Math.floor(day / 7);
  if (wk < 5) return `${wk} tuần trước`;
  return new Date(iso).toLocaleDateString();
}
