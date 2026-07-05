'use client';
// src/components/library/BookGrid.tsx – Library with grid/list/compact view modes
import { useEffect, useState, useCallback } from 'react';
import { BookCard, BookSummary } from './BookCard';
import {
  Search, BookOpen, Heart, Filter, LayoutGrid, List, LayoutList,
  Star, Download, Trash2, BookMarked, Plus
} from 'lucide-react';
import { cn, formatDate } from '@/lib/utils';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { EmptyState, LoadingSkeleton } from '@/components/layout/EmptyState';

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
  const coverUrl = `/api/library/${book.id}/cover`;
  const starRating = book.rating ? Math.round(book.rating / 2) : 0;

  const handleStatusChange = async (readStatus: string) => {
    const updated = await fetch(`/api/library/${book.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ readStatus }),
    }).then((r) => r.json()) as BookSummary;
    onUpdate(updated);
  };

  const handleDelete = async () => {
    if (!confirm(`Remove "${book.title}"?`)) return;
    await fetch(`/api/library/${book.id}`, { method: 'DELETE' });
    onDelete(book.id);
  };

  return (
    <div className="flex items-center gap-3 rounded-xl border bg-card p-3 hover:bg-muted/30 transition-colors group">
      {/* Cover */}
      <div className="h-16 w-11 shrink-0 overflow-hidden rounded bg-muted">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={coverUrl} alt={book.title} className="h-full w-full object-cover"
          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
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
          <Badge className="border text-[9px] px-1.5 h-4 py-0">{book.language.toUpperCase()}</Badge>
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
          <button key={s} onClick={() => handleStatusChange(s)}
            className={cn('rounded px-2 py-1 text-[9px] font-medium capitalize transition-colors',
              book.readStatus === s ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-muted/80'
            )}>{s}</button>
        ))}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
        <Link
          href={`/library/${book.id}/read`}
          className="flex items-center gap-1 rounded-md bg-primary px-2.5 py-1.5 text-[11px] font-medium text-primary-foreground hover:bg-primary/90"
        >
          <BookOpen className="h-3 w-3" /> Read
        </Link>
        <a href={`/api/library/${book.id}/download`} download
          className="flex h-8 w-8 items-center justify-center rounded-md border hover:bg-muted transition-colors">
          <Download className="h-3.5 w-3.5" />
        </a>
        <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-destructive hover:bg-destructive/10" onClick={handleDelete}>
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
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
  const [viewMode, setViewMode] = useState<ViewMode>('grid');

  useEffect(() => { setViewMode(loadViewMode()); }, []);

  const fetchBooks = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    if (lang)   params.set('language', lang);
    if (readStatus) params.set('readStatus', readStatus);
    if (isFavorite) params.set('isFavorite', 'true');
    const res = await fetch(`/api/library?${params}`);
    if (res.ok) setBooks(await res.json());
    setLoading(false);
  }, [search, lang, readStatus, isFavorite]);

  useEffect(() => { void fetchBooks(); }, [fetchBooks]);

  const handleDelete = (id: string) => setBooks((prev) => prev.filter((b) => b.id !== id));
  const handleUpdate = (updated: BookSummary) => setBooks((prev) => prev.map((b) => b.id === updated.id ? updated : b));
  const handleEnhanced = (newBook: BookSummary) => setBooks((prev) => [newBook, ...prev]);

  const setView = (v: ViewMode) => { setViewMode(v); saveViewMode(v); };

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
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search" placeholder="Search title, author, series…"
            value={search} onChange={(e) => setSearch(e.target.value)}
            className="h-9 w-full rounded-md border bg-background pl-9 pr-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring ring-offset-background"
          />
        </div>

        {/* Language */}
        <select value={lang} onChange={(e) => setLang(e.target.value)}
          className="h-9 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring ring-offset-background">
          <option value="">All languages</option>
          <option value="vi">Vietnamese</option>
          <option value="en">English</option>
          <option value="mixed">Mixed</option>
        </select>

        {/* Status tabs */}
        <div className="flex rounded-md border overflow-hidden">
          {READ_STATUS_OPTS.map((opt) => (
            <button key={opt.value} onClick={() => setReadStatus(opt.value)}
              className={cn('px-3 h-9 text-xs font-medium transition-colors border-r last:border-r-0',
                readStatus === opt.value ? 'bg-primary text-primary-foreground' : 'bg-background hover:bg-muted',
              )}>{opt.label}</button>
          ))}
        </div>

        {/* Favorites */}
        <button
          onClick={() => setIsFavorite((v) => !v)}
          className={cn('h-9 px-3 rounded-md border flex items-center gap-1.5 text-xs font-medium transition-colors',
            isFavorite ? 'bg-rose-500/10 border-rose-500/30 text-rose-600 dark:text-rose-400' : 'bg-background hover:bg-muted',
          )}
        >
          <Heart className={cn('h-3.5 w-3.5', isFavorite && 'fill-rose-500 text-rose-500')} />
          Favorites
        </button>

        {/* View mode toggle */}
        <div className="flex rounded-md border overflow-hidden ml-auto">
          {VIEW_ICONS.map(({ id, icon: Icon, label }) => (
            <button key={id} onClick={() => setView(id)} title={label}
              className={cn('flex h-9 w-9 items-center justify-center transition-colors border-r last:border-r-0',
                viewMode === id ? 'bg-primary text-primary-foreground' : 'bg-background hover:bg-muted',
              )}>
              <Icon className="h-3.5 w-3.5" />
            </button>
          ))}
        </div>

        {/* Count */}
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
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
      ) : books.length === 0 ? (
        <EmptyState
          icon={<BookOpen className="h-6 w-6" />}
          title={search || lang || readStatus || isFavorite ? 'Không có kết quả' : 'Thư viện trống'}
          hint={search || lang || readStatus || isFavorite
            ? 'Thử bỏ bớt bộ lọc hoặc đổi từ khoá khác.'
            : 'Upload file EPUB, HTML hoặc TXT đầu tiên để bắt đầu.'}
          action={!(search || lang || readStatus || isFavorite) && (
            <Link href="/"><Button size="sm"><Plus className="h-3.5 w-3.5 mr-1.5" />Thêm sách mới</Button></Link>
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

      <p className="text-xs text-muted-foreground">
        {books.length} book{books.length !== 1 ? 's' : ''} in library
      </p>
    </div>
  );
}
