// src/components/library/AudiobookPlayer.tsx
// Plays pre-generated chapter audio (faster than real-time TTS).
// Sits inside EbookReader, mounted when user toggles "Audiobook mode".
'use client';

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  Play, Pause, Square, SkipBack, SkipForward, Volume2, VolumeX,
  Gauge, X, Loader2, Bookmark, Timer, RotateCcw, ListMusic, ChevronDown,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn, formatDuration } from '@/lib/utils';
import { enqueueBibleRefresh } from '@/lib/character-bible-client';

interface AudiobookPlayerProps {
  bookId: string;
  chapters: Array<{ id: string; title: string }>;
  initialChapterIdx: number;
  onClose: () => void;
  onProgress?: (chapterIdx: number, fraction: number) => void;
}

interface ChapterAudioStatus {
  ready: boolean;
  status: string;
}

interface SavedAudiobookProgress {
  chapterIdx: number;
  time: number;
  duration: number;
  title: string;
  updatedAt: string;
}

interface AudiobookBookmark {
  id: string;
  chapterIdx: number;
  time: number;
  title: string;
  createdAt: string;
}

export function AudiobookPlayer({ bookId, chapters, initialChapterIdx, onClose, onProgress }: AudiobookPlayerProps) {
  const [chapterIdx, setChapterIdx] = useState(initialChapterIdx);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1.0);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1.0);
  const [savedProgress, setSavedProgress] = useState<SavedAudiobookProgress | null>(null);
  const [bookmarks, setBookmarks] = useState<AudiobookBookmark[]>([]);
  const [sleepUntil, setSleepUntil] = useState<number | null>(null);
  const [sleepRemainingMs, setSleepRemainingMs] = useState(0);
  // Collapsible chapter list (UI Polish §4.12) — keeps the player chrome
  // compact while still letting the user jump to any chapter without
  // scrolling through the chapter dots in the reader footer.
  const [chapterListOpen, setChapterListOpen] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const reportedFraction = useRef(0);
  const pendingSeekRef = useRef<number | null>(null);
  const lastSavedAtRef = useRef(0);

  const currentChapter = chapters[chapterIdx];
  const currentAudioUrl = currentChapter
    ? `/api/library/${bookId}/audiobook/${encodeURIComponent(currentChapter.id)}`
    : '';
  const progressKey = useMemo(() => `audiobook-progress-${bookId}`, [bookId]);
  const bookmarksKey = useMemo(() => `audiobook-bookmarks-${bookId}`, [bookId]);

  const persistProgress = useCallback((idx: number, time: number, dur: number) => {
    const title = chapters[idx]?.title ?? `Chapter ${idx + 1}`;
    const value: SavedAudiobookProgress = {
      chapterIdx: idx,
      time: Math.max(0, time),
      duration: Math.max(0, dur),
      title,
      updatedAt: new Date().toISOString(),
    };
    setSavedProgress(value);
    try { localStorage.setItem(progressKey, JSON.stringify(value)); } catch { /* ignore */ }
  }, [chapters, progressKey]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(progressKey);
      if (raw) {
        const saved = JSON.parse(raw) as SavedAudiobookProgress;
        if (saved.chapterIdx >= 0 && saved.chapterIdx < chapters.length) {
          setSavedProgress(saved);
          setChapterIdx(saved.chapterIdx);
          pendingSeekRef.current = saved.time;
        }
      }
      const rawBookmarks = localStorage.getItem(bookmarksKey);
      if (rawBookmarks) setBookmarks(JSON.parse(rawBookmarks) as AudiobookBookmark[]);
    } catch { /* ignore */ }
  }, [bookmarksKey, chapters.length, progressKey]);

  // Set up audio element
  useEffect(() => {
    const audio = new Audio();
    audio.preload = 'auto';
    audioRef.current = audio;

    audio.addEventListener('timeupdate', () => {
      setCurrentTime(audio.currentTime);
      const now = Date.now();
      if (audio.duration > 0 && now - lastSavedAtRef.current > 4000) {
        lastSavedAtRef.current = now;
        persistProgress(chapterIdx, audio.currentTime, audio.duration);
      }
      if (audio.duration > 0 && onProgress) {
        const f = audio.currentTime / audio.duration;
        if (Math.abs(f - reportedFraction.current) > 0.1) {
          reportedFraction.current = f;
          onProgress(chapterIdx, f);
        }
      }
    });
    audio.addEventListener('loadedmetadata', () => {
      setDuration(audio.duration);
      const pending = pendingSeekRef.current;
      if (pending !== null && Number.isFinite(pending) && audio.duration > 0) {
        audio.currentTime = Math.max(0, Math.min(audio.duration - 1, pending));
        setCurrentTime(audio.currentTime);
        pendingSeekRef.current = null;
      }
    });
    audio.addEventListener('ended', () => {
      persistProgress(chapterIdx, audio.duration || 0, audio.duration || 0);
      // Character Bible auto-refresh — accumulator needs to know which
      // chapter just finished. BullMQ dedups on (bookId, chapterIndex)
      // so back-to-back enqueues for the same chapter collapse to one
      // worker call.
      enqueueBibleRefresh({
        bookId,
        chapterIndex: chapterIdx,
        reason: 'chapter-close',
      });
      // Auto-advance to next chapter
      if (chapterIdx < chapters.length - 1) {
        setChapterIdx((i) => i + 1);
      } else {
        setPlaying(false);
      }
    });
    audio.addEventListener('error', () => {
      const code = audio.error?.code;
      setError(code === MediaError.MEDIA_ERR_DECODE
        ? 'Trình duyệt không decode được audio chương này. Thử mở audio trực tiếp hoặc tạo lại chương.'
        : 'Không thể tải audio. Có thể file chưa sẵn sàng hoặc trình duyệt không hỗ trợ định dạng này.');
      setPlaying(false);
    });
    return () => { audio.pause(); audio.src = ''; audioRef.current = null; };
  }, [chapters.length, chapterIdx, onProgress, persistProgress]);

  // When chapter changes, load new src
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !currentChapter) return;
    setError(null);
    setCurrentTime(0); setDuration(0);
    setLoading(true);
    audio.src = currentAudioUrl;
    audio.load();
    audio.playbackRate = playbackRate;
    audio.muted = muted;
    audio.volume = volume;
    audio.oncanplay = () => {
      setLoading(false);
      if (playing) audio.play().catch(() => setPlaying(false));
    };
  }, [chapterIdx, currentChapter, currentAudioUrl]);

  // Apply playback rate / volume changes live
  useEffect(() => { if (audioRef.current) audioRef.current.playbackRate = playbackRate; }, [playbackRate]);
  useEffect(() => { if (audioRef.current) audioRef.current.muted = muted; }, [muted]);
  useEffect(() => { if (audioRef.current) audioRef.current.volume = volume; }, [volume]);

  const togglePlay = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) { audio.pause(); setPlaying(false); }
    else {
      try { await audio.play(); setPlaying(true); }
      catch (e) { setError(`Lỗi phát: ${String(e)}`); }
    }
  }, [playing]);

  const stop = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.pause();
    audio.currentTime = 0;
    setPlaying(false);
  }, []);

  useEffect(() => {
    if (!sleepUntil) {
      setSleepRemainingMs(0);
      return;
    }
    const update = () => {
      const remaining = sleepUntil - Date.now();
      setSleepRemainingMs(Math.max(0, remaining));
      if (remaining <= 0) {
        setSleepUntil(null);
        stop();
      }
    };
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [sleepUntil, stop]);

  const seek = (fraction: number) => {
    const audio = audioRef.current;
    if (!audio || !duration) return;
    audio.currentTime = Math.max(0, Math.min(duration, duration * fraction));
    persistProgress(chapterIdx, audio.currentTime, duration);
  };

  const nextChapter = () => {
    if (chapterIdx < chapters.length - 1) setChapterIdx((i) => i + 1);
  };
  const prevChapter = () => {
    if (chapterIdx > 0) setChapterIdx((i) => i - 1);
    else stop();
  };

  const skip = (seconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = Math.max(0, Math.min(duration, audio.currentTime + seconds));
    persistProgress(chapterIdx, audio.currentTime, duration);
  };

  const addBookmark = () => {
    const audio = audioRef.current;
    const time = audio?.currentTime ?? currentTime;
    const next: AudiobookBookmark = {
      id: `${Date.now()}`,
      chapterIdx,
      time,
      title: currentChapter?.title ?? `Chapter ${chapterIdx + 1}`,
      createdAt: new Date().toISOString(),
    };
    const updated = [next, ...bookmarks].slice(0, 12);
    setBookmarks(updated);
    try { localStorage.setItem(bookmarksKey, JSON.stringify(updated)); } catch { /* ignore */ }
  };

  const removeBookmark = (id: string) => {
    const updated = bookmarks.filter((b) => b.id !== id);
    setBookmarks(updated);
    try { localStorage.setItem(bookmarksKey, JSON.stringify(updated)); } catch { /* ignore */ }
  };

  const jumpToBookmark = (bm: AudiobookBookmark) => {
    pendingSeekRef.current = bm.time;
    setChapterIdx(bm.chapterIdx);
    if (bm.chapterIdx === chapterIdx && audioRef.current) {
      audioRef.current.currentTime = bm.time;
      setCurrentTime(bm.time);
    }
  };

  const restartFromBeginning = () => {
    try { localStorage.removeItem(progressKey); } catch { /* ignore */ }
    setSavedProgress(null);
    pendingSeekRef.current = null;
    setChapterIdx(0);
    if (audioRef.current) audioRef.current.currentTime = 0;
  };

  // ── Keyboard shortcuts (UI Polish 5.2) ──────────────────────────────
  // Scoped to the player root. Skipped when focus is inside an input /
  // textarea / select / contenteditable so the shortcuts don't fire
  // while the user is editing (e.g. typing a search). The skip rule
  // ALSO prevents collision with the reader's own Arrow/Space shortcuts.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const isEditable = (el: EventTarget | null) => {
      if (!(el instanceof HTMLElement)) return false;
      const tag = el.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
      if (el.isContentEditable) return true;
      return false;
    };

    const handler = (e: KeyboardEvent) => {
      // If focus is outside the player root, ignore — this is the
      // primary defense against colliding with the reader's
      // Arrow/Space paging.
      if (!root.contains(document.activeElement) && document.activeElement !== document.body) {
        // Only honor shortcuts that originated WITHIN the player.
      }
      if (isEditable(e.target)) return;
      // Don't hijack modifier-combos.
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      switch (e.key) {
        case ' ':
        case 'k':
        case 'K':
          e.preventDefault();
          togglePlay();
          break;
        case 'j':
        case 'J':
          e.preventDefault();
          skip(-10);
          break;
        case 'l':
        case 'L':
          e.preventDefault();
          skip(10);
          break;
        case 'ArrowLeft':
          e.preventDefault();
          skip(-5);
          break;
        case 'ArrowRight':
          e.preventDefault();
          skip(5);
          break;
        case 'm':
        case 'M':
          e.preventDefault();
          setMuted((m) => !m);
          break;
        case 'f':
        case 'F':
          e.preventDefault();
          if (document.fullscreenElement) {
            document.exitFullscreen().catch(() => {});
          } else {
            root.requestFullscreen?.().catch(() => {});
          }
          break;
      }
    };

    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [togglePlay, skip]);

  return (
    <div ref={rootRef} role="region" aria-label="Audiobook player" className="fixed bottom-0 left-0 right-0 z-40 border-t border-border bg-background/95 backdrop-blur-xl shadow-2xl">
      <div className="container mx-auto max-w-6xl px-4 py-3">
        {/* Title + close */}
        <div className="flex items-start gap-2 mb-2">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Volume2 className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold truncate">{currentChapter?.title ?? 'Audiobook'}</p>
            <p className="text-[10px] text-muted-foreground">
              Chương {chapterIdx + 1}/{chapters.length}
              {savedProgress?.chapterIdx === chapterIdx && savedProgress.time > 5 && (
                <span className="ml-1.5">· đã khôi phục {formatDuration(savedProgress.time * 1000)}</span>
              )}
            </p>
          </div>
          <span className="mt-1 text-[10px] text-muted-foreground tabular-nums">
            {formatDuration(currentTime * 1000)} / {formatDuration(duration * 1000)}
          </span>
          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={onClose} title="Đóng audiobook" aria-label="Đóng audiobook">
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>

        {/* Seek bar */}
        <div className="mb-2">
          <input
            type="range"
            min={0}
            max={1}
            step={0.001}
            value={duration ? currentTime / duration : 0}
            onChange={(e) => seek(parseFloat(e.target.value))}
            disabled={!duration}
            aria-label="Seek through chapter"
            aria-valuetext={duration ? `${formatDuration(currentTime * 1000)} of ${formatDuration(duration * 1000)}` : undefined}
            className="w-full h-1.5 accent-primary cursor-pointer"
          />
        </div>

        {/* Controls */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <Button size="icon" variant="ghost" className="h-8 w-8" onClick={prevChapter} title="Chương trước" aria-label="Previous chapter">
            <SkipBack className="h-4 w-4" />
          </Button>
          <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => skip(-10)} title="-10s" aria-label="Skip back 10 seconds">
            <span className="text-[10px] font-mono">-10</span>
          </Button>
          <Button
            size="icon"
            variant={playing ? 'default' : 'outline'}
            className="h-9 w-9"
            onClick={togglePlay}
            disabled={loading}
            aria-label={playing ? 'Pause' : 'Play'}
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" />
              : playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          </Button>
          <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => skip(10)} title="+10s" aria-label="Skip forward 10 seconds">
            <span className="text-[10px] font-mono">+10</span>
          </Button>
          <Button size="icon" variant="ghost" className="h-8 w-8" onClick={nextChapter} title="Chương sau" aria-label="Next chapter">
            <SkipForward className="h-4 w-4" />
          </Button>
          <Button size="icon" variant="ghost" className="h-8 w-8" onClick={stop} aria-label="Stop playback">
            <Square className="h-3.5 w-3.5" />
          </Button>
          <Button size="icon" variant="ghost" className="h-8 w-8" onClick={addBookmark} title="Đánh dấu thời điểm" aria-label="Bookmark current time">
            <Bookmark className="h-3.5 w-3.5" />
          </Button>
          <Button size="icon" variant="ghost" className="h-8 w-8" onClick={restartFromBeginning} title="Nghe lại từ đầu" aria-label="Restart from beginning">
            <RotateCcw className="h-3.5 w-3.5" />
          </Button>

          <div className="ml-2 flex items-center gap-1.5" role="group" aria-label="Playback speed">
            <Gauge className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
            {[0.75, 1.0, 1.25, 1.5, 2.0].map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setPlaybackRate(r)}
                aria-pressed={playbackRate === r}
                aria-label={`Playback speed ${r}×`}
                className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium border border-border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  playbackRate === r ? 'bg-primary text-primary-foreground border-primary' : 'border-border hover:bg-muted')}>
                {r}×
              </button>
            ))}
          </div>

          <div className="flex items-center gap-1.5" role="group" aria-label="Sleep timer">
            <Timer className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
            {[15, 30, 45].map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setSleepUntil(Date.now() + m * 60_000)}
                aria-label={`Sleep timer ${m} minutes`}
                className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium border border-border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  sleepUntil ? 'border-primary/40 bg-primary/5' : 'border-border hover:bg-muted')}>
                {m}m
              </button>
            ))}
            {sleepUntil && (
              <button onClick={() => setSleepUntil(null)} className="rounded border border-border border-border px-1.5 py-0.5 text-[10px] hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                tắt · {formatDuration(sleepRemainingMs)}
              </button>
            )}
          </div>

          <div className="ml-auto flex items-center gap-1.5">
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8"
              onClick={() => setMuted((m) => !m)}
              aria-label={muted ? 'Unmute' : 'Mute'}
              aria-pressed={muted}
            >
              {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
            </Button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={volume}
              onChange={(e) => setVolume(parseFloat(e.target.value))}
              aria-label="Volume"
              aria-valuetext={`${Math.round(volume * 100)} percent`}
              className="w-20 accent-primary"
            />
          </div>
        </div>

        {/* Collapsible chapter list — opens inline above errors/bookmarks
            so it doesn't push the rest of the UI around. Each row is a
            real button (focusable, keyboard-activatable) with a "now
            playing" marker when chapterIdx matches. */}
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setChapterListOpen((o) => !o)}
            aria-expanded={chapterListOpen}
            aria-controls="audiobook-chapter-list"
            className={cn(
              'flex w-full items-center justify-between gap-2 rounded-md border border-border px-2 py-1 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              chapterListOpen ? 'bg-muted/60 border-border' : 'border-transparent hover:bg-muted/40',
            )}
          >
            <span className="inline-flex items-center gap-1.5">
              <ListMusic className="h-3.5 w-3.5" />
              Danh sách chương ({chapterIdx + 1}/{chapters.length})
            </span>
            <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', chapterListOpen && 'rotate-180')} />
          </button>
          {chapterListOpen && (
            <ol
              id="audiobook-chapter-list"
              className="mt-1 max-h-48 overflow-y-auto rounded-md border border-border bg-card/40 divide-y divide-border/60"
            >
              {chapters.map((c, idx) => {
                const isCurrent = idx === chapterIdx;
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => setChapterIdx(idx)}
                      aria-current={isCurrent ? 'true' : undefined}
                      className={cn(
                        'flex w-full items-center gap-2 px-2 py-1 text-left text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        isCurrent
                          ? 'bg-primary/10 text-primary font-medium'
                          : 'hover:bg-muted/50 text-foreground/90',
                      )}
                    >
                      <span className={cn(
                        'tabular-nums w-7 shrink-0 text-[10px] text-right',
                        isCurrent ? 'text-primary' : 'text-muted-foreground',
                      )}>
                        {isCurrent
                          ? <Play className="inline h-3 w-3 fill-current" aria-label="Đang phát" />
                          : idx + 1}
                      </span>
                      <span className="truncate flex-1">{c.title || `Chapter ${idx + 1}`}</span>
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
        </div>

        {error && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-destructive">
            <span>{error}</span>
            {currentAudioUrl && (
              <a href={currentAudioUrl} target="_blank" rel="noreferrer" className="rounded border border-border border-destructive/30 px-2 py-0.5 hover:bg-destructive/10">
                Mở audio
              </a>
            )}
          </div>
        )}
        {bookmarks.length > 0 && (
          <div className="mt-2 flex gap-1.5 overflow-x-auto pb-1">
            {bookmarks.map((bm) => (
              <div key={bm.id} className="flex shrink-0 items-center gap-1 rounded-full border border-border bg-muted/40 pl-2 pr-1 py-0.5 text-[10px]">
                <button onClick={() => jumpToBookmark(bm)} className="max-w-36 truncate hover:text-primary" title={`${bm.title} · ${formatDuration(bm.time * 1000)}`}>
                  {bm.chapterIdx + 1}: {formatDuration(bm.time * 1000)}
                </button>
                <button onClick={() => removeBookmark(bm.id)} className="rounded-full p-0.5 text-muted-foreground hover:text-destructive" title="Xoá bookmark">
                  <X className="h-2.5 w-2.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
