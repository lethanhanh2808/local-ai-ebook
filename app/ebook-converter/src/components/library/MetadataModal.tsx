'use client';
// src/components/library/MetadataModal.tsx
// Calibre-style metadata editor modal for books in the library
import { useState, useEffect } from 'react';
import { X, Save, Loader2, Tag, Plus, Star } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { BookSummary } from './BookCard';

interface MetadataModalProps {
  book: BookSummary;
  onClose: () => void;
  onSaved: (updated: BookSummary) => void;
}

const LANGUAGES = [
  { value: 'vi', label: 'Vietnamese' },
  { value: 'en', label: 'English' },
  { value: 'zh', label: 'Chinese' },
  { value: 'ja', label: 'Japanese' },
  { value: 'ko', label: 'Korean' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
  { value: 'es', label: 'Spanish' },
  { value: 'mixed', label: 'Mixed' },
];

export function MetadataModal({ book, onClose, onSaved }: MetadataModalProps) {
  const [title, setTitle] = useState(book.title);
  const [author, setAuthor] = useState(book.author);
  const [description, setDescription] = useState(book.description ?? '');
  const [publisher, setPublisher] = useState(book.publisher ?? '');
  const [publishDate, setPublishDate] = useState(book.publishDate ?? '');
  const [identifier, setIdentifier] = useState(book.identifier ?? '');
  const [series, setSeries] = useState(book.series ?? '');
  const [seriesIndex, setSeriesIndex] = useState(book.seriesIndex?.toString() ?? '');
  const [rating, setRating] = useState<number>(book.rating ? Math.round(book.rating / 2) : 0); // store as 1-5
  const [language, setLanguage] = useState(book.language);
  const [tags, setTags] = useState<string[]>(book.tags ?? []);
  const [notes, setNotes] = useState(book.notes ?? '');
  const [tagInput, setTagInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const addTag = () => {
    const t = tagInput.trim().toLowerCase();
    if (t && !tags.includes(t)) setTags([...tags, t]);
    setTagInput('');
  };

  const removeTag = (t: string) => setTags(tags.filter((x) => x !== t));

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/library/${book.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title, author, description, publisher, language, tags,
          publishDate: publishDate || undefined,
          identifier: identifier || undefined,
          series: series || undefined,
          seriesIndex: seriesIndex ? parseFloat(seriesIndex) : undefined,
          rating: rating > 0 ? rating * 2 : undefined, // convert 1-5 → 1-10
          notes: notes || undefined,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? 'Save failed');
      const updated = await res.json() as BookSummary;
      onSaved(updated);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const inputCls = 'w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring transition-shadow';
  const labelCls = 'block text-xs font-medium text-muted-foreground mb-1';

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />

      {/* Panel */}
      <div className="relative z-10 w-full max-w-2xl max-h-[90vh] flex flex-col rounded-2xl border bg-card shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b shrink-0">
          <h2 className="font-semibold text-base">Edit Metadata</h2>
          <button onClick={onClose} className="rounded-lg p-1.5 hover:bg-muted transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
          {/* Title */}
          <div>
            <label className={labelCls}>Title *</label>
            <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} className={inputCls} />
          </div>

          {/* Author */}
          <div>
            <label className={labelCls}>Author</label>
            <input type="text" value={author} onChange={(e) => setAuthor(e.target.value)} className={inputCls} />
          </div>

          {/* 2-col: Publisher + Language */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Publisher</label>
              <input type="text" value={publisher} onChange={(e) => setPublisher(e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>Language</label>
              <select value={language} onChange={(e) => setLanguage(e.target.value)} className={inputCls}>
                {LANGUAGES.map((l) => (
                  <option key={l.value} value={l.value}>{l.label}</option>
                ))}
              </select>
            </div>
          </div>

          {/* 2-col: Publish Date + ISBN/Identifier */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Publish Date</label>
              <input type="text" value={publishDate} onChange={(e) => setPublishDate(e.target.value)} placeholder="e.g. 2023-01-15" className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>ISBN / Identifier</label>
              <input type="text" value={identifier} onChange={(e) => setIdentifier(e.target.value)} placeholder="e.g. 978-..." className={inputCls} />
            </div>
          </div>

          {/* 2-col: Series + Series Index */}
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <label className={labelCls}>Series</label>
              <input type="text" value={series} onChange={(e) => setSeries(e.target.value)} placeholder="Series name…" className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>Volume #</label>
              <input type="number" value={seriesIndex} onChange={(e) => setSeriesIndex(e.target.value)} step="0.1" min="0" placeholder="1" className={inputCls} />
            </div>
          </div>

          {/* Star Rating */}
          <div>
            <label className={labelCls}>Rating</label>
            <div className="flex gap-1.5 items-center">
              {[1, 2, 3, 4, 5].map((star) => (
                <button
                  key={star}
                  type="button"
                  onClick={() => setRating(rating === star ? 0 : star)}
                  className="focus:outline-none"
                >
                  <Star className={cn('h-5 w-5 transition-colors', star <= rating ? 'fill-amber-400 text-amber-400' : 'text-muted-foreground/30 hover:text-amber-300')} />
                </button>
              ))}
              {rating > 0 && <span className="text-xs text-muted-foreground ml-1">{rating}/5</span>}
            </div>
          </div>

          {/* Description */}
          <div>
            <label className={labelCls}>Description / Synopsis</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              className={`${inputCls} resize-y min-h-[80px]`}
              placeholder="Enter a brief description or synopsis…"
            />
          </div>

          {/* Tags */}
          <div>
            <label className={labelCls}>Tags</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag(); } }}
                placeholder="Add tag and press Enter…"
                className={`${inputCls} flex-1`}
              />
              <Button variant="outline" size="sm" onClick={addTag} type="button">
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </div>
            {tags.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {tags.map((t) => (
                  <span key={t} className="flex items-center gap-1 rounded-full bg-primary/10 text-primary px-2.5 py-1 text-xs font-medium">
                    <Tag className="h-3 w-3" />
                    {t}
                    <button
                      onClick={() => removeTag(t)}
                      className="ml-0.5 rounded-full hover:bg-primary/20 p-0.5 transition-colors"
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Notes */}
          <div>
            <label className={labelCls}>Personal Notes</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className={`${inputCls} resize-y`}
              placeholder="Private notes about this book…"
            />
          </div>

          {error && (
            <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 px-6 py-4 border-t shrink-0 bg-muted/30">
          <div className="text-xs text-muted-foreground">
            File: <span className="font-mono text-[10px]">{book.originalFilename}</span>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>Cancel</Button>
            <Button size="sm" onClick={handleSave} disabled={saving || !title.trim()}>
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Save className="h-3.5 w-3.5 mr-1" />}
              Save
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
