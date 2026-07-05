// src/components/library/AudiobookPanel.tsx
// Audiobook pre-generation status + trigger + per-character voice test.
'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import {
  Headphones, Loader2, RefreshCw, Trash2, Play, Pause, ChevronLeft, ChevronRight,
  CheckCircle2, AlertTriangle, Wand2, Square, Volume2, ListMusic,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn, formatDuration } from '@/lib/utils';
import { AudiobookPlayer } from './AudiobookPlayer';

interface Chapter {
  id: string;
  chapterFile: string;
  chapterTitle: string | null;
  status: string;
  progress: number;
  durationMs: number | null;
  sizeBytes: number | null;
  errorMsg: string | null;
  generatedAt: string | null;
}

interface AudiobookSummary {
  total: number; ready: number; failed: number; pending: number;
  durationMs: number; sizeBytes: number; pct: number;
}

interface Book {
  id: string;
  title: string;
  language: string;
  ttsBackend: string;
  audiobookStatus: string;
  audiobookGeneratedAt: string | null;
  audiobookDurationMs: number;
}

interface Props {
  bookId: string;
  onChapterAudioReady?: (chapterFile: string) => void;
}

export function AudiobookPanel({ bookId, onChapterAudioReady }: Props) {
  const [book, setBook] = useState<Book | null>(null);
  const [summary, setSummary] = useState<AudiobookSummary | null>(null);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [voices, setVoices] = useState<{ id: string; name: string; isDefault: boolean }[]>([]);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [polling, setPolling] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playingChapter, setPlayingChapter] = useState<string | null>(null);
  // Full-screen continuous playback
  const [playerOpen, setPlayerOpen] = useState(false);
  const [playerStartIdx, setPlayerStartIdx] = useState(0);

  const fetchStatus = useCallback(async () => {
    const r = await fetch(`/api/library/${bookId}/audiobook`);
    if (!r.ok) return;
    const data = await r.json();
    setBook(data.book);
    setSummary(data.summary);
    setChapters(data.chapters);
    setVoices(data.voices);
    setLoading(false);
    if (onChapterAudioReady) {
      for (const c of data.chapters) {
        if (c.status === 'ready') onChapterAudioReady(c.chapterFile);
      }
    }
  }, [bookId, onChapterAudioReady]);

  useEffect(() => { void fetchStatus(); }, [fetchStatus]);

  // Poll while generating
  useEffect(() => {
    if (book?.audiobookStatus === 'generating') {
      setPolling(true);
      pollRef.current = setInterval(() => void fetchStatus(), 3000);
      return () => { if (pollRef.current) clearInterval(pollRef.current); pollRef.current = null; setPolling(false); };
    }
  }, [book?.audiobookStatus, fetchStatus]);

  const handleStart = async () => {
    setStarting(true);
    try {
      await fetch(`/api/library/${bookId}/audiobook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'generate' }),
      });
      await fetchStatus();
    } finally { setStarting(false); }
  };

  const handleStop = async () => {
    if (!confirm('Dừng đang tạo? Chương đang chạy sẽ hoàn thành, các chương sau sẽ không tạo.')) return;
    setStopping(true);
    try {
      await fetch(`/api/library/${bookId}/audiobook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop' }),
      });
      await fetchStatus();
    } finally { setStopping(false); }
  };

  const handleReset = async () => {
    if (!confirm('Xoá toàn bộ audio đã tạo?')) return;
    setResetting(true);
    await fetch(`/api/library/${bookId}/audiobook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'reset' }),
    });
    await fetchStatus();
    setResetting(false);
  };

  const handleRegenOne = async (chapterFile: string) => {
    await fetch(`/api/library/${bookId}/audiobook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'regenerate_one', chapterFile }),
    });
    await fetchStatus();
  };

  const playChapter = (chapterFile: string) => {
    const encoded = encodeURIComponent(chapterFile);
    const url = `/api/library/${bookId}/audiobook/${encoded}`;
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
    const audio = new Audio(url);
    audioRef.current = audio;
    setPlayingChapter(chapterFile);
    audio.onended = () => { URL.revokeObjectURL(audio.src); setPlayingChapter(null); audioRef.current = null; };
    audio.onerror = () => setPlayingChapter(null);
    audio.play().catch(() => setPlayingChapter(null));
  };
  const stopPlay = () => { if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; } setPlayingChapter(null); };

  if (loading) return <div className="p-6 text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Đang tải…</div>;
  if (!book) return null;

  const status = book.audiobookStatus;
  const isGenerating = status === 'generating';

  return (
    <div className="space-y-4">
      <div className="rounded-xl border bg-card p-4">
        <div className="flex items-center justify-between gap-3 mb-3">
          <h3 className="text-sm font-semibold flex items-center gap-1.5">
            <Headphones className="h-4 w-4 text-primary" />Audiobook đọc trước
          </h3>
          <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-medium',
            status === 'ready' ? 'bg-green-500/15 text-green-700 dark:text-green-400'
            : status === 'generating' ? 'bg-blue-500/15 text-blue-700 dark:text-blue-400'
            : status === 'partial' ? 'bg-amber-500/15 text-amber-700 dark:text-amber-400'
            : status === 'failed' ? 'bg-destructive/15 text-destructive'
            : 'bg-muted text-muted-foreground')}>
            {isGenerating && <Loader2 className="h-2.5 w-2.5 animate-spin inline mr-1" />}
            {status === 'none' ? 'Chưa tạo' :
             status === 'generating' ? `Đang tạo ${summary?.pct ?? 0}%` :
             status === 'ready' ? `Sẵn sàng · ${summary?.ready ?? 0} chương` :
             status === 'partial' ? `Một phần · ${summary?.ready ?? 0}/${summary?.total ?? 0}` :
             status === 'failed' ? 'Lỗi' : status}
          </span>
        </div>

        <p className="text-xs text-muted-foreground mb-3">
          Tạo trước audio cho cả sách để đọc audiobook không phụ thuộc model TTS khi đang đọc.
          Quá trình chạy nền, bạn có thể tiếp tục dùng máy.
          {voices.length === 0 && (
            <span className="block mt-1 text-amber-600 dark:text-amber-400">
              ⚠ Chưa có giọng clone — audiobook sẽ dùng giọng VieNeu mặc định.
            </span>
          )}
        </p>

        {/* Summary stats */}
        {summary && summary.total > 0 && (
          <div className="grid grid-cols-3 gap-2 mb-3 text-center">
            <div className="rounded-lg bg-muted/50 p-2">
              <p className="text-lg font-bold">{summary.ready}<span className="text-xs text-muted-foreground font-normal">/{summary.total}</span></p>
              <p className="text-[10px] text-muted-foreground">chương</p>
            </div>
            <div className="rounded-lg bg-muted/50 p-2">
              <p className="text-lg font-bold">{formatDuration(summary.durationMs)}</p>
              <p className="text-[10px] text-muted-foreground">tổng</p>
            </div>
            <div className="rounded-lg bg-muted/50 p-2">
              <p className="text-lg font-bold">{(summary.sizeBytes / 1024 / 1024).toFixed(0)}<span className="text-xs text-muted-foreground font-normal">MB</span></p>
              <p className="text-[10px] text-muted-foreground">dung lượng</p>
            </div>
          </div>
        )}

        {/* Progress bar */}
        {summary && summary.total > 0 && (
          <div className="h-2 rounded-full bg-muted overflow-hidden mb-3">
            <div className={cn('h-full transition-all', isGenerating ? 'bg-blue-500' : status === 'failed' ? 'bg-destructive' : 'bg-green-500')}
              style={{ width: `${summary.pct}%` }} />
          </div>
        )}

        {/* Action buttons */}
        <div className="flex flex-wrap gap-2">
          {isGenerating ? (
            <Button size="sm" variant="destructive" onClick={handleStop} disabled={stopping}>
              {stopping ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Square className="h-3.5 w-3.5 mr-1 fill-current" />}
              {stopping ? 'Đang dừng…' : 'Dừng'}
            </Button>
          ) : (
            <Button size="sm" onClick={handleStart} disabled={starting}>
              {starting ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Wand2 className="h-3.5 w-3.5 mr-1" />}
              {starting ? 'Đang bắt đầu…' : status === 'none' ? 'Tạo audiobook' : status === 'failed' ? 'Thử lại' : 'Tạo thêm'}
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={fetchStatus} disabled={polling}>
            <RefreshCw className={cn('h-3.5 w-3.5', polling && 'animate-spin')} />
          </Button>
          {/* Primary "Start Listening" button — only when there's at least one chapter ready */}
          {summary && summary.ready > 0 && (
            <Button
              size="sm"
              variant="default"
              onClick={() => {
                // Start from the first ready chapter
                const firstReady = chapters.findIndex((c) => c.status === 'ready');
                setPlayerStartIdx(Math.max(0, firstReady));
                setPlayerOpen(true);
              }}
              className="bg-primary text-primary-foreground"
            >
              <ListMusic className="h-3.5 w-3.5 mr-1" />
              ▶ Nghe audiobook ({summary.ready})
            </Button>
          )}
          {summary && summary.ready > 0 && (
            <Button size="sm" variant="ghost" onClick={handleReset} disabled={resetting}>
              {resetting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
            </Button>
          )}
        </div>
      </div>

      {/* Chapter list */}
      {chapters.length > 0 && (
        <div className="rounded-xl border bg-card">
          <div className="px-4 py-2 border-b text-xs font-semibold text-muted-foreground">Danh sách chương</div>
          <div className="max-h-80 overflow-y-auto divide-y">
            {chapters.map((c, idx) => (
              <div key={c.id} className="flex items-center gap-3 px-3 py-2 text-xs hover:bg-muted/30">
                <span className="text-muted-foreground w-6 shrink-0 text-right">{idx + 1}</span>
                <div className="flex-1 min-w-0">
                  <p className="font-medium truncate">{c.chapterTitle ?? c.chapterFile}</p>
                  <p className="text-[10px] text-muted-foreground">
                    {c.status === 'ready' && c.durationMs && <>✓ {formatDuration(c.durationMs)} · {(c.sizeBytes!/1024).toFixed(0)}KB</>}
                    {c.status === 'generating' && <><Loader2 className="h-2.5 w-2.5 animate-spin inline" /> {c.progress}%</>}
                    {c.status === 'failed' && <span className="text-destructive">✗ {c.errorMsg?.slice(0, 40) ?? 'failed'}</span>}
                    {c.status === 'pending' && <>chờ…</>}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  {c.status === 'ready' && (
                    playingChapter === c.chapterFile ? (
                      <Button size="icon" variant="ghost" className="h-7 w-7" onClick={stopPlay}>
                        <Pause className="h-3.5 w-3.5" />
                      </Button>
                    ) : (
                      <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => playChapter(c.chapterFile)}>
                        <Play className="h-3.5 w-3.5" />
                      </Button>
                    )
                  )}
                  {c.status === 'failed' && (
                    <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => handleRegenOne(c.chapterFile)} title="Tạo lại">
                      <RefreshCw className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Full continuous audiobook player */}
      {playerOpen && summary && summary.ready > 0 && (
        <AudiobookPlayer
          bookId={bookId}
          chapters={chapters
            .filter((c) => c.status === 'ready')
            .map((c) => ({ id: c.chapterFile, title: c.chapterTitle ?? c.chapterFile }))}
          initialChapterIdx={playerStartIdx}
          onClose={() => setPlayerOpen(false)}
          onProgress={(_idx, _frac) => {
            // Could persist last-listened position in the future
          }}
        />
      )}
    </div>
  );
}
