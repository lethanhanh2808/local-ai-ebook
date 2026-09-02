// src/components/library/AudioStudio.tsx
//
// Dedicated full-page "Audio Studio" for a book. Consolidates the audio
// production & management workflows that used to live as cramped tabs inside
// the reader's right-side Audio panel:
//   - Audiobook generation + progress
//   - Voice library (Giọng)
//   - Character detection (Nhân vật)
//   - Per-sentence voice assignment (Phân giọng)
// Read-aloud stays inline in the reader (it's synced to the chapter iframe);
// everything else is processed here.
'use client';

import { lazy, Suspense, useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import {
  ArrowLeft, Headphones, Loader2, Wand2, CheckCircle2, AlertCircle, Mic, User,
} from 'lucide-react';
import { cn } from '@/lib/utils';

const AudiobookPanel = lazy(() => import('./AudiobookPanel').then((m) => ({ default: m.AudiobookPanel })));
const VoicePanel = lazy(() => import('./VoicePanel').then((m) => ({ default: m.VoicePanel })));
const VoiceAssignPage = lazy(() => import('./VoiceAssignPage').then((m) => ({ default: m.VoiceAssignPage })));
const CharactersPanel = lazy(() => import('./CharactersPanel').then((m) => ({ default: m.CharactersPanel })));
const BibleAnalysisControls = lazy(() => import('./BibleAnalysisControls').then((m) => ({ default: m.BibleAnalysisControls })));

type StudioTab = 'audiobook' | 'voices' | 'characters' | 'assign';

const TABS: { id: StudioTab; label: string }[] = [
  { id: 'audiobook', label: 'Audiobook' },
  { id: 'voices', label: 'Giọng' },
  { id: 'characters', label: 'Nhân vật' },
  { id: 'assign', label: 'Phân giọng' },
];

function PanelSkeleton() {
  return (
    <div className="m-4 flex h-32 items-center justify-center rounded-lg border border-border bg-muted/30 text-sm text-muted-foreground animate-pulse">
      <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Đang tải…
    </div>
  );
}

interface StudioStatus {
  audiobookPct: number;
  audiobookReady: number;
  audiobookTotal: number;
  audiobookStatus: string;
  voiceCount: number;
  characterCount: number;
  characterAssigned: number;
}

export function AudioStudio({ bookId, bookTitle }: { bookId: string; bookTitle: string }) {
  const searchParams = useSearchParams();
  const initialTab = (searchParams.get('tab') as StudioTab | null) ?? 'audiobook';
  const [tab, setTab] = useState<StudioTab>(TABS.some((t) => t.id === initialTab) ? initialTab : 'audiobook');
  const [status, setStatus] = useState<StudioStatus | null>(null);
  const [generating, setGenerating] = useState(false);
  // Bumped after a range analysis completes so CharactersPanel re-fetches the
  // character grid + relationship graph (otherwise results stay stale).
  const [charactersRefreshKey, setCharactersRefreshKey] = useState(0);

  // Pull a lightweight cross-panel snapshot so the studio header + tab badges
  // reflect real state (audiobook progress, voice/character counts) without
  // each tab being a silo.
  const refreshStatus = useCallback(async () => {
    try {
      const [ab, voices, chars] = await Promise.all([
        fetch(`/api/library/${bookId}/audiobook`).then((r) => r.json()).catch(() => null),
        fetch(`/api/library/${bookId}/voices`).then((r) => r.json()).catch(() => ({ voices: [] })),
        fetch(`/api/library/${bookId}/characters`).then((r) => r.json()).catch(() => ({ characters: [] })),
      ]);
      const summary = ab?.summary ?? { ready: 0, total: 0, pct: 0 };
      const chapters = ab?.chapters ?? [];
      const status_ = ab?.book?.audiobookStatus ?? 'none';
      const characterList = chars.characters ?? [];
      setStatus({
        audiobookPct: summary.pct ?? 0,
        audiobookReady: summary.ready ?? 0,
        audiobookTotal: summary.total ?? chapters.length ?? 0,
        audiobookStatus: status_,
        voiceCount: (voices.voices ?? []).length,
        characterCount: characterList.length,
        characterAssigned: characterList.filter((c: { voiceId?: string | null }) => !!c.voiceId).length,
      });
    } catch {
      /* best-effort */
    }
  }, [bookId]);

  useEffect(() => { void refreshStatus(); }, [refreshStatus, tab]);

  // Poll while generating so the header + badges stay live.
  useEffect(() => {
    if (status?.audiobookStatus !== 'generating') return;
    const id = setInterval(() => void refreshStatus(), 3000);
    return () => clearInterval(id);
  }, [status?.audiobookStatus, refreshStatus]);

  const generateAudiobook = useCallback(async () => {
    setGenerating(true);
    try {
      await fetch(`/api/library/${bookId}/audiobook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'generate' }),
      });
      await refreshStatus();
      setTab('audiobook');
    } finally {
      setGenerating(false);
    }
  }, [bookId, refreshStatus]);

  const badge = (id: StudioTab): string | null => {
    if (!status) return null;
    switch (id) {
      case 'audiobook':
        return status.audiobookTotal > 0 ? `${status.audiobookReady}/${status.audiobookTotal}` : null;
      case 'voices':
        return status.voiceCount > 0 ? String(status.voiceCount) : null;
      case 'characters':
        return status.characterCount > 0 ? `${status.characterAssigned}/${status.characterCount}` : null;
      case 'assign':
        return status.characterAssigned > 0 ? `${status.characterAssigned}/${status.characterCount}` : null;
    }
  };

  const isGenerating = status?.audiobookStatus === 'generating';

  return (
    <div className="flex h-screen flex-col bg-gradient-to-b from-muted/40 to-background text-foreground">
      {/* Header */}
      <header className="flex items-center gap-3 border-b border-border/70 bg-background/80 px-5 py-3.5 backdrop-blur">
        <Link
          href={`/library/${bookId}/read`}
          className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-border/70 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          aria-label="Quay lại đọc"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Headphones className="h-3.5 w-3.5" />
            </span>
            <h1 className="truncate text-[15px] font-semibold tracking-tight">{bookTitle}</h1>
          </div>
          <p className="truncate pl-8 text-xs text-muted-foreground">Audio Studio</p>
        </div>
        <Link
          href={`/library/${bookId}/read`}
          className="inline-flex items-center gap-1.5 rounded-xl border border-border/70 px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Headphones className="h-3.5 w-3.5" /> Đọc sách
        </Link>
      </header>

      {/* Status strip — live cross-panel snapshot as elegant chips */}
      {status && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border/70 bg-background/60 px-5 py-2.5">
          <span className={cn(
            'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium',
            isGenerating
              ? 'border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-300'
              : status.audiobookReady === status.audiobookTotal && status.audiobookTotal > 0
                ? 'border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-400'
                : status.audiobookStatus === 'failed'
                  ? 'border-destructive/30 bg-destructive/10 text-destructive'
                  : 'border-border/70 bg-muted/50 text-muted-foreground',
          )}>
            {isGenerating ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : status.audiobookReady === status.audiobookTotal && status.audiobookTotal > 0 ? (
              <CheckCircle2 className="h-3 w-3" />
            ) : status.audiobookStatus === 'failed' ? (
              <AlertCircle className="h-3 w-3" />
            ) : (
              <Headphones className="h-3 w-3" />
            )}
            Audiobook {status.audiobookReady}/{status.audiobookTotal} · {status.audiobookPct}%
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-muted/50 px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
            <Mic className="h-3 w-3" /> {status.voiceCount} giọng
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-muted/50 px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
            <User className="h-3 w-3" /> {status.characterAssigned}/{status.characterCount} nhân vật
          </span>
        </div>
      )}

      {/* Segmented tab bar */}
      <div className="flex justify-center border-b border-border/70 bg-background/40 px-4 py-2.5">
        <div className="inline-flex w-full max-w-5xl items-center gap-1 rounded-xl border border-border/70 bg-muted/40 p-1">
          {TABS.map((t) => {
            const b = badge(t.id);
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setTab(t.id)}
                className={cn(
                  'relative flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-all',
                  active
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {t.label}
                {b && (
                  <span className={cn(
                    'rounded-full px-1.5 py-0.5 text-[10px] font-semibold',
                    active ? 'bg-primary/15 text-primary' : 'bg-background/70 text-muted-foreground',
                  )}>
                    {b}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Content — centered, comfortable max width */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl px-4 py-6">
          {tab === 'audiobook' && (
            <Suspense fallback={<PanelSkeleton />}>
              <AudiobookPanel bookId={bookId} />
            </Suspense>
          )}
          {tab === 'voices' && (
            <Suspense fallback={<PanelSkeleton />}>
              <VoicePanel
                bookId={bookId}
                bookLanguage="vi"
                section="voices"
              />
            </Suspense>
          )}
          {tab === 'characters' && (
            <Suspense fallback={<PanelSkeleton />}>
              <div className="space-y-6">
                <BibleAnalysisControls
                  bookId={bookId}
                  onAnalysisComplete={() => {
                    void refreshStatus();
                    setCharactersRefreshKey((k) => k + 1);
                  }}
                />
                <CharactersPanel
                  bookId={bookId}
                  bookLanguage="vi"
                  refreshSignal={charactersRefreshKey}
                />
              </div>
            </Suspense>
          )}
          {tab === 'assign' && (
            <Suspense fallback={<PanelSkeleton />}>
              <VoiceAssignPage bookId={bookId} bookTitle={bookTitle} />
            </Suspense>
          )}
        </div>
      </div>

      {/* Cross-tab CTA — generate the audiobook from the current voice/character
          setup without leaving the Phân giọng or Nhân vật tab. */}
      {(tab === 'assign' || tab === 'characters') && (
        <div className="flex items-center gap-3 border-t border-border/70 bg-background/80 px-5 py-3.5 backdrop-blur">
          <div className="min-w-0 flex-1 text-xs text-muted-foreground">
            {isGenerating
              ? `Đang tạo audiobook… ${status?.audiobookPct ?? 0}%`
              : 'Tạo audiobook từ cài đặt giọng hiện tại.'}
          </div>
          <Button
            size="sm"
            onClick={() => void generateAudiobook()}
            disabled={generating || isGenerating}
            className="shrink-0 rounded-xl"
          >
            {generating || isGenerating ? (
              <><Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />Đang tạo…</>
            ) : (
              <><Wand2 className="h-3.5 w-3.5 mr-1" />Tạo audiobook</>
            )}
          </Button>
        </div>
      )}
    </div>
  );
}

// (Button is imported from @/components/ui/button below)
