// src/app/convert/page.tsx
// Dedicated converter page — focused on the import/EPUB-conversion workflow.
//
// Sections:
//   1. Hero + Upload zone (large, with AI enhancement options)
//   2. Conversion queue (active + recent jobs)
//   3. Stats (success rate, total processed, AI calls)
//   4. Tips / supported formats
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import {
  Upload, FileText, Sparkles, Wand2, ShieldOff, Settings, Clock,
  CheckCircle2, AlertTriangle, Loader2, ArrowRight, Plus, BookOpen,
  ChevronRight, ListChecks, Zap, Languages, BookCheck, Server, RefreshCw,
  Play, Square, Check,
} from 'lucide-react';
import { Button, buttonClasses } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { UploadZone } from '@/components/jobs/UploadZone';
import { JobList } from '@/components/jobs/JobList';
import { PageHeader } from '@/components/layout/PageHeader';
import { StatCard } from '@/components/layout/StatCard';
import { EmptyState, LoadingSkeleton } from '@/components/layout/EmptyState';

interface Job {
  id: string; filename: string; originalExt: string;
  status: string; progress: number; stage: string;
  createdAt: string; errorMsg: string | null;
}

const BASE_SUPPORTED_FORMATS = [
  { ext: 'EPUB',  desc: 'EPUB 2/3 — đầu vào/ra chính' },
  { ext: 'HTML',  desc: 'Trang web đã lưu' },
  { ext: 'TXT',   desc: 'Văn bản thuần' },
];

interface CalibreFormat {
  extension: string;
  description: string;
}

