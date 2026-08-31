'use client';
// src/components/library/BookGrid.tsx – Library with grid/list/compact view modes
import { useEffect, useState, useCallback } from 'react';
import { BookCard, BookSummary } from './BookCard';
import {
  Search, BookOpen, Heart, Filter, LayoutGrid, List, LayoutList,
  Star, Download, Trash2, BookMarked, Plus, ImagePlus, Loader2
} from 'lucide-react';
import { cn, formatDate } from '@/lib/utils';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { useToast } from '@/components/ui/toast';
import { EmptyState, LoadingSkeleton } from '@/components/layout/EmptyState';
import { ErrorState } from '@/components/layout/ErrorState';

type ViewMode = 'grid' | 'compact' | 'list';

const READ_STATUS_OPTS = [
  { value: '', label: 'All' },
  { value: 'unread', label: 'Unread' },
  { value: 'reading', label: 'Reading' },
  { value: 'read', label: 'Read' },
  { value: 'archived', label: 'Archived' },
];

const STATUS_COLOR: Record<string, string> = {
  read:     'bg-green-500/15 text-green-700 dark:text-green-400',
  reading:  'bg-blue-500/15 text-blue-700 dark:text-blue-400',
  unread:   'bg-muted text-muted-foreground',
  archived: 'bg-muted/50 text-muted-foreground/60',
};

