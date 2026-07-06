// src/app/convert/page.tsx
// Dedicated converter page — focused on the import/EPUB-conversion workflow.
//
// Sections:
//   1. Hero + Upload zone (large, with AI enhancement options)
//   2. Conversion queue (active + recent jobs)
//   3. Stats (success rate, total processed, AI calls)
//   4. Tips / supported formats
'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import {
  Upload, FileText, Sparkles, Wand2, ShieldOff, Settings, Clock,
  CheckCircle2, AlertTriangle, Loader2, ArrowRight, Plus, BookOpen,
  ChevronRight, ListChecks, Zap, Languages, BookCheck, Server, RefreshCw,
  Play, Square, Check,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
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

const SUPPORTED_FORMATS = [
  { ext: 'EPUB',  desc: 'EPUB 2/3 — đầu vào/ra chính' },
  { ext: 'HTML',  desc: 'Trang web đã lưu' },
  { ext: 'TXT',   desc: 'Văn bản thuần' },
];

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
    <div className="mx-auto max-w-7xl px-4 py-8 space-y-8">
      {/* ── Worker status banner (only shown when offline) ─────────────── */}
      {workerStatus && !workerStatus.online && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 flex items-start gap-3">
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
                  // Poll status until online (worker takes ~1s to ping Redis)
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
          <Button size="sm" variant="outline" onClick={() => { void fetchWorkerStatus(); }} className="shrink-0">
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

      {/* ── Worker status (compact, when online) — shows counts + stop btn */}
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

      {/* ── Hero ──────────────────────────────────────────────────────────── */}
      <section className="relative overflow-hidden rounded-2xl border border-border bg-gradient-to-br from-primary/8 via-primary/3 to-transparent p-6 sm:p-8">
        <div className="relative z-10 flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            <span className="text-[10px] font-bold uppercase tracking-widest text-primary">
              Convert · Repair · Optimize
            </span>
          </div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">
            Chuyển đổi & sửa chữa ebook
          </h1>
          <p className="text-sm text-muted-foreground max-w-2xl">
            Kéo thả file EPUB, HTML hoặc TXT vào đây. AI sẽ tự động phát hiện lỗi,
            sửa chữa cấu trúc, làm sạch watermark, và xuất ra EPUB3 chuẩn cho máy đọc sách.
          </p>
          <div className="flex flex-wrap gap-2 pt-1">
            <Link href="/settings">
              <Button variant="outline" size="sm">
                <Settings className="h-3.5 w-3.5 mr-1.5" /> Cài đặt AI
              </Button>
            </Link>
            <a href="#queue">
              <Button variant="ghost" size="sm">
                <ListChecks className="h-3.5 w-3.5 mr-1.5" /> Xem hàng đợi ({stats.total})
                <ChevronRight className="h-3.5 w-3.5 ml-0.5" />
              </Button>
            </a>
          </div>
        </div>
        <div className="absolute -right-12 -top-12 h-48 w-48 rounded-full bg-primary/10 blur-3xl pointer-events-none" />
        <div className="absolute -right-24 -bottom-16 h-56 w-56 rounded-full bg-primary/5 blur-3xl pointer-events-none" />
      </section>

      {/* ── Upload zone ───────────────────────────────────────────────────── */}
      <section>
        <PageHeader
          eyebrow="Bước 1"
          title="Upload file"
          description="File sẽ được xử lý qua 5 giai đoạn: validate → repair → convert → embed → done"
          icon={<Upload className="h-4 w-4" />}
        />
        <UploadZone onJobCreated={onJobCreated} />
      </section>

      {/* ── Stats ─────────────────────────────────────────────────────────── */}
      <section>
        <PageHeader
          eyebrow="Tổng quan"
          title="Thống kê chuyển đổi"
          icon={<Zap className="h-4 w-4" />}
          actions={
            <Button size="sm" variant="ghost" onClick={fetchJobs}>
              <Loader2 className={cn(loading && 'animate-spin', 'h-3.5 w-3.5')} />
            </Button>
          }
        />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatCard
            icon={<FileText className="h-5 w-5" />}
            label="Tổng file"
            value={loading ? '—' : stats.total}
            sub="Đã xử lý"
            tone="primary"
          />
          <StatCard
            icon={<Loader2 className="h-5 w-5" />}
            label="Đang xử lý"
            value={loading ? '—' : stats.active}
            sub="Đang chạy"
            tone="warning"
          />
          <StatCard
            icon={<CheckCircle2 className="h-5 w-5" />}
            label="Hoàn thành"
            value={loading ? '—' : stats.completed}
            sub={stats.total ? `${Math.round(stats.completed / stats.total * 100)}% thành công` : 'Chưa có'}
            tone="success"
          />
          <StatCard
            icon={<AlertTriangle className="h-5 w-5" />}
            label="Lỗi"
            value={loading ? '—' : stats.failed}
            sub="Cần xem lại"
            tone="danger"
          />
        </div>
      </section>

      {/* ── Queue ─────────────────────────────────────────────────────────── */}
      <section id="queue">
        <PageHeader
          eyebrow="Bước 2"
          title="Hàng đợi chuyển đổi"
          description="Các file đang được AI xử lý. Click vào job để xem chi tiết / download kết quả."
          icon={<ListChecks className="h-4 w-4" />}
          actions={
            <Button size="sm" variant="ghost" onClick={() => setRefreshKey((k) => k + 1)}>
              <Loader2 className={cn(loading && 'animate-spin', 'h-3.5 w-3.5')} />
            </Button>
          }
        />
        <JobList refreshTrigger={refreshKey} />
      </section>

      {/* ── What gets done + supported formats ─────────────────────────────── */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
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
            {SUPPORTED_FORMATS.map((f) => (
              <div key={f.ext} className="flex items-center gap-3 rounded-md border border-border bg-muted/30 px-3 py-2">
                <span className="rounded bg-primary/15 px-2 py-0.5 text-[10px] font-bold text-primary tabular-nums">
                  .{f.ext.toLowerCase()}
                </span>
                <span className="text-xs">{f.desc}</span>
              </div>
            ))}
          </div>
          <div className="mt-4 rounded-md border border-border border-dashed bg-muted/30 p-3 text-[11px] text-muted-foreground">
            <Sparkles className="inline h-3 w-3 mr-1 text-primary" />
            AI provider đang dùng có thể thay đổi trong{' '}
            <Link href="/settings" className="text-primary hover:underline font-medium">Cài đặt</Link>.
          </div>
        </Card>
      </section>
    </div>
  );
}

// cn helper is imported from '@/lib/utils' (UI Polish 2026-07-06)
