'use client';
// src/components/library/EpubEditor.tsx
// Small WYSIWYG EPUB chapter editor. Saves edits as a new library copy.

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  Bold,
  Heading1,
  Heading2,
  Italic,
  ListOrdered,
  Loader2,
  Pilcrow,
  Quote,
  Redo2,
  Save,
  Undo2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface ChapterSummary {
  id: string;
  file: string;
  order: number;
  title: string;
}

interface EditorBook {
  id: string;
  title: string;
  author: string;
}

interface EpubEditorProps {
  bookId: string;
}

export function EpubEditor({ bookId }: EpubEditorProps) {
  const [book, setBook] = useState<EditorBook | null>(null);
  const [chapters, setChapters] = useState<ChapterSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [html, setHtml] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [savedBookId, setSavedBookId] = useState<string | null>(null);
  const editorRef = useRef<HTMLDivElement | null>(null);

  const loadChapter = useCallback(async (chapterId: string) => {
    setLoading(true);
    const res = await fetch(`/api/library/${bookId}/editor?chapterId=${encodeURIComponent(chapterId)}`, { cache: 'no-store' });
    if (!res.ok) throw new Error('Failed to load chapter');
    const data = await res.json();
    setBook(data.book);
    setChapters(data.chapters);
    setActiveId(data.chapter.id);
    setTitle(data.chapter.title);
    setHtml(data.chapter.html);
    setDirty(false);
    setSavedBookId(null);
    setLoading(false);
  }, [bookId]);

  useEffect(() => {
    let cancelled = false;
    async function init() {
      setLoading(true);
      const res = await fetch(`/api/library/${bookId}/editor`, { cache: 'no-store' });
      if (!res.ok) throw new Error('Failed to load editor');
      const data = await res.json();
      if (cancelled) return;
      setBook(data.book);
      setChapters(data.chapters);
      const first = data.chapters?.[0]?.id;
      if (first) await loadChapter(first);
      else setLoading(false);
    }
    void init().catch(() => setLoading(false));
    return () => { cancelled = true; };
  }, [bookId, loadChapter]);

  const command = (cmd: string, value?: string) => {
    editorRef.current?.focus();
    document.execCommand(cmd, false, value);
    setHtml(editorRef.current?.innerHTML ?? '');
    setDirty(true);
  };

  const save = async () => {
    if (!activeId) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/library/${bookId}/editor`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chapterId: activeId,
          title,
          html: editorRef.current?.innerHTML ?? html,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Save failed');
      setSavedBookId(data.book.id);
      setDirty(false);
    } finally {
      setSaving(false);
    }
  };

  const tools = [
    { title: 'Undo', icon: Undo2, run: () => command('undo') },
    { title: 'Redo', icon: Redo2, run: () => command('redo') },
    { title: 'Paragraph', icon: Pilcrow, run: () => command('formatBlock', 'p') },
    { title: 'Heading 1', icon: Heading1, run: () => command('formatBlock', 'h1') },
    { title: 'Heading 2', icon: Heading2, run: () => command('formatBlock', 'h2') },
    { title: 'Bold', icon: Bold, run: () => command('bold') },
    { title: 'Italic', icon: Italic, run: () => command('italic') },
    { title: 'Quote', icon: Quote, run: () => command('formatBlock', 'blockquote') },
    { title: 'Ordered list', icon: ListOrdered, run: () => command('insertOrderedList') },
  ];

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-20 border-b bg-background/95 backdrop-blur">
        <div className="flex h-14 items-center gap-2 px-4">
          <Link
            href={`/library/${bookId}/read`}
            title="Back to reader"
            className="inline-flex h-9 w-9 items-center justify-center rounded-md hover:bg-accent hover:text-accent-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-semibold">{book?.title ?? 'EPUB editor'}</h1>
            <p className="truncate text-[11px] text-muted-foreground">{book?.author ?? ''}</p>
          </div>
          {savedBookId && (
            <Link
              href={`/library/${savedBookId}/read`}
              className="inline-flex h-8 items-center justify-center rounded-md border border-input bg-background px-3 text-xs font-medium hover:bg-accent hover:text-accent-foreground"
            >
              Open edited copy
            </Link>
          )}
          <Button onClick={save} disabled={!dirty || saving || loading} size="sm" className="gap-1.5">
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            Save copy
          </Button>
        </div>
      </header>

      <div className="grid min-h-[calc(100vh-3.5rem)] grid-cols-1 lg:grid-cols-[280px_1fr]">
        <aside className="border-b bg-muted/20 lg:border-b-0 lg:border-r">
          <div className="max-h-[42vh] overflow-auto p-2 lg:max-h-[calc(100vh-3.5rem)]">
            {chapters.map((chapter) => (
              <button
                key={chapter.id}
                onClick={() => {
                  if (dirty && !confirm('Discard unsaved edits and open another chapter?')) return;
                  void loadChapter(chapter.id);
                }}
                className={cn(
                  'mb-1 flex w-full items-start gap-2 rounded-md px-2 py-2 text-left text-xs transition-colors',
                  activeId === chapter.id ? 'bg-primary text-primary-foreground' : 'hover:bg-muted',
                )}
              >
                <span className="mt-0.5 w-7 shrink-0 text-[10px] tabular-nums opacity-70">{chapter.order}</span>
                <span className="line-clamp-2">{chapter.title}</span>
              </button>
            ))}
          </div>
        </aside>

        <main className="min-w-0">
          <div className="sticky top-14 z-10 border-b bg-background/95 px-4 py-2 backdrop-blur">
            <div className="flex flex-wrap items-center gap-1">
              {tools.map(({ title: toolTitle, icon: Icon, run }) => (
                <Button key={toolTitle} type="button" variant="ghost" size="icon" title={toolTitle} onClick={run} className="h-8 w-8">
                  <Icon className="h-4 w-4" />
                </Button>
              ))}
              <div className="mx-2 h-6 w-px bg-border" />
              <input
                value={title}
                onChange={(e) => { setTitle(e.target.value); setDirty(true); }}
                className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm font-medium"
                aria-label="Chapter title"
              />
            </div>
          </div>

          <div className="mx-auto max-w-4xl px-4 py-6">
            {loading ? (
              <div className="flex h-80 items-center justify-center text-sm text-muted-foreground">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading
              </div>
            ) : (
              <div
                key={activeId}
                ref={editorRef}
                contentEditable
                suppressContentEditableWarning
                onInput={(event) => {
                  setHtml(event.currentTarget.innerHTML);
                  setDirty(true);
                }}
                dangerouslySetInnerHTML={{ __html: html }}
                className="min-h-[70vh] rounded-lg border bg-card px-8 py-8 font-serif text-[18px] leading-8 outline-none shadow-sm focus:ring-2 focus:ring-primary/30 [&_blockquote]:mx-8 [&_blockquote]:my-6 [&_blockquote]:border-l-2 [&_blockquote]:pl-4 [&_h1]:mb-6 [&_h1]:mt-8 [&_h1]:text-center [&_h1]:text-3xl [&_h2]:mb-4 [&_h2]:mt-8 [&_h2]:text-center [&_h2]:text-2xl [&_hr]:my-8 [&_p]:my-0 [&_p]:indent-8"
              />
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
