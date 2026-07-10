// src/components/library/IllustrationsGallery.tsx
//
// "View all images" modal for the EbookReader. Lists every generated
// illustration in the current book as a thumbnail grid; clicking a
// thumbnail jumps the reader to that chapter.
//
// Self-contained — fetches its own list, handles loading / empty / error
// states, lazy-loads thumbnails, calls onJumpChapter when the user picks
// one so the parent reader can update its currentIdx.
'use client';

import { useEffect, useState } from 'react';
import { ImageIcon, Loader2, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface Illustration {
  id: string;
  bookId: string;
  chapterIndex: number;
  chapterTitle: string;
  prompt?: string | null;
  imageModel?: string | null;
  generatedAt: string;
}

interface IllustrationsGalleryProps {
  bookId: string;
  /** When provided, the chapter-title bar of the active chapter is
   *  highlighted. Pass the current chapter's 0-based index. */
  currentChapterIdx?: number;
  /** Called with the chapter index when the user clicks a thumbnail. */
  onJumpChapter: (chapterIndex: number) => void;
  /** Optional inline className for the inner grid wrapper. */
  className?: string;
}

export function IllustrationsGallery({
  bookId,
  currentChapterIdx,
  onJumpChapter,
  className,
}: IllustrationsGalleryProps) {
  const [items, setItems] = useState<Illustration[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setErr(null);
      try {
        const res = await fetch(`/api/library/${bookId}/illustrations`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json() as { illustrations: Illustration[] };
        if (!cancelled) setItems(data.illustrations ?? []);
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [bookId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-12 text-xs text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Đang tải gallery…
      </div>
    );
  }
  if (err) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
        Không tải được ảnh: {err}
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-10 text-xs text-muted-foreground">
        <ImageIcon className="h-8 w-8 opacity-40" />
        <p>Chưa có illustration nào trong sách này.</p>
        <p>Vào <span className="font-semibold">Thông tin sách → AI Illustrations</span> để generate.</p>
      </div>
    );
  }

  return (
    <div className={cn('space-y-2', className)}>
      <p className="text-[11px] text-muted-foreground">
        {items.length} ảnh đã generate. Click để nhảy tới chapter.
      </p>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3 max-h-[60vh] overflow-y-auto pr-1">
        {items.map((it) => {
          const isCurrent = currentChapterIdx === it.chapterIndex;
          return (
            <button
              key={it.id}
              onClick={() => onJumpChapter(it.chapterIndex)}
              className={cn(
                'group relative flex flex-col gap-1 rounded-md overflow-hidden border bg-card text-left transition-all hover:shadow-md',
                isCurrent
                  ? 'border-primary ring-2 ring-primary/40'
                  : 'border-border hover:border-primary/50',
              )}
              title={`Chapter ${it.chapterIndex + 1}: ${it.chapterTitle || 'Chương ' + (it.chapterIndex + 1)}`}
            >
              <div className="relative aspect-[3/4] bg-muted overflow-hidden">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/api/library/${bookId}/illustrations/${it.chapterIndex}`}
                  alt={it.chapterTitle || `Chapter ${it.chapterIndex + 1}`}
                  loading="lazy"
                  className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                />
                <div className="absolute top-1 left-1 rounded-full bg-background/85 backdrop-blur px-1.5 py-0.5 text-[9px] font-semibold tabular-nums">
                  Ch. {it.chapterIndex + 1}
                </div>
                {isCurrent && (
                  <div className="absolute top-1 right-1 rounded-full bg-primary text-primary-foreground px-1.5 py-0.5 text-[9px] font-semibold">
                    Hiện tại
                  </div>
                )}
              </div>
              <div className="px-1.5 py-1.5 space-y-0.5">
                <p className="text-[10px] font-medium truncate">
                  {it.chapterTitle || `Chương ${it.chapterIndex + 1}`}
                </p>
                {it.prompt && (
                  <p className="text-[9px] text-muted-foreground line-clamp-2 font-mono leading-tight">
                    {it.prompt.slice(0, 90)}{it.prompt.length > 90 ? '…' : ''}
                  </p>
                )}
                <p className="text-[8px] text-muted-foreground/70 flex items-center gap-1">
                  {it.imageModel || 'image-01'}
                </p>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
