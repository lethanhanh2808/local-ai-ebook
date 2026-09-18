// src/app/convert/page.tsx
// Dedicated converter page — focused on the import/EPUB-conversion workflow.
//
// Page layout (paper world):
//   • Page header (eyebrow + title + description + actions)
//   • Worker status — single block, two states (offline banner / online
//     compact line) with action feedback appended underneath
//   • Hero upload card (Card wraps UploadZone; UploadZone keeps its own
//     inner cards for the dropzone / AI toggle / preset / deep-format rows)
//   • Two-column main area at lg+ (1.5fr / 1fr split):
//       LEFT  → Queue (Card) + AI Pipeline (numbered vertical timeline Card)
//       RIGHT → Stats (hero success-rate Card) + Supported formats (Card)
//
// All section headers use the same CardHeader / CardEyebrow / CardTitle
// pattern so the rhythm reads as one cohesive page.
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  FileText, Sparkles, ShieldOff, Settings, ListChecks,
  CheckCircle2, AlertTriangle, Loader2, Languages, BookCheck, Server, RefreshCw,
  Play, Check, Square, Wifi,
} from 'lucide-react';
import { Button, buttonClasses } from '@/components/ui/button';
import {
  Card, CardHeader, CardTitle, CardDescription, CardEyebrow, CardContent, CardFooter,
} from '@/components/ui/card';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { UploadZone } from '@/components/jobs/UploadZone';
import { JobList } from '@/components/jobs/JobList';
import { PageHeader } from '@/components/layout/PageHeader';

interface Job {
  id: string; filename: string; originalExt: string;
  status: string; progress: number; stage: string;
  createdAt: string; errorMsg: string | null;
}

type SupportedFormat = {
  ext: string;
  desc: string;
  viaCalibre?: boolean;
};

const BASE_SUPPORTED_FORMATS: SupportedFormat[] = [
  { ext: 'EPUB',  desc: 'EPUB 2/3 — đầu vào/ra chính' },
  { ext: 'HTML',  desc: 'Trang web đã lưu' },
  { ext: 'TXT',   desc: 'Văn bản thuần' },
];

interface CalibreFormat {
  extension: string;
  description: string;
}