function formatBytes(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1048576).toFixed(1)} MB`;
}

function loadViewMode(): ViewMode {
  try { return (localStorage.getItem('library-view') as ViewMode) ?? 'grid'; } catch { return 'grid'; }
}
function saveViewMode(v: ViewMode) {
  try { localStorage.setItem('library-view', v); } catch { /**/ }
}

// ─── List view row ────────────────────────────────────────────────────────────
function BookListRow({
  book,
  onDelete,
  onUpdate,
}: {
  book: BookSummary;
  onDelete: (id: string) => void;
  onUpdate: (b: BookSummary) => void;
}) {
  const toast = useToast();
  const coverUrl = `/api/library/${book.id}/cover`;
  const starRating = book.rating ? Math.round(book.rating / 2) : 0;

  const handleStatusChange = async (readStatus: string) => {
    try {
      const res = await fetch(`/api/library/${book.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ readStatus }),
      });
      if (!res.ok) throw new Error(`Update failed (HTTP ${res.status})`);
      onUpdate(await res.json() as BookSummary);
    } catch (e) {
      toast.error('Could not update reading status', { description: e instanceof Error ? e.message : String(e) });
    }
  };

  const handleDelete = () => {
    toast.confirm({
      title: `Remove "${book.title}"?`,
      confirmLabel: 'Remove',
      destructive: true,
      onConfirm: async () => {
        try {
          const res = await fetch(`/api/library/${book.id}`, { method: 'DELETE' });
          if (!res.ok) throw new Error(`Remove failed (HTTP ${res.status})`);
          onDelete(book.id);
          toast.success('Removed', { description: book.title });
        } catch (e) {
          toast.error('Failed to remove', { description: e instanceof Error ? e.message : String(e) });
        }
      },
    });
  };

  const [generatingCover, setGeneratingCover] = useState(false);
  const handleGenerateCover = async () => {
    setGeneratingCover(true);
    try {
      const res = await fetch(`/api/library/${book.id}/cover/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: true }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `Cover generation failed (HTTP ${res.status})`);
      onUpdate({ ...book, hasCover: true, coverPath: `/api/library/${book.id}/cover` });
      toast.success('Cover updated', { description: book.title });
    } catch (e) {
      toast.error('Cover generation failed', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setGeneratingCover(false);
    }
  };

  return (
    <Card className="flex items-center gap-3 rounded-xl border border-border p-3 hover:bg-muted/30 transition-colors group">
      {/* Cover */}
      <div className="relative h-16 w-11 shrink-0 overflow-hidden rounded bg-muted">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={coverUrl} alt={book.title} className="h-full w-full object-fill"
          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
        {!book.hasCover && (
          <button
            type="button"
            onClick={handleGenerateCover}
            disabled={generatingCover}
            title="Generate a cover for this book"
            aria-label={`Generate cover for ${book.title}`}
            className="absolute inset-0 flex items-center justify-center bg-black/55 text-[8px] font-semibold text-white hover:bg-black/70 transition-colors disabled:opacity-60"
          >
            {generatingCover ? <Loader2 className="h-3 w-3 animate-spin" /> : <ImagePlus className="h-3 w-3" />}
          </button>
        )}
        {generatingCover && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/60">
            <Loader2 className="h-4 w-4 animate-spin text-white" />
          </div>
        )}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0 space-y-0.5">
        <div className="flex items-start gap-2 min-w-0">
          <p className="text-sm font-semibold truncate flex-1">{book.title}</p>
          {book.isFavorite && <Heart className="h-3.5 w-3.5 shrink-0 fill-rose-500 text-rose-500 mt-0.5" />}
        </div>
        <p className="text-xs text-muted-foreground truncate">{book.author}</p>
        {book.series && (
          <p className="text-[10px] text-primary/70 italic truncate">
            {book.series}{book.seriesIndex != null ? ` #${book.seriesIndex}` : ''}
          </p>
        )}
        <div className="flex items-center flex-wrap gap-1.5 mt-1">
          <Badge className="border border-border text-[9px] px-1.5 h-4 py-0">{book.language.toUpperCase()}</Badge>
          <span className={cn('rounded-full px-1.5 py-0.5 text-[9px] font-medium', STATUS_COLOR[book.readStatus] ?? STATUS_COLOR.unread)}>
            {book.readStatus}
          </span>
          {starRating > 0 && (
            <div className="flex gap-0.5">
              {Array.from({length: 5}, (_, i) => (
                <Star key={i} className={cn('h-2.5 w-2.5', i < starRating ? 'fill-amber-400 text-amber-400' : 'text-muted-foreground/20')} />
              ))}
            </div>
          )}
          {book.readProgress > 0 && (
            <span className="text-[9px] text-muted-foreground">{book.readProgress}%</span>
          )}
          <span className="text-[9px] text-muted-foreground/60">{formatBytes(book.fileSize)}</span>
        </div>
      </div>

      {/* Status quick toggle */}
      <div className="hidden sm:flex gap-0.5 shrink-0">
        {(['unread', 'reading', 'read'] as const).map((s) => (
          <button key={s} type="button" onClick={() => handleStatusChange(s)} aria-pressed={book.readStatus === s}
            className={cn('rounded px-2 py-1 text-[9px] font-medium capitalize transition-colors',
              book.readStatus === s ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-muted/80'
            )}>{s}</button>
        ))}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1 shrink-0 opacity-100 transition-opacity lg:opacity-0 lg:group-hover:opacity-100 group-focus-within:opacity-100">
        <Link
          href={`/library/${book.id}/read`}
          className="flex items-center gap-1 rounded-md bg-primary px-2.5 py-1.5 text-[11px] font-medium text-primary-foreground hover:bg-primary/90"
        >
          <BookOpen className="h-3 w-3" /> Read
        </Link>
        <a href={`/api/library/${book.id}/download`} download
          aria-label={`Download ${book.title}`}
          className="flex h-8 w-8 items-center justify-center rounded-md border border-border hover:bg-muted transition-colors">
          <Download className="h-3.5 w-3.5" />
        </a>
        <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-destructive hover:bg-destructive/10" onClick={handleDelete}>
          <span className="sr-only">Remove {book.title}</span>
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </Card>
  );
}

