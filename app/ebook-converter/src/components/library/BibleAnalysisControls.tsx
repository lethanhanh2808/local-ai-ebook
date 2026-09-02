// src/components/library/BibleAnalysisControls.tsx
// Range-based, incremental character-bible analysis controls for the
// "Nhân vật" (Characters) tab.
//
// Drives the new backend endpoints:
//   GET  /api/library/:id/characters/bible/status
//   POST /api/library/:id/characters/bible/analyze-range  (SSE)
//
// Features (per the enhancement plan):
//   - Pick a chapter range (from / to) — requirement #4
//   - "Phân tích" runs the selected range; "Tiếp tục phân tích" runs only
//     the not-yet-analyzed chapters — requirement #1, #2
//   - Already-analyzed chapters are flagged and skipped by default; a
//     "Phân tích lại" toggle forces re-run — requirement #3
//   - Live SSE progress with per-chapter status + a chapter flag strip.
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Play, RefreshCw, SkipForward, Loader2, CheckCircle2, AlertTriangle, Circle,
  Flag,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { useToast } from '@/components/ui/toast';
import {
  openRangeAnalysisStream,
  consumeSseStream,
  fetchBibleStatus,
  type BibleRangeEvent,
} from '@/lib/character-bible-client';

interface ChapterStatus {
  chapterIndex: number;
  file: string;
  title: string | null;
  analyzed: boolean;
  status: string | null;
  analyzedAt: string | null;
  lastError: string | null;
  charCount: number;
}

interface BibleStatus {
  bookId: string;
  totalChapters: number;
  analyzedCount: number;
  failedCount: number;
  pendingDiffCount: number;
  characterCount: number;
  chapters: ChapterStatus[];
}

interface Props {
  bookId: string;
  /** Called after a successful range run so the parent can refresh cards. */
  onAnalysisComplete?: () => void;
}

type RunState = 'idle' | 'running' | 'done' | 'error';

