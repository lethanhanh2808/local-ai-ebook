'use client';
// src/components/jobs/UploadZone.tsx
// Drag-and-drop upload zone + AI Enhancement options
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useDropzone } from 'react-dropzone';
import { motion, AnimatePresence } from 'framer-motion';
import { Upload, FileText, Loader2, Sparkles, ChevronDown, ChevronUp, ShieldOff, Wand2, Zap, Smartphone, AlertTriangle, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import Link from 'next/link';

// Base MIME types that the pipeline handles directly (no preprocessing).
const BASE_ACCEPTED_TYPES: Record<string, string[]> = {
  'application/epub+zip': ['.epub'],
  'application/octet-stream': ['.epub'],
  'application/x-zip-compressed': ['.epub'],
  'application/xhtml+xml': ['.html', '.htm'],
  'text/html': ['.html', '.htm'],
  'text/plain': ['.txt'],
};

interface CalibreProbeResponse {
  ok: boolean;
  formats: Array<{ extension: string; mimeTypes: string[]; description: string }>;
  installUrl: string;
}

interface UploadZoneProps {
  onJobCreated: (jobId: string, filename: string) => void;
}

export function UploadZone({ onJobCreated }: UploadZoneProps) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queue, setQueue] = useState<File[]>([]);
  // Initial state is seeded from /settings (loaded async on mount) so the
  // toggles match whatever the user has saved in /settings.
  const [aiEnhance, setAiEnhance] = useState(true);
  const [aiWatermarkClean, setAiWatermarkClean] = useState(true);
  const [deepFormat, setDeepFormat] = useState(false);
  // Default ON — most web-novel source EPUBs ship with CSS that crashes
  // Onyx Boox / Kobo after the first 1–2 pages. User can turn off in /settings.
  const [readerFriendly, setReaderFriendly] = useState(true);
  const [aiPrompt, setAiPrompt] = useState('');
  const [showPrompt, setShowPrompt] = useState(false);
  // When ON (default), uploaded files start converting immediately.
  // When OFF, files are saved as 'pending' and the user must click "Start" in the queue.
  const [autoStart, setAutoStart] = useState(true);
  // Phase 4.3 — Calibre probe. When ok=true, MOBI is added to the dropzone
  // accept list. When ok=false, a banner points the user to Settings →
  // Importers to install Calibre. `null` means we haven't fetched yet; the
  // dropzone still works for EPUB/HTML/TXT during that window.
  const [calibre, setCalibre] = useState<CalibreProbeResponse | null>(null);

  // Phase 4.3 — fetch Calibre probe on mount. The API does its own 60s
  // caching on the server side so we don't need an interval here.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/tools/calibre', { cache: 'no-store' });
        if (!res.ok) return;
        const json = (await res.json()) as CalibreProbeResponse;
        if (!cancelled) setCalibre(json);
      } catch { /* best-effort */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const acceptedTypes = useMemo(() => {
    if (!calibre?.ok) return BASE_ACCEPTED_TYPES;
    // Merge in Calibre-handled MIME types so the dropzone accepts them.
    const merged: Record<string, string[]> = { ...BASE_ACCEPTED_TYPES };
    for (const f of calibre.formats) {
      for (const mime of f.mimeTypes) {
        const ext = `.${f.extension}`;
        const existing = merged[mime] ?? [];
        if (!existing.includes(ext)) merged[mime] = [...existing, ext];
      }
    }
    return merged;
  }, [calibre]);

  // Sync initial AI-flag state from /settings on mount (so users don't
  // toggle "Deep Format" in /settings, come here, and see the wrong default).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/settings');
        if (!res.ok) return;
        const s = await res.json();
        if (cancelled) return;
        if (typeof s.defaultAiEnhance === 'boolean') setAiEnhance(s.defaultAiEnhance);
        if (typeof s.defaultAiWatermarkClean === 'boolean') setAiWatermarkClean(s.defaultAiWatermarkClean);
        if (typeof s.defaultDeepFormat === 'boolean') setDeepFormat(s.defaultDeepFormat);
        if (typeof s.defaultReaderFriendly === 'boolean') setReaderFriendly(s.defaultReaderFriendly);
      } catch { /* best-effort */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const uploadFile = useCallback(
    async (file: File) => {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('aiEnhance', String(aiEnhance));
      fd.append('aiWatermarkClean', String(aiWatermarkClean));
      fd.append('deepFormat', String(deepFormat));
      fd.append('readerFriendly', String(readerFriendly));
      fd.append('startImmediately', String(autoStart));
      if ((aiEnhance || deepFormat) && aiPrompt.trim()) fd.append('aiPrompt', aiPrompt.trim());
      const res = await fetch('/api/upload', { method: 'POST', body: fd });
      const data = (await res.json()) as { jobId?: string; filename?: string; status?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Upload failed');
      onJobCreated(data.jobId!, data.filename!);
    },
    [onJobCreated, aiEnhance, aiWatermarkClean, deepFormat, readerFriendly, aiPrompt, autoStart],
  );

  const onDrop = useCallback(
    async (accepted: File[]) => {
      if (accepted.length === 0) return;
      setError(null);
      setUploading(true);
      setQueue(accepted);
      try {
        for (const file of accepted) {
          await uploadFile(file);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Unknown error');
      } finally {
        setUploading(false);
        setQueue([]);
      }
    },
    [uploadFile],
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: acceptedTypes,
    maxSize: 100 * 1024 * 1024,
    disabled: uploading,
    multiple: true,
  });

  return (
    <div className="space-y-3">
      {/* Phase 4.3 — Calibre missing banner. Only render when the probe has
          resolved (calibre !== null) and reports ok=false. While still
          loading (calibre === null) we render nothing — the dropzone still
          works for EPUB/HTML/TXT and we don't want to flash a banner for a
          transient probe miss. */}
      {calibre && !calibre.ok && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-800 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="font-medium">Calibre chưa được cài — MOBI / AZW3 không upload được.</p>
            <p className="mt-0.5 text-amber-900/80 dark:text-amber-200/80">
              Mở{' '}
              <Link href="/settings#importers" className="font-medium underline underline-offset-2">
                Settings → Importers
              </Link>{' '}
              để cài <code className="bg-amber-500/15 px-1 rounded">ebook-convert</code>.
            </p>
          </div>
        </div>
      )}
      <div
        {...getRootProps()}
        className={cn(
          'relative flex min-h-44 cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed',
          'transition-all duration-200 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
          isDragActive
            ? 'border-primary bg-primary/5 scale-[1.01]'
            : 'border-border hover:border-primary/50 hover:bg-muted/40',
          uploading && 'pointer-events-none opacity-70',
        )}
      >
        <input {...getInputProps({ 'aria-label': 'Choose ebook files to upload' })} />
        <AnimatePresence mode="wait">
          {uploading ? (
            <motion.div key="loading" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}
              className="flex flex-col items-center gap-3 p-6 text-center"
            >
              <Loader2 className="h-10 w-10 animate-spin text-primary" />
              <p className="text-sm font-medium">Uploading {queue.length} file{queue.length > 1 ? 's' : ''}…</p>
              {aiEnhance && <p className="text-xs text-primary/70 flex items-center gap-1"><Sparkles className="h-3 w-3" />AI enhancement queued</p>}
            </motion.div>
          ) : isDragActive ? (
            <motion.div key="drag" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
              className="flex flex-col items-center gap-3 p-6 text-center"
            >
              <Upload className="h-10 w-10 text-primary" />
              <p className="text-base font-semibold text-primary">Drop files here</p>
            </motion.div>
          ) : (
            <motion.div key="idle" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="flex flex-col items-center gap-3 p-6 text-center"
            >
              <div className="rounded-full bg-primary/10 p-4">
                <FileText className="h-8 w-8 text-primary" />
              </div>
              <div>
                <p className="text-base font-medium">Drop ebooks here or click to browse</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  EPUB · HTML · TXT{calibre?.ok ? ' · MOBI' : ''} &mdash; up to 100 MB each
                </p>
              </div>
              <Button variant="outline" size="sm" className="mt-2" type="button">Choose files</Button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Auto-start toggle */}
      <Card className="rounded-xl border overflow-hidden">
        <div className="flex items-center gap-3 px-4 py-3 select-none">
          <Switch
            checked={autoStart}
            onCheckedChange={setAutoStart}
            label="Auto-start conversion"
          />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <Zap className="h-4 w-4 text-primary" />
              <span className="text-sm font-medium">Auto-start conversion</span>
              {!autoStart && <span className="text-[10px] rounded-full bg-amber-500/15 text-amber-700 dark:text-amber-400 px-1.5 py-0.5 font-medium">MANUAL</span>}
              <Tooltip content={autoStart
                ? 'Files start converting as soon as upload completes.'
                : 'Files go to "Pending". Click ▶ Start in the queue below to begin.'} side="top">
                <span tabIndex={0} className="inline-flex text-muted-foreground/70 hover:text-foreground cursor-help">
                  <Info className="h-3 w-3" />
                </span>
              </Tooltip>
            </div>
          </div>
        </div>
      </Card>

      {/* AI Enhancement Options */}
      <Card className="rounded-xl border overflow-hidden divide-y divide-border">
        {/* Light AI enhance (fast) */}
        <div className="flex items-center gap-3 px-4 py-3 select-none">
          <Switch checked={aiEnhance} onCheckedChange={setAiEnhance} label="AI Enhancement" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <Sparkles className="h-4 w-4 text-primary" />
              <span className="text-sm font-medium">AI Enhancement</span>
              {aiEnhance && <span className="text-[10px] rounded-full bg-primary/15 text-primary px-1.5 py-0.5 font-medium">FAST</span>}
              <Tooltip content="Quick parallel pass: fixes watermarks, encoding, broken images. ~30s per book." side="top">
                <span tabIndex={0} className="inline-flex text-muted-foreground/70 hover:text-foreground cursor-help">
                  <Info className="h-3 w-3" />
                </span>
              </Tooltip>
            </div>
          </div>
        </div>

        {/* Deep format (slow, Vietnamese-novel optimized) */}
        <div className="flex items-center gap-3 px-4 py-3 select-none">
          <Switch checked={deepFormat} onCheckedChange={setDeepFormat} label="Deep Format" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <Wand2 className="h-4 w-4 text-primary" />
              <span className="text-sm font-medium">Deep Format (Vietnamese novel)</span>
              {deepFormat && <span className="text-[10px] rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400 px-1.5 py-0.5 font-medium">SLOW</span>}
              <Tooltip content={<><strong>Recommended cho tiểu thuyết.</strong> AI re-formats từng chương: gộp/tách đoạn văn, định dạng hội thoại (nháy cong), ngắt cảnh (&lt;hr/&gt;). ~2-5 phút/chương.</>} side="top">
                <span tabIndex={0} className="inline-flex text-muted-foreground/70 hover:text-foreground cursor-help">
                  <Info className="h-3 w-3" />
                </span>
              </Tooltip>
            </div>
          </div>
        </div>

        {/* Reader-friendly (e-ink / Onyx Boox / Kobo safe) */}
        <div className="flex items-center gap-3 px-4 py-3 select-none">
          <Switch checked={readerFriendly} onCheckedChange={setReaderFriendly} label="Reader-friendly output" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <Smartphone className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              <span className="text-sm font-medium">Reader-friendly (Onyx Boox / Kobo / Kindle)</span>
              {readerFriendly && <span className="text-[10px] rounded-full bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 px-1.5 py-0.5 font-medium">QUICK</span>}
              <Tooltip content={<><strong>Dùng khi sách chỉ hiện 1–2 trang trên máy đọc e-ink.</strong> Bỏ animation, blur, text-shadow, hyphens, background gradient, font custom. Dùng stylesheet tối giản — convert xong trong vài chục giây.</>} side="top">
                <span tabIndex={0} className="inline-flex text-muted-foreground/70 hover:text-foreground cursor-help">
                  <Info className="h-3 w-3" />
                </span>
              </Tooltip>
            </div>
          </div>
        </div>

        {/* Custom prompt (shown when either AI option is on) */}
        {(aiEnhance || deepFormat) && (
          <div className="px-4 py-3">
            <button
              type="button"
              onClick={() => setShowPrompt((v) => !v)}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              {showPrompt ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              Custom AI prompt (optional)
            </button>
            <AnimatePresence>
              {showPrompt && (
                <motion.textarea
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  value={aiPrompt}
                  onChange={(e) => setAiPrompt(e.target.value)}
                  placeholder="vd: 'Bỏ qua các đoạn recap. Giữ nguyên tên riêng Nhật/Hán-Việt.'"
                  rows={3}
                  aria-label="Custom AI prompt"
                  className="mt-2 w-full rounded-md border border-border bg-background px-3 py-2 text-xs font-mono outline-none focus-visible:ring-2 focus-visible:ring-ring resize-y"
                />
              )}
            </AnimatePresence>
          </div>
        )}
      </Card>

      {/* (Legacy single-toggle kept for back-compat with old saved state — see below) */}
      {false && (
      <Card className="rounded-xl border overflow-hidden">
        <label className="flex items-center gap-3 px-4 py-3 cursor-pointer select-none">
          <div
            onClick={(e) => { e.preventDefault(); setAiEnhance((v) => !v); if (aiEnhance) setShowPrompt(false); }}
            className={cn(
              'relative w-9 h-5 rounded-full transition-colors duration-200 shrink-0',
              aiEnhance ? 'bg-primary' : 'bg-muted-foreground/30',
            )}
          >
            <div className={cn(
              'absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform duration-200',
              aiEnhance ? 'translate-x-4' : 'translate-x-0',
            )} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <Sparkles className="h-4 w-4 text-primary" />
              <span className="text-sm font-medium">AI Enhancement</span>
              {aiEnhance && <span className="text-[10px] rounded-full bg-primary/15 text-primary px-1.5 py-0.5 font-medium">ON</span>}
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              AI processes each chapter in parallel: fixes formatting, removes broken images, standardizes Vietnamese text
            </p>
          </div>
          {aiEnhance && (
            <button
              type="button"
              onClick={(e) => { e.preventDefault(); setShowPrompt((v) => !v); }}
              className="shrink-0 p-1 rounded hover:bg-muted transition-colors"
              title={showPrompt ? 'Hide custom prompt' : 'Add custom prompt'}
            >
              {showPrompt ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </button>
          )}
        </label>

        <AnimatePresence>
          {aiEnhance && showPrompt && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="overflow-hidden"
            >
              <div className="px-4 pb-3 border-t border-border">
                <label className="block text-xs font-medium mb-1.5 mt-2 text-muted-foreground">
                  Custom AI instructions (optional)
                </label>
                <textarea
                  value={aiPrompt}
                  onChange={(e) => setAiPrompt(e.target.value)}
                  placeholder="e.g. Translate chapter titles to English. Fix dialogue format. Ensure proper paragraph breaks."
                  rows={3}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none resize-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                <p className="text-[10px] text-muted-foreground mt-1">
                  Leave blank to use default enhancement (formatting, broken image removal, Vietnamese text cleanup)
                </p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </Card>
      )}

      {/* AI Watermark Cleanup */}
      <Card className="rounded-xl border overflow-hidden">
        <div className="flex items-center gap-3 px-4 py-3 select-none">
          <Switch checked={aiWatermarkClean} onCheckedChange={setAiWatermarkClean} label="AI Watermark Cleanup" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <ShieldOff className="h-4 w-4 text-primary" />
              <span className="text-sm font-medium">AI Watermark Cleanup</span>
              {aiWatermarkClean && <span className="text-[10px] rounded-full bg-primary/15 text-primary px-1.5 py-0.5 font-medium">ON</span>}
              <Tooltip content="Detects repeated watermark phrases in the ebook and removes them during conversion" side="top">
                <span tabIndex={0} className="inline-flex text-muted-foreground/70 hover:text-foreground cursor-help">
                  <Info className="h-3 w-3" />
                </span>
              </Tooltip>
            </div>
          </div>
        </div>
      </Card>

      <AnimatePresence>
        {error && (
          <motion.p initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
            role="alert"
            className="rounded-lg bg-destructive/10 px-4 py-2 text-sm text-destructive"
          >
            {error}
          </motion.p>
        )}
      </AnimatePresence>
    </div>
  );
}