export default function ConvertPage() {
  const toast = useToast();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [workerStatus, setWorkerStatus] = useState<{
    online: boolean;
    redis: boolean;
    recommendation: string | null;
    counts?: { pending: number; queued: number; processing: number; completed: number; failed: number };
  } | null>(null);
  const [workerStarting, setWorkerStarting] = useState(false);
  const [workerActionMsg, setWorkerActionMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  // Phase 4.3 — Calibre probe. When ok, the "Định dạng hỗ trợ" card
  // surfaces Calibre-handled formats (MOBI for v1) so users discover that
  // they can drag in Kindle files.
  const [calibreFormats, setCalibreFormats] = useState<CalibreFormat[]>([]);

  const fetchJobs = useCallback(async () => {
    try {
      const data = await fetch('/api/jobs').then((r) => r.json()).catch(() => []);
      setJobs(data);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchWorkerStatus = useCallback(async () => {
    try {
      const data = await fetch('/api/worker/status').then((r) => r.json()).catch(() => null);
      if (data) setWorkerStatus({
        online: !!data.online,
        redis: !!data.redis,
        recommendation: data.recommendation ?? null,
        counts: data.counts,
      });
    } catch { /* ignore */ }
  }, []);

  // Phase 4.3 — Calibre probe is independent of worker status. We fire-and-
  // forget on mount; the 60s server-side cache keeps this cheap.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/tools/calibre', { cache: 'no-store' });
        if (!res.ok) return;
        const json = (await res.json()) as { ok: boolean; formats: CalibreFormat[] };
        if (!cancelled && json.ok) setCalibreFormats(json.formats);
      } catch { /* best-effort */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // Phase 4.3 — merge base formats with Calibre-discoverable ones for the
  // "Định dạng hỗ trợ" card. When the probe returns no formats (Calibre
  // missing), we render just the base trio.
  const supportedFormats = useMemo(() => {
    if (calibreFormats.length === 0) return BASE_SUPPORTED_FORMATS;
    const extra = calibreFormats.map((f) => ({
      ext: f.extension.toUpperCase(),
      desc: f.description,
    }));
    return [...BASE_SUPPORTED_FORMATS, ...extra];
  }, [calibreFormats]);

  useEffect(() => { void fetchJobs(); void fetchWorkerStatus(); }, [fetchJobs, fetchWorkerStatus, refreshKey]);

  const stopWorker = async () => {
    try {
      const r = await fetch('/api/worker/stop', { method: 'POST' });
      const data = await r.json();
      if (data.ok) {
        setWorkerActionMsg({ kind: 'ok', text: 'Worker đã dừng.' });
        await fetchWorkerStatus();
      } else {
        setWorkerActionMsg({ kind: 'err', text: `Lỗi: ${data.error}` });
      }
    } catch (e) {
      setWorkerActionMsg({ kind: 'err', text: `Lỗi: ${String(e)}` });
    }
  };

  // Poll while there are active or pending jobs. When the queue empties, do
// one more refresh 3s later to ensure the stats settle to their final values.
  useEffect(() => {
    const hasActive = jobs.some((j) => j.status === 'processing' || j.status === 'queued');
    const hasPending = jobs.some((j) => j.status === 'pending');
    if (!hasActive && !hasPending) {
      // No active work — refresh once after 3s to catch any final state changes.
      const t = setTimeout(() => setRefreshKey((k) => k + 1), 3000);
      return () => clearTimeout(t);
    }
    const t = setInterval(() => setRefreshKey((k) => k + 1), 2000);
    return () => clearInterval(t);
  }, [jobs]);

  // Also poll worker status every 15s to detect when worker comes back online
  useEffect(() => {
    const t = setInterval(() => { void fetchWorkerStatus(); }, 15_000);
    return () => clearInterval(t);
  }, [fetchWorkerStatus]);

  const onJobCreated = (_id: string, _filename: string) => setRefreshKey((k) => k + 1);

  const stats = {
    total: jobs.length,
    completed: jobs.filter((j) => j.status === 'completed').length,
    failed: jobs.filter((j) => j.status === 'failed').length,
    active: jobs.filter((j) => j.status === 'processing' || j.status === 'queued').length,
  };

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 space-y-6">
      {/* ── Page header ─────────────────────────────────────────────────── */}
      <PageHeader
        eyebrow="Convert · Repair · Optimize"
        title="Chuyển đổi & sửa chữa ebook"
        description="Kéo thả file EPUB, HTML hoặc TXT. AI tự động phát hiện lỗi, sửa chữa cấu trúc, làm sạch watermark và xuất EPUB3 chuẩn cho máy đọc sách."
        icon={<Sparkles className="h-4 w-4" />}
        actions={
          <div className="flex items-center gap-2">
            <Link href="/settings" className={buttonClasses({ variant: 'outline', size: 'sm' })}>
              <Settings className="h-3.5 w-3.5 mr-1.5" /> Cài đặt AI
            </Link>
            <a href="#queue" className={buttonClasses({ variant: 'ghost', size: 'sm' })}>
              <ListChecks className="h-3.5 w-3.5 mr-1.5" /> Hàng đợi ({stats.total})
            </a>
          </div>
        }
      />

      {/* ── Worker status banner (offline) ──────────────────────────────── */}
      {workerStatus && !workerStatus.online && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 flex flex-wrap items-start gap-3">
          <Server className="h-5 w-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-amber-700 dark:text-amber-400">
              Worker đang offline — job sẽ KHÔNG được xử lý cho đến khi khởi động lại
            </p>
            <p className="text-xs text-amber-700/80 dark:text-amber-400/80 mt-1">
              {workerStatus.recommendation ??
                'Bấm nút "Khởi động worker" bên dưới — worker sẽ chạy nền và tự khởi động lại nếu crash.'}
            </p>
          </div>
          <Button
            size="sm"
            variant="default"
            disabled={workerStarting}
            onClick={async () => {
              setWorkerStarting(true);
              setWorkerActionMsg(null);
              try {
                const r = await fetch('/api/worker/start', { method: 'POST' });
                const data = await r.json();
                if (data.ok) {
                  setWorkerActionMsg({ kind: 'ok', text: data.message ?? `Worker đã khởi động (pid=${data.pid})` });
                  for (let i = 0; i < 8; i++) {
                    await new Promise((r) => setTimeout(r, 800));
                    await fetchWorkerStatus();
                    if (workerStatus?.online) break;
                  }
                } else {
                  setWorkerActionMsg({ kind: 'err', text: `Không thể khởi động: ${data.error ?? 'lỗi không rõ'}` });
                }
              } catch (e) {
                setWorkerActionMsg({ kind: 'err', text: `Lỗi: ${String(e)}` });
              } finally {
                setWorkerStarting(false);
              }
            }}
            className="shrink-0"
          >
            {workerStarting ? (
              <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
            ) : (
              <Play className="h-3.5 w-3.5 mr-1 fill-current" />
            )}
            Khởi động worker
          </Button>
          <Button size="sm" variant="outline" onClick={() => { void fetchWorkerStatus(); }} className="shrink-0" aria-label="Refresh worker status">
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
      {workerActionMsg && (
        <div className={cn(
          'flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs',
          workerActionMsg.kind === 'ok'
            ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-700 dark:text-emerald-400'
            : 'bg-destructive/10 border-destructive/30 text-destructive',
        )}>
          {workerActionMsg.kind === 'ok' ? <Check className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}
          <span>{workerActionMsg.text}</span>
        </div>
      )}

      {/* ── Worker status (compact, when online) — shows counts + stop btn ── */}
      {workerStatus?.online && (
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground px-1">
          <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
            Worker đang chạy
          </span>
          {workerStatus.counts && workerStatus.counts.processing > 0 && (
            <span className="text-blue-600 dark:text-blue-400">
              • {workerStatus.counts.processing} đang xử lý
            </span>
          )}
          {workerStatus.counts && workerStatus.counts.queued + workerStatus.counts.pending > 0 && (
            <span className="text-amber-600 dark:text-amber-400">
              • {workerStatus.counts.queued + workerStatus.counts.pending} chờ
            </span>
          )}
          <button
            onClick={() => {
              toast.confirm({
                title: 'Dừng worker?',
                description: 'Job đang xử lý sẽ tiếp tục chạy nhưng job mới sẽ KHÔNG được nhận.',
                confirmLabel: 'Dừng',
                destructive: true,
                onConfirm: stopWorker,
              });
            }}
            className="ml-auto text-[10px] text-muted-foreground hover:text-destructive transition-colors"
          >
            Dừng worker
          </button>
        </div>
      )}

      {/* ── Main two-column layout ───────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-[1.4fr_1fr] gap-6 items-start">
        {/* Left: upload + AI options + queue */}
        <div className="space-y-6">
          <Card className="rounded-2xl border border-border p-5 sm:p-6">
            <div className="flex items-center gap-2 mb-4">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Upload className="h-4 w-4" />
              </div>
              <div>
                <h2 className="text-sm font-semibold">Upload file</h2>
                <p className="text-[11px] text-muted-foreground">5 giai đoạn: validate → repair → convert → embed → done</p>
              </div>
            </div>
            <UploadZone onJobCreated={onJobCreated} />
          </Card>

          <section id="queue">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <ListChecks className="h-4 w-4" />
                </div>
                <div>
                  <h2 className="text-sm font-semibold">Hàng đợi chuyển đổi</h2>
                  <p className="text-[11px] text-muted-foreground">Click vào job để xem chi tiết / download</p>
                </div>
              </div>
              <Button size="sm" variant="ghost" onClick={() => setRefreshKey((k) => k + 1)} aria-label="Refresh conversion queue">
                <Loader2 className={cn(loading && 'animate-spin', 'h-3.5 w-3.5')} />
              </Button>
            </div>
            <JobList refreshTrigger={refreshKey} />
          </section>
        </div>

        {/* Right: stats + pipeline + formats */}
        <div className="space-y-6">
          {/* Stats */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Zap className="h-4 w-4" />
                </div>
                <h2 className="text-sm font-semibold">Thống kê chuyển đổi</h2>
              </div>
              <Button size="sm" variant="ghost" onClick={fetchJobs} aria-label="Refresh conversion statistics">
                <Loader2 className={cn(loading && 'animate-spin', 'h-3.5 w-3.5')} />
              </Button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <StatCard icon={<FileText className="h-5 w-5" />} label="Tổng file" value={loading ? '—' : stats.total} sub="Đã xử lý" tone="primary" />
              <StatCard icon={<Loader2 className="h-5 w-5" />} label="Đang xử lý" value={loading ? '—' : stats.active} sub="Đang chạy" tone="warning" />
              <StatCard icon={<CheckCircle2 className="h-5 w-5" />} label="Hoàn thành" value={loading ? '—' : stats.completed} sub={stats.total ? `${Math.round(stats.completed / stats.total * 100)}% thành công` : 'Chưa có'} tone="success" />
              <StatCard icon={<AlertTriangle className="h-5 w-5" />} label="Lỗi" value={loading ? '—' : stats.failed} sub="Cần xem lại" tone="danger" />
            </div>
          </div>

          {/* AI pipeline */}
          <Card className="rounded-xl border border-border p-5">
            <h3 className="text-sm font-semibold flex items-center gap-2 mb-3">
              <Wand2 className="h-4 w-4 text-primary" />
              AI pipeline
            </h3>
            <ol className="space-y-3">
              {[
                { icon: BookCheck,    label: 'Validate',     desc: 'Phát hiện HTML lỗi, encoding, cấu trúc bị hỏng' },
                { icon: Sparkles,     label: 'Repair (AI)',  desc: 'Sửa chữa HTML bằng LLM — giữ nguyên ý nghĩa' },
                { icon: Languages,    label: 'Convert',      desc: 'Chuyển sang EPUB3 với font Literata + Vietnamese shaping' },
                { icon: ShieldOff,    label: 'Clean',        desc: 'Loại bỏ quảng cáo / watermark tự động (tuỳ chọn)' },
                { icon: CheckCircle2, label: 'Embed fonts',  desc: 'Nhúng font và metadata cho Kindle/Boox/Kobo' },
              ].map((step, i) => (
                <li key={step.label} className="flex items-start gap-3">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary text-xs font-bold">
                    {i + 1}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-semibold flex items-center gap-1.5">
                      <step.icon className="h-3 w-3" /> {step.label}
                    </p>
                    <p className="text-[11px] text-muted-foreground">{step.desc}</p>
                  </div>
                </li>
              ))}
            </ol>
          </Card>

          {/* Supported formats */}
          <Card className="rounded-xl border border-border p-5">
            <h3 className="text-sm font-semibold flex items-center gap-2 mb-3">
              <FileText className="h-4 w-4 text-primary" />
              Định dạng hỗ trợ
            </h3>
            <div className="space-y-1.5">
              {supportedFormats.map((f) => (
                <div key={f.ext} className="flex items-center gap-3 rounded-md border border-border bg-muted/30 px-3 py-2">
                  <span className="rounded bg-primary/15 px-2 py-0.5 text-[10px] font-bold text-primary tabular-nums">
                    .{f.ext.toLowerCase()}
                  </span>
                  <span className="text-xs">{f.desc}</span>
                </div>
              ))}
              {calibreFormats.map((f) => (
                <div key={f.extension} className="flex items-center gap-3 rounded-md border border-border bg-muted/30 px-3 py-2">
                  <span className="rounded bg-amber-500/15 px-2 py-0.5 text-[10px] font-bold text-amber-700 dark:text-amber-300 tabular-nums">
                    .{f.extension}
                  </span>
                  <span className="text-xs">
                    {f.description}{' '}
                    <span className="text-[10px] text-muted-foreground">(qua Calibre)</span>
                  </span>
                </div>
              ))}
            </div>
            <div className="mt-4 rounded-md border border-border border-dashed bg-muted/30 p-3 text-[11px] text-muted-foreground">
              <Sparkles className="inline h-3 w-3 mr-1 text-primary" />
              AI provider đang dùng có thể thay đổi trong{' '}
              <Link href="/settings" className="text-primary hover:underline font-medium">Cài đặt</Link>.
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