export function BibleAnalysisControls({ bookId, onAnalysisComplete }: Props) {
  const toast = useToast();
  const [status, setStatus] = useState<BibleStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const [from, setFrom] = useState(0);
  const [to, setTo] = useState(0);
  const [forceRerun, setForceRerun] = useState(false);
  // Parallel chapter-analysis concurrency (from Settings, default 5).
  const [concurrency, setConcurrency] = useState(5);

  const [runState, setRunState] = useState<RunState>('idle');
  const [progress, setProgress] = useState<{
    total: number;
    done: number;
    skipped: number;
    failed: number;
    currentChapter: number | null;
    log: string[];
  }>({ total: 0, done: 0, skipped: 0, failed: 0, currentChapter: null, log: [] });

  const abortRef = useRef<AbortController | null>(null);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    try {
      const data = (await fetchBibleStatus(bookId)) as BibleStatus;
      setStatus(data);
      // Default the range to the first un-analyzed window (or whole book).
      const firstUn = data.chapters.findIndex((c) => !c.analyzed);
      const start = firstUn >= 0 ? firstUn : 0;
      const end = Math.min(start + 9, data.totalChapters - 1);
      setFrom(start);
      setTo(end);
      // Pull the live concurrency setting so the run uses the latest value.
      // NOTE: getSettings() is server-only (Prisma + node-fetch) and must not
      // be imported into a client component — fetch it over the API instead.
      try {
        const s = await fetch('/api/settings').then((r) => (r.ok ? r.json() : null));
        if (s && typeof s.bibleConcurrency === 'number' && Number.isFinite(s.bibleConcurrency)) {
          setConcurrency(Math.max(1, Math.min(16, Math.floor(s.bibleConcurrency))));
        }
      } catch { /* keep default */ }
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Lỗi tải trạng thái phân tích');
    } finally {
      setLoading(false);
    }
  }, [bookId, toast]);

  useEffect(() => { void loadStatus(); }, [loadStatus]);

  const analyzedSet = useMemo(
    () => new Set((status?.chapters ?? []).filter((c) => c.analyzed).map((c) => c.chapterIndex)),
    [status],
  );

  const unanalyzedInRange = useMemo(() => {
    if (!status) return 0;
    let n = 0;
    for (let i = from; i <= to; i++) if (!analyzedSet.has(i)) n++;
    return n;
  }, [status, from, to, analyzedSet]);

  const runRange = useCallback(async (mode: 'range' | 'continue') => {
    if (!status) return;
    const skipAnalyzed = mode === 'continue' ? true : !forceRerun;
    const fromIdx = from;
    const toIdx = to;
    setRunState('running');
    setProgress({ total: 0, done: 0, skipped: 0, failed: 0, currentChapter: null, log: [] });

    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const res = await openRangeAnalysisStream(bookId, {
        from: fromIdx,
        to: toIdx,
        skipAnalyzed,
        autoMerge: true,
        concurrency,
        signal: ac.signal,
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

      await consumeSseStream<BibleRangeEvent>(res, (ev) => {
        setProgress((prev) => {
          const next = { ...prev };
          switch (ev.kind) {
            case 'range-start':
              next.total = ev.total;
              next.log = [`▶ Bắt đầu phân tích ${ev.total} chương (${ev.from}–${ev.to})`];
              break;
            case 'chapter-skip':
              next.skipped += 1;
              next.log = [...next.log, `⏭ Chương ${ev.chapterIndex + 1}: đã phân tích, bỏ qua`];
              break;
            case 'chapter-start':
              next.currentChapter = ev.chapterIndex;
              next.log = [...next.log, `… Chương ${ev.chapterIndex + 1} (${ev.index + 1}/${ev.total})`];
              break;
            case 'chapter-done':
              next.done += 1;
              next.log = [...next.log, `✓ Chương ${ev.chapterIndex + 1}: +${ev.autoApplied} bản ghi`];
              break;
            case 'chapter-error':
              next.failed += 1;
              next.log = [...next.log, `✗ Chương ${ev.chapterIndex + 1}: ${ev.message}`];
              break;
            case 'range-done':
              next.log = [...next.log, `■ Hoàn tất: ${ev.analyzed} ok, ${ev.skipped} bỏ qua, ${ev.failed} lỗi`];
              break;
            default:
              break;
          }
          return next;
        });
      });

      setRunState('done');
      toast('success', 'Phân tích nhân vật hoàn tất');
      await loadStatus();
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        setRunState('idle');
        return;
      }
      setRunState('error');
      toast('error', e instanceof Error ? e.message : 'Lỗi phân tích');
    } finally {
      abortRef.current = null;
      // Always refresh the parent (header counts + character grid/graph),
      // even on error/abort, so any partial results are shown.
      onAnalysisComplete?.();
    }
  }, [bookId, status, from, to, forceRerun, loadStatus, onAnalysisComplete, toast]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setRunState('idle');
  }, []);

  if (loading || !status) {
    return (
      <Card className="p-4 flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Đang tải trạng thái phân tích…
      </Card>
    );
  }

  const pct = status.totalChapters > 0
    ? Math.round((status.analyzedCount / status.totalChapters) * 100)
    : 0;

  return (
    <Card className="p-4 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold">Phân tích nhân vật theo chương</div>
          <div className="text-xs text-muted-foreground">
            {status.analyzedCount}/{status.totalChapters} chương đã phân tích · {status.characterCount} nhân vật · {status.pendingDiffCount} chờ duyệt
          </div>
        </div>
        <div className="text-xs text-muted-foreground">{pct}% hoàn thành</div>
      </div>

      {/* Range picker */}
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-muted-foreground flex flex-col gap-1">
          Từ chương
          <Select value={String(from)} onValueChange={(v) => setFrom(Number(v))} disabled={runState === 'running'}>
            <SelectTrigger className="h-9 w-32 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {status.chapters.map((c) => (
                <SelectItem key={c.chapterIndex} value={String(c.chapterIndex)} className="text-xs">
                  #{c.chapterIndex + 1} {c.title ? `· ${c.title}` : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <label className="text-xs text-muted-foreground flex flex-col gap-1">
          Đến chương
          <Select value={String(to)} onValueChange={(v) => setTo(Number(v))} disabled={runState === 'running'}>
            <SelectTrigger className="h-9 w-32 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {status.chapters.map((c) => (
                <SelectItem key={c.chapterIndex} value={String(c.chapterIndex)} className="text-xs">
                  #{c.chapterIndex + 1} {c.title ? `· ${c.title}` : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>

        <Button size="sm" onClick={() => void runRange('range')} disabled={runState === 'running' || to < from}>
          <Play className="h-3.5 w-3.5 mr-1" /> Phân tích
        </Button>
        <Button size="sm" variant="secondary" onClick={() => void runRange('continue')} disabled={runState === 'running' || unanalyzedInRange === 0}>
          <SkipForward className="h-3.5 w-3.5 mr-1" /> Tiếp tục ({unanalyzedInRange})
        </Button>

        <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
          <input
            type="checkbox"
            checked={forceRerun}
            onChange={(e) => setForceRerun(e.target.checked)}
            disabled={runState === 'running'}
            className="h-3.5 w-3.5"
          />
          Phân tích lại (bỏ qua cờ đã xong)
        </label>

        {runState === 'running' && (
          <Button size="sm" variant="ghost" onClick={stop}>
            Dừng
          </Button>
        )}
      </div>

      {/* Chapter flag strip */}
      <div className="flex flex-wrap gap-1 max-h-28 overflow-y-auto rounded-md border border-border/60 p-2">
        {status.chapters.map((c) => {
          const state = c.status === 'failed' ? 'failed' : c.analyzed ? 'done' : 'todo';
          const Icon = state === 'done' ? CheckCircle2 : state === 'failed' ? AlertTriangle : Circle;
          const inRange = c.chapterIndex >= from && c.chapterIndex <= to;
          return (
            <button
              key={c.chapterIndex}
              type="button"
              title={`Chương ${c.chapterIndex + 1}${c.title ? `: ${c.title}` : ''} — ${state === 'done' ? 'đã phân tích' : state === 'failed' ? 'lỗi' : 'chưa phân tích'}`}
              onClick={() => { setFrom(c.chapterIndex); setTo(c.chapterIndex); }}
              className={cn(
                'inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] transition-colors',
                inRange ? 'ring-1 ring-primary/50' : '',
                state === 'done' && 'text-emerald-600',
                state === 'failed' && 'text-amber-600',
                state === 'todo' && 'text-muted-foreground/60',
              )}
            >
              <Icon className="h-3 w-3" />
              {c.chapterIndex + 1}
            </button>
          );
        })}
      </div>

      {/* Live progress */}
      {runState !== 'idle' && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {runState === 'running' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {runState === 'done' && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />}
            {runState === 'error' && <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />}
            <span>
              {progress.done} xong · {progress.skipped} bỏ qua · {progress.failed} lỗi
              {progress.total > 0 && ` · ${progress.done + progress.skipped + progress.failed}/${progress.total}`}
            </span>
          </div>
          <div className="max-h-32 overflow-y-auto rounded-md bg-muted/40 p-2 text-[11px] font-mono text-muted-foreground space-y-0.5">
            {progress.log.map((l, i) => <div key={i}>{l}</div>)}
          </div>
        </div>
      )}

      {status.pendingDiffCount > 0 && (
        <div className="flex items-center gap-2 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700">
          <Flag className="h-3.5 w-3.5" />
          Có {status.pendingDiffCount} thay đổi chờ bạn duyệt (xem bên dưới).
        </div>
      )}
    </Card>
  );
}
