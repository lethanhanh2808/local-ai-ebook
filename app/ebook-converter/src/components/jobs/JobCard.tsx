'use client';
// src/components/jobs/JobCard.tsx – Full-width conversion job card with live stats
import { useState, useEffect, useRef, useCallback } from 'react';
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
import { cn, formatDate, STATUS_COLORS } from '@/lib/utils';

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

export function JobCard({ job, position, onDelete, onAddedToLibrary }: JobCardProps) {
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
        alert(`Không thể bắt đầu: ${data.error ?? res.statusText}`);
        return;
      }
      // Parent will refresh the list and the job will move to 'queued' → 'processing'
    } finally {
      setStarting(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm(`Xoá job "${job.filename}"?\n\nFile input và (nếu có) file output sẽ bị xoá khỏi đĩa.`)) return;
    await fetch(`/api/jobs/${job.id}`, { method: 'DELETE' });
    onDelete(job.id);
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
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: -20, height: 0 }}
      className={cn(
        'rounded-xl border bg-card shadow-sm transition-shadow hover:shadow-md overflow-hidden',
        job.status === 'failed' && 'border-destructive/40',
        job.status === 'completed' && 'border-green-500/20',
        isActive && 'border-blue-500/30',
      )}
    >
      {/* Top color bar */}
      <div className={cn('h-0.5 w-full', {
        'bg-amber-400': job.status === 'pending',
        'bg-yellow-400': job.status === 'queued',
        'bg-blue-500': job.status === 'processing',
        'bg-green-500': job.status === 'completed',
        'bg-red-500': job.status === 'failed',
        'bg-gray-400': job.status === 'cancelled',
      })} />

      <div className="p-4">
        {/* Header row */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-2.5 min-w-0 flex-1">
            <div className={cn('mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg', {
              'bg-amber-100 text-amber-600 dark:bg-amber-900/30': job.status === 'pending',
              'bg-yellow-100 text-yellow-600 dark:bg-yellow-900/30': job.status === 'queued',
              'bg-blue-100 text-blue-600 dark:bg-blue-900/30': job.status === 'processing',
              'bg-green-100 text-green-600 dark:bg-green-900/30': job.status === 'completed',
              'bg-red-100 text-red-600 dark:bg-red-900/30': job.status === 'failed',
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
            <Badge className={cn(STATUS_COLORS[job.status] ?? '', 'flex items-center gap-1 text-xs')}>
              {STATUS_ICONS[job.status]}
              <span className="capitalize">{job.status}</span>
            </Badge>
          </div>
        </div>

        {/* Progress section */}
        {isActive && (
          <div className="mt-3 space-y-1.5">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <RefreshCw className="h-3 w-3 animate-spin" />
                {job.stage.replace(/_/g, ' ')}
              </span>
              <div className="flex items-center gap-3">
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
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>Elapsed: {formatDuration(elapsed)}</span>
              {position !== undefined && job.status === 'queued' && (
                <span>Queue position #{position + 1}</span>
              )}
              {/* AI stats during processing — real-time speed */}
              {job.aiCallCount && job.aiCallCount > 0 && (
                <span className="flex items-center gap-1 text-blue-600 dark:text-blue-400 font-mono">
                  <Activity className="h-3 w-3" />
                  {job.aiCallCount} calls
                  {/* Prefer server-reported rates (more accurate). Fall back
                      to client-measured throughput if not available. */}
                  {job.aiGenerationTokensPerSecond && job.aiGenerationTokensPerSecond > 0 ? (
                    <span className="text-emerald-600 dark:text-emerald-400">
                      · gen {job.aiGenerationTokensPerSecond.toFixed(1)} tok/s
                    </span>
                  ) : job.aiTotalDurationMs && job.aiTotalDurationMs > 0 ? (
                    <span className="text-muted-foreground/70">
                      · {((job.aiTotalTokens ?? 0) * 1000 / job.aiTotalDurationMs).toFixed(1)} tok/s
                    </span>
                  ) : null}
                  {job.aiPromptTokensPerSecond && job.aiPromptTokensPerSecond > 0 && (
                    <span className="text-amber-600 dark:text-amber-400">
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
              <span className="flex items-center gap-1"><Zap className="h-3 w-3 text-amber-500" />Repaired {repair.repairedFiles as number} files</span>
            )}
            {/* AI call stats */}
            {job.aiCallCount && job.aiCallCount > 0 && (
              <span className="flex items-center gap-1 text-blue-600 dark:text-blue-400 font-mono" title={`${job.aiTotalTokens} tokens, ${job.aiTotalDurationMs}ms total`}>
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
              <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400 font-mono"
                title="Server-reported output tokens per second (excludes network + prompt-evaluation)">
                <Zap className="h-3 w-3" />gen {job.aiGenerationTokensPerSecond.toFixed(1)} tok/s
              </span>
            )}
            {job.aiPromptTokensPerSecond && job.aiPromptTokensPerSecond > 0 && (
              <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400 font-mono"
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
                  <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400 font-medium" title={warning}>
                    <AlertTriangle className="h-3 w-3" />Deep format failed: {warning.slice(0, 60)}{warning.length > 60 ? '…' : ''}
                  </span>
                );
              }
              if (typeof calls === 'number' && calls > 0) {
                return (
                  <span className="flex items-center gap-1 text-purple-600 dark:text-purple-400 font-medium">
                    <Sparkles className="h-3 w-3" />Deep format · {calls} AI calls
                  </span>
                );
              }
              return null;
            })()}
            {validation?.score !== undefined && (
              <span className="flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3 text-green-500" />Score {String(validation.score)}/100
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
          <p key={i} className="mt-1 text-xs text-amber-600 dark:text-amber-400 flex items-start gap-1">
            <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />{w}
          </p>
        ))}

        {/* Footer */}
        <div className="mt-3 flex items-center justify-between pt-2 border-t border-border/50">
          <div className="flex items-center gap-2">
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
          <div className="flex items-center gap-1.5">
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
                  className={cn('h-7 px-2.5 text-xs gap-1', addedToLib && 'text-green-600')}
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
}

// ── DebugConsole: live log panel that tails the per-job log file ─────────
interface DebugConsoleProps {
  logPath: string;
  open: boolean;
  onClose: () => void;
}

interface LogEntry { ts: number; level: 'info' | 'warn' | 'error' | 'debug'; stage: string; message: string; meta?: Record<string, unknown>; }

function DebugConsole({ logPath, open, onClose }: DebugConsoleProps) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [autoscroll, setAutoscroll] = useState(true);
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

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={onClose}>
          <motion.div
            initial={{ y: 20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 20, opacity: 0 }}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-4xl max-h-[80vh] rounded-xl border bg-card shadow-2xl flex flex-col">
            <header className="flex items-center justify-between px-4 py-3 border-b">
              <div className="flex items-center gap-2">
                <Terminal className="h-4 w-4 text-primary" />
                <h3 className="font-semibold text-sm">Debug Console</h3>
                <span className="text-[10px] text-muted-foreground font-mono">{logPath.split('/').pop()}</span>
              </div>
              <div className="flex items-center gap-2">
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={autoscroll}
                    onChange={(e) => setAutoscroll(e.target.checked)}
                    className="h-3 w-3"
                  />
                  Auto-scroll
                </label>
                <span className="text-xs text-muted-foreground">{entries.length} entries</span>
                <button onClick={onClose} className="text-muted-foreground hover:text-foreground p-1" title="Đóng">
                  <XCircle className="h-4 w-4" />
                </button>
              </div>
            </header>
            <div
              ref={tailRef}
              className="flex-1 overflow-y-auto bg-zinc-950 text-zinc-100 font-mono text-[11px] leading-relaxed p-3"
              style={{ minHeight: 300 }}>
              {error && <div className="text-red-400 p-2">Error: {error}</div>}
              {!error && entries.length === 0 && <div className="text-zinc-500 p-2">Đang tải log...</div>}
              {entries.map((e, i) => (
                <div key={i} className={cn('flex gap-2 hover:bg-zinc-900 px-1 -mx-1 rounded',
                  e.level === 'error' && 'text-red-300',
                  e.level === 'warn' && 'text-yellow-300',
                  e.level === 'debug' && 'text-zinc-500',
                )}>
                  <span className="text-zinc-500 shrink-0 w-20">
                    {new Date(e.ts).toLocaleTimeString()}
                  </span>
                  <span className={cn('shrink-0 w-16 truncate',
                    e.stage === 'ai-call' && 'text-blue-300',
                    e.stage === 'chapter-done' && 'text-green-300',
                    e.level === 'error' && 'text-red-400',
                  )}>
                    [{e.stage}]
                  </span>
                  <span className="flex-1 break-all">{e.message}</span>
                  {e.meta && (
                    <span className="text-zinc-500 text-[10px] shrink-0">
                      {JSON.stringify(e.meta)}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
