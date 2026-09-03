'use client';
// src/components/jobs/JobCard.tsx – Full-width conversion job card with live stats
import { forwardRef, useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  CheckCircle2, XCircle, Loader2, Clock, Download, Trash2,
  BookOpen, AlertTriangle, Library, ChevronDown, ChevronUp,
  FileText, Languages, User, Hash, Zap, RefreshCw, Play, Sparkles, Cpu,
  Terminal, Activity, Coins,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { useToast } from '@/components/ui/toast';
import { Card } from '@/components/ui/card';
import { Dialog, DialogBody } from '@/components/ui/dialog';
import { cn, formatDate } from '@/lib/utils';

export interface Job {
  id: string;
  filename: string;
  status: string;
  progress: number;
  stage: string;
  errorMsg: string | null;
  outputPath: string | null;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, string> | null;
  report: Record<string, unknown> | null;
  aiModel?: string | null;
  aiProvider?: string | null;
  aiCallCount?: number | null;
  aiTotalTokens?: number | null;
  aiTotalDurationMs?: number | null;
  /** Server-reported generation rate (tokens/sec emitted by the model). Only
   *  set when the AI provider supports streaming + usage metadata. */
  aiGenerationTokensPerSecond?: number | null;
  /** Server-reported prompt-evaluation rate (tokens/sec for input tokenisation). */
  aiPromptTokensPerSecond?: number | null;
  logPath?: string | null;
}

const STATUS_ICONS: Record<string, React.ReactNode> = {
  pending:    <Clock className="h-3.5 w-3.5" />,
  queued:     <Clock className="h-3.5 w-3.5" />,
  processing: <Loader2 className="h-3.5 w-3.5 animate-spin" />,
  completed:  <CheckCircle2 className="h-3.5 w-3.5" />,
  failed:     <XCircle className="h-3.5 w-3.5" />,
  cancelled:  <XCircle className="h-3.5 w-3.5" />,
};

const STATUS_VARIANT: Record<string, 'status-queued' | 'status-active' | 'status-done' | 'status-failed' | 'status-idle'> = {
  pending:    'status-queued',
  queued:     'status-queued',
  processing: 'status-active',
  completed:  'status-done',
  failed:     'status-failed',
  cancelled:  'status-idle',
};

function formatDuration(ms: number): string {
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m}m ${s}s`;
}

function useElapsed(createdAt: string, active: boolean) {
  const [elapsed, setElapsed] = useState(Date.now() - new Date(createdAt).getTime());
  const ref = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (!active) { setElapsed(Date.now() - new Date(createdAt).getTime()); return; }
    ref.current = setInterval(() => setElapsed(Date.now() - new Date(createdAt).getTime()), 1000);
    return () => { if (ref.current) clearInterval(ref.current); };
  }, [createdAt, active]);
  return elapsed;
}

interface JobCardProps {
  job: Job;
  position?: number; // position in queue (for queued jobs)
  onDelete: (id: string) => void;
  onAddedToLibrary?: (id: string) => void;
}

export const JobCard = forwardRef<HTMLDivElement, JobCardProps>(function JobCard(
  { job, position, onDelete, onAddedToLibrary },
  forwardedRef,
) {
  const toast = useToast();
  const [addingToLib, setAddingToLib] = useState(false);
  const [addedToLib, setAddedToLib] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [starting, setStarting] = useState(false);
  const [showConsole, setShowConsole] = useState(false);
  const isActive = job.status === 'processing' || job.status === 'queued';
  const elapsed = useElapsed(job.createdAt, isActive);

  // Estimate time remaining
  const eta = isActive && job.progress > 2
    ? Math.round(elapsed * (100 - job.progress) / job.progress)
    : null;

  // Extract stats from report
  const validation = job.report?.validation as Record<string, unknown> | undefined;
  const repair = job.report?.repair as Record<string, unknown> | undefined;
  const info: string[] = (validation?.info as string[]) ?? [];
  const chapterCount = info.find(i => i.includes('spine'))?.match(/\d+/)?.[0] ?? null;

  const handleDownload = () => { window.location.href = `/api/jobs/${job.id}/download`; };

  const handleStart = async () => {
    setStarting(true);
    try {
      const res = await fetch(`/api/jobs/${job.id}/start`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error('Không thể bắt đầu', { description: data.error ?? res.statusText });
        return;
      }
      // Parent will refresh the list and the job will move to 'queued' → 'processing'
    } finally {
      setStarting(false);
    }
  };

  const handleDelete = () => {
    toast.confirm({
      title: `Xoá job "${job.filename}"?`,
      description: 'File input và (nếu có) file output sẽ bị xoá khỏi đĩa.',
      confirmLabel: 'Delete',
      destructive: true,
      onConfirm: async () => {
        await fetch(`/api/jobs/${job.id}`, { method: 'DELETE' });
        onDelete(job.id);
        toast.success('Job deleted');
      },
    });
  };

  const handleAddToLibrary = async () => {
    setAddingToLib(true);
    try {
      const res = await fetch('/api/library', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: job.id }),
      });
      if (res.ok) { setAddedToLib(true); onAddedToLibrary?.(job.id); }
    } finally {
      setAddingToLib(false);
    }
  };

  return (
    <motion.div
      ref={forwardedRef}
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: -20, height: 0 }}
      className={cn(
        // Base border (color set explicitly because this element sits inside a
        // Card without one). Conditional classes override `border-border` for
        // status highlights; later classes win in Tailwind's cascade.
        'min-w-0 border border-border shadow-sm transition-shadow hover:shadow-md overflow-hidden',
        job.status === 'failed' && 'border-destructive/40',
        job.status === 'completed' && 'border-success-fg/40',
        isActive && 'border-primary/40',
      )}
    >
      {/* Top color bar */}
      <div className={cn('h-0.5 w-full', {
        'bg-bible-pending-border': job.status === 'pending' || job.status === 'queued',
        'bg-primary': job.status === 'processing',
        'bg-success-fg': job.status === 'completed',
        'bg-destructive': job.status === 'failed',
        'bg-muted-foreground': job.status === 'cancelled',
      })} />

      <div className="p-3 sm:p-4">
        {/* Header row */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-2.5 min-w-0 flex-1">
            <div className={cn('mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg', {
              'bg-bible-pending-bg text-bible-pending-fg': job.status === 'pending' || job.status === 'queued',
              'bg-primary/15 text-primary': job.status === 'processing',
              'bg-success-bg text-success-fg': job.status === 'completed',
              'bg-destructive/15 text-destructive': job.status === 'failed',
            })}>
              {STATUS_ICONS[job.status] ?? <BookOpen className="h-3.5 w-3.5" />}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold leading-tight" title={job.filename}>
                {job.metadata?.title ?? job.filename}
              </p>
              {/* AI model badge — shows which model is processing this job */}
              {job.aiModel && (
                <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                  <Cpu className="h-2.5 w-2.5 shrink-0" />
                  <span className="truncate font-mono" title={job.aiModel}>{job.aiModel}</span>
                  {job.aiProvider && (
                    <span className="text-[9px] text-muted-foreground/60">· {job.aiProvider}</span>
                  )}
                </div>
              )}
              {job.metadata?.author && (
                <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1">
                  <User className="h-3 w-3" />{job.metadata.author}
                </p>
              )}
              {!job.metadata?.title && (
                <p className="text-xs text-muted-foreground truncate">{job.filename}</p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Badge variant={STATUS_VARIANT[job.status] ?? 'status-idle'} className="flex items-center gap-1">
              {STATUS_ICONS[job.status]}
              <span className="capitalize">{job.status}</span>
            </Badge>
          </div>
        </div>

        {/* Progress section */}
        {isActive && (
          <div className="mt-3 space-y-1.5">
            <div className="flex flex-col gap-1 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
              <span className="flex items-center gap-1">
                <RefreshCw className="h-3 w-3 animate-spin" />
                {job.stage.replace(/_/g, ' ')}
              </span>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                {eta !== null && (
                  <span className="flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    ~{formatDuration(eta)} left
                  </span>
                )}
                <span className="font-mono font-medium text-foreground">{job.progress}%</span>
              </div>
            </div>
            <Progress value={job.progress} className="h-2" />
            <div className="flex flex-wrap items-center justify-between gap-1 text-xs text-muted-foreground">
              <span>Elapsed: {formatDuration(elapsed)}</span>
              {position !== undefined && job.status === 'queued' && (
                <span>Queue position #{position + 1}</span>
              )}
              {/* AI stats during processing — real-time speed */}
              {job.aiCallCount && job.aiCallCount > 0 && (
                <span className="flex items-center gap-1 text-primary font-mono">
                  <Activity className="h-3 w-3" />
                  {job.aiCallCount} calls
                  {/* Prefer server-reported rates (more accurate). Fall back
                      to client-measured throughput if not available. */}
                  {job.aiGenerationTokensPerSecond && job.aiGenerationTokensPerSecond > 0 ? (
                    <span className="text-success-fg">
                      · gen {job.aiGenerationTokensPerSecond.toFixed(1)} tok/s
                    </span>
                  ) : job.aiTotalDurationMs && job.aiTotalDurationMs > 0 ? (
                    <span className="text-muted-foreground/70">
                      · {((job.aiTotalTokens ?? 0) * 1000 / job.aiTotalDurationMs).toFixed(1)} tok/s
                    </span>
                  ) : null}
                  {job.aiPromptTokensPerSecond && job.aiPromptTokensPerSecond > 0 && (
                    <span className="text-bible-pending-fg">
                      · prompt {job.aiPromptTokensPerSecond.toFixed(0)} tok/s
                    </span>
                  )}
                </span>
              )}
            </div>
          </div>
        )}

        {/* Debug Console — live log of what's happening */}
        {job.logPath && (
          <DebugConsole logPath={job.logPath} open={showConsole} onClose={() => setShowConsole(false)} />
        )}

        {/* Completed stats row */}
        {job.status === 'completed' && (
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {chapterCount && (
              <span className="flex items-center gap-1"><Hash className="h-3 w-3" />{chapterCount} chapters</span>
            )}
            {job.metadata?.language && (
              <span className="flex items-center gap-1"><Languages className="h-3 w-3" />{job.metadata.language.toUpperCase()}</span>
            )}
            {repair && typeof repair.repairedFiles === 'number' && repair.repairedFiles > 0 && (
              <span className="flex items-center gap-1"><Zap className="h-3 w-3 text-bible-pending-fg" />Repaired {repair.repairedFiles as number} files</span>
            )}
            {/* AI call stats */}
            {job.aiCallCount && job.aiCallCount > 0 && (
              <span className="flex items-center gap-1 text-primary font-mono" title={`${job.aiTotalTokens} tokens, ${job.aiTotalDurationMs}ms total`}>
                <Activity className="h-3 w-3" />
                {job.aiCallCount} AI calls
                {job.aiTotalDurationMs && job.aiTotalDurationMs > 0 && (
                  <span className="text-muted-foreground/70">
                    · {((job.aiTotalTokens ?? 0) * 1000 / job.aiTotalDurationMs).toFixed(1)} tok/s avg
                  </span>
                )}
              </span>
            )}
            {/* Per-second rates reported by the AI server (OMLX). These are
                more accurate than client-measured tok/s because they exclude
                network overhead and account for prompt-evaluation time. */}
            {job.aiGenerationTokensPerSecond && job.aiGenerationTokensPerSecond > 0 && (
              <span className="flex items-center gap-1 text-success-fg font-mono"
                title="Server-reported output tokens per second (excludes network + prompt-evaluation)">
                <Zap className="h-3 w-3" />gen {job.aiGenerationTokensPerSecond.toFixed(1)} tok/s
              </span>
            )}
            {job.aiPromptTokensPerSecond && job.aiPromptTokensPerSecond > 0 && (
              <span className="flex items-center gap-1 text-bible-pending-fg font-mono"
                title="Server-reported input tokens per second (prompt evaluation rate)">
                <Zap className="h-3 w-3" />prompt {job.aiPromptTokensPerSecond.toFixed(1)} tok/s
              </span>
            )}
            {job.aiTotalTokens && job.aiTotalTokens > 0 && (
              <span className="flex items-center gap-1 text-muted-foreground/80" title="Total tokens consumed by AI">
                <Coins className="h-3 w-3" />{job.aiTotalTokens.toLocaleString()} tokens
              </span>
            )}
            {(() => {
              const calls = (job.report as { deepFormatAiCalls?: number; deepFormatWarning?: string } | null)?.deepFormatAiCalls;
              const warning = (job.report as { deepFormatWarning?: string } | null)?.deepFormatWarning;
              if (warning) {
                return (
                  <span className="flex items-center gap-1 text-bible-pending-fg font-medium" title={warning}>
                    <AlertTriangle className="h-3 w-3" />Deep format failed: {warning.slice(0, 60)}{warning.length > 60 ? '…' : ''}
                  </span>
                );
              }
              if (typeof calls === 'number' && calls > 0) {
                return (
                  <span className="flex items-center gap-1 text-accent-foreground font-medium">
                    <Sparkles className="h-3 w-3" />Deep format · {calls} AI calls
                  </span>
                );
              }
              return null;
            })()}
            {(() => {
              // Auto-enqueue report from the worker: shows how many bible
              // jobs were fanned out after a deep-format conversion so the
              // user knows the integration is working without digging
              // into settings.
              const fanout = (job.report as { bibleFanout?: { enqueued: number; skipped: boolean; reason?: string } } | null)?.bibleFanout;
              if (!fanout || fanout.skipped) return null;
              return (
                <span
                  className="flex items-center gap-1 text-sky-700 dark:text-sky-300 font-medium"
                  title={`Đã tự động enqueue ${fanout.enqueued} bible-refresh job — character bible sẽ được build từ bản text đã được AI format (deep-format source).`}
                >
                  <BookOpen className="h-3 w-3" />
                  Bible auto-enqueue · {fanout.enqueued} chương
                </span>
              );
            })()}
            {validation?.score !== undefined && (
              <span className="flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3 text-success-fg" />Score {String(validation.score)}/100
              </span>
            )}
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {formatDuration(new Date(job.updatedAt).getTime() - new Date(job.createdAt).getTime())}
            </span>
          </div>
        )}

        {/* Error */}
        {job.status === 'failed' && job.errorMsg && (
          <div className="mt-3 flex items-start gap-1.5 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span>{job.errorMsg}</span>
          </div>
        )}

        {/* Validation warnings (expandable) */}
        {job.status === 'completed' && (validation?.warnings as string[] | undefined)?.length ? (
          <button
            onClick={() => setShowDetails((v) => !v)}
            className="mt-2 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {showDetails ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            {showDetails ? 'Hide' : 'Show'} {(validation?.warnings as string[] | undefined)?.length ?? 0} warning(s)
          </button>
        ) : null}
        {showDetails && (validation?.warnings as string[] | undefined)?.map((w, i) => (
          <p key={i} className="mt-1 text-xs text-bible-pending-fg flex items-start gap-1">
            <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />{w}
          </p>
        ))}

        {/* Footer */}
        <div className="mt-3 flex flex-col gap-2 border-t border-border/50 pt-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">{formatDate(job.createdAt)}</span>
            {/* Console button — shows live log of what's being processed */}
            {job.logPath && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setShowConsole(true)}
                className="h-6 px-2 text-[10px] gap-1 text-muted-foreground"
                title="Xem log chi tiết của quá trình xử lý">
                <Terminal className="h-3 w-3" />Console
              </Button>
            )}
          </div>
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            {/* Start button — for pending jobs only */}
            {job.status === 'pending' && (
              <Button
                size="sm"
                onClick={handleStart}
                disabled={starting}
                className="h-7 px-2.5 text-xs gap-1"
              >
                {starting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3 fill-current" />}
                {starting ? 'Đang bắt đầu…' : 'Bắt đầu'}
              </Button>
            )}
            {job.status === 'completed' && (
              <>
                <Button size="sm" variant="outline" onClick={handleDownload} className="h-7 px-2.5 text-xs gap-1">
                  <Download className="h-3 w-3" />Download
                </Button>
                <Button
                  size="sm"
                  variant={addedToLib ? 'ghost' : 'default'}
                  onClick={handleAddToLibrary}
                  disabled={addingToLib || addedToLib}
                  className={cn('h-7 px-2.5 text-xs gap-1', addedToLib && 'text-success-fg')}
                >
                  {addedToLib ? (
                    <><CheckCircle2 className="h-3 w-3" />In Library</>
                  ) : addingToLib ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <><Library className="h-3 w-3" />Add to Library</>
                  )}
                </Button>
              </>
            )}
            <Button
              size="icon"
              variant="ghost"
              onClick={handleDelete}
              // Allow delete in ANY state (even active) — the server now properly
              // removes the job from BullMQ before deleting the DB row.
              title="Xoá job này"
              className="h-7 w-7 text-muted-foreground hover:text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </div>
    </motion.div>
  );
});
JobCard.displayName = 'JobCard';

// ── DebugConsole: live log panel that tails the per-job log file ─────────
interface DebugConsoleProps {
  logPath: string;
  open: boolean;
  onClose: () => void;
}

interface LogEntry { ts: number; level: 'info' | 'warn' | 'error' | 'debug'; stage: string; message: string; meta?: Record<string, unknown>; }

// Levels shown in the level-filter chip group. Order matters — it
// drives the chip order and the default-on set.
const LEVELS: LogEntry['level'][] = ['info', 'warn', 'error', 'debug'];

function DebugConsole({ logPath, open, onClose }: DebugConsoleProps) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [autoscroll, setAutoscroll] = useState(true);
  // Default: show info + warn + error, hide debug (heartbeats).
  // The user can toggle debug back on to see liveness pings.
  const [levelFilter, setLevelFilter] = useState<Set<LogEntry['level']>>(
    new Set(['info', 'warn', 'error']),
  );
  const [showMeta, setShowMeta] = useState(false);
  const tailRef = useRef<HTMLDivElement | null>(null);
  const lastTsRef = useRef<number>(0);

  const fetchLogs = useCallback(async () => {
    try {
      const params = lastTsRef.current > 0 ? `?from=${lastTsRef.current}` : '';
      const res = await fetch(`/api/jobs/${logPath.split('/').pop()?.replace('.jsonl', '') ?? ''}/log${params}`);
      if (!res.ok) {
        setError(`HTTP ${res.status}`);
        return;
      }
      const data = (await res.json()) as { entries: LogEntry[]; total: number };
      if (data.entries.length > 0) {
        setEntries((prev) => [...prev, ...data.entries]);
        if (data.entries.length > 0) {
          lastTsRef.current = data.entries[data.entries.length - 1].ts;
        }
        if (autoscroll) {
          requestAnimationFrame(() => {
            if (tailRef.current) tailRef.current.scrollTop = tailRef.current.scrollHeight;
          });
        }
      }
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [autoscroll, logPath]);

  // Poll while open (every 2 seconds)
  useEffect(() => {
    if (!open) return;
    lastTsRef.current = 0;
    setEntries([]);
    fetchLogs();
    const t = setInterval(fetchLogs, 2000);
    return () => clearInterval(t);
  }, [open, fetchLogs]);

  const toggleLevel = (lvl: LogEntry['level']) => {
    setLevelFilter((prev) => {
      const next = new Set(prev);
      if (next.has(lvl)) next.delete(lvl); else next.add(lvl);
      return next;
    });
  };

  const visibleEntries = useMemo(
    () => entries.filter((e) => levelFilter.has(e.level)),
    [entries, levelFilter],
  );

  // Header counters per level — quick at-a-glance.
  const counts = useMemo(() => {
    const out: Record<LogEntry['level'], number> = { info: 0, warn: 0, error: 0, debug: 0 };
    for (const e of entries) out[e.level] = (out[e.level] ?? 0) + 1;
    return out;
  }, [entries]);

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }} widthClass="max-w-5xl">
      <div className="flex flex-col max-h-[80vh]">
        <header className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2 min-w-0">
            <Terminal className="h-4 w-4 text-primary shrink-0" />
            <h3 className="font-semibold text-sm shrink-0">Debug Console</h3>
            <span className="text-[10px] text-muted-foreground font-mono truncate" title={logPath}>
              {logPath.split('/').pop()}
            </span>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {/* Level filter — clickable chips that show counts and
                toggle visibility for each level. Default: hide debug
                so heartbeats don't drown real progress. */}
            {LEVELS.map((lvl) => {
              const on = levelFilter.has(lvl);
              return (
                <button
                  key={lvl}
                  type="button"
                  onClick={() => toggleLevel(lvl)}
                  title={on ? `Ẩn ${lvl}` : `Hiện ${lvl}`}
                  className={cn(
                    'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono border transition-colors',
                    on ? 'border-border' : 'border-transparent opacity-40 line-through',
                    lvl === 'info' && on && 'bg-sky-100 text-sky-900 border-sky-300 dark:bg-sky-950/40 dark:text-sky-200 dark:border-sky-700',
                    lvl === 'warn' && on && 'bg-amber-100 text-amber-900 border-amber-300 dark:bg-amber-950/40 dark:text-amber-200 dark:border-amber-700',
                    lvl === 'error' && on && 'bg-red-100 text-red-900 border-red-300 dark:bg-red-950/40 dark:text-red-200 dark:border-red-700',
                    lvl === 'debug' && on && 'bg-zinc-100 text-zinc-600 border-zinc-300 dark:bg-zinc-800 dark:text-zinc-400 dark:border-zinc-700',
                  )}>
                  <span className="font-semibold uppercase">{lvl}</span>
                  <span className="opacity-70">{counts[lvl]}</span>
                </button>
              );
            })}
            <button
              type="button"
              onClick={() => setShowMeta((v) => !v)}
              title={showMeta ? 'Ẩn metadata' : 'Hiện metadata'}
              className={cn(
                'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono border',
                showMeta ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border text-muted-foreground',
              )}>
              <span className="font-semibold">{showMeta ? '–' : '+'}</span>
              <span>meta</span>
            </button>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={autoscroll}
                onChange={(e) => setAutoscroll(e.target.checked)}
                className="h-3 w-3"
              />
              Auto-scroll
            </label>
            <span className="text-xs text-muted-foreground whitespace-nowrap">
              {visibleEntries.length}/{entries.length} entries
            </span>
            <button onClick={onClose} className="text-muted-foreground hover:text-foreground p-1" title="Đóng">
              <XCircle className="h-4 w-4" />
            </button>
          </div>
        </header>
        <DialogBody className="p-0">
          <div
            ref={tailRef}
            className="overflow-y-auto overflow-x-hidden bg-popover text-popover-foreground font-mono text-[11px] leading-snug p-2"
            style={{ minHeight: 320, maxHeight: 'calc(80vh - 60px)' }}>
            {error && <div className="text-destructive p-2">Error: {error}</div>}
            {!error && entries.length === 0 && <div className="text-muted-foreground p-2">Đang tải log...</div>}
            {entries.length > 0 && visibleEntries.length === 0 && (
              <div className="text-muted-foreground p-2">
                Đã lọc hết {entries.length} entries. Bật lại chip <span className="font-semibold">INFO</span> hoặc <span className="font-semibold">DEBUG</span> phía trên để xem.
              </div>
            )}
            {visibleEntries.map((e, i) => (
              <div
                key={i}
                className={cn(
                  'flex flex-col gap-0.5 px-2 py-1 rounded hover:bg-muted/60 border border-transparent',
                  e.level === 'error' && 'bg-red-50/60 border-red-200 dark:bg-red-950/20 dark:border-red-900',
                  e.level === 'warn' && 'bg-amber-50/60 dark:bg-amber-950/20',
                  e.level === 'debug' && 'text-muted-foreground',
                )}>
                <div className="flex items-start gap-2 min-w-0">
                  <span className="text-muted-foreground shrink-0 w-[68px] tabular-nums" title={new Date(e.ts).toISOString()}>
                    {new Date(e.ts).toLocaleTimeString()}
                  </span>
                  <span
                    className={cn(
                      'shrink-0 px-1.5 rounded text-[10px] font-semibold tracking-wide',
                      e.stage === 'ai-call' && 'bg-blue-100 text-blue-900 dark:bg-blue-950/50 dark:text-blue-200',
                      e.stage === 'chapter-done' && 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-200',
                      (e.stage === 'stale-recovery' || e.level === 'error') && 'bg-red-100 text-red-900 dark:bg-red-950/60 dark:text-red-200',
                      e.stage === 'start' && 'bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-200',
                      e.level === 'debug' && 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400',
                      !['ai-call','chapter-done','stale-recovery','start'].includes(e.stage)
                        && e.level !== 'error' && e.level !== 'debug'
                        && 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
                    )}
                    title={e.stage}>
                    {e.stage}
                  </span>
                  <span
                    className={cn(
                      'flex-1 min-w-0 whitespace-pre-wrap wrap-anywhere break-words',
                      e.level === 'error' && 'font-semibold text-red-900 dark:text-red-200',
                    )}
                    title={e.message}>
                    {e.message}
                  </span>
                </div>
                {showMeta && e.meta && (
                  <pre
                    className="ml-[76px] mt-0.5 p-1.5 bg-muted/50 rounded text-[10px] text-muted-foreground overflow-x-auto whitespace-pre-wrap break-all"
                    title={JSON.stringify(e.meta, null, 2)}>
                    {JSON.stringify(e.meta, null, 2)}
                  </pre>
                )}
              </div>
            ))}
          </div>
        </DialogBody>
      </div>
    </Dialog>
  );
}
