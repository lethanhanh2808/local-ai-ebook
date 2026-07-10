'use client';
// src/components/library/EpubEditor.tsx
// Small WYSIWYG EPUB chapter editor. Saves edits as a new library copy.

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  Bold,
  CopyPlus,
  Heading1,
  Heading2,
  ImagePlus,
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
import { useToast } from '@/components/ui/toast';
import { Card } from '@/components/ui/card';
import { Dialog, DialogBody } from '@/components/ui/dialog';
import { IllustrationsPanel } from '@/components/library/IllustrationsPanel';
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
  const toast = useToast();
  const [book, setBook] = useState<EditorBook | null>(null);
  const [chapters, setChapters] = useState<ChapterSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  // The chapter HTML lives in TWO places:
  //   1. `htmlRef` — the current DOM innerHTML of the contentEditable
  //      (the source of truth after mount; never read from state during
  //      composition, never written to by React after mount).
  //   2. `htmlBootstrap` — only used to bootstrap a chapter on load; set
  //      in loadChapter() and consumed by the bootstrap useEffect, then
  //      cleared so subsequent renders never touch the DOM.
  //
  // Why not `dangerouslySetInnerHTML={{__html: html}}`? Because React
  // re-applies that attribute on EVERY render — even when the value
  // hasn't changed, even mid-composition. That re-write of innerHTML
  // wipes the IME's intermediate buffer and you see characters appear
  // reversed / caret jump / diacritics dropped. The bootstrap pattern
  // below keeps React's hands off the contentEditable's DOM after the
  // initial population.
  const htmlRef = useRef<string>('');
  const [htmlBootstrap, setHtmlBootstrap] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [savedBookId, setSavedBookId] = useState<string | null>(null);
  const [illustOpen, setIllustOpen] = useState(false);
  // Number of already-generated illustrations — drives the "0 ảnh →
  // tạo" red-dot badge on the header trigger.
  const [illustCount, setIllustCount] = useState(0);
  const editorRef = useRef<HTMLDivElement | null>(null);
  // Vietnamese IME gate. Vietnamese input methods (Unikey, EVKey, Telex,
  // VNI) work via composition events: compositionstart → many
  // compositionupdate/input events → compositionend. While composing,
  // we ignore onInput AND we don't re-set innerHTML (we never do,
  // regardless). We sync the htmlRef once on compositionend so the next
  // Save uses the committed text — not the raw keystrokes.
  const composingRef = useRef(false);

  const loadChapter = useCallback(async (chapterId: string) => {
    setLoading(true);
    const res = await fetch(`/api/library/${bookId}/editor?chapterId=${encodeURIComponent(chapterId)}`, { cache: 'no-store' });
    if (!res.ok) throw new Error('Failed to load chapter');
    const data = await res.json();
    setBook(data.book);
    setChapters(data.chapters);
    setActiveId(data.chapter.id);
    setTitle(data.chapter.title);
    // Stage the chapter HTML as a "bootstrap" payload. The effect below
    // consumes it once, writes it into the DOM via the ref, and clears
    // the payload so subsequent renders never re-write innerHTML.
    htmlRef.current = data.chapter.html;
    setHtmlBootstrap(data.chapter.html);
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

  // Fetch illustration count once on mount — surfaces the red-dot
  // badge on the "Tạo ảnh" header trigger. The inline rail on the
  // right side reloads on its own (IllustrationsPanel owns its state).
  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/library/${bookId}/illustrations`, { cache: 'no-store' })
      .then((r) => r.ok ? r.json() : { illustrations: [] })
      .then((d) => { if (!cancelled) setIllustCount((d.illustrations ?? []).length); })
      .catch(() => { /* count stays 0 */ });
    return () => { cancelled = true; };
  }, [bookId]);

  // Bootstrap the contentEditable DOM from a staged chapter payload.
  // Runs ONCE per chapter-load: when htmlBootstrap is set (by loadChapter)
  // we copy it into the DOM via ref and clear the staged payload so this
  // effect short-circuits on subsequent renders. This is the entire
  // reason we don't use dangerouslySetInnerHTML — that re-applies on
  // every parent re-render and stomps the IME composition buffer.
  useEffect(() => {
    if (htmlBootstrap === null) return;
    if (editorRef.current && htmlBootstrap !== editorRef.current.innerHTML) {
      editorRef.current.innerHTML = htmlBootstrap;
      htmlRef.current = htmlBootstrap;
    }
    setHtmlBootstrap(null);
  }, [htmlBootstrap]);

  const command = (cmd: string, value?: string) => {
    editorRef.current?.focus();
    document.execCommand(cmd, false, value);
    htmlRef.current = editorRef.current?.innerHTML ?? '';
    setDirty(true);
  };

  const save = async (mode: 'save' | 'saveAs') => {
    if (!activeId) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/library/${bookId}/editor`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chapterId: activeId,
          title,
          mode,
          // Authoritative read: the live contentEditable DOM. Don't fall
          // back to any cached state — there isn't one (and there shouldn't
          // be) so we never accidentally save stale or pre-IME text.
          html: htmlRef.current,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Save failed');
      // Only 'saveAs' creates a brand-new library row, so the "Open
      // edited copy" link should surface only in that case. For 'save'
      // we just rewrote the current book in place — the existing link
      // (back to the reader of this book) keeps working as-is.
      if (data.mode === 'saveAs') {
        setSavedBookId(data.book.id);
      }
      setDirty(false);
      if (data.mode === 'saveAs') {
        toast.success('Saved as new copy', {
          description: `${data.book.title} is now in your library.`,
        });
      } else {
        toast.success('Saved to current book', {
          description: 'Use "Save As…" to keep an untouched original copy alongside this one.',
        });
      }
    } catch (err) {
      toast.error('Save failed', {
        description: err instanceof Error ? err.message : 'Unknown error',
      });
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
      <header className="sticky top-0 z-20 border-b border-border bg-background/95 backdrop-blur">
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
          {/* AI illustrations — primary CTA. On lg screens the right-rail
              <IllustrationsPanel variant="rail" /> is mounted, so this
              header trigger is mostly for tablet/mobile. We still keep
              it visible on all breakpoints because users come to it via
              muscle memory. Relabel "Tạo ảnh" matches the action the
              user wants ("generate picture"); the red-dot badge
              surfaces the "no images yet" state proactively. */}
          <Button
            variant="default"
            size="sm"
            onClick={() => setIllustOpen(true)}
            title="Tạo ảnh cho chapters"
            className="gap-1.5 relative"
          >
            <ImagePlus className="h-3.5 w-3.5" />
            Tạo ảnh
            {illustCount === 0 && (
              <span
                aria-label="Chưa có ảnh — bấm để tạo"
                className="ml-1 inline-block h-2 w-2 rounded-full bg-amber-400 shadow ring-1 ring-background"
              />
            )}
          </Button>
          {/* Book-detail hub link — surfaces Character Bible, Audiobook
              status, cover-regen, etc. The chapter editor is one of
              several places to act on a book; the detail page is the rest. */}
          <Link
            href={`/library/${bookId}`}
            title="Thông tin sách"
            className="inline-flex h-8 items-center justify-center rounded-md border border-border bg-background px-2.5 text-xs font-medium hover:bg-accent hover:text-accent-foreground"
          >
            Thông tin sách
          </Link>
          {savedBookId && savedBookId !== bookId && (
            <Link
              href={`/library/${savedBookId}/read`}
              className="inline-flex h-8 items-center justify-center rounded-md border border-border border-input bg-background px-3 text-xs font-medium hover:bg-accent hover:text-accent-foreground"
            >
              Open edited copy
            </Link>
          )}
          {/* Primary action: Save (in-place). Two save modes for editing
              a book, matching user expectations from any desktop editor:
              "Save" rewrites the current book on disk; "Save As…"
              duplicates the book into a new " - Edited" copy so the
              original is preserved untouched. */}
          <Button onClick={() => save('save')} disabled={!dirty || saving || loading} size="sm" className="gap-1.5">
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            Save
          </Button>
          <Button
            onClick={() => save('saveAs')}
            disabled={saving || loading}
            variant="outline"
            size="sm"
            className="gap-1.5"
            title="Create a new library copy titled '<book> - Edited'"
          >
            <CopyPlus className="h-3.5 w-3.5" />
            Save As…
          </Button>
        </div>
      </header>

      <div className="grid min-h-[calc(100vh-3.5rem)] grid-cols-1 lg:grid-cols-[280px_1fr_320px]">
        <aside className="border-b border-border bg-muted/20 lg:border-b-0 lg:border-r border-border">
          <div className="max-h-[42vh] overflow-auto p-2 lg:max-h-[calc(100vh-3.5rem)]">
            {chapters.map((chapter) => (
              <button
                key={chapter.id}
                onClick={() => {
                  if (!dirty) {
                    void loadChapter(chapter.id);
                    return;
                  }
                  toast.confirm({
                    title: 'Discard unsaved edits?',
                    description: 'Open another chapter without saving?',
                    confirmLabel: 'Discard',
                    destructive: true,
                    onConfirm: () => { void loadChapter(chapter.id); },
                  });
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

        <main className="min-w-0 border-r border-border">
          <div className="sticky top-14 z-10 border-b border-border bg-background/95 px-4 py-2 backdrop-blur">
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
                onCompositionStart={() => { composingRef.current = true; }}
                onCompositionEnd={(e) => {
                  composingRef.current = false;
                  // Sync the final committed string once composition is
                  // done — not on every keystroke during composition.
                  setTitle(e.currentTarget.value);
                  setDirty(true);
                }}
                onBlur={() => { composingRef.current = false; }}
                lang="vi"
                spellCheck={false}
                className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-sm font-medium"
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
                lang="vi"
                spellCheck={false}
                onCompositionStart={() => { composingRef.current = true; }}
                onCompositionEnd={(event) => {
                  composingRef.current = false;
                  // One-shot sync after IME finishes — never during.
                  htmlRef.current = event.currentTarget.innerHTML;
                  setDirty(true);
                }}
                onInput={(event) => {
                  if (composingRef.current) return;
                  // Just track the latest innerHTML in a ref. Do NOT
                  // call setState and do NOT touch innerHTML here —
                  // both break IME. The DOM is the source of truth.
                  htmlRef.current = event.currentTarget.innerHTML;
                  setDirty(true);
                }}
                onBlur={() => { composingRef.current = false; }}
                className="min-h-[70vh] px-8 py-8 font-serif text-[18px] leading-8 outline-none shadow-sm focus:ring-2 focus:ring-primary/30 [&_blockquote]:mx-8 [&_blockquote]:my-6 [&_blockquote]:border-l-2 [&_blockquote]:pl-4 [&_h1]:mb-6 [&_h1]:mt-8 [&_h1]:text-center [&_h1]:text-3xl [&_h2]:mb-4 [&_h2]:mt-8 [&_h2]:text-center [&_h2]:text-2xl [&_hr]:my-8 [&_p]:my-0 [&_p]:indent-8"
              />
            )}
          </div>
        </main>

        {/* Right-side illustrations rail — only on lg+. Below lg the
            rail collapses and the header "Tạo ảnh" button opens the
            same panel inside a <Dialog>. The rail is `sticky top-14` so
            it stays visible while the user scrolls the chapter body. */}
        <aside className="hidden lg:block bg-muted/20">
          <div className="sticky top-14 max-h-[calc(100vh-3.5rem)] overflow-auto p-2">
            <IllustrationsPanel bookId={bookId} variant="rail" />
          </div>
        </aside>
      </div>

      {/* AI Illustrations modal — used by tablet/mobile where the rail
          isn't visible, and as the click-target on the header "Tạo ảnh"
          button at any breakpoint. */}
      {illustOpen && (
        <Dialog open onOpenChange={(v) => { if (!v) setIllustOpen(false); }} widthClass="max-w-2xl" title="AI Illustrations">
          <DialogBody>
            <IllustrationsPanel bookId={bookId} />
          </DialogBody>
        </Dialog>
      )}
    </div>
  );
}