const PIPELINE_STEPS = [
  { icon: BookCheck,    label: 'Validate',     desc: 'Phát hiện HTML lỗi, encoding, cấu trúc bị hỏng' },
  { icon: Sparkles,     label: 'Repair (AI)',  desc: 'Sửa chữa HTML bằng LLM — giữ nguyên ý nghĩa' },
  { icon: Languages,    label: 'Convert',      desc: 'Chuyển sang EPUB3 với font Literata + Vietnamese shaping' },
  { icon: ShieldOff,    label: 'Clean',        desc: 'Loại bỏ quảng cáo / watermark tự động (tuỳ chọn)' },
  { icon: CheckCircle2, label: 'Embed fonts',  desc: 'Nhúng font và metadata cho Kindle / Boox / Kobo' },
] as const;

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
  // missing), we render just the base trio. `viaCalibre` flags which entries
  // came from the Calibre probe so the row gets an amber extension tag.
  const supportedFormats = useMemo<SupportedFormat[]>(() => {
    if (calibreFormats.length === 0) {
      return BASE_SUPPORTED_FORMATS.map((f) => ({ ...f, viaCalibre: false }));
    }
    const extra: SupportedFormat[] = calibreFormats.map((f) => ({
      ext: f.extension.toUpperCase(),
      desc: f.description,
      viaCalibre: true,
    }));
    return [
      ...BASE_SUPPORTED_FORMATS.map((f) => ({ ...f, viaCalibre: false })),
      ...extra,
    ];
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
  const successRate = stats.total ? Math.round((stats.completed / stats.total) * 100) : 0;

  // Show the worker status block when we know either state (online OR offline)
  // — never when null/unknown, so first-paint doesn't flash a banner.
  const showWorkerStatus = workerStatus !== null;

  return (
    <div className="mx-auto w-full max-w-canvas px-4 sm:px-6 lg:px-8 py-8 sm:py-10 space-y-6">
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

      {/* ── Worker status block — single region, two states ──────────────── */}
      {showWorkerStatus && (
        <div className="space-y-2">
          {workerStatus && !workerStatus.online && (
            <div className="border border-amber-500/40 border-l-2 border-l-amber-500 bg-amber-500/10 p-4 flex flex-wrap items-start gap-3">
              <div className="flex h-8 w-8 items-center justify-center bg-amber-500 text-amber-50 shrink-0">
                <Server className="h-4 w-4" />
              </div>
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
              <Button size="icon" variant="outline" onClick={() => { void fetchWorkerStatus(); }} className="shrink-0" aria-label="Refresh worker status">
                <RefreshCw className="h-3.5 w-3.5" />
              </Button>
            </div>
          )}

          {workerStatus?.online && (
            <div className="flex items-center gap-3 text-[11px] px-3 py-2 border border-emerald-500/30 bg-emerald-500/[0.06]">
              <div className="flex h-6 w-6 items-center justify-center bg-emerald-500 text-emerald-50 shrink-0">
                <Wifi className="h-3 w-3" />
              </div>
              <span className="inline-flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400 font-semibold uppercase tracking-[0.16em] text-[10px]">
                Worker đang chạy
              </span>
              {workerStatus.counts && workerStatus.counts.processing > 0 && (
                <>
                  <span className="h-3 w-px bg-border" aria-hidden="true" />
                  <span className="text-blue-700 dark:text-blue-400">
                    <span className="font-bold tabular-nums">{workerStatus.counts.processing}</span> đang xử lý
                  </span>
                </>
              )}
              {workerStatus.counts && (workerStatus.counts.queued + workerStatus.counts.pending) > 0 && (
                <>
                  <span className="h-3 w-px bg-border" aria-hidden="true" />
                  <span className="text-amber-700 dark:text-amber-400">
                    <span className="font-bold tabular-nums">{workerStatus.counts.queued + workerStatus.counts.pending}</span> chờ
                  </span>
                </>
              )}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  toast.confirm({
                    title: 'Dừng worker?',
                    description: 'Job đang xử lý sẽ tiếp tục chạy nhưng job mới sẽ KHÔNG được nhận.',
                    confirmLabel: 'Dừng',
                    destructive: true,
                    onConfirm: stopWorker,
                  });
                }}
                className="ml-auto h-7 px-2 text-[10px] text-muted-foreground hover:text-destructive"
              >
                <Square className="h-3 w-3 mr-1 fill-current" />
                Dừng worker
              </Button>
            </div>
          )}

          {workerActionMsg && (
            <div className={cn(
              'flex items-center gap-2 border px-3 py-1.5 text-xs',
              workerActionMsg.kind === 'ok'
                ? 'border-l-2 border-l-emerald-500 bg-emerald-500/10 border-emerald-500/30 text-emerald-700 dark:text-emerald-400'
                : 'border-l-2 border-l-destructive bg-destructive/10 border-destructive/30 text-destructive',
            )}>
              {workerActionMsg.kind === 'ok' ? <Check className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}
              <span>{workerActionMsg.text}</span>
            </div>
          )}
        </div>
      )}

      {/* ── Hero: Upload zone ────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardEyebrow>Bước 1 — Tải lên</CardEyebrow>
          <CardTitle>Upload file EPUB / HTML / TXT</CardTitle>
          <CardDescription>
            5 giai đoạn: validate → repair → convert → embed → done. Kéo thả một hoặc nhiều file cùng lúc.
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-0">
          <UploadZone onJobCreated={onJobCreated} />
        </CardContent>
      </Card>

      {/* ── Two-column main area ─────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-[1.5fr_1fr] gap-6 items-start">
        {/* LEFT: workflow (queue) + learning (pipeline) */}
        <div className="space-y-6">
          {/* Queue */}
          <Card id="queue">
            <div className="flex items-start justify-between gap-3 px-5 pt-5 pb-3">
              <div className="space-y-1 flex-1 min-w-0">
                <CardEyebrow>Workflow</CardEyebrow>
                <CardTitle>Hàng đợi chuyển đổi</CardTitle>
                <CardDescription>
                  Click job để xem chi tiết / download. Đang chạy: <span className="font-bold tabular-nums text-foreground">{stats.active}</span> · Lỗi: <span className="font-bold tabular-nums text-foreground">{stats.failed}</span>
                </CardDescription>
              </div>
              <Button
                size="icon"
                variant="ghost"
                onClick={() => setRefreshKey((k) => k + 1)}
                aria-label="Refresh conversion queue"
                className="shrink-0 mt-1"
              >
                <Loader2 className={cn(loading && 'animate-spin', 'h-4 w-4')} />
              </Button>
            </div>
            <CardContent className="pt-0">
              <JobList refreshTrigger={refreshKey} />
            </CardContent>
          </Card>

          {/* AI pipeline — numbered vertical timeline */}
          <Card>
            <CardHeader>
              <CardEyebrow>Quy trình</CardEyebrow>
              <CardTitle>AI pipeline</CardTitle>
              <CardDescription>
                Mỗi conversion chạy qua 5 giai đoạn liên tiếp — từ validate đến embed font.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ol className="relative">
                {PIPELINE_STEPS.map((step, i) => (
                  <li
                    key={step.label}
                    className={cn(
                      'relative flex gap-4 pb-5 last:pb-0',
                    )}
                  >
                    <div className="relative flex flex-col items-center shrink-0">
                      <span className="flex h-7 w-7 items-center justify-center bg-primary text-primary-foreground text-[11px] font-bold tabular-nums">
                        {i + 1}
                      </span>
                      {i < PIPELINE_STEPS.length - 1 && (
                        <span
                          className="w-px flex-1 bg-border mt-1.5 min-h-3"
                          aria-hidden="true"
                        />
                      )}
                    </div>
                    <div className="flex-1 min-w-0 pt-0.5">
                      <p className="text-[13px] font-semibold leading-tight flex items-center gap-1.5">
                        <step.icon className="h-3.5 w-3.5 text-primary" />
                        {step.label}
                      </p>
                      <p className="text-[11px] text-muted-foreground leading-snug mt-0.5">
                        {step.desc}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        </div>

        {/* RIGHT: overview (stats) + capability (formats) */}
        <div className="space-y-6">
          {/* Stats — hero success rate + 3-cell mini grid */}
          <Card>
            <CardHeader>
              <CardEyebrow>Tổng quan</CardEyebrow>
              <CardTitle>Thống kê chuyển đổi</CardTitle>
              <CardDescription>
                Cập nhật realtime theo hàng đợi. Khoảng vài giây khi không có job mới.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              {/* Hero: success rate */}
              <div className="space-y-2">
                <div className="flex items-baseline justify-between">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                    Tỉ lệ thành công
                  </p>
                  <p className="text-[10px] text-muted-foreground tabular-nums">
                    trên {stats.total} file
                  </p>
                </div>
                <p className="text-5xl font-bold leading-none tracking-[-0.02em] text-emerald-600 dark:text-emerald-400 tabular-nums">
                  {stats.total ? successRate : '—'}
                  {stats.total > 0 && (
                    <span className="text-2xl text-emerald-600/60 dark:text-emerald-400/60 ml-0.5">%</span>
                  )}
                </p>
                {stats.total > 0 && (
                  <div className="h-1 w-full bg-muted overflow-hidden">
                    <div
                      className="h-full bg-emerald-500 transition-all duration-500"
                      style={{ width: `${successRate}%` }}
                    />
                  </div>
                )}
              </div>

              {/* Mini grid — totals / active / failed */}
              <div className="grid grid-cols-3 gap-4 pt-4 border-t border-border">
                <div className="space-y-1">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                    Tổng
                  </p>
                  <p className="flex items-center gap-1.5">
                    <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="text-lg font-bold tabular-nums">
                      {loading ? '—' : stats.total}
                    </span>
                  </p>
                </div>
                <div className="space-y-1">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                    Đang xử lý
                  </p>
                  <p className="flex items-center gap-1.5">
                    <Loader2 className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
                    <span className="text-lg font-bold tabular-nums">
                      {loading ? '—' : stats.active}
                    </span>
                  </p>
                </div>
                <div className="space-y-1">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                    Lỗi
                  </p>
                  <p className="flex items-center gap-1.5">
                    <AlertTriangle
                      className={cn(
                        'h-3.5 w-3.5',
                        stats.failed > 0 ? 'text-destructive' : 'text-muted-foreground',
                      )}
                    />
                    <span
                      className={cn(
                        'text-lg font-bold tabular-nums',
                        stats.failed > 0 && 'text-destructive',
                      )}
                    >
                      {loading ? '—' : stats.failed}
                    </span>
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Supported formats — single render (no duplicate Calibre row) */}
          <Card>
            <CardHeader>
              <CardEyebrow>Hỗ trợ</CardEyebrow>
              <CardTitle>Định dạng file</CardTitle>
              <CardDescription>
                {calibreFormats.length > 0
                  ? `${supportedFormats.length} định dạng — EPUB / HTML / TXT và ${calibreFormats.length} qua Calibre.`
                  : '3 định dạng cơ bản. Cài Calibre để mở khoá Kindle (MOBI / AZW3).'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="space-y-1.5">
                {supportedFormats.map((f) => (
                  <li
                    key={f.ext}
                    className="flex items-center gap-3 border border-border bg-muted/30 px-3 py-2"
                  >
                    <span
                      className={cn(
                        'border border-current px-2 py-0.5 text-[10px] font-bold tabular-nums shrink-0',
                        f.viaCalibre
                          ? 'text-amber-700 dark:text-amber-400'
                          : 'text-primary',
                      )}
                    >
                      .{f.ext.toLowerCase()}
                    </span>
                    <span className="text-xs flex-1 min-w-0">{f.desc}</span>
                    {f.viaCalibre && (
                      <span className="border border-current px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.16em] text-amber-700 dark:text-amber-400 shrink-0">
                        via Calibre
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </CardContent>
            <CardFooter className="text-[11px] text-muted-foreground gap-1.5">
              <Sparkles className="h-3 w-3 text-primary shrink-0" />
              <span>
                AI provider đang dùng có thể thay đổi trong{' '}
                <Link href="/settings" className="text-primary hover:underline font-medium">
                  Cài đặt
                </Link>
                .
              </span>
            </CardFooter>
          </Card>
        </div>
      </div>
    </div>
  );
}
