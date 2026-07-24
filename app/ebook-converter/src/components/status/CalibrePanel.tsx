'use client';
// src/components/status/CalibrePanel.tsx
//
// Phase 4.3 of docs/NEXT_UP_PLAN.md — Settings → Importers tab content.
//
// Surfaces Calibre's `ebook-convert` binary status, version, and the list of
// input formats it handles (MOBI for v1). Lets the user "Re-check" after
// installing Calibre so the upload zone stops nagging about the missing
// preprocessor.

import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle, CheckCircle2, ExternalLink, FileText, Loader2,
  Package, RefreshCw,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Card } from '@/components/ui/card';

interface CalibreFormat {
  extension: string;
  mimeTypes: string[];
  description: string;
  requiresOcr: boolean;
}

interface CalibreProbeResponse {
  ok: boolean;
  path: string | null;
  version: string | null;
  error: string | null;
  checkedAt: number;
  formats: CalibreFormat[];
  bannerText: string | null;
  installUrl: string;
}

export function CalibrePanel() {
  const [data, setData] = useState<CalibreProbeResponse | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (force = false) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/tools/calibre${force ? '?force=1' : ''}`, {
        cache: 'no-store',
      });
      const json = (await res.json()) as CalibreProbeResponse;
      setData(json);
    } catch (err) {
      setData({
        ok: false,
        path: null,
        version: null,
        error: err instanceof Error ? err.message : String(err),
        checkedAt: Date.now(),
        formats: [],
        bannerText: 'Không thể kết nối tới /api/tools/calibre.',
        installUrl: 'https://calibre-ebook.com/download',
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const rows: Array<{ label: string; ok: boolean; detail: React.ReactNode; Icon: React.ComponentType<{ className?: string }> }> = [
    {
      label: 'ebook-convert',
      ok: !!data?.ok,
      detail: data?.path ?? data?.error ?? 'Đang kiểm tra…',
      Icon: Package,
    },
    {
      label: 'Version',
      ok: !!data?.version,
      detail: data?.version ?? '—',
      Icon: Package,
    },
    {
      label: 'Định dạng hỗ trợ',
      ok: (data?.formats.length ?? 0) > 0,
      detail: data?.formats.length
        ? data.formats.map((f) => `.${f.extension} — ${f.description}`).join(', ')
        : '—',
      Icon: FileText,
    },
  ];

  return (
    <div className="space-y-4">
      <Card className="p-5 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold flex items-center gap-2">
              {data?.ok ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-500" />
              ) : (
                <AlertTriangle className="h-4 w-4 text-amber-500" />
              )}
              Calibre (ebook-convert)
              <span className={cn(
                'text-[10px] px-2 py-0.5 rounded-full font-semibold uppercase tracking-wider',
                data?.ok
                  ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                  : 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
              )}>
                {data?.ok ? 'Sẵn sàng' : 'Tùy chọn'}
              </span>
            </h3>
            <p className="text-[11px] text-muted-foreground mt-1">
              Cần thiết để upload file MOBI (Kindle). Worker sẽ chạy{' '}
              <code className="text-[10px] bg-muted px-1 py-0.5 rounded">ebook-convert</code>{' '}
              để chuyển sang EPUB trước khi vào pipeline.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void load(true)}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border hover:bg-muted"
            title="Kiểm tra lại"
            aria-label="Kiểm tra lại Calibre"
          >
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
          </button>
        </div>

        <div className="grid gap-2 sm:grid-cols-3">
          {rows.map(({ label, ok, detail, Icon }) => (
            <div
              key={label}
              className={cn(
                'flex items-start gap-2 rounded-lg border border-border px-3 py-2',
                ok
                  ? 'border-emerald-500/20 bg-emerald-500/5'
                  : 'border-amber-500/25 bg-amber-500/5',
              )}
            >
              <Icon className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', ok ? 'text-emerald-500' : 'text-amber-500')} />
              <div className="min-w-0">
                <p className="text-xs font-medium">{label}</p>
                <p className="text-[10px] text-muted-foreground truncate font-mono" title={typeof detail === 'string' ? detail : undefined}>
                  {detail}
                </p>
              </div>
            </div>
          ))}
        </div>

        {!data?.ok && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-[11px] text-amber-800 dark:text-amber-200 space-y-1.5">
            <p className="font-medium">Calibre chưa được cài đặt.</p>
            <p>
              Upload file <code className="bg-amber-500/15 px-1 rounded">.mobi</code> sẽ bị từ chối cho đến khi{' '}
              <code className="bg-amber-500/15 px-1 rounded">ebook-convert</code> có sẵn trong PATH.
            </p>
            <p>
              Cài đặt:{' '}
              <a
                href={data?.installUrl ?? 'https://calibre-ebook.com/download'}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1 font-medium underline underline-offset-2"
              >
                calibre-ebook.com/download
                <ExternalLink className="h-3 w-3" />
              </a>
              {' '}
              (macOS / Windows / Linux). Sau khi cài xong, bấm <strong>Kiểm tra lại</strong>.
            </p>
          </div>
        )}
      </Card>

      <Card className="p-5 space-y-2">
        <h4 className="text-xs font-semibold flex items-center gap-2">
          <FileText className="h-3.5 w-3.5 text-muted-foreground" />
          Cách hoạt động
        </h4>
        <ul className="text-[11px] text-muted-foreground space-y-1 list-disc list-inside">
          <li>
            File <code className="bg-muted px-1 rounded">.mobi</code> được upload qua API — server sẽ đánh dấu{' '}
            <code className="bg-muted px-1 rounded">requiresPreprocessing: true</code> trong job.
          </li>
          <li>
            Worker probe <code className="bg-muted px-1 rounded">ebook-convert</code>, log stage{' '}
            <code className="bg-muted px-1 rounded">preprocess-resolve</code>.
          </li>
          <li>
            <code className="bg-muted px-1 rounded">ebook-convert input.mobi output.epub</code> chạy với timeout 3 phút. Progress
            được stream vào Debug Console (<code className="bg-muted px-1 rounded">preprocess-convert</code>).
          </li>
          <li>
            File EPUB trung gian được tạo cùng thư mục với input. Pipeline chính (validate → format → AI) nhận EPUB thay cho MOBI.
          </li>
          <li>
            Lỗi Calibre (binary thiếu, MOBI hỏng) sẽ throw{' '}
            <code className="bg-muted px-1 rounded">UnrecoverableError</code> — không retry để khỏi lãng phí 3 phút × 3 attempts.
          </li>
        </ul>
      </Card>
    </div>
  );
}
