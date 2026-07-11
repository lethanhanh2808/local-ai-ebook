'use client';
// src/components/library/BookCard.tsx
import { useEffect, useState } from 'react';
import { Download, Trash2, BookMarked, Tag, ImagePlus, Loader2, Sparkles, Pencil, Star, Heart, BookOpen, CheckCircle2, Clock } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { Card } from '@/components/ui/card';
import { cn, formatBytes } from '@/lib/utils';
import Link from 'next/link';
import { MetadataModal } from './MetadataModal';

export interface BookSummary {
  id: string;
  title: string;
  author: string;
  language: string;
  description?: string | null;
  publisher?: string | null;
  publishDate?: string | null;
  identifier?: string | null;
  series?: string | null;
  seriesIndex?: number | null;
  rating?: number | null;
  fileSize: number;
  originalFilename: string;
  tags: string[];
  readProgress: number;
  readStatus: string;
  isFavorite: boolean;
  notes?: string | null;
  addedAt: string;
  coverPath?: string | null;
}

interface BookCardProps {
  book: BookSummary;
  onDelete: (id: string) => void;
  onUpdate?: (updated: BookSummary) => void;
  onEnhanced?: (newBook: BookSummary) => void;
  compact?: boolean;
}

export function BookCard({ book: initialBook, onDelete, onUpdate, onEnhanced, compact = false }: BookCardProps) {
  const toast = useToast();
  const [book, setBook] = useState(initialBook);
  const [deleting, setDeleting] = useState(false);
  const [coverKey, setCoverKey] = useState(0);
  // BUGFIX 2026-07-11: when the parent's `book.coverPath` flips from
  // null/old → new (e.g. after the user navigates back to the library
  // page and the parent's cached list now reflects the freshly
  // generated cover), bump coverKey so the <img> re-fetches. Without
  // this, the BookCard mounts with coverKey=0 and the browser may serve
  // the OLD cached response for the same ?v=0 URL — showing the SVG
  // placeholder ("default cover") even though the DB has the new path.
  useEffect(() => {
    setCoverKey((k) => k + 1);
  }, [book.coverPath]);
  const [generatingCover, setGeneratingCover] = useState(false);
  const [coverError, setCoverError] = useState(false);
  const [enhancing, setEnhancing] = useState(false);
  const [showMeta, setShowMeta] = useState(false);
  const coverUrl = `/api/library/${book.id}/cover?v=${coverKey}`;

  const langLabel: Record<string, string> = { vi: 'VI', en: 'EN', mixed: 'MX' };

  const STATUS_ICON: Record<string, React.ReactNode> = {
    reading: <BookOpen className="h-2.5 w-2.5" />,
    read: <CheckCircle2 className="h-2.5 w-2.5" />,
    unread: <Clock className="h-2.5 w-2.5" />,
  };
  const STATUS_COLOR: Record<string, string> = {
    reading: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
    read: 'bg-green-500/15 text-green-600 dark:text-green-400',
    unread: 'bg-muted text-muted-foreground',
    archived: 'bg-muted/50 text-muted-foreground/60',
  };

  const handleDelete = () => {
    toast.confirm({
      title: `Remove "${book.title}" from library?`,
      confirmLabel: 'Remove',
      destructive: true,
      onConfirm: async () => {
        setDeleting(true);
        try {
          const res = await fetch(`/api/library/${book.id}`, { method: 'DELETE' });
          if (!res.ok) {
            const body = await res.json().catch(() => ({})) as { error?: string };
            throw new Error(body.error ?? `Remove failed (HTTP ${res.status})`);
          }
          onDelete(book.id);
          toast.success('Removed', { description: book.title });
        } catch (e) {
          toast.error('Failed to remove', { description: e instanceof Error ? e.message : String(e) });
          setDeleting(false);
        }
      },
    });
  };

  const handleGenerateCover = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setGeneratingCover(true);
    try {
      const res = await fetch(`/api/library/${book.id}/cover/generate`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `Cover generation failed (HTTP ${res.status})`);
      }
      setCoverKey((k) => k + 1);
      setCoverError(false);
      toast.success('Cover updated', { description: book.title });
    } catch (e) {
      toast.error('Cover generation failed', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setGeneratingCover(false);
    }
  };

  const handleEnhance = () => {
    toast.confirm({
      title: `AI-enhance "${book.title}"?`,
      description: 'Creates a new book entry with " - AI Edited" suffix. May take several minutes.',
      confirmLabel: 'Enhance',
      onConfirm: async () => {
        setEnhancing(true);
        try {
          const res = await fetch(`/api/library/${book.id}/enhance`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
          if (!res.ok) throw new Error((await res.json()).error ?? 'Enhancement failed');
          const newBook = await res.json() as BookSummary;
          onEnhanced?.(newBook);
          toast.success('AI-enhanced version created', { description: newBook.title });
        } catch (e) {
          toast.error('Enhancement failed', { description: e instanceof Error ? e.message : String(e) });
        } finally {
          setEnhancing(false);
        }
      },
    });
  };

  const handleToggleFavorite = async () => {
    try {
      const res = await fetch(`/api/library/${book.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isFavorite: !book.isFavorite }),
      });
      if (!res.ok) throw new Error(`Update failed (HTTP ${res.status})`);
      const updated = await res.json() as BookSummary;
      setBook(updated);
      onUpdate?.(updated);
    } catch (e) {
      toast.error('Could not update favorite', { description: e instanceof Error ? e.message : String(e) });
    }
  };

  const handleStatusChange = async (readStatus: string) => {
    try {
      const res = await fetch(`/api/library/${book.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ readStatus }),
      });
      if (!res.ok) throw new Error(`Update failed (HTTP ${res.status})`);
      const updated = await res.json() as BookSummary;
      setBook(updated);
      onUpdate?.(updated);
    } catch (e) {
      toast.error('Could not update reading status', { description: e instanceof Error ? e.message : String(e) });
    }
  };

  const handleMetaSaved = (updated: BookSummary) => {
    setBook(updated);
    onUpdate?.(updated);
  };

  const starRating = book.rating ? Math.round(book.rating / 2) : 0; // convert 1-10 → 1-5

  return (
    <>
      {showMeta && (
        <MetadataModal book={book} onClose={() => setShowMeta(false)} onSaved={handleMetaSaved} />
      )}
      <Card className={cn('group flex flex-col overflow-hidden shadow-sm transition-all hover:shadow-md hover:-translate-y-0.5', compact && 'text-[10px]')}>
        {/* Cover */}
        <div className="relative aspect-[2/3] bg-muted overflow-hidden">
          {!coverError ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={coverKey}
              src={coverUrl}
              alt={book.title}
              className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
              onError={() => setCoverError(true)}
            />
          ) : (
            <div className="h-full w-full flex flex-col items-center justify-center bg-gradient-to-br from-muted to-muted/60 p-4">
              <p className="text-center text-xs font-medium text-muted-foreground line-clamp-4">{book.title}</p>
            </div>
          )}

          {book.readProgress > 0 && (
            <div
              role="progressbar"
              aria-label={`Reading progress for ${book.title}`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(book.readProgress)}
              className="absolute bottom-0 left-0 right-0 h-1 bg-foreground/15"
            >
              <div className="h-full bg-primary transition-all" style={{ width: `${book.readProgress}%` }} />
            </div>
          )}

          {/* Top badges */}
          <div className="absolute top-1.5 left-1.5 right-1.5 flex items-start justify-between">
            <button
              type="button"
              onClick={handleToggleFavorite}
              className="rounded-full bg-background/80 backdrop-blur p-1 hover:bg-background transition-colors"
              title={book.isFavorite ? 'Remove from favorites' : 'Add to favorites'}
              aria-label={book.isFavorite ? `Remove ${book.title} from favorites` : `Add ${book.title} to favorites`}
              aria-pressed={book.isFavorite}
            >
              <Heart className={cn('h-3 w-3', book.isFavorite ? 'fill-rose-500 text-rose-500' : 'text-muted-foreground')} />
            </button>
            <Badge className="text-[9px] px-1.5 py-0 h-4">
              {langLabel[book.language] ?? book.language.toUpperCase()}
            </Badge>
          </div>

          {/* Read status pill */}
          {book.readStatus !== 'unread' && (
            <div className={cn('absolute bottom-1.5 left-1.5 flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[9px] font-medium', STATUS_COLOR[book.readStatus] ?? STATUS_COLOR.unread)}>
              {STATUS_ICON[book.readStatus]}
              <span className="capitalize">{book.readStatus}</span>
            </div>
          )}

          {/* Hover overlay */}
          <div className="absolute inset-0 flex items-center justify-center gap-2 bg-modal-overlay/40 opacity-100 transition-colors sm:bg-modal-overlay/0 sm:opacity-0 sm:group-hover:bg-modal-overlay/70 sm:group-hover:opacity-100 sm:group-focus-within:bg-modal-overlay/70 sm:group-focus-within:opacity-100">
            <button
              type="button"
              onClick={handleGenerateCover}
              disabled={generatingCover || enhancing}
              className="rounded-lg bg-background/90 backdrop-blur px-2 py-1.5 text-[10px] font-medium flex items-center gap-1 hover:bg-background transition-colors"
              title="Regenerate cover"
            >
              {generatingCover ? <Loader2 className="h-3 w-3 animate-spin" /> : <ImagePlus className="h-3 w-3" />}
              Cover
            </button>
            <button
              type="button"
              onClick={() => setShowMeta(true)}
              disabled={enhancing}
              className="rounded-lg bg-background/90 backdrop-blur px-2 py-1.5 text-[10px] font-medium flex items-center gap-1 hover:bg-background transition-colors"
              title="Edit metadata"
            >
              <Pencil className="h-3 w-3" />
              Edit
            </button>
          </div>
        </div>

        {/* Info */}
        <div className="flex flex-1 flex-col gap-0.5 p-3">
          <h3 className="line-clamp-2 text-xs font-semibold leading-tight">{book.title}</h3>
          <p className="text-[10px] text-muted-foreground truncate">{book.author}</p>
          {book.series && (
            <p className="text-[9px] text-primary/70 truncate italic">
              {book.series}{book.seriesIndex != null ? ` #${book.seriesIndex}` : ''}
            </p>
          )}
          {/* Star rating */}
          {starRating > 0 && (
            <div className="flex gap-0.5 mt-0.5">
              {Array.from({ length: 5 }, (_, i) => (
                <Star key={i} className={cn('h-2.5 w-2.5', i < starRating ? 'fill-amber-400 text-amber-400' : 'text-muted-foreground/30')} />
              ))}
            </div>
          )}
          {book.tags.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-0.5">
              {book.tags.slice(0, 3).map((t) => (
                <span key={t} className="flex items-center gap-0.5 rounded-full bg-muted px-1.5 py-0.5 text-[9px] text-muted-foreground">
                  <Tag className="h-2 w-2" />{t}
                </span>
              ))}
            </div>
          )}
          {/* Read status quick-toggle */}
          <div className="mt-1.5 flex gap-0.5">
            {(['unread', 'reading', 'read'] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => handleStatusChange(s)}
                aria-pressed={book.readStatus === s}
                className={cn(
                  'flex-1 rounded text-[8px] py-0.5 font-medium capitalize transition-colors',
                  book.readStatus === s
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground hover:bg-muted/80',
                )}
              >{s}</button>
            ))}
          </div>
          <p className="mt-auto pt-1.5 text-[9px] text-muted-foreground/60">{formatBytes(book.fileSize)}</p>
        </div>

        {/* Actions */}
        <div className="flex flex-wrap gap-1 border-t border-border p-2">
          <Link
            href={`/library/${book.id}/read`}
            className="flex basis-full items-center justify-center gap-1 rounded-md bg-primary px-2 py-1.5 text-[11px] font-medium text-primary-foreground hover:bg-primary/90 transition-colors lg:basis-auto lg:flex-1"
          >
            <BookMarked className="h-3 w-3" /> Read
          </Link>
          <button
            type="button"
            onClick={handleEnhance}
            disabled={enhancing || deleting}
            title="AI-enhance this book (creates a new entry)"
            aria-label={`AI-enhance ${book.title}`}
            className="flex items-center justify-center rounded-md border border-border px-2 py-1.5 text-[11px] font-medium hover:bg-primary/10 hover:border-primary/40 transition-colors disabled:opacity-50"
          >
            {enhancing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3 text-primary" />}
          </button>
          <Link
            href={`/library/${book.id}/edit`}
            title="Edit EPUB"
            aria-label={`Edit ${book.title}`}
            className="flex items-center justify-center rounded-md border border-border px-2 py-1.5 text-[11px] font-medium hover:bg-muted transition-colors"
          >
            <Pencil className="h-3 w-3" />
          </Link>
          <a
            href={`/api/library/${book.id}/download`}
            download
            aria-label={`Download ${book.title}`}
            className="flex items-center justify-center rounded-md border border-border px-2 py-1.5 text-[11px] font-medium hover:bg-muted transition-colors"
          >
            <Download className="h-3 w-3" />
          </a>
          <Button
            size="sm"
            variant="ghost"
            className="px-2 text-destructive hover:bg-destructive/10"
            onClick={handleDelete}
            disabled={deleting || enhancing}
            aria-label={`Remove ${book.title} from library`}
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      </Card>
    </>
  );

}
