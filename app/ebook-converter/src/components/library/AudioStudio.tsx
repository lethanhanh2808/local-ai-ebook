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
  ArrowLeft, Headphones, Loader2, Wand2, CheckCircle2, AlertCircle,
} from 'lucide-react';
import { cn } from '@/lib/utils';

const AudiobookPanel = lazy(() => import('./AudiobookPanel').then((m) => ({ default: m.AudiobookPanel })));
const VoicePanel = lazy(() => import('./VoicePanel').then((m) => ({ default: m.VoicePanel })));
const VoiceAssignPage = lazy(() => import('./VoiceAssignPage').then((m) => ({ default: m.VoiceAssignPage })));

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
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className="flex items-center gap-3 border-b px-4 py-3">
        <Link
          href={`/library/${bookId}/read`}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border transition-colors hover:bg-accent"
          aria-label="Quay lại đọc"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{bookTitle}</div>
          <div className="truncate text-xs text-muted-foreground">Audio Studio</div>
        </div>
        <Link
          href={`/library/${bookId}/read`}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-accent"
        >
          <Headphones className="h-3.5 w-3.5" /> Đọc sách
        </Link>
      </header>

      {/* Studio status strip — live cross-panel snapshot */}
      {status && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b bg-muted/30 px-4 py-1.5 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            {isGenerating ? (
              <Loader2 className="h-3 w-3 animate-spin text-blue-500" />
            ) : status.audiobookReady === status.audiobookTotal && status.audiobookTotal > 0 ? (
              <CheckCircle2 className="h-3 w-3 text-green-600" />
            ) : status.audiobookStatus === 'failed' ? (
              <AlertCircle className="h-3 w-3 text-destructive" />
            ) : (
              <Headphones className="h-3 w-3" />
            )}
            Audiobook: {status.audiobookReady}/{status.audiobookTotal} chương ({status.audiobookPct}%)
          </span>
          <span>Giọng: {status.voiceCount}</span>
          <span>Nhân vật: {status.characterAssigned}/{status.characterCount} đã gán</span>
        </div>
      )}

      <div className={cn('flex border-b shrink-0', 'border-border')} role="tablist" aria-label="Audio Studio">
        {TABS.map((t) => {
          const b = badge(t.id);
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                'relative flex-1 py-2.5 text-sm font-medium transition-colors border-b-2',
                tab === t.id
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {t.label}
              {b && (
                <span className={cn(
                  'ml-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold',
                  tab === t.id ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground',
                )}>
                  {b}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
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
            <VoicePanel
              bookId={bookId}
              bookLanguage="vi"
              section="characters"
            />
          </Suspense>
        )}
        {tab === 'assign' && (
          <Suspense fallback={<PanelSkeleton />}>
            <VoiceAssignPage bookId={bookId} bookTitle={bookTitle} />
          </Suspense>
        )}
      </div>

      {/* Cross-tab CTA — generate the audiobook from the current voice/character
          setup without leaving the Phân giọng or Nhân vật tab. */}
      {(tab === 'assign' || tab === 'characters') && (
        <div className="flex items-center gap-3 border-t bg-background px-4 py-3">
          <div className="min-w-0 flex-1 text-xs text-muted-foreground">
            {isGenerating
              ? `Đang tạo audiobook… ${status?.audiobookPct ?? 0}%`
              : 'Tạo audiobook từ cài đặt giọng hiện tại.'}
          </div>
          <Button
            size="sm"
            onClick={() => void generateAudiobook()}
            disabled={generating || isGenerating}
            className="shrink-0"
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
