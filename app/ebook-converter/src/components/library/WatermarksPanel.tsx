// src/components/library/WatermarksPanel.tsx
//
// Self-contained "Watermarks" card surfaced on /library/[id].
// Three sections:
//   1. Saved phrases — list + manual add + delete
//   2. Detect — re-uses GET /api/library/[id]/watermarks to surface candidates
//   3. Apply to file — POSTs to /api/library/[id]/watermarks/apply which
//      atomically rewrites the EPUB on disk with each saved phrase stripped
//      from every chapter. After a successful run the per-phrase hit counts
//      are rendered sorted by hits desc, e.g.
//
//        "Đọc thêm truyện hay tại: DTV-EBOOK.com.vn"  —  32 lần
//        "DTV-EBOOK"                                  —  11 lần
//        "TruyenFull.vn"                              —   4 lần
//
// We mount this on the book detail page (not inside the reader) because
// the user manages books from the library — and because the apply pass
// is destructive (it overwrites the file on disk), it deserves a confirm
// dialog, which the in-iframe reader doesn't have room for.
'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import {
  Wand2, Loader2, RefreshCw, Trash2, AlertCircle, Plus,
  ScanSearch, Sparkles, Eraser, ShieldCheck,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';

interface WatermarkCandidate {
  text: string;
  count: number;
  percentage: number;
  confirmed?: boolean;
}

interface PhraseHit { phrase: string; hits: number }

interface ApplyResult {
  ok: true;
  phrases: PhraseHit[];
  totalHits: number;
  chaptersStripped: number;
  chaptersUnchanged: number;
  bytesChanged: number;
  durationMs: number;
  oldSize: number;
  newSize: number;
}

interface WatermarksPanelProps {
  bookId: string;
}

