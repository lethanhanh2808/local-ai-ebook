'use client';
// src/components/library/ShelvesView.tsx – Shelves/Reading lists manager
import { useEffect, useRef, useState } from 'react';
import {
  Plus, Trash2, BookMarked, ChevronRight, Loader2, X,
  Pencil, Check, BookOpen, GripVertical, ArrowDownAZ,
  Clock, Hash, BookCopy, SortAsc,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import { EmptyState } from '@/components/layout/EmptyState';

interface PreviewBook { id: string; hasCover: boolean; readStatus: string; }
interface ShelfSummary {
  id: string;
  name: string;
  description: string | null;
  isPublic: boolean;
  bookCount: number;
  createdAt: string;
  updatedAt: string;
  previewBooks: PreviewBook[];
  readingCount: number;
}

type SortKey = 'name' | 'count' | 'recent';

/** Generate a deterministic gradient from a shelf name */
function shelfGradient(name: string): { gradient: string; iconOpacity: number } {
  const GRADIENTS = [
    'linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)',
    'linear-gradient(135deg, #2d1b69 0%, #11998e 100%)',
    'linear-gradient(135deg, #4a0072 0%, #cc2b5e 100%)',
    'linear-gradient(135deg, #093028 0%, #237a57 100%)',
    'linear-gradient(135deg, #373b44 0%, #4286f4 100%)',
    'linear-gradient(135deg, #c94b4b 0%, #4b134f 100%)',
    'linear-gradient(135deg, #834d9b 0%, #d04ed6 100%)',
    'linear-gradient(135deg, #0f2027 0%, #203a43 50%, #2c5364 100%)',
    'linear-gradient(135deg, #485563 0%, #29323c 100%)',
    'linear-gradient(135deg, #b79891 0%, #94716b 100%)',
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = ((hash << 5) - hash) + name.charCodeAt(i);
  return { gradient: GRADIENTS[Math.abs(hash) % GRADIENTS.length], iconOpacity: 0.6 };
}

/** Get 1–2 letter initials from a shelf name */
function shelfInitials(name: string): string {
  const words = name.trim().split(/\s+/);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function ShelfCard({ shelf, onDelete, onRename }: {
  shelf: ShelfSummary;
  onDelete: (id: string, name: string) => void;
  onRename: (id: string, name: string, desc: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(shelf.name);
  const [editDesc, setEditDesc] = useState(shelf.description ?? '');
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function startEdit() { setEditName(shelf.name); setEditDesc(shelf.description ?? ''); setEditing(true); setTimeout(() => inputRef.current?.focus(), 30); }
  function cancelEdit() { setEditing(false); }

  async function commitEdit() {
    if (!editName.trim()) return;
    setSaving(true);
    await fetch(`/api/shelves/${shelf.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: editName.trim(), description: editDesc.trim() || null }),
    });
    setSaving(false);
    setEditing(false);
    onRename(shelf.id, editName.trim(), editDesc.trim() || null);
  }

  const readPct = shelf.bookCount > 0
    ? Math.round((shelf.previewBooks.filter(b => b.readStatus === 'read').length / Math.min(shelf.bookCount, 4)) * 100)
    : 0;

  const { gradient } = shelfGradient(shelf.name);
  const initials = shelfInitials(shelf.name);

  return (
    <div className="group relative flex flex-col rounded-2xl border bg-card overflow-hidden hover:shadow-lg transition-all duration-200">
      {/* Auto-generated gradient cover */}
      <div className="flex h-24 items-center justify-center relative overflow-hidden"
        style={{ background: gradient }}>
        {/* Subtle noise/texture overlay */}
        <div className="absolute inset-0 opacity-10"
          style={{ backgroundImage: 'url("data:image/svg+xml,%3Csvg viewBox=\'0 0 200 200\' xmlns=\'http://www.w3.org/2000/svg\'%3E%3Cfilter id=\'n\'%3E%3CfeTurbulence type=\'fractalNoise\' baseFrequency=\'0.9\' numOctaves=\'4\'/%3E%3C/filter%3E%3Crect width=\'100%25\' height=\'100%25\' filter=\'url(%23n)\' opacity=\'1\'/%3E%3C/svg%3E")', backgroundSize: 'cover' }} />
        <div className="relative text-center select-none">
          <p className="text-4xl font-black text-white/70 leading-none tracking-tight">{initials}</p>
          <p className="text-[10px] font-medium text-white/40 mt-1 tracking-wide">
            {shelf.bookCount} {shelf.bookCount === 1 ? 'book' : 'books'}
          </p>
        </div>
      </div>

      {/* Body */}
      <div className="flex flex-col flex-1 p-4 gap-2">
        {editing ? (
          <div className="space-y-2">
            <input ref={inputRef} value={editName} onChange={(e) => setEditName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') commitEdit(); if (e.key === 'Escape') cancelEdit(); }}
              className="w-full rounded-lg border bg-background px-3 py-1.5 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring" />
            <input value={editDesc} onChange={(e) => setEditDesc(e.target.value)}
              placeholder="Description…"
              className="w-full rounded-lg border bg-background px-3 py-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring" />
            <div className="flex gap-2">
              <button onClick={commitEdit} disabled={saving || !editName.trim()}
                className="flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
                {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />} Save
              </button>
              <button onClick={cancelEdit} className="rounded-md px-3 py-1.5 text-xs hover:bg-muted">Cancel</button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex items-start justify-between gap-2">
              <h3 className="font-semibold text-sm leading-tight">{shelf.name}</h3>
              <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                <button onClick={startEdit}
                  className="rounded-md p-1.5 hover:bg-muted transition-colors" title="Rename">
                  <Pencil className="h-3 w-3" />
                </button>
                <button onClick={() => onDelete(shelf.id, shelf.name)}
                  className="rounded-md p-1.5 hover:bg-destructive/10 text-destructive transition-colors" title="Delete">
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            </div>
            {shelf.description && (
              <p className="text-xs text-muted-foreground leading-snug line-clamp-2">{shelf.description}</p>
            )}
          </>
        )}

        <div className="mt-auto pt-2 flex items-center justify-between">
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <BookCopy className="h-3 w-3" />
              {shelf.bookCount} book{shelf.bookCount !== 1 ? 's' : ''}
            </span>
            {shelf.readingCount > 0 && (
              <span className="flex items-center gap-1 text-blue-500">
                <BookOpen className="h-3 w-3" />
                {shelf.readingCount} reading
              </span>
            )}
          </div>
          <Link href={`/shelves/${shelf.id}`}
            className="flex items-center gap-1 rounded-md bg-primary/10 px-2.5 py-1.5 text-xs font-medium text-primary hover:bg-primary/20 transition-colors">
            Open <ChevronRight className="h-3 w-3" />
          </Link>
        </div>

        {/* Reading progress bar */}
        {shelf.bookCount > 0 && (
          <div className="h-1 rounded-full bg-muted overflow-hidden">
            <div className="h-full rounded-full bg-primary/40 transition-all"
              style={{ width: `${readPct}%` }} />
          </div>
        )}
      </div>
    </div>
  );
}

export function ShelvesView() {
  const [shelves, setShelves] = useState<ShelfSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>('name');

  const fetchShelves = async () => {
    const res = await fetch('/api/shelves');
    if (res.ok) setShelves(await res.json());
    setLoading(false);
  };

  useEffect(() => { void fetchShelves(); }, []);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    const res = await fetch('/api/shelves', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName.trim(), description: newDesc.trim() || undefined }),
    });
    if (res.ok) {
      setNewName(''); setNewDesc(''); setShowForm(false);
      await fetchShelves();
    }
    setCreating(false);
  };

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Delete shelf "${name}"? Books inside won't be deleted.`)) return;
    await fetch(`/api/shelves/${id}`, { method: 'DELETE' });
    setShelves((prev) => prev.filter((s) => s.id !== id));
  };

  const handleRename = (id: string, name: string, desc: string | null) => {
    setShelves((prev) => prev.map((s) => s.id === id ? { ...s, name, description: desc } : s));
  };

  const sorted = [...shelves].sort((a, b) => {
    if (sortKey === 'count') return b.bookCount - a.bookCount;
    if (sortKey === 'recent') return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    return a.name.localeCompare(b.name);
  });

  const totalBooks = shelves.reduce((s, sh) => s + sh.bookCount, 0);
  const totalReading = shelves.reduce((s, sh) => s + sh.readingCount, 0);

  if (loading) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-52 animate-pulse rounded-2xl bg-muted" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Toolbar */}
      <div className="flex items-center gap-3 flex-wrap">
        {/* Stats chips */}
        {shelves.length > 0 && (
          <div className="flex items-center gap-2 mr-auto text-xs text-muted-foreground">
            <span className="flex items-center gap-1 rounded-full border px-2.5 py-1">
              <BookMarked className="h-3 w-3" />{shelves.length} shelf{shelves.length !== 1 ? 'ves' : ''}
            </span>
            <span className="flex items-center gap-1 rounded-full border px-2.5 py-1">
              <BookCopy className="h-3 w-3" />{totalBooks} books
            </span>
            {totalReading > 0 && (
              <span className="flex items-center gap-1 rounded-full border border-blue-300 bg-blue-50 dark:bg-blue-950/30 px-2.5 py-1 text-blue-600 dark:text-blue-400">
                <BookOpen className="h-3 w-3" />{totalReading} reading
              </span>
            )}
          </div>
        )}

        {/* Sort */}
        <div className="flex items-center rounded-lg border overflow-hidden text-xs">
          {([['name', 'A–Z', ArrowDownAZ], ['count', 'Most books', Hash], ['recent', 'Recent', Clock]] as [SortKey, string, React.FC<{className?:string}>][]).map(([key, label, Icon]) => (
            <button key={key} onClick={() => setSortKey(key)}
              className={cn('flex items-center gap-1 px-2.5 py-1.5 transition-colors',
                sortKey === key ? 'bg-primary text-primary-foreground' : 'hover:bg-muted')}>
              <Icon className="h-3 w-3" />{label}
            </button>
          ))}
        </div>

        <Button size="sm" onClick={() => setShowForm((v) => !v)} variant={showForm ? 'ghost' : 'default'}>
          {showForm ? <X className="h-4 w-4 mr-1" /> : <Plus className="h-4 w-4 mr-1" />}
          {showForm ? 'Cancel' : 'New Shelf'}
        </Button>
      </div>

      {/* Create form */}
      {showForm && (
        <div className="rounded-xl border bg-card p-4 space-y-3">
          <h3 className="text-sm font-semibold">Create Reading List</h3>
          <div className="grid sm:grid-cols-2 gap-3">
            <input type="text" value={newName} onChange={(e) => setNewName(e.target.value)}
              placeholder="Shelf name…"
              className="rounded-lg border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onKeyDown={(e) => e.key === 'Enter' && handleCreate()} />
            <input type="text" value={newDesc} onChange={(e) => setNewDesc(e.target.value)}
              placeholder="Description (optional)…"
              className="rounded-lg border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" />
          </div>
          <Button size="sm" onClick={handleCreate} disabled={creating || !newName.trim()}>
            {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Plus className="h-3.5 w-3.5 mr-1" />}
            Create
          </Button>
        </div>
      )}

      {/* Empty state */}
      {shelves.length === 0 ? (
        <EmptyState
          icon={<BookMarked className="h-6 w-6" />}
          title="Chưa có shelves nào"
          hint="Tạo shelf đầu tiên để nhóm sách theo chủ đề — giống Calibre shelves."
          action={<Button onClick={() => setShowForm(true)} size="sm"><Plus className="h-3.5 w-3.5 mr-1.5" />Tạo shelf đầu tiên</Button>}
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {sorted.map((shelf) => (
            <ShelfCard key={shelf.id} shelf={shelf} onDelete={handleDelete} onRename={handleRename} />
          ))}
        </div>
      )}
    </div>
  );
}
