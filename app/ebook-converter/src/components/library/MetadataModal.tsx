'use client';
// src/components/library/MetadataModal.tsx
// Calibre-style metadata editor modal for books in the library
import { useId, useState } from 'react';
import { X, Save, Loader2, Tag, Plus, Star } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogFooter } from '@/components/ui/dialog';
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
  const id = useId();
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
          title: title.trim(),
          author: author.trim(),
          description: description.trim() || null,
          publisher: publisher.trim() || null,
          language,
          tags,
          publishDate: publishDate.trim() || null,
          identifier: identifier.trim() || null,
          series: series.trim() || null,
          seriesIndex: seriesIndex.trim() ? parseFloat(seriesIndex) : null,
          rating: rating > 0 ? rating * 2 : null, // convert 1-5 → 1-10; null clears
          notes: notes.trim() || null,
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
    <Dialog
      open
      onOpenChange={(open) => { if (!open) onClose(); }}
      title="Edit Metadata"
      description="Update library details, reading metadata, tags, and personal notes."
      widthClass="max-w-2xl"
    >
      <form onSubmit={(e) => { e.preventDefault(); void handleSave(); }} className="flex min-h-0 flex-1 flex-col">
        <DialogBody className="space-y-4">
          {/* Title */}
          <div>
            <label htmlFor={`${id}-title`} className={labelCls}>Title *</label>
            <input id={`${id}-title`} autoFocus required type="text" value={title} onChange={(e) => setTitle(e.target.value)} className={inputCls} />
          </div>

          {/* Author */}
          <div>
            <label htmlFor={`${id}-author`} className={labelCls}>Author</label>
            <input id={`${id}-author`} type="text" value={author} onChange={(e) => setAuthor(e.target.value)} className={inputCls} />
          </div>

          {/* 2-col: Publisher + Language */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor={`${id}-publisher`} className={labelCls}>Publisher</label>
              <input id={`${id}-publisher`} type="text" value={publisher} onChange={(e) => setPublisher(e.target.value)} className={inputCls} />
            </div>
            <div>
              <label htmlFor={`${id}-language`} className={labelCls}>Language</label>
              <select id={`${id}-language`} value={language} onChange={(e) => setLanguage(e.target.value)} className={inputCls}>
                {LANGUAGES.map((l) => (
                  <option key={l.value} value={l.value}>{l.label}</option>
                ))}
              </select>
            </div>
          </div>

          {/* 2-col: Publish Date + ISBN/Identifier */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor={`${id}-publish-date`} className={labelCls}>Publish Date</label>
              <input id={`${id}-publish-date`} type="text" value={publishDate} onChange={(e) => setPublishDate(e.target.value)} placeholder="e.g. 2023-01-15" className={inputCls} />
            </div>
            <div>
              <label htmlFor={`${id}-identifier`} className={labelCls}>ISBN / Identifier</label>
              <input id={`${id}-identifier`} type="text" value={identifier} onChange={(e) => setIdentifier(e.target.value)} placeholder="e.g. 978-..." className={inputCls} />
            </div>
          </div>

          {/* 2-col: Series + Series Index */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="sm:col-span-2">
              <label htmlFor={`${id}-series`} className={labelCls}>Series</label>
              <input id={`${id}-series`} type="text" value={series} onChange={(e) => setSeries(e.target.value)} placeholder="Series name…" className={inputCls} />
            </div>
            <div>
              <label htmlFor={`${id}-series-index`} className={labelCls}>Volume #</label>
              <input id={`${id}-series-index`} type="number" value={seriesIndex} onChange={(e) => setSeriesIndex(e.target.value)} step="0.1" min="0" placeholder="1" className={inputCls} />
            </div>
          </div>

          {/* Star Rating */}
          <div>
            <span id={`${id}-rating-label`} className={labelCls}>Rating</span>
            <div className="flex gap-1.5 items-center" role="group" aria-labelledby={`${id}-rating-label`}>
              {[1, 2, 3, 4, 5].map((star) => (
                <button
                  key={star}
                  type="button"
                  onClick={() => setRating(rating === star ? 0 : star)}
                  aria-label={`${star} out of 5 stars`}
                  aria-pressed={rating === star}
                  className="rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Star className={cn('h-5 w-5 transition-colors', star <= rating ? 'fill-amber-400 text-amber-400' : 'text-muted-foreground/30 hover:text-amber-300')} />
                </button>
              ))}
              {rating > 0 && <span className="text-xs text-muted-foreground ml-1">{rating}/5</span>}
            </div>
          </div>

          {/* Description */}
          <div>
            <label htmlFor={`${id}-description`} className={labelCls}>Description / Synopsis</label>
            <textarea
              id={`${id}-description`}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              className={`${inputCls} resize-y min-h-[80px]`}
              placeholder="Enter a brief description or synopsis…"
            />
          </div>

          {/* Tags */}
          <div>
            <label htmlFor={`${id}-tag-input`} className={labelCls}>Tags</label>
            <div className="flex gap-2">
              <input
                type="text"
                id={`${id}-tag-input`}
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
                      type="button"
                      onClick={() => removeTag(t)}
                      aria-label={`Remove tag ${t}`}
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
            <label htmlFor={`${id}-notes`} className={labelCls}>Personal Notes</label>
            <textarea
              id={`${id}-notes`}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className={`${inputCls} resize-y`}
              placeholder="Private notes about this book…"
            />
          </div>

          {error && (
            <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
          )}
        </DialogBody>

        <DialogFooter className="items-center justify-between sm:justify-between">
          <div className="min-w-0 max-w-full truncate text-xs text-muted-foreground">
            File: <span className="font-mono text-[10px]">{book.originalFilename}</span>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>Cancel</Button>
            <Button type="submit" size="sm" disabled={saving || !title.trim()}>
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Save className="h-3.5 w-3.5 mr-1" />}
              Save
            </Button>
          </div>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