export function WatermarksPanel({ bookId }: WatermarksPanelProps) {
  const toast = useToast();
  const newPhraseId = useId();

  const [saved, setSaved] = useState<string[]>([]);
  const [candidates, setCandidates] = useState<WatermarkCandidate[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const [loadingSaved, setLoadingSaved] = useState(true);
  const [detecting, setDetecting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [applying, setApplying] = useState(false);

  const [newPhrase, setNewPhrase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<ApplyResult | null>(null);

  // ── Load saved phrases ──────────────────────────────────────────────────
  const reload = useCallback(async () => {
    setLoadingSaved(true);
    setError(null);
    try {
      const r = await fetch(`/api/library/${bookId}/watermarks`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json() as { candidates?: WatermarkCandidate[]; saved: string[] };
      setSaved(data.saved ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingSaved(false);
    }
  }, [bookId]);

  useEffect(() => { void reload(); }, [reload]);

  // ── Detect (regex or regex+AI) ──────────────────────────────────────────
  const detect = async (useAI: boolean) => {
    setDetecting(true);
    setError(null);
    setLastResult(null);
    try {
      const r = await fetch(`/api/library/${bookId}/watermarks?ai=${useAI}`);
      const data = await r.json() as { candidates?: WatermarkCandidate[]; saved?: string[] };
      if (!r.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${r.status}`);
      const list = data.candidates ?? [];
      setCandidates(list);
      // Pre-select AI-confirmed + already-saved
      const savedSet = new Set(data.saved ?? []);
      const pre = new Set<number>();
      list.forEach((c, i) => {
        if (c.confirmed || savedSet.has(c.text)) pre.add(i);
      });
      setSelected(pre);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDetecting(false);
    }
  };

  const saveDetected = async () => {
    const toSave = [
      ...saved,
      ...Array.from(selected)
        .map((i) => candidates[i]?.text)
        .filter((t): t is string => Boolean(t) && !saved.includes(t!)),
    ];
    // De-dupe (defensive)
    const unique = [...new Set(toSave)];
    setSaving(true);
    setError(null);
    try {
      const r = await fetch(`/api/library/${bookId}/watermarks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ watermarks: unique }),
      });
      const data = await r.json() as { error?: string };
      if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
      await reload();
      setCandidates([]);
      setSelected(new Set());
      toast.success(`Đã lưu ${unique.length} phrase.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  // ── Manual add / delete ─────────────────────────────────────────────────
  const addPhrase = async () => {
    const p = newPhrase.trim();
    if (p.length < 4) { setError('Phrase phải ≥ 4 ký tự'); return; }
    if (saved.includes(p)) { setError('Phrase đã có trong danh sách'); return; }
    const next = [...saved, p];
    setError(null);
    try {
      const r = await fetch(`/api/library/${bookId}/watermarks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ watermarks: next }),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({})) as { error?: string };
        setError(data.error ?? `HTTP ${r.status}`);
        return;
      }
      setSaved(next);
      setNewPhrase('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const deletePhrase = (phrase: string) => {
    toast.confirm({
      title: 'Xoá phrase?',
      description: phrase,
      confirmLabel: 'Xoá',
      destructive: true,
      onConfirm: async () => {
        const next = saved.filter((s) => s !== phrase);
        try {
          const r = await fetch(`/api/library/${bookId}/watermarks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ watermarks: next }),
          });
          if (!r.ok) {
            const data = await r.json().catch(() => ({})) as { error?: string };
            setError(data.error ?? `HTTP ${r.status}`);
            return;
          }
          setSaved(next);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      },
    });
  };

  // ── Apply to file (destructive) ────────────────────────────────────────
  const applyToFile = () => {
    if (saved.length === 0) {
      toast.error('Chưa có phrase nào. Bấm Detect trước.');
      return;
    }
    toast.confirm({
      title: 'Ghi đè file EPUB trên đĩa?',
      description:
        `Sẽ rewrite ${saved.length} phrase khỏi tất cả chapters. ` +
        'File gốc sẽ được thay bằng bản đã strip. Hành động này KHÔNG thể undo tự động — ' +
        'bạn nên backup file EPUB ở nơi khác nếu sách quý.',
      confirmLabel: 'Ghi đè file',
      destructive: true,
      onConfirm: async () => {
        setApplying(true);
        setError(null);
        setLastResult(null);
        try {
          const r = await fetch(`/api/library/${bookId}/watermarks/apply`, { method: 'POST' });
          const data = await r.json() as ApplyResult & { error?: string };
          if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
          setLastResult(data);
          toast.success(
            `Đã strip ${data.chaptersStripped} chapters trong ${(data.durationMs / 1000).toFixed(1)}s`,
          );
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          setError(msg);
          toast.error(`Apply failed: ${msg}`);
        } finally {
          setApplying(false);
        }
      },
    });
  };

  return (
    <Card className="p-5 space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-semibold flex items-center gap-2">
            <Wand2 className="h-4 w-4 text-primary" /> Watermarks
            <span className="text-[10px] px-2 py-0.5 rounded-full font-semibold uppercase tracking-wider bg-rose-500/15 text-rose-700 dark:text-rose-400">
              {saved.length} saved
            </span>
          </h2>
          <p className="text-[11px] text-muted-foreground mt-1.5 leading-relaxed">
            Phrase lưu ở đây sẽ bị strip khi đọc. Bấm <span className="font-semibold">Apply to file</span> để
            ghi lại bản đã strip vào file EPUB trên đĩa — useful cho sách import trước khi có auto-detect,
            hoặc khi push sang audiobook converter.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={reload} title="Tải lại">
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Section 1 — saved phrases */}
      <div className="space-y-2 pt-2 border-t border-border">
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <label htmlFor={newPhraseId} className="text-xs font-medium flex items-center gap-1.5">
              <Plus className="h-3 w-3" /> Thêm phrase thủ công
            </label>
            <Input
              id={newPhraseId}
              value={newPhrase}
              onChange={(e) => setNewPhrase(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void addPhrase(); }}
              placeholder="vd: www.dtv-ebook.com.vn"
              className="mt-1 font-mono text-xs"
              maxLength={500}
            />
          </div>
          <Button size="sm" onClick={() => void addPhrase()} disabled={newPhrase.trim().length < 4}>
            <Plus className="h-3.5 w-3.5" /> Thêm
          </Button>
        </div>

        <div className="rounded-lg border border-border divide-y divide-border max-h-[260px] overflow-y-auto">
          {loadingSaved ? (
            <div className="p-6 text-center text-xs text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin mx-auto mb-1" /> Đang tải…
            </div>
          ) : saved.length === 0 ? (
            <div className="p-6 text-center text-xs text-muted-foreground space-y-1.5">
              <Wand2 className="h-6 w-6 mx-auto opacity-40" />
              <p>Chưa có phrase nào.</p>
              <p>Bấm <span className="font-semibold">Detect</span> để AI tìm, hoặc thêm tay ở trên.</p>
            </div>
          ) : (
            saved.map((phrase) => (
              <div key={phrase} className="flex items-start gap-2 px-3 py-2 hover:bg-muted/30">
                <p className="flex-1 min-w-0 text-xs font-mono break-words whitespace-pre-wrap">
                  {phrase}
                </p>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => deletePhrase(phrase)}
                  className="shrink-0 text-destructive hover:bg-destructive/10"
                  title="Xoá phrase"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Section 2 — detect */}
      <div className="space-y-2 pt-2 border-t border-border">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-xs font-medium">
            <ScanSearch className="h-3.5 w-3.5" /> Tìm phrase mới
          </div>
          <div className="flex gap-1.5">
            <Button size="sm" variant="outline" onClick={() => void detect(false)} disabled={detecting}>
              {detecting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ScanSearch className="h-3.5 w-3.5" />}
              Detect
            </Button>
            <Button
              size="sm"
              onClick={() => void detect(true)}
              disabled={detecting}
              title="Dùng AI (GPT/MiniMax) lọc false-positive. Tốn ~5–15s + 1 LLM call."
            >
              {detecting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
              Detect + AI
            </Button>
          </div>
        </div>

        {candidates.length > 0 && (
          <div className="rounded-lg border border-border max-h-[260px] overflow-y-auto">
            <div className="p-2 text-[10px] text-muted-foreground border-b border-border bg-muted/30">
              {candidates.length} candidates · pre-selected = AI-confirmed ∪ already-saved.
              Tick để thêm, bỏ tick để bỏ, rồi bấm Save.
            </div>
            {candidates.map((c, i) => (
              <label
                key={i}
                className={cn(
                  'flex items-start gap-2 px-3 py-2 text-xs cursor-pointer border-b border-border last:border-b-0',
                  selected.has(i) ? 'bg-primary/5' : 'hover:bg-muted/30',
                )}
              >
                <input
                  type="checkbox"
                  checked={selected.has(i)}
                  onChange={() => {
                    const next = new Set(selected);
                    if (next.has(i)) next.delete(i); else next.add(i);
                    setSelected(next);
                  }}
                  className="mt-0.5 shrink-0"
                />
                <div className="min-w-0 flex-1">
                  <p className="font-mono break-words whitespace-pre-wrap">{c.text}</p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    {c.count} chương ({c.percentage}%)
                    {c.confirmed && <span className="ml-1 text-emerald-600 dark:text-emerald-400 font-semibold">✓ AI confirmed</span>}
                  </p>
                </div>
              </label>
            ))}
          </div>
        )}

        {candidates.length > 0 && (
          <div className="flex justify-end">
            <Button size="sm" onClick={() => void saveDetected()} disabled={saving || selected.size === 0}>
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <ShieldCheck className="h-3.5 w-3.5 mr-1" />}
              Lưu {selected.size > 0 ? `${selected.size} ` : ''}phrase mới
            </Button>
          </div>
        )}
      </div>

      {/* Section 3 — apply to file */}
      <div className="space-y-2 pt-2 border-t border-border">
        <div className="flex items-center justify-between gap-2">
          <div>
            <p className="text-xs font-medium flex items-center gap-1.5">
              <Eraser className="h-3.5 w-3.5" /> Ghi file EPUB đã strip
            </p>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              Dùng {saved.length} phrase đã lưu. Sách sẽ được rewrite atomic (file gốc chỉ bị thay khi
              write xong). Thời gian ~1–3s cho sách 1–5 MB.
            </p>
          </div>
          <Button
            size="sm"
            variant="default"
            onClick={applyToFile}
            disabled={applying || saved.length === 0}
            className="shrink-0"
          >
            {applying
              ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
              : <Eraser className="h-3.5 w-3.5 mr-1" />}
            {applying ? 'Đang ghi…' : 'Apply to file'}
          </Button>
        </div>

        {lastResult && (
          <div className="rounded-md border border-emerald-500/40 bg-emerald-500/5 p-3 text-xs space-y-2">
            <p className="font-semibold flex items-center gap-1.5 text-emerald-700 dark:text-emerald-300">
              <ShieldCheck className="h-3.5 w-3.5" />
              Đã xoá {lastResult.totalHits} lần × {lastResult.phrases.filter(p => p.hits > 0).length} cụm từ
              {' '}({lastResult.chaptersStripped} chapters trong {(lastResult.durationMs / 1000).toFixed(1)}s)
            </p>
            <ul className="space-y-1 pl-1">
              {[...lastResult.phrases]
                .sort((a, b) => b.hits - a.hits)
                .map((p) => (
                  <li key={p.phrase} className="flex justify-between gap-2 font-mono text-[11px]">
                    <span className="truncate" title={p.phrase}>&ldquo;{p.phrase}&rdquo;</span>
                    <span className={cn(
                      'shrink-0 tabular-nums',
                      p.hits > 0
                        ? 'text-emerald-700 dark:text-emerald-300 font-semibold'
                        : 'text-muted-foreground/60',
                    )}>
                      — {String(p.hits).padStart(3, ' ')} lần
                    </span>
                  </li>
                ))}
            </ul>
            <p className="text-[10px] text-muted-foreground">
              {((lastResult.oldSize - lastResult.newSize) / 1024).toFixed(1)} KB nhỏ hơn
              ({lastResult.oldSize.toLocaleString()} → {lastResult.newSize.toLocaleString()} bytes).
            </p>
            <button
              onClick={() => setLastResult(null)}
              className="text-[10px] underline opacity-70 hover:opacity-100"
            >
              đóng
            </button>
          </div>
        )}
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2.5 text-xs text-destructive flex items-start gap-1.5">
          <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}
    </Card>
  );
}