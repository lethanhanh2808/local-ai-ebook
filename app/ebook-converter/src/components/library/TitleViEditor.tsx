// src/components/library/TitleViEditor.tsx
//
// Inline editor for Book.titleVi — the optional Vietnamese title used by
// the cover generator. Falls back to `title` when null. Keeps a small
// inline pattern: click to edit, blur or Enter to save, Esc to cancel.
//
// Why inline + not a separate page: this is a one-line field per book;
// routing away from /library/<id> just to type the title is overkill.
'use client';

import { useEffect, useState } from 'react';
import { Pencil, Check, X, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface TitleViEditorProps {
  bookId: string;
  /** The book's stored title — shown when titleVi is null so the user can
   *  see what the cover currently renders. */
  fallbackTitle: string;
  initialTitleVi: string | null;
}

export function TitleViEditor({ bookId, fallbackTitle, initialTitleVi }: TitleViEditorProps) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(initialTitleVi ?? '');
  const [committed, setCommitted] = useState(initialTitleVi);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setValue(initialTitleVi ?? '');
    setCommitted(initialTitleVi);
  }, [initialTitleVi]);

  const startEdit = () => {
    setValue(committed ?? '');
    setError(null);
    setEditing(true);
  };
  const cancel = () => {
    setValue(committed ?? '');
    setEditing(false);
    setError(null);
  };
  const save = async (next: string | null) => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/library/${bookId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ titleVi: next }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({} as any));
        throw new Error(d.error ?? `HTTP ${res.status}`);
      }
      setCommitted(next);
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };
  const onSave = () => {
    const trimmed = value.trim();
    void save(trimmed === '' ? null : trimmed);
  };
  const onKeyDown = (ev: React.KeyboardEvent<HTMLInputElement>) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      onSave();
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      cancel();
    }
  };

  if (editing) {
    return (
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={saving}
            placeholder={fallbackTitle}
            className="h-8 flex-1 rounded-md border border-border bg-background px-2 text-sm font-medium"
            aria-label="Vietnamese title for cover"
            autoFocus
          />
          <Button size="sm" variant="default" onClick={onSave} disabled={saving} className="h-8 px-2">
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
          </Button>
          <Button size="sm" variant="outline" onClick={cancel} disabled={saving} className="h-8 px-2">
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
        {error && <p className="text-[10px] text-destructive">{error}</p>}
        <p className="text-[10px] text-muted-foreground">
          Để trống = dùng nguyên tiêu đề gốc. Bìa sách sẽ in tiêu đề này.
        </p>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-2">
      <div className="flex-1 min-w-0">
        <p className={cn('font-medium break-words', !committed && 'italic text-muted-foreground')}>
          {committed || <span>(chưa set — bìa sẽ dùng &quot;{fallbackTitle}&quot;)</span>}
        </p>
        <p className="text-[10px] text-muted-foreground mt-0.5">
          Vietnamese title in cover. Falls back to stored title when empty.
        </p>
      </div>
      <Button size="sm" variant="ghost" onClick={startEdit} className="h-7 px-2 text-[11px]" title="Sửa">
        <Pencil className="h-3 w-3" />
      </Button>
    </div>
  );
}