// ─── Main BookGrid ────────────────────────────────────────────────────────────
export function BookGrid() {
  const [books, setBooks] = useState<BookSummary[]>([]);
  const [search, setSearch] = useState('');
  const [lang, setLang] = useState('');
  const [readStatus, setReadStatus] = useState('');
  const [isFavorite, setIsFavorite] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [filtersReady, setFiltersReady] = useState(false);
  const [debouncedSearch, setDebouncedSearch] = useState('');

  useEffect(() => { setViewMode(loadViewMode()); }, []);

  // Dashboard links and browser history can pre-populate library filters.
  useEffect(() => {
    const applyUrl = () => {
      const params = new URLSearchParams(window.location.search);
      const nextSearch = params.get('search') ?? params.get('q') ?? '';
      setSearch(nextSearch);
      setDebouncedSearch(nextSearch.trim());
      setLang(params.get('language') ?? '');
      setReadStatus(params.get('readStatus') ?? params.get('status') ?? '');
      setIsFavorite(params.get('isFavorite') === 'true' || params.get('favorites') === '1');
      setFiltersReady(true);
    };
    applyUrl();
    window.addEventListener('popstate', applyUrl);
    return () => window.removeEventListener('popstate', applyUrl);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  // Keep the current view shareable without adding a history entry per keystroke.
  useEffect(() => {
    if (!filtersReady) return;
    const params = new URLSearchParams();
    if (search.trim()) params.set('search', search.trim());
    if (lang) params.set('language', lang);
    if (readStatus) params.set('status', readStatus);
    if (isFavorite) params.set('favorites', '1');
    const query = params.toString();
    window.history.replaceState(null, '', query ? `/library?${query}` : '/library');
  }, [filtersReady, isFavorite, lang, readStatus, search]);

  const fetchBooks = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (debouncedSearch) params.set('search', debouncedSearch);
      if (lang)   params.set('language', lang);
      if (readStatus) params.set('readStatus', readStatus);
      if (isFavorite) params.set('isFavorite', 'true');
      const res = await fetch(`/api/library?${params}`, { signal });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `Không thể tải thư viện (HTTP ${res.status})`);
      }
      const data = await res.json() as unknown;
      if (!Array.isArray(data)) throw new Error('Phản hồi thư viện không hợp lệ.');
      setBooks(data as BookSummary[]);
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [debouncedSearch, lang, readStatus, isFavorite]);

  useEffect(() => {
    if (!filtersReady) return;
    const controller = new AbortController();
    void fetchBooks(controller.signal);
    return () => controller.abort();
  }, [fetchBooks, filtersReady]);

  const handleDelete = (id: string) => setBooks((prev) => prev.filter((b) => b.id !== id));
  const handleUpdate = (updated: BookSummary) => setBooks((prev) => prev.map((b) => b.id === updated.id ? updated : b));
  const handleEnhanced = (newBook: BookSummary) => setBooks((prev) => [newBook, ...prev]);

  const setView = (v: ViewMode) => { setViewMode(v); saveViewMode(v); };
  const clearFilters = () => {
    setSearch('');
    setLang('');
    setReadStatus('');
    setIsFavorite(false);
  };
  const hasFilters = Boolean(search || lang || readStatus || isFavorite);

  const VIEW_ICONS = [
    { id: 'grid' as ViewMode, icon: LayoutGrid, label: 'Grid' },
    { id: 'compact' as ViewMode, icon: LayoutList, label: 'Compact' },
    { id: 'list' as ViewMode, icon: List, label: 'List' },
  ];

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap gap-2 items-center">
        {/* Search */}
        <div className="relative flex-1 min-w-40">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          <Input
            type="search" placeholder="Search title, author, series…"
            value={search} onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
            aria-label="Search library"
          />
        </div>

        {/* Language — Radix Select reserves "" for "clear selection / placeholder",
            so the "All languages" sentinel is "all" instead. We translate back to
            the empty string when sending to the API and when filtering locally. */}
        <Select value={lang || 'all'} onValueChange={(v) => setLang(v === 'all' ? '' : v)}>
          <SelectTrigger className="w-[160px]" aria-label="Filter by language">
            <SelectValue placeholder="All languages" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All languages</SelectItem>
            <SelectItem value="vi">Vietnamese</SelectItem>
            <SelectItem value="en">English</SelectItem>
            <SelectItem value="mixed">Mixed</SelectItem>
          </SelectContent>
        </Select>

        {/* Status tabs */}
        <div className="flex max-w-full overflow-x-auto rounded-md border border-border" role="group" aria-label="Filter by reading status">
          {READ_STATUS_OPTS.map((opt) => (
            <button key={opt.value} type="button" onClick={() => setReadStatus(opt.value)} aria-pressed={readStatus === opt.value}
              className={cn('px-3 h-9 text-xs font-medium transition-colors border-r border-border last:border-r-0',
                readStatus === opt.value ? 'bg-primary text-primary-foreground' : 'bg-background hover:bg-muted',
              )}>{opt.label}</button>
          ))}
        </div>

        {/* Favorites */}
        <button
          type="button"
          onClick={() => setIsFavorite((v) => !v)}
          aria-pressed={isFavorite}
          className={cn('h-9 px-3 rounded-md border border-border flex items-center gap-1.5 text-xs font-medium transition-colors',
            isFavorite ? 'bg-rose-500/10 border-rose-500/30 text-rose-600 dark:text-rose-400' : 'bg-background hover:bg-muted',
          )}
        >
          <Heart className={cn('h-3.5 w-3.5', isFavorite && 'fill-rose-500 text-rose-500')} />
          Favorites
        </button>

        {/* View mode toggle */}
        <div className="flex rounded-md border border-border overflow-hidden ml-auto" role="group" aria-label="Library layout">
          {VIEW_ICONS.map(({ id, icon: Icon, label }) => (
            <button key={id} type="button" onClick={() => setView(id)} title={label} aria-label={`${label} view`} aria-pressed={viewMode === id}
              className={cn('flex h-9 w-9 items-center justify-center transition-colors border-r border-border last:border-r-0',
                viewMode === id ? 'bg-primary text-primary-foreground' : 'bg-background hover:bg-muted',
              )}>
              <Icon className="h-3.5 w-3.5" />
            </button>
          ))}
        </div>

        {/* Count */}
        <div className="flex items-center gap-1 text-xs text-muted-foreground" aria-live="polite">
          <Filter className="h-3.5 w-3.5" />
          <span>{books.length} book{books.length !== 1 ? 's' : ''}</span>
        </div>
      </div>

      {/* Content */}
      {loading ? (
        viewMode === 'list' ? (
          <LoadingSkeleton rows={8} />
        ) : (
          <div className={cn('grid gap-4', viewMode === 'compact' ? 'grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7' : 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5')}>
            {Array.from({ length: viewMode === 'compact' ? 14 : 10 }).map((_, i) => (
              <div key={i} className={cn('animate-pulse rounded-xl bg-muted', viewMode === 'compact' ? 'h-48' : 'h-72')} />
            ))}
          </div>
        )
      ) : error ? (
        <ErrorState
          onRetry={() => void fetchBooks()}
          message={error}
          details={String(error)}
          retrying={loading}
        />
      ) : books.length === 0 ? (
        <EmptyState
          icon={<BookOpen className="h-6 w-6" />}
          title={hasFilters ? 'Không có kết quả' : 'Thư viện trống'}
          hint={hasFilters
            ? 'Thử bỏ bớt bộ lọc hoặc đổi từ khoá khác.'
            : 'Upload file EPUB, HTML hoặc TXT đầu tiên để bắt đầu.'}
          action={hasFilters ? (
            <Button size="sm" variant="outline" onClick={clearFilters}>Xoá bộ lọc</Button>
          ) : (
            <Link href="/convert" className="inline-flex h-8 items-center justify-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground shadow hover:bg-primary/90">
              <Plus className="h-3.5 w-3.5 mr-1.5" />Thêm sách mới
            </Link>
          )}
        />
      ) : viewMode === 'list' ? (
        <div className="space-y-2">
          {books.map((book) => (
            <BookListRow key={book.id} book={book} onDelete={handleDelete} onUpdate={handleUpdate} />
          ))}
        </div>
      ) : (
        <div className={cn('grid gap-4', viewMode === 'compact'
          ? 'grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7'
          : 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5',
        )}>
          {books.map((book) => (
            <BookCard key={book.id} book={book} onDelete={handleDelete} onUpdate={handleUpdate} onEnhanced={handleEnhanced} compact={viewMode === 'compact'} />
          ))}
        </div>
      )}

      <p className="text-xs text-muted-foreground" aria-live="polite">
        {books.length} book{books.length !== 1 ? 's' : ''} in library
      </p>
    </div>
  );
}
