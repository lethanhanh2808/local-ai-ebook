'use client';
// src/app/shelves/[id]/page.tsx – Books in a specific shelf
import { useCallback, useEffect, useState, use } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, BookMarked, Plus, Trash2, Search, BookOpen, Loader2, X,
  LayoutGrid, List, ChevronDown, Info,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { useToast } from '@/components/ui/toast';
import { Dialog, DialogBody, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/layout/PageHeader';
import { cn } from '@/lib/utils';

interface ShelfBook {
  id: string;
  title: string;
  author: string;
  language: string;
  readStatus: string;
  readProgress: number;
  coverPath: string | null;
}

interface Shelf {
  id: string;
  name: string;
  description: string | null;
  isPublic: boolean;
  books: ShelfBook[];
}

interface LibraryBook {
  id: string;
  title: string;
  author: string;
  language: string;
  coverPath: string | null;
}

const STATUS_LABELS: Record<string, string> = {
  unread: 'Unread', reading: 'Reading', read: 'Read', archived: 'Archived',
};
const STATUS_COLOR: Record<string, string> = {
  read:     'bg-green-500/15 text-green-700 dark:text-green-400 border-green-300/30',
  reading:  'bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-300/30',
  unread:   'bg-muted text-muted-foreground border-transparent',
  archived: 'bg-muted/50 text-muted-foreground/60 border-transparent',
};

type SortKey = 'title' | 'author' | 'status' | 'progress';
type FilterStatus = 'all' | 'unread' | 'reading' | 'read' | 'archived';
type ViewMode = 'list' | 'grid';

/** Inline read-status pill with dropdown */
function StatusPill({ bookId, current, onChange }: { bookId: string; current: string; onChange: (s: string) => void }) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  async function set(s: string) {
    setSaving(true); setOpen(false);
    await fetch(`/api/library/${bookId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ readStatus: s }),
    });
    onChange(s); setSaving(false);
  }

  return (
    <div className="relative">
      <button onClick={() => setOpen((v) => !v)} disabled={saving}
        className={cn('flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors',
          STATUS_COLOR[current] ?? STATUS_COLOR.unread)}>
        {saving ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : STATUS_LABELS[current] ?? current}
        <ChevronDown className="h-2.5 w-2.5 opacity-60" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full z-20 mt-1 min-w-[110px] rounded-lg border border-border bg-popover text-popover-foreground shadow-lg overflow-hidden">
            {Object.keys(STATUS_LABELS).map((s) => (
              <button key={s} onClick={() => set(s)}
                className={cn('w-full px-3 py-1.5 text-left text-xs hover:bg-muted transition-colors',
                  s === current && 'font-semibold bg-muted/50')}>
                {STATUS_LABELS[s]}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export default function ShelfDetailPage(props: { params: Promise<{ id: string }> }) {
  const params = use(props.params);
  const { id } = params;
  const toast = useToast();
  const [shelf, setShelf] = useState<Shelf | null>(null);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [allBooks, setAllBooks] = useState<LibraryBook[]>([]);
  const [bookSearch, setBookSearch] = useState('');
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('title');
  const [filterStatus, setFilterStatus] = useState<FilterStatus>('all');
  const [viewMode, setViewMode] = useState<ViewMode>('list');

  const fetchShelf = useCallback(async () => {
    const res = await fetch(`/api/shelves/${id}`);
    if (res.ok) setShelf(await res.json());
    setLoading(false);
  }, [id]);

  useEffect(() => { void fetchShelf(); }, [fetchShelf]);

  const openAddModal = async () => {
    setShowAddModal(true);
    if (allBooks.length === 0) {
      const res = await fetch('/api/library');
      if (res.ok) setAllBooks(await res.json());
    }
  };

  const handleAdd = async (bookId: string) => {
    setAdding(bookId);
    await fetch(`/api/shelves/${id}/books`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookId }),
    });
    setAdding(null);
    await fetchShelf();
  };

  const handleRemove = (bookId: string) => {
    toast.confirm({
      title: 'Remove this book from the shelf?',
      confirmLabel: 'Remove',
      destructive: true,
      onConfirm: async () => {
        setRemoving(bookId);
        await fetch(`/api/shelves/${id}/books/${bookId}`, { method: 'DELETE' });
        setRemoving(null);
        setShelf((s) => s ? { ...s, books: s.books.filter((b) => b.id !== bookId) } : s);
      },
    });
  };

  const handleStatusChange = (bookId: string, status: string) => {
    setShelf((s) => s ? { ...s, books: s.books.map((b) => b.id === bookId ? { ...b, readStatus: status } : b) } : s);
  };

  const shelfBookIds = new Set(shelf?.books.map((b) => b.id) ?? []);
  const filteredLib = allBooks.filter(
    (b) => !shelfBookIds.has(b.id) &&
      (b.title.toLowerCase().includes(bookSearch.toLowerCase()) ||
       b.author.toLowerCase().includes(bookSearch.toLowerCase())),
  );

  const displayBooks = (shelf?.books ?? [])
    .filter((b) => {
      const matchSearch = b.title.toLowerCase().includes(search.toLowerCase()) ||
        b.author.toLowerCase().includes(search.toLowerCase());
      const matchStatus = filterStatus === 'all' || b.readStatus === filterStatus;
      return matchSearch && matchStatus;
    })
    .sort((a, b) => {
      if (sortKey === 'author') return a.author.localeCompare(b.author);
      if (sortKey === 'status') return a.readStatus.localeCompare(b.readStatus);
      if (sortKey === 'progress') return (b.readProgress ?? 0) - (a.readProgress ?? 0);
      return a.title.localeCompare(b.title);
    });

  const statusCounts = (shelf?.books ?? []).reduce<Record<string, number>>((acc, b) => {
    acc[b.readStatus] = (acc[b.readStatus] ?? 0) + 1; return acc;
  }, {});
  const avgProgress = shelf?.books.length
    ? Math.round(shelf.books.reduce((s, b) => s + (b.readProgress ?? 0), 0) / shelf.books.length)
    : 0;

  if (loading) return (
    <div className="flex h-64 items-center justify-center">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>
  );

  if (!shelf) return (
    <div className="container mx-auto max-w-6xl px-4 py-16 text-center">
      <BookMarked className="mx-auto h-12 w-12 text-muted-foreground/40 mb-4" />
      <p className="text-muted-foreground">Shelf not found.</p>
      <Link href="/shelves" className="mt-4 inline-flex items-center gap-1 text-sm text-primary hover:underline">
        <ArrowLeft className="h-3.5 w-3.5" /> Back to Shelves
      </Link>
    </div>
  );

  return (
    <div className="container mx-auto max-w-6xl px-4 py-8 space-y-6">
      {/* Header */}
      <div>
        <PageHeader
          title={shelf.name}
          description={shelf.description ?? undefined}
          icon={<BookMarked className="h-5 w-5" />}
          breadcrumbs={[
            { label: 'Library', href: '/library' },
            { label: 'Shelves', href: '/shelves' },
            { label: shelf.name },
          ]}
          actions={
            <Button onClick={openAddModal} size="sm" className="shrink-0 gap-1.5">
              <Plus className="h-4 w-4" /> Add Books
            </Button>
          }
        />
      </div>
      {/* Stats bar */}
      {shelf.books.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: 'Total', value: shelf.books.length, color: '' },
            { label: 'Reading', value: statusCounts.reading ?? 0, color: 'text-blue-600' },
            { label: 'Finished', value: statusCounts.read ?? 0, color: 'text-green-600' },
            { label: 'Avg. progress', value: `${avgProgress}%`, color: '' },
          ].map(({ label, value, color }) => (
            <div key={label} className="p-4 text-center">
              <p className={cn('text-2xl font-bold', color)}>{value}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{label}</p>
            </div>
          ))}
        </div>
      )}
      {/* Toolbar */}
      {shelf.books.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[160px]">
            <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input type="search" placeholder="Search in shelf…" value={search} onChange={(e) => setSearch(e.target.value)}
              className="h-8 w-full rounded-lg border bg-background pl-8 pr-3 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring" />
          </div>
          <div className="flex gap-1 flex-wrap">
            {(['all', 'reading', 'unread', 'read', 'archived'] as FilterStatus[]).map((s) => (
              <button key={s} onClick={() => setFilterStatus(s)}
                className={cn('rounded-full border px-2.5 py-1 text-[10px] font-medium transition-colors',
                  filterStatus === s ? 'bg-primary text-primary-foreground border-primary' : 'hover:bg-muted border-transparent')}>
                {s === 'all' ? `All (${shelf.books.length})` : `${STATUS_LABELS[s]} (${statusCounts[s] ?? 0})`}
              </button>
            ))}
          </div>
          <select value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)}
            aria-label="Sort shelf books"
            className="h-8 rounded-lg border bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <option value="title">Sort: Title</option>
            <option value="author">Sort: Author</option>
            <option value="status">Sort: Status</option>
            <option value="progress">Sort: Progress</option>
          </select>
          <div className="flex rounded-lg border overflow-hidden">
            {([['list', List], ['grid', LayoutGrid]] as [ViewMode, React.FC<{ className?: string }>][]).map(([m, Icon]) => (
              <button key={m} type="button" onClick={() => setViewMode(m)} aria-label={`${m} view`} aria-pressed={viewMode === m}
                className={cn('flex h-8 w-8 items-center justify-center transition-colors',
                  viewMode === m ? 'bg-primary text-primary-foreground' : 'hover:bg-muted')}>
                <Icon className="h-3.5 w-3.5" />
              </button>
            ))}
          </div>
        </div>
      )}
      {/* Book list */}
      {shelf.books.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed py-24 text-muted-foreground">
          <BookOpen className="h-12 w-12 opacity-30" />
          <p className="text-sm">No books on this shelf yet.</p>
          <Button onClick={openAddModal} variant="outline" size="sm" className="gap-1.5">
            <Plus className="h-4 w-4" /> Add Books
          </Button>
        </div>
      ) : displayBooks.length === 0 ? (
        <div className="py-12 text-center text-sm text-muted-foreground">No books match your filter.</div>
      ) : viewMode === 'grid' ? (
        <div className="grid gap-4 grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {displayBooks.map((book) => (
            <div key={book.id} className="group relative flex flex-col rounded-xl overflow-hidden border bg-card hover:shadow-md transition-all">
              <div className="relative aspect-[2/3] bg-muted overflow-hidden">
                {book.coverPath ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  (<img src={`/api/library/${book.id}/cover`} alt={book.title}
                    className="absolute inset-0 h-full w-full object-cover"
                    onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />)
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <BookOpen className="h-8 w-8 text-muted-foreground/30" />
                  </div>
                )}
                {book.readProgress > 0 && (
                  <div className="absolute bottom-0 left-0 right-0 h-1 bg-foreground/15">
                    <div className="h-full bg-primary" style={{ width: `${book.readProgress}%` }} />
                  </div>
                )}
                <div className="absolute inset-0 bg-modal-overlay/70 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-1.5">
                  <Link href={`/library/${book.id}/read`}
                    className="flex items-center gap-1 rounded-md bg-primary px-2.5 py-1.5 text-[11px] font-medium text-primary-foreground hover:bg-primary/90">
                    <BookOpen className="h-3 w-3" /> Read
                  </Link>
                  <Link href={`/library/${book.id}`}
                    className="flex items-center gap-1 rounded-md bg-background/90 px-2.5 py-1.5 text-[11px] font-medium text-foreground hover:bg-background"
                    title="Thông tin sách & AI Illustrations">
                    <Info className="h-3 w-3" /> Info
                  </Link>
                </div>
              </div>
              <div className="p-2.5 space-y-1.5">
                <p className="text-xs font-semibold leading-tight line-clamp-2">{book.title}</p>
                <p className="text-[10px] text-muted-foreground truncate">{book.author}</p>
                <div className="flex items-center justify-between">
                  <StatusPill bookId={book.id} current={book.readStatus} onChange={(s) => handleStatusChange(book.id, s)} />
                  <button onClick={() => handleRemove(book.id)} disabled={removing === book.id}
                    aria-label={`Remove ${book.title} from shelf`}
                    className="rounded p-0.5 text-destructive/60 hover:text-destructive hover:bg-destructive/10 transition-colors opacity-0 group-hover:opacity-100">
                    {removing === book.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-1.5">
          {displayBooks.map((book) => (
            <div key={book.id} className="group flex items-center gap-3 p-3 hover:bg-muted/30 transition-colors">
              <div className="h-14 w-10 shrink-0 overflow-hidden rounded bg-muted">
                {book.coverPath ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  (<img src={`/api/library/${book.id}/cover`} alt={book.title}
                    className="h-full w-full object-cover"
                    onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />)
                ) : (
                  <div className="h-full w-full flex items-center justify-center">
                    <BookOpen className="h-4 w-4 text-muted-foreground/40" />
                  </div>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold truncate">{book.title}</p>
                <p className="text-xs text-muted-foreground truncate">{book.author}</p>
                <div className="mt-1.5 flex items-center gap-2">
                  <StatusPill bookId={book.id} current={book.readStatus} onChange={(s) => handleStatusChange(book.id, s)} />
                  {book.readProgress > 0 && (
                    <div className="flex items-center gap-1.5 min-w-0">
                      <div className="h-1 w-20 rounded-full bg-muted overflow-hidden">
                        <div className="h-full rounded-full bg-primary/60" style={{ width: `${book.readProgress}%` }} />
                      </div>
                      <span className="text-[10px] text-muted-foreground">{book.readProgress}%</span>
                    </div>
                  )}
                  <Badge className="border text-[9px] px-1.5 py-0 h-4">{book.language.toUpperCase()}</Badge>
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <Link href={`/library/${book.id}/read`}
                  className="flex items-center gap-1 rounded-md bg-primary px-2 py-1.5 text-[11px] font-medium text-primary-foreground hover:bg-primary/90 transition-colors">
                  <BookOpen className="h-3 w-3" /> Read
                </Link>
                <Link href={`/library/${book.id}`}
                  className="flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1.5 text-[11px] font-medium text-foreground hover:bg-muted transition-colors"
                  title="Thông tin sách & AI Illustrations">
                  <Info className="h-3 w-3" /> Info
                </Link>
                <Button size="sm" variant="ghost" className="px-2 text-destructive hover:bg-destructive/10"
                  onClick={() => handleRemove(book.id)} disabled={removing === book.id} aria-label={`Remove ${book.title} from shelf`}>
                  {removing === book.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
      {/* Add books modal */}
      <Dialog open={showAddModal} onOpenChange={setShowAddModal} widthClass="max-w-lg" title="Add Books to Shelf">
        <DialogBody>
          <div className="space-y-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground pointer-events-none" />
              <Input autoFocus type="search" placeholder="Search library…" value={bookSearch}
                onChange={(e) => setBookSearch(e.target.value)} className="pl-9" />
            </div>
            <div className="max-h-80 overflow-y-auto space-y-1">
              {filteredLib.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  {allBooks.length === 0 ? 'Loading…' : 'No books to add.'}
                </p>
              ) : filteredLib.map((book) => (
                <div key={book.id} className="flex items-center gap-3 rounded-lg p-2 hover:bg-muted/50">
                  <div className="h-10 w-7 shrink-0 overflow-hidden rounded bg-muted">
                    {book.coverPath && (
                      // eslint-disable-next-line @next/next/no-img-element
                      (<img src={`/api/library/${book.id}/cover`} alt={book.title} className="h-full w-full object-cover" />)
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{book.title}</p>
                    <p className="text-xs text-muted-foreground truncate">{book.author}</p>
                  </div>
                  <Button size="sm" variant="outline" className="shrink-0 text-xs"
                    onClick={() => handleAdd(book.id)} disabled={adding === book.id} aria-label={`Add ${book.title} to shelf`}>
                    {adding === book.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
                  </Button>
                </div>
              ))}
            </div>
          </div>
        </DialogBody>
      </Dialog>
    </div>
  );
}
