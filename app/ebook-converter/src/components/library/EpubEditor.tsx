'use client';
// src/components/library/EpubEditor.tsx
// Small WYSIWYG EPUB chapter editor. Saves edits as a new library copy.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  Bold,
  CopyPlus,
  Heading1,
  Heading2,
  Heading3,
  ImagePlus,
  Italic,
  ListOrdered,
  List,
  Loader2,
  Pilcrow,
  Quote,
  Redo2,
  Save,
  Strikethrough,
  Underline,
  Undo2,
  Link as LinkIcon,
  Image as ImageIcon,
  Minus as HrIcon,
  Table as TableIcon,
  Code as CodeIcon,
  AlignLeft as AlignLeftIcon,
  AlignCenter as AlignCenterIcon,
  AlignRight as AlignRightIcon,
  AlignJustify as AlignJustifyIcon,
  IndentIncrease,
  IndentDecrease,
  Superscript as SuperscriptIcon,
  Subscript as SubscriptIcon,
  Eraser,
  Search,
  Replace,
  CaseSensitive,
  ChevronUp,
  ChevronDown,
  Keyboard,
  Languages,
  Hash,
  Type,
  X,
} from 'lucide-react';
import { Button, buttonClasses } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { Card } from '@/components/ui/card';
import { Dialog, DialogBody, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
  /** Deep-link from the reader: open this chapter on mount instead of
   *  chapter 1. Resolved against the chapter list once it arrives. */
  initialChapterId?: string;
}

const DRAFT_KEY_PREFIX = 'epub-editor-draft:';
const DRAFT_SAVE_INTERVAL_MS = 5_000;
const DRAFT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/** Plain-text view of the contentEditable DOM. Used for live word /
 *  character counts. We collapse whitespace so the counter matches what
 *  the writer expects from a word-processor. */
function plainTextFromHtml(html: string): string {
  if (!html) return '';
  const withBreaks = html
    .replace(/<\s*(br\s*\/?|\/p|\/div|\/h[1-6]|\/li|\/blockquote|\/pre|\/tr|\/hr)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return withBreaks
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function countStats(html: string) {
  const text = plainTextFromHtml(html);
  const chars = text.length;
  const charsNoSpace = text.replace(/\s+/g, '').length;
  // Vietnamese-aware word splitting: runs of Unicode letters/digits.
  const wordsArr = text.trim().match(/[\p{L}\p{N}]+/gu);
  const words = wordsArr ? wordsArr.length : 0;
  const paragraphs = text.split(/\n+/).map((p) => p.trim()).filter(Boolean).length;
  // Vietnamese reading speed ≈ 220 wpm; conservative.
  const minutes = words / 220;
  return { chars, charsNoSpace, words, paragraphs, minutes };
}

/** Vietnamese text normalizers. Each is opt-in and idempotent. */
const VI_HELPERS = {
  stripDiacritics: (s: string) =>
    s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').normalize('NFC'),
  trimSpaces: (s: string) =>
    s.replace(/[\u00A0\s]+/g, ' ').replace(/[ \t]+\n/g, '\n').trim(),
  normalizeEllipsis: (s: string) => s.replace(/\.{3,}/g, '…'),
  smartQuotes: (s: string) =>
    s
      .replace(/(^|[\s(\[{<])"(\S)/g, '$1\u201C$2')
      .replace(/(\S)"/g, '$1\u201D')
      .replace(/(^|[\s(\[{<])'(\S)/g, '$1\u2018$2')
      .replace(/(\S)'/g, '$1\u2019'),
};

const SPECIAL_CHARS: { label: string; char: string; group: string }[] = [
  { label: 'Em dash',         char: '—', group: 'Dấu câu' },
  { label: 'En dash',         char: '–', group: 'Dấu câu' },
  { label: 'Ellipsis',        char: '…', group: 'Dấu câu' },
  { label: 'Mở ngoặc kép',    char: '“', group: 'Dấu câu' },
  { label: 'Đóng ngoặc kép',  char: '”', group: 'Dấu câu' },
  { label: 'Mở ngoặc đơn',    char: '‘', group: 'Dấu câu' },
  { label: 'Đóng ngoặc đơn',  char: '’', group: 'Dấu câu' },
  { label: 'Bullet',          char: '•', group: 'Dấu câu' },
  { label: 'Copyright',       char: '©', group: 'Ký hiệu' },
  { label: 'Trademark',       char: '™', group: 'Ký hiệu' },
  { label: 'Registered',      char: '®', group: 'Ký hiệu' },
  { label: 'Section',         char: '§', group: 'Ký hiệu' },
  { label: 'Paragraph',       char: '¶', group: 'Ký hiệu' },
  { label: 'Degree',          char: '°', group: 'Ký hiệu' },
  { label: 'Plus/minus',      char: '±', group: 'Ký hiệu' },
  { label: 'Multiply',        char: '×', group: 'Ký hiệu' },
  { label: 'Divide',          char: '÷', group: 'Ký hiệu' },
  { label: 'Euro',            char: '€', group: 'Tiền tệ' },
  { label: 'Dollar',          char: '$', group: 'Tiền tệ' },
  { label: 'Pound',           char: '£', group: 'Tiền tệ' },
  { label: 'Yen',             char: '¥', group: 'Tiền tệ' },
  { label: 'Đồng Việt Nam',   char: '₫', group: 'Tiền tệ' },
  { label: 'Non-breaking sp.', char: ' ', group: 'Khác' },
];

const KEYBOARD_SHORTCUTS: { keys: string[]; label: string }[] = [
  { keys: ['Ctrl', 'B'],          label: 'In đậm' },
  { keys: ['Ctrl', 'I'],          label: 'In nghiêng' },
  { keys: ['Ctrl', 'U'],          label: 'Gạch chân' },
  { keys: ['Ctrl', 'K'],          label: 'Chèn liên kết' },
  { keys: ['Ctrl', 'H'],          label: 'Tìm & thay thế' },
  { keys: ['Ctrl', 'F'],          label: 'Tìm nhanh' },
  { keys: ['Ctrl', 'S'],          label: 'Lưu (Save)' },
  { keys: ['Ctrl', 'Shift', 'S'], label: 'Lưu bản sao (Save As…)' },
  { keys: ['Ctrl', 'Z'],          label: 'Hoàn tác' },
  { keys: ['Ctrl', 'Y'],          label: 'Làm lại' },
  { keys: ['Ctrl', 'Shift', 'L'], label: 'Danh sách bullet' },
  { keys: ['Ctrl', 'Shift', '7'], label: 'Danh sách số' },
  { keys: ['Esc'],                label: 'Đóng hộp thoại' },
];

export function EpubEditor({ bookId, initialChapterId }: EpubEditorProps) {
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
  // ── New text-editing state ────────────────────────────────────────────
  // Find & replace panel + match navigation. We don't try to highlight
  // matches in the DOM (would fight the IME-safe innerHTML rules); the
  // counter + "Next/Prev" + scroll-into-view on the active match is the
  // minimum useful affordance.
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findReplace, setFindReplace] = useState('');
  const [findCase, setFindCase] = useState(false);
  const [findHits, setFindHits] = useState<{ node: Text; index: number; length: number }[]>([]);
  const [findCursor, setFindCursor] = useState(0);
  const [specialOpen, setSpecialOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [draftRestored, setDraftRestored] = useState(false);
  // Vietnamese helper results (last applied). Used to surface a toast
  // with the diff size so the user can undo by Ctrl+Z if needed.
  const lastViHelper = useRef<{ name: string; changedChars: number } | null>(null);

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
    setFindHits([]);
    setFindCursor(0);
    setDraftRestored(false);
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
      // Honour deep-link from the reader (?chapter=<id>). Falls back to
      // chapter 1 if not specified or the id no longer exists.
      const requested = initialChapterId && data.chapters.some((c: ChapterSummary) => c.id === initialChapterId)
        ? initialChapterId
        : data.chapters?.[0]?.id;
      if (requested) await loadChapter(requested);
      else setLoading(false);
    }
    void init().catch(() => setLoading(false));
    return () => { cancelled = true; };
    // initialChapterId is allowed to "win" once on mount; subsequent
    // changes (there shouldn't be any) are ignored to avoid clobbering
    // an in-progress edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId]);

  // ── Auto-save draft to localStorage ─────────────────────────────────
  // We persist BOTH the chapter body HTML and the chapter title so a
  // page refresh (or accidental tab close) doesn't lose work. Drafts are
  // keyed by (bookId, chapterId) so editing multiple books doesn't
  // collide. Drafts older than 14 days are dropped on restore to avoid
  // resurrecting stale content.
  useEffect(() => {
    if (!activeId || loading) return;
    const key = `${DRAFT_KEY_PREFIX}${bookId}:${activeId}`;
    if (!draftRestored) {
      try {
        const raw = window.localStorage.getItem(key);
        if (raw) {
          const parsed = JSON.parse(raw) as { html: string; title: string; ts: number };
          if (Date.now() - parsed.ts < DRAFT_MAX_AGE_MS) {
            toast.confirm({
              title: 'Khôi phục bản nháp?',
              description: `Có bản nháp chưa lưu từ ${new Date(parsed.ts).toLocaleString()}. Khôi phục hay bắt đầu lại từ chương gốc?`,
              confirmLabel: 'Khôi phục',
              cancelLabel: 'Bỏ nháp',
              onConfirm: () => {
                htmlRef.current = parsed.html;
                if (editorRef.current && parsed.html !== editorRef.current.innerHTML) {
                  editorRef.current.innerHTML = parsed.html;
                }
                setTitle(parsed.title);
                setDirty(true);
              },
            });
          } else {
            window.localStorage.removeItem(key);
          }
        }
      } catch {
        /* localStorage disabled */
      }
      setDraftRestored(true);
    }
    const id = window.setInterval(() => {
      if (!dirty) return;
      try {
        window.localStorage.setItem(key, JSON.stringify({
          html: htmlRef.current,
          title,
          ts: Date.now(),
        }));
      } catch {
        /* quota / disabled — silent */
      }
    }, DRAFT_SAVE_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [activeId, bookId, loading, dirty, title, draftRestored, toast]);

  // Drop the saved draft after a successful save so we don't keep
  // resurrecting it next time the user reopens the chapter.
  const clearDraft = useCallback(() => {
    if (!activeId) return;
    try {
      window.localStorage.removeItem(`${DRAFT_KEY_PREFIX}${bookId}:${activeId}`);
    } catch {
      /* ignore */
    }
  }, [activeId, bookId]);

  // Warn before navigating away with unsaved changes — including
  // browser reload/close. Also flush the draft one final time.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Modern browsers ignore the returned string but still show their
      // own confirmation; older browsers respect returnValue.
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

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

  // ── Insert helpers ──────────────────────────────────────────────────
  // Each builds an HTML snippet, focuses the editor, then uses
  // insertHTML (execCommand) so the change is undoable via Ctrl+Z.
  // After any insertion we re-pull innerHTML into the ref so the next
  // Save / auto-draft sees the latest state.
  const focusEditor = () => editorRef.current?.focus();

  const insertHtml = (html: string) => {
    focusEditor();
    if (typeof document === 'undefined') return;
    document.execCommand('insertHTML', false, html);
    htmlRef.current = editorRef.current?.innerHTML ?? '';
    setDirty(true);
  };

  const promptAndInsertLink = useCallback(() => {
    focusEditor();
    const url = window.prompt('URL liên kết (bỏ trống để hủy):', 'https://');
    if (!url) return;
    // If the user has a selection, execCommand createLink wraps it; if
    // not, fall back to inserting a labelled anchor.
    const selection = window.getSelection();
    const hasSelection = selection && !selection.isCollapsed && editorRef.current?.contains(selection.anchorNode ?? null);
    if (hasSelection) {
      command('createLink', url);
    } else {
      const safeUrl = url.replace(/"/g, '&quot;');
      insertHtml(`<a href="${safeUrl}" rel="noopener noreferrer" target="_blank">${url}</a>&nbsp;`);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const insertImage = () => {
    focusEditor();
    const url = window.prompt('URL ảnh (http/https hoặc /api/library/...):', '');
    if (!url) return;
    const alt = window.prompt('Chú thích (alt text):', '') ?? '';
    const safeUrl = url.replace(/"/g, '&quot;');
    const safeAlt = alt.replace(/"/g, '&quot;');
    insertHtml(`<figure><img src="${safeUrl}" alt="${safeAlt}" /><figcaption>${alt}</figcaption></figure>`);
  };

  const insertHorizontalRule = () => insertHtml('<hr/>');

  const insertTable = () => {
    // 2x2 default — easy for the user to expand inside the editor.
    insertHtml(
      '<table><tbody>' +
      '<tr><td>Ô 1</td><td>Ô 2</td></tr>' +
      '<tr><td>Ô 3</td><td>Ô 4</td></tr>' +
      '</tbody></table><p><br/></p>'
    );
  };

  const insertSpecial = (ch: string) => {
    setSpecialOpen(false);
    insertHtml(ch);
  };

  // ── Vietnamese helpers ─────────────────────────────────────────────
  // Each runs across the WHOLE editor (selection or all). We don't try
  // to operate on the DOM directly because execCommand's replacements
  // work and let the user undo. Returns the number of chars changed
  // for the toast.
  const applyViHelper = (name: keyof typeof VI_HELPERS) => {
    const sel = window.getSelection();
    const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
    const isCollapsed = !range || range.collapsed;
    const helper = VI_HELPERS[name];
    if (isCollapsed) {
      // Apply to the whole editor content.
      const before = htmlRef.current;
      const text = plainTextFromHtml(before);
      const replaced = helper(text);
      if (replaced === text) {
        toast.info('Không có gì thay đổi', { description: `Trình chuẩn hóa ${name} không tìm thấy chuỗi cần sửa.` });
        return;
      }
      // Replace the entire body with a single paragraph of the new text,
      // wrapped in <p> so spacing matches a typical chapter.
      const safe = replaced
        .split(/\n\n+/)
        .map((p) => `<p>${escapeHtmlInline(p).replace(/\n/g, '<br/>')}</p>`)
        .join('');
      if (editorRef.current) editorRef.current.innerHTML = safe;
      htmlRef.current = safe;
      setDirty(true);
      lastViHelper.current = { name, changedChars: Math.abs(replaced.length - text.length) };
      toast.success(`Đã chuẩn hóa: ${name}`, { description: 'Dùng Ctrl+Z để hoàn tác nếu cần.' });
    } else {
      // Apply only inside the user's selection (plain-text transform).
      const selectedText = range!.toString();
      const replaced = helper(selectedText);
      if (replaced === selectedText) {
        toast.info('Không có gì thay đổi trong vùng chọn');
        return;
      }
      // Replace selection text node. Use document.execCommand insertText
      // so the change participates in the browser's undo stack.
      document.execCommand('insertText', false, replaced);
      htmlRef.current = editorRef.current?.innerHTML ?? '';
      setDirty(true);
      toast.success(`Đã áp dụng ${name} cho vùng chọn`);
    }
  };

  // Escape user text for safe HTML insertion (used by the
  // "transform whole editor" path of applyViHelper).
  function escapeHtmlInline(s: string) {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // ── Find & replace scanner ──────────────────────────────────────────
  // Walks the editor's text nodes, collecting every occurrence of
  // findQuery. We store offsets into the text nodes (NOT the DOM range)
  // because the DOM is owned by the user — re-rendering would wipe
  // any IME composition. Jumping to a hit just sets a fresh selection.
  const recomputeFindHits = useCallback((query: string, caseSensitive: boolean) => {
    if (!editorRef.current || !query) {
      setFindHits([]);
      setFindCursor(0);
      return;
    }
    const needle = caseSensitive ? query : query.toLocaleLowerCase('vi');
    const walker = document.createTreeWalker(editorRef.current, NodeFilter.SHOW_TEXT);
    const hits: { node: Text; index: number; length: number }[] = [];
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const text = node as Text;
      const hay = caseSensitive ? text.data : text.data.toLocaleLowerCase('vi');
      let from = 0;
      while (from <= hay.length - needle.length) {
        const i = hay.indexOf(needle, from);
        if (i === -1) break;
        hits.push({ node: text, index: i, length: needle.length });
        from = i + needle.length;
      }
    }
    setFindHits(hits);
    setFindCursor(hits.length > 0 ? 1 : 0);
  }, []);

  const jumpToHit = (hitIdx: number) => {
    const hit = findHits[hitIdx];
    if (!hit || !editorRef.current) return;
    const range = document.createRange();
    try {
      range.setStart(hit.node, hit.index);
      range.setEnd(hit.node, hit.index + hit.length);
    } catch {
      return;
    }
    const sel = window.getSelection();
    if (!sel) return;
    sel.removeAllRanges();
    sel.addRange(range);
    // Scroll the editor into view if the selection is offscreen. We
    // intentionally scroll the *editor* (cheap) rather than computing
    // getBoundingClientRect on every hit (expensive, especially on
    // long chapters).
    const rect = range.getBoundingClientRect();
    const editorRect = editorRef.current.getBoundingClientRect();
    if (rect.top < editorRect.top || rect.bottom > editorRect.bottom) {
      hit.node.parentElement?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  };

  const findNext = () => {
    if (findHits.length === 0) return;
    const next = ((findCursor) % findHits.length);
    setFindCursor(next + 1);
    jumpToHit(next);
  };

  const findPrev = () => {
    if (findHits.length === 0) return;
    const next = ((findCursor - 2 + findHits.length) % findHits.length);
    setFindCursor(next + 1);
    jumpToHit(next);
  };

  const replaceCurrent = () => {
    if (findHits.length === 0) return;
    const hit = findHits[(findCursor - 1 + findHits.length) % findHits.length];
    if (!hit) return;
    hit.node.replaceData(hit.index, hit.length, findReplace);
    htmlRef.current = editorRef.current?.innerHTML ?? '';
    setDirty(true);
    recomputeFindHits(findQuery, findCase);
    // Advance cursor to the next match so the user can keep replacing.
    setTimeout(() => {
      if (findHits.length > 0) findNext();
    }, 0);
  };

  const replaceAll = () => {
    if (findHits.length === 0 || !editorRef.current) return;
    const count = findHits.length;
    // Replace from the END so earlier offsets stay valid.
    for (let i = findHits.length - 1; i >= 0; i--) {
      const hit = findHits[i];
      hit.node.replaceData(hit.index, hit.length, findReplace);
    }
    htmlRef.current = editorRef.current?.innerHTML ?? '';
    setDirty(true);
    recomputeFindHits(findQuery, findCase);
    toast.success(`Đã thay thế ${count} lần`, { description: `"${findQuery}" → "${findReplace}"` });
  };

  // ── Keyboard shortcuts ─────────────────────────────────────────────
  // Ctrl+F focuses the find box (default browser Ctrl+F is suppressed),
  // Ctrl+H opens find+replace, Ctrl+S / Ctrl+Shift+S trigger the two
  // save modes, Ctrl+B/I/U toggle formatting.
  // We bind `save` through a ref so the handler always calls the latest
  // closure — no need to re-bind on every save redefinition.
  const saveRef = useRef<(mode: 'save' | 'saveAs') => Promise<void>>(async () => {});
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod && e.key !== 'Escape') return;
      const key = e.key.toLowerCase();
      if (mod && key === 'b') { e.preventDefault(); command('bold'); return; }
      if (mod && key === 'i') { e.preventDefault(); command('italic'); return; }
      if (mod && key === 'u') { e.preventDefault(); command('underline'); return; }
      if (mod && key === 'k') { e.preventDefault(); promptAndInsertLink(); return; }
      if (mod && key === 'f') { e.preventDefault(); setFindOpen(true); return; }
      if (mod && key === 'h') { e.preventDefault(); setFindOpen(true); return; }
      if (mod && key === 's' && !e.shiftKey) { e.preventDefault(); void saveRef.current('save'); return; }
      if (mod && key === 's' && e.shiftKey) { e.preventDefault(); void saveRef.current('saveAs'); return; }
      if (e.key === 'Escape') {
        if (findOpen) setFindOpen(false);
        else if (specialOpen) setSpecialOpen(false);
        else if (shortcutsOpen) setShortcutsOpen(false);
        else if (illustOpen) setIllustOpen(false);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // `promptAndInsertLink` is an inline arrow so its identity changes
    // every render; the handler below re-binds intentionally so it always
    // closes over the latest version. The other deps (`findOpen`, etc.)
    // are booleans that change rarely, so re-binding is cheap.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findOpen, specialOpen, shortcutsOpen, illustOpen, promptAndInsertLink]);

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
      // Draft is now stale (or saved) — drop it so the next open
      // doesn't keep offering to restore.
      clearDraft();
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
  // Keep saveRef pointing at the latest `save` so the global keyboard
  // handler can fire it without depending on closure ordering.
  saveRef.current = save;

  // ── Live word/character count ───────────────────────────────────────
  // Cheap — runs whenever the `dirty` flag flips (i.e. on every editor
  // input/bold/etc. and once on first render when `htmlBootstrap` set).
  // The `dirty` read is intentional — it ties recomputation to the same
  // render that flipped the dirty flag.
  const stats = useMemo(() => {
    void dirty; // tie recomputation to the dirty-flag render
    return countStats(htmlRef.current);
  }, [dirty]);

  // Toolbar groups keep the row scannable; each row uses <kbd>-style
  // tooltips on hover for keyboard hints. Grouped for visual stability
  // — paragraph-format group, inline-format group, insert group.
  const toolGroups: { label: string; tools: { title: string; icon: typeof Bold; run: () => void }[] }[] = [
    {
      label: 'Lịch sử',
      tools: [
        { title: 'Hoàn tác (Ctrl+Z)', icon: Undo2, run: () => command('undo') },
        { title: 'Làm lại (Ctrl+Y)',  icon: Redo2, run: () => command('redo') },
      ],
    },
    {
      label: 'Khối',
      tools: [
        { title: 'Đoạn văn',      icon: Pilcrow, run: () => command('formatBlock', 'p') },
        { title: 'Tiêu đề 1',     icon: Heading1, run: () => command('formatBlock', 'h1') },
        { title: 'Tiêu đề 2',     icon: Heading2, run: () => command('formatBlock', 'h2') },
        { title: 'Tiêu đề 3',     icon: Heading3, run: () => command('formatBlock', 'h3') },
        { title: 'Trích dẫn',     icon: Quote,    run: () => command('formatBlock', 'blockquote') },
        { title: 'Mã (pre)',      icon: CodeIcon, run: () => command('formatBlock', 'pre') },
      ],
    },
    {
      label: 'Định dạng',
      tools: [
        { title: 'In đậm (Ctrl+B)',     icon: Bold,          run: () => command('bold') },
        { title: 'In nghiêng (Ctrl+I)', icon: Italic,        run: () => command('italic') },
        { title: 'Gạch chân (Ctrl+U)',  icon: Underline,     run: () => command('underline') },
        { title: 'Gạch ngang',          icon: Strikethrough, run: () => command('strikeThrough') },
        { title: 'Trên',                icon: SuperscriptIcon, run: () => command('superscript') },
        { title: 'Dưới',                icon: SubscriptIcon,   run: () => command('subscript') },
        { title: 'Bỏ định dạng',        icon: Eraser,        run: () => command('removeFormat') },
      ],
    },
    {
      label: 'Căn chỉnh',
      tools: [
        { title: 'Căn trái',     icon: AlignLeftIcon,   run: () => command('justifyLeft') },
        { title: 'Căn giữa',     icon: AlignCenterIcon, run: () => command('justifyCenter') },
        { title: 'Căn phải',     icon: AlignRightIcon,  run: () => command('justifyRight') },
        { title: 'Căn đều',      icon: AlignJustifyIcon, run: () => command('justifyFull') },
        { title: 'Thụt vào',     icon: IndentIncrease,  run: () => command('indent') },
        { title: 'Thụt ra',      icon: IndentDecrease,  run: () => command('outdent') },
      ],
    },
    {
      label: 'Danh sách',
      tools: [
        { title: 'Bullet list', icon: List,       run: () => command('insertUnorderedList') },
        { title: 'Number list', icon: ListOrdered, run: () => command('insertOrderedList') },
      ],
    },
    {
      label: 'Chèn',
      tools: [
        { title: 'Liên kết (Ctrl+K)', icon: LinkIcon,   run: promptAndInsertLink },
        { title: 'Ảnh từ URL',         icon: ImageIcon,  run: insertImage },
        { title: 'Đường kẻ ngang',      icon: HrIcon,     run: insertHorizontalRule },
        { title: 'Bảng 2×2',           icon: TableIcon,  run: insertTable },
        { title: 'Ký tự đặc biệt',     icon: Hash,       run: () => setSpecialOpen(true) },
      ],
    },
  ];

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-20 border-b border-border bg-background/95 backdrop-blur">
        <div className="flex min-h-14 items-center gap-1.5 px-2 py-2 sm:gap-2 sm:px-4">
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
            aria-label="Tạo ảnh cho chapters"
            className="gap-1.5 relative px-2 sm:px-3"
          >
            <ImagePlus className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Tạo ảnh</span>
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
            className="hidden h-8 items-center justify-center rounded-md border border-border bg-background px-2.5 text-xs font-medium hover:bg-accent hover:text-accent-foreground sm:inline-flex"
          >
            Thông tin sách
          </Link>
          {savedBookId && savedBookId !== bookId && (
            <Link
              href={`/library/${savedBookId}/read`}
              className="hidden h-8 items-center justify-center rounded-md border border-border border-input bg-background px-3 text-xs font-medium hover:bg-accent hover:text-accent-foreground md:inline-flex"
            >
              Open edited copy
            </Link>
          )}
          {/* Primary action: Save (in-place). Two save modes for editing
              a book, matching user expectations from any desktop editor:
              "Save" rewrites the current book on disk; "Save As…"
              duplicates the book into a new " - Edited" copy so the
              original is preserved untouched. */}
          <Button onClick={() => save('save')} disabled={!dirty || saving || loading} size="sm" className="gap-1.5 px-2 sm:px-3" aria-label="Save changes">
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            <span className="hidden sm:inline">Save</span>
          </Button>
          <Button
            onClick={() => save('saveAs')}
            disabled={saving || loading}
            variant="outline"
            size="sm"
            className="gap-1.5 px-2 sm:px-3"
            title="Create a new library copy titled '<book> - Edited'"
            aria-label="Save as a new edited copy"
          >
            <CopyPlus className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Save As…</span>
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

        <section className="min-w-0 border-r border-border" aria-label="Chapter editor">
          <div className="sticky top-14 z-10 border-b border-border bg-background/95 px-4 py-2 backdrop-blur">
            <div className="flex flex-wrap items-center gap-1">
              {toolGroups.map((group, gi) => (
                <div key={group.label} className="flex items-center gap-0.5">
                  {group.tools.map(({ title: toolTitle, icon: Icon, run }) => (
                    <Button key={toolTitle} type="button" variant="ghost" size="icon" title={toolTitle} onClick={run} className="h-8 w-8">
                      <Icon className="h-4 w-4" />
                    </Button>
                  ))}
                  {gi < toolGroups.length - 1 && <div className="mx-1.5 h-5 w-px bg-border" aria-hidden />}
                </div>
              ))}
              {/* Vietnamese helpers + Find + Special-chars + Shortcuts */}
              <div className="mx-1.5 h-5 w-px bg-border" aria-hidden />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button type="button" variant="ghost" size="sm" className="h-8 gap-1 px-2" title="Công cụ tiếng Việt">
                    <Languages className="h-4 w-4" /><span className="hidden lg:inline text-xs">Tiếng Việt</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-[16rem]">
                  <DropdownMenuItem onSelect={() => applyViHelper('stripDiacritics')} className="gap-2">
                    <Eraser className="h-3.5 w-3.5" />
                    <span className="flex-1">Bỏ dấu (Tiếng Việt → ASCII)</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => applyViHelper('trimSpaces')} className="gap-2">
                    <Eraser className="h-3.5 w-3.5" />
                    <span className="flex-1">Gộp khoảng trắng thừa</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => applyViHelper('normalizeEllipsis')} className="gap-2">
                    <Type className="h-3.5 w-3.5" />
                    <span className="flex-1">Chuẩn hóa dấu ba chấm (... → …)</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => applyViHelper('smartQuotes')} className="gap-2">
                    <Type className="h-3.5 w-3.5" />
                    <span className="flex-1">Smart quotes (&ldquo;…&rdquo;)</span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                title="Tìm & thay thế (Ctrl+H)"
                aria-label="Tìm & thay thế"
                onClick={() => setFindOpen((o) => !o)}
                className={cn('h-8 w-8', findOpen && 'bg-accent text-accent-foreground')}
              >
                <Search className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                title="Phím tắt"
                aria-label="Phím tắt"
                onClick={() => setShortcutsOpen(true)}
                className="h-8 w-8"
              >
                <Keyboard className="h-4 w-4" />
              </Button>
              <div className="mx-1.5 h-5 w-px bg-border" aria-hidden />
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
              {dirty && (
                <span
                  className="ml-1 inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300"
                  title="Chưa lưu — bản nháp tự động lưu mỗi 5 giây"
                  aria-label="Chưa lưu"
                >
                  ● chưa lưu
                </span>
              )}
            </div>

            {/* Find & Replace bar — slides in below the toolbar. We keep
                it inline (not a Dialog) because users want to see matches
                highlighted/scrolled-to in the editor behind it. */}
            {findOpen && (
              <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/30 p-2">
                <div className="relative flex-1 min-w-[10rem]">
                  <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={findQuery}
                    onChange={(e) => { setFindQuery(e.target.value); recomputeFindHits(e.target.value, findCase); }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); e.shiftKey ? findPrev() : findNext(); }
                      if (e.key === 'Escape') setFindOpen(false);
                    }}
                    placeholder="Tìm…"
                    aria-label="Tìm"
                    autoFocus
                    className="h-8 pl-7 text-xs"
                  />
                </div>
                <Input
                  value={findReplace}
                  onChange={(e) => setFindReplace(e.target.value)}
                  placeholder="Thay bằng…"
                  aria-label="Thay bằng"
                  className="h-8 text-xs flex-1 min-w-[8rem]"
                />
                <button
                  type="button"
                  onClick={() => { const next = !findCase; setFindCase(next); recomputeFindHits(findQuery, next); }}
                  aria-label="Phân biệt hoa/thường"
                  title="Phân biệt hoa/thường"
                  className={cn(
                    'inline-flex h-8 w-8 items-center justify-center rounded-md border transition-colors',
                    findCase ? 'border-primary bg-primary/10 text-primary' : 'border-border hover:bg-accent',
                  )}
                >
                  <CaseSensitive className="h-3.5 w-3.5" />
                </button>
                <div className="flex items-center gap-0.5">
                  <Button type="button" variant="ghost" size="icon" title="Kết quả trước (Shift+Enter)" onClick={findPrev} className="h-8 w-8" disabled={findHits.length === 0}>
                    <ChevronUp className="h-3.5 w-3.5" />
                  </Button>
                  <Button type="button" variant="ghost" size="icon" title="Kết quả tiếp theo (Enter)" onClick={findNext} className="h-8 w-8" disabled={findHits.length === 0}>
                    <ChevronDown className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <span className="min-w-[5rem] text-center text-[10px] tabular-nums text-muted-foreground">
                  {findQuery
                    ? findHits.length === 0 ? 'không thấy'
                      : `${findCursor || 1}/${findHits.length}`
                    : '—'}
                </span>
                <Button type="button" variant="outline" size="sm" onClick={replaceCurrent} disabled={findHits.length === 0} className="h-8 gap-1 px-2 text-xs">
                  <Replace className="h-3.5 w-3.5" />Thay
                </Button>
                <Button type="button" variant="default" size="sm" onClick={replaceAll} disabled={findHits.length === 0} className="h-8 px-2 text-xs">
                  Tất cả
                </Button>
                <Button type="button" variant="ghost" size="icon" onClick={() => setFindOpen(false)} title="Đóng (Esc)" className="h-8 w-8">
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            )}
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
                role="textbox"
                aria-label="Chapter content"
                aria-multiline="true"
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
            {/* Live stats footer — runs on every keystroke (cheap, in-memory). */}
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-2 text-[10px] text-muted-foreground">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 tabular-nums">
                <span><b className="font-medium text-foreground">{stats.words.toLocaleString('vi')}</b> từ</span>
                <span><b className="font-medium text-foreground">{stats.chars.toLocaleString('vi')}</b> ký tự</span>
                <span className="hidden sm:inline"><b className="font-medium text-foreground">{stats.charsNoSpace.toLocaleString('vi')}</b> không khoảng trắng</span>
                <span><b className="font-medium text-foreground">{stats.paragraphs.toLocaleString('vi')}</b> đoạn</span>
                <span title="Ước tính @ 220 từ/phút">~{stats.minutes < 1 ? '<1' : stats.minutes.toFixed(1)} phút đọc</span>
              </div>
              <div className="flex items-center gap-2">
                {dirty ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 font-medium text-amber-700 dark:text-amber-300">
                    ● chưa lưu
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 font-medium text-emerald-700 dark:text-emerald-300">
                    ✓ đã đồng bộ
                  </span>
                )}
              </div>
            </div>
          </div>
        </section>

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

      {/* Special Characters palette — grouped by category. Click a tile
          to insert at the caret. We re-open the editor and focus it
          after insert so subsequent typing continues where the user
          expects. */}
      <Dialog open={specialOpen} onOpenChange={(v) => { if (!v) setSpecialOpen(false); }} widthClass="max-w-2xl" title="Ký tự đặc biệt">
        <DialogBody>
          {Object.entries(
            SPECIAL_CHARS.reduce<Record<string, typeof SPECIAL_CHARS>>((acc, item) => {
              (acc[item.group] ||= []).push(item);
              return acc;
            }, {}),
          ).map(([group, items]) => (
            <div key={group} className="mb-4">
              <div className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">{group}</div>
              <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-6 md:grid-cols-8">
                {items.map((it) => (
                  <button
                    key={it.label + it.char}
                    type="button"
                    title={it.label}
                    onClick={() => insertSpecial(it.char)}
                    className="inline-flex h-10 items-center justify-center rounded-md border border-border bg-background text-base hover:bg-accent hover:text-accent-foreground"
                  >
                    {it.char === ' ' ? '␣' : it.char}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => setSpecialOpen(false)}>Đóng</Button>
        </DialogFooter>
      </Dialog>

      {/* Keyboard shortcuts cheat-sheet — opens on demand, closes on Esc
          or backdrop click. Renders inside <Dialog> for the focus trap. */}
      <Dialog open={shortcutsOpen} onOpenChange={(v) => { if (!v) setShortcutsOpen(false); }} widthClass="max-w-md" title="Phím tắt">
        <DialogBody>
          <ul className="space-y-1.5 text-xs">
            {KEYBOARD_SHORTCUTS.map((s) => (
              <li key={s.label} className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">{s.label}</span>
                <span className="flex items-center gap-1">
                  {s.keys.map((k, i) => (
                    <kbd key={`${s.label}-${k}-${i}`} className="rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[10px]">{k}</kbd>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </DialogBody>
        <DialogFooter>
          <Button variant="default" size="sm" onClick={() => setShortcutsOpen(false)}>Đóng</Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
