'use client';
// src/components/jobs/JobList.tsx – Full-width queue with management controls
import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { JobCard, Job } from './JobCard';
import {
  Loader2, Trash2, CheckCircle2, RefreshCw, BookOpen,
  Filter, LayoutList, Clock, Zap, Play,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { ErrorState } from '@/components/layout/ErrorState';

type Filter = 'all' | 'pending' | 'active' | 'completed' | 'failed';

const FILTER_OPTS: { value: Filter; label: string; icon: React.ReactNode }[] = [
  { value: 'all',       label: 'All',       icon: <LayoutList className="h-3.5 w-3.5" /> },
  { value: 'pending',   label: 'Pending',   icon: <Clock className="h-3.5 w-3.5" /> },
  { value: 'active',    label: 'Active',    icon: <Zap className="h-3.5 w-3.5" /> },
  { value: 'completed', label: 'Done',      icon: <CheckCircle2 className="h-3.5 w-3.5" /> },
  { value: 'failed',    label: 'Failed',    icon: <Zap className="h-3.5 w-3.5 rotate-180" /> },
];

interface JobListProps {
  refreshTrigger?: number;
}

export function JobList({ refreshTrigger }: JobListProps) {
  const toast = useToast();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [autoClean, setAutoClean] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoCleanRef = useRef(autoClean);
  autoCleanRef.current = autoClean;

  const fetchJobs = useCallback(async () => {
    try {
      setError(null);
      const res = await fetch('/api/jobs');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as Job[];
      setJobs(data);

      // Auto-cleanup completed jobs older than 30 minutes
      if (autoCleanRef.current) {
        const cutoff = Date.now() - 30 * 60 * 1000;
        const toDelete = data.filter(
          (j) => j.status === 'completed' && new Date(j.updatedAt).getTime() < cutoff,
        );
        for (const j of toDelete) {
          await fetch(`/api/jobs/${j.id}`, { method: 'DELETE' });
        }
        if (toDelete.length > 0) {
          setJobs((prev) => prev.filter((j) => !toDelete.some((d) => d.id === j.id)));
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchJobs();
    timerRef.current = setInterval(fetchJobs, 2500);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [fetchJobs, refreshTrigger]);

  const handleDelete = useCallback((id: string) => {
    setJobs((prev) => prev.filter((j) => j.id !== id));
  }, []);

  const handleClearCompleted = async () => {
    const completed = jobs.filter((j) => j.status === 'completed');
    await Promise.all(completed.map((j) => fetch(`/api/jobs/${j.id}`, { method: 'DELETE' })));
    setJobs((prev) => prev.filter((j) => j.status !== 'completed'));
  };

  const handleClearFailed = async () => {
    const failed = jobs.filter((j) => j.status === 'failed');
    await Promise.all(failed.map((j) => fetch(`/api/jobs/${j.id}`, { method: 'DELETE' })));
    setJobs((prev) => prev.filter((j) => j.status !== 'failed'));
  };

  const filtered = jobs.filter((j) => {
    if (filter === 'pending')   return j.status === 'pending';
    if (filter === 'active')    return j.status === 'processing' || j.status === 'queued';
    if (filter === 'completed') return j.status === 'completed';
    if (filter === 'failed')    return j.status === 'failed';
    return true;
  });

  const activeCount = jobs.filter((j) => j.status === 'processing' || j.status === 'queued').length;
  const completedCount = jobs.filter((j) => j.status === 'completed').length;
  const failedCount = jobs.filter((j) => j.status === 'failed').length;
  const pendingCount = jobs.filter((j) => j.status === 'pending').length;
  const queuedJobs = jobs.filter((j) => j.status === 'queued');
  const pendingJobs = jobs.filter((j) => j.status === 'pending');

  const startAllPending = () => {
    if (pendingJobs.length === 0) return;
    toast.confirm({
      title: `Bắt đầu ${pendingJobs.length} job đang chờ?`,
      confirmLabel: 'Start all',
      onConfirm: async () => {
        for (const j of pendingJobs) {
          await fetch(`/api/jobs/${j.id}/start`, { method: 'POST' });
        }
        toast.success(`Started ${pendingJobs.length} jobs`);
      },
    });
  };

  const clearCompleted = () => {
    toast.confirm({
      title: `Xoá ${completedCount} job đã hoàn thành?`,
      confirmLabel: 'Clear',
      destructive: true,
      onConfirm: async () => {
        const targets = jobs.filter((j) => j.status === 'completed' || j.status === 'failed');
        for (const j of targets) {
          await fetch(`/api/jobs/${j.id}`, { method: 'DELETE' });
        }
        toast.success(`Cleared ${targets.length} jobs`);
      },
    });
  };

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <ErrorState
        onRetry={() => void fetchJobs()}
        message={error}
        details={String(error)}
        retrying={loading}
      />
    );
  }

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      {jobs.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {/* Filter tabs */}
          <div className="flex rounded-lg border overflow-hidden">
            {FILTER_OPTS.map((opt) => {
              const count = opt.value === 'all' ? jobs.length
                : opt.value === 'pending' ? pendingCount
                : opt.value === 'active' ? activeCount
                : opt.value === 'completed' ? completedCount
                : opt.value === 'failed' ? failedCount
                : 0;
              return (
                <button
                  key={opt.value}
                  onClick={() => setFilter(opt.value)}
                  className={cn(
                    'flex items-center gap-1.5 px-3 h-8 text-xs font-medium border-r border-border last:border-r-0 transition-colors',
                    filter === opt.value ? 'bg-primary text-primary-foreground' : 'bg-background hover:bg-muted text-muted-foreground',
                  )}
                >
                  {opt.icon}{opt.label}
                  {count > 0 && (
                    <span className={cn(
                      'ml-0.5 rounded-full px-1.5 py-0 text-[10px] font-bold',
                      filter === opt.value ? 'bg-primary-foreground/20 text-primary-foreground' : 'bg-muted text-foreground',
                    )}>{count}</span>
                  )}
                </button>
              );
            })}
          </div>

          {/* "Start all pending" — prominent when there are pending jobs */}
          {pendingCount > 0 && (
            <Button
              size="sm"
              onClick={startAllPending}
              className="gap-1"
            >
              <Play className="h-3.5 w-3.5 fill-current" />
              Bắt đầu tất cả ({pendingCount})
            </Button>
          )}

          {/* Spacer */}
          <div className="flex-1" />

          {/* Auto-clean toggle */}
          <button
            onClick={() => setAutoClean((v) => !v)}
            className={cn(
              'flex items-center gap-1.5 rounded-lg border px-3 h-8 text-xs font-medium transition-colors',
              autoClean ? 'bg-amber-500/10 border-amber-500/30 text-amber-600 dark:text-amber-400' : 'bg-background hover:bg-muted text-muted-foreground',
            )}
            title="Auto-remove completed jobs older than 30 minutes"
          >
            <Clock className="h-3.5 w-3.5" />
            Auto-clean
          </button>

          {/* Bulk actions */}
          {completedCount > 0 && (
            <Button
              size="sm"
              variant="ghost"
              onClick={handleClearCompleted}
              className="h-8 px-3 text-xs gap-1.5 text-muted-foreground hover:text-foreground"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Clear {completedCount} done
            </Button>
          )}
          {failedCount > 0 && (
            <Button
              size="sm"
              variant="ghost"
              onClick={handleClearFailed}
              className="h-8 px-3 text-xs gap-1.5 text-destructive hover:text-destructive hover:bg-destructive/10"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Clear {failedCount} failed
            </Button>
          )}
        </div>
      )}

      {/* Active summary banner */}
      {activeCount > 0 && (
        <div className="flex items-center gap-2 rounded-lg bg-blue-500/10 border border-blue-500/20 px-4 py-2 text-sm text-blue-700 dark:text-blue-300">
          <Loader2 className="h-4 w-4 animate-spin shrink-0" />
          <span>
            {activeCount === 1
              ? '1 conversion in progress…'
              : `${activeCount} conversions in progress…`}
          </span>
        </div>
      )}

      {/* Empty state */}
      {filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed py-16 text-center text-muted-foreground">
          {jobs.length === 0 ? (
            <>
              <BookOpen className="h-10 w-10 mx-auto mb-3 opacity-30" />
              <p className="text-sm">No conversions yet. Upload a file above to get started.</p>
            </>
          ) : (
            <p className="text-sm">No {filter} jobs.</p>
          )}
        </div>
      ) : (
        <div className="space-y-2.5">
          <AnimatePresence mode="popLayout">
            {filtered.map((job) => (
              <JobCard
                key={job.id}
                job={job}
                position={queuedJobs.findIndex((q) => q.id === job.id)}
                onDelete={handleDelete}
              />
            ))}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}
