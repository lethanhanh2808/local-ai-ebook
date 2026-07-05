'use client';
// src/components/status/ServiceHealth.tsx
// Reusable local-service health indicator for TTS-dependent workflows.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, AlertTriangle, CheckCircle2, Loader2, RefreshCw, Server, Volume2 } from 'lucide-react';
import { cn } from '@/lib/utils';

interface TtsBackend {
  id: string;
  name: string;
  ready: boolean;
  languages?: string[];
}

interface TtsHealth {
  ok: boolean;
  checkedAt: string;
  unified: { ok: boolean; url: string; status: string };
  services: { vieneu: boolean; piper: boolean; mossNano: boolean };
  backends: TtsBackend[];
  defaultBackend: string | null;
  recommendation: string | null;
}

interface WorkerHealth {
  online: boolean;
  redis: boolean;
}

interface ServiceHealthProps {
  variant?: 'compact' | 'panel';
  className?: string;
  showWorker?: boolean;
}

export function ServiceHealth({ variant = 'compact', className, showWorker = true }: ServiceHealthProps) {
  const [tts, setTts] = useState<TtsHealth | null>(null);
  const [worker, setWorker] = useState<WorkerHealth | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [ttsRes, workerRes] = await Promise.all([
        fetch('/api/tts/health', { cache: 'no-store' }).then((r) => r.json()).catch(() => null),
        showWorker
          ? fetch('/api/worker/status', { cache: 'no-store' }).then((r) => r.json()).catch(() => null)
          : Promise.resolve(null),
      ]);
      setTts(ttsRes);
      setWorker(workerRes ? { online: !!workerRes.online, redis: !!workerRes.redis } : null);
    } finally {
      setLoading(false);
    }
  }, [showWorker]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => clearInterval(timer);
  }, [load]);

  const allOk = !!tts?.ok && (!showWorker || (!!worker?.online && !!worker?.redis));
  const label = useMemo(() => {
    if (loading && !tts) return 'Checking services';
    if (allOk) return 'Services ready';
    if (!tts?.ok) return 'TTS needs attention';
    if (showWorker && !worker?.online) return 'Worker offline';
    if (showWorker && !worker?.redis) return 'Redis offline';
    return 'Services degraded';
  }, [allOk, loading, showWorker, tts?.ok, worker?.online, worker?.redis]);

  if (variant === 'compact') {
    return (
      <button
        type="button"
        onClick={() => void load()}
        title={tts?.recommendation ?? label}
        className={cn(
          'inline-flex h-7 items-center gap-1.5 rounded-full border px-2 text-[11px] font-medium transition-colors',
          allOk
            ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
            : 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
          className,
        )}
      >
        {loading ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : allOk ? (
          <CheckCircle2 className="h-3 w-3" />
        ) : (
          <AlertTriangle className="h-3 w-3" />
        )}
        <span className="hidden lg:inline">{label}</span>
        <span className="lg:hidden">{allOk ? 'Ready' : 'Check'}</span>
      </button>
    );
  }

  const rows = [
    { label: 'Unified TTS', ok: !!tts?.unified?.ok, detail: tts?.unified?.url ?? 'not checked', Icon: Server },
    { label: 'VieNeu', ok: !!tts?.services?.vieneu, detail: 'Vietnamese read-aloud and audiobook default', Icon: Volume2 },
    { label: 'Piper', ok: !!tts?.services?.piper, detail: 'legacy fallback', Icon: Activity },
    { label: 'MOSS-Nano', ok: !!tts?.services?.mossNano, detail: 'non-Vietnamese cloning', Icon: Activity },
    ...(showWorker ? [{ label: 'Worker + Redis', ok: !!worker?.online && !!worker?.redis, detail: 'conversion and audiobook queues', Icon: Server }] : []),
  ];

  return (
    <div className={cn('rounded-xl border bg-card p-4 space-y-3', className)}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold flex items-center gap-2">
            {allOk ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : <AlertTriangle className="h-4 w-4 text-amber-500" />}
            Local service health
          </h3>
          <p className="text-[11px] text-muted-foreground mt-1">
            Reader, TTS preview, voice cloning, and audiobook generation depend on these local services.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md border hover:bg-muted"
          title="Refresh service health"
        >
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
        </button>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        {rows.map(({ label: rowLabel, ok, detail, Icon }) => (
          <div key={rowLabel} className={cn(
            'flex items-start gap-2 rounded-lg border px-3 py-2',
            ok ? 'border-emerald-500/20 bg-emerald-500/5' : 'border-amber-500/25 bg-amber-500/5',
          )}>
            <Icon className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', ok ? 'text-emerald-500' : 'text-amber-500')} />
            <div className="min-w-0">
              <p className="text-xs font-medium">{rowLabel}</p>
              <p className="text-[10px] text-muted-foreground truncate">{ok ? 'ready' : 'not ready'} · {detail}</p>
            </div>
          </div>
        ))}
      </div>

      {!allOk && (
        <p className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300">
          {tts?.recommendation ?? 'Run ./scripts/start_full_app.sh --background from the repository root, then refresh this panel.'}
        </p>
      )}
    </div>
  );
}

