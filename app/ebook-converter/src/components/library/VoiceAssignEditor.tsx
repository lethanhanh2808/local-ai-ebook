// src/components/library/VoiceAssignEditor.tsx
//
// Voice Assign Editor — the "Phân giọng" tab in the reader's Audio panel.
//
// Lists every sentence of the current chapter in reading order. For each
// sentence it shows the character the attribution engine discovered (if any)
// and a voice picker. The user can correct the voice per sentence; changes
// auto-save (debounced PUT) to the per-chapter ChapterVoicePlan. Sentences left
// on the narration (default) voice need no assignment — read-aloud and the
// audiobook generator fall back to narration automatically.
'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { Loader2, Check, Mic, User, Save, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';

interface PlanSentence {
  i: number;
  text: string;
  charId: string | null;
  voiceId: string | null;
  source: 'narration' | 'character' | 'manual';
}

interface VoiceOption {
  id: string;
  label: string;
  desc?: string;
  isCloned?: boolean;
}

interface CharacterInfo {
  id: string;
  name: string;
  voiceId: string | null;
}

interface VoiceAssignEditorProps {
  bookId: string;
  chapterId: string | null;
  chapterTitle: string | null;
  panelCls: string;
  mutedCls: string;
  dividerCls: string;
  hoverCls: string;
  activeCls: string;
  accentColor: string;
}

const NARRATION_VALUE = '__narration__';

export function VoiceAssignEditor({
  bookId,
  chapterId,
  chapterTitle,
  mutedCls,
  dividerCls,
  hoverCls,
  activeCls,
  accentColor,
}: VoiceAssignEditorProps) {
  const [sentences, setSentences] = useState<PlanSentence[]>([]);
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [characters, setCharacters] = useState<Record<string, CharacterInfo>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirtyRef = useRef(false);

  // Load voices + characters once per book.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [bookVoices, engineVoices, chars] = await Promise.all([
          fetch(`/api/library/${bookId}/voices`).then((r) => r.json()).catch(() => ({ voices: [] })),
          fetch('/api/tts/voices').then((r) => r.json()).catch(() => ({ voices: [] })),
          fetch(`/api/library/${bookId}/characters`).then((r) => r.json()).catch(() => ({ characters: [] })),
        ]);
        if (cancelled) return;
        const opts: VoiceOption[] = [];
        for (const v of (engineVoices.voices ?? []) as Array<{ id: string; label?: string }>) {
          opts.push({ id: v.id, label: v.label ?? v.id });
        }
        for (const v of (bookVoices.voices ?? []) as Array<{ id: string; name: string; isCloned?: boolean }>) {
          opts.push({ id: v.id, label: v.name, isCloned: v.isCloned });
        }
        setVoices(opts);
        const charMap: Record<string, CharacterInfo> = {};
        for (const c of (chars.characters ?? []) as Array<{ id: string; name: string; voiceId?: string | null }>) {
          charMap[c.id] = { id: c.id, name: c.name, voiceId: c.voiceId ?? null };
        }
        setCharacters(charMap);
      } catch {
        /* best-effort */
      }
    })();
    return () => { cancelled = true; };
  }, [bookId]);

  // Load the plan whenever the chapter changes.
  useEffect(() => {
    if (!chapterId) {
      setSentences([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const r = await fetch(
          `/api/library/${bookId}/chapters/${encodeURIComponent(chapterId)}/voice-plan`,
        );
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json() as { sentences?: PlanSentence[] };
        if (cancelled) return;
        setSentences(data.sentences ?? []);
        setSaveState('idle');
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Lỗi tải plan');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [bookId, chapterId]);

  const persist = useCallback(
    (next: PlanSentence[]) => {
      if (!chapterId) return;
      setSaveState('saving');
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(async () => {
        try {
          const r = await fetch(
            `/api/library/${bookId}/chapters/${encodeURIComponent(chapterId)}/voice-plan`,
            {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ sentences: next }),
            },
          );
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          setSaveState('saved');
          dirtyRef.current = false;
          setTimeout(() => { if (!dirtyRef.current) setSaveState('idle'); }, 1500);
        } catch {
          setSaveState('error');
        }
      }, 500);
    },
    [bookId, chapterId],
  );

  const onPick = useCallback(
    (index: number, value: string) => {
      const voiceId = value === NARRATION_VALUE ? null : value;
      setSentences((prev) => {
        const next = prev.map((s, idx) =>
          idx === index
            ? { ...s, voiceId, source: 'manual' as const }
            : s,
        );
        dirtyRef.current = true;
        persist(next);
        return next;
      });
    },
    [persist],
  );

  if (!chapterId) {
    return (
      <div className={cn('p-4 text-sm', mutedCls)}>
        Chọn một chương để phân giọng.
      </div>
    );
  }

  if (loading) {
    return (
      <div className={cn('flex items-center justify-center gap-2 p-8 text-sm', mutedCls)}>
        <Loader2 className="h-4 w-4 animate-spin" /> Đang tải câu…
      </div>
    );
  }

  if (error) {
    return (
      <div className={cn('flex items-center gap-2 p-4 text-sm text-red-500')}>
        <AlertTriangle className="h-4 w-4" /> {error}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className={cn('flex items-center justify-between gap-2 border-b px-3 py-2 text-xs', dividerCls)}>
        <div className="min-w-0">
          <div className="font-medium">Phân giọng theo câu</div>
          <div className={cn('truncate', mutedCls)}>{chapterTitle ?? chapterId}</div>
        </div>
        <SaveStateBadge state={saveState} mutedCls={mutedCls} />
      </div>

      {/* Sentence list */}
      <div className="flex-1 overflow-y-auto">
        {sentences.length === 0 && (
          <div className={cn('p-4 text-sm', mutedCls)}>Không có câu nào trong chương này.</div>
        )}
        {sentences.map((s, idx) => {
          const char = s.charId ? characters[s.charId] : null;
          // Default selection: the character's assigned voice (if any), else the
          // user's explicit assignment, else narration.
          const selected = s.voiceId ?? (char?.voiceId ?? NARRATION_VALUE);
          return (
            <div
              key={s.i}
              className={cn(
                'border-b px-3 py-2.5',
                s.source === 'character' ? 'bg-primary/5' : '',
                dividerCls,
              )}
            >
              <div className="mb-1.5 flex items-start gap-2">
                {s.source === 'character' && char ? (
                  <span
                    className="mt-0.5 inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium"
                    style={{ backgroundColor: `${accentColor}22`, color: accentColor }}
                    title={`Nhân vật được nhận diện: ${char.name}`}
                  >
                    <User className="h-3 w-3" /> {char.name}
                  </span>
                ) : (
                  <span className={cn('mt-0.5 inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px]', mutedCls)}>
                    <Mic className="h-3 w-3" /> Kể
                  </span>
                )}
                <p className="text-[13px] leading-snug">{s.text}</p>
              </div>
              <select
                value={selected ?? NARRATION_VALUE}
                onChange={(e) => onPick(idx, e.target.value)}
                className={cn(
                  'w-full rounded-md border bg-transparent px-2 py-1 text-xs outline-none focus:ring-1',
                  dividerCls,
                  hoverCls,
                )}
                aria-label={`Chọn giọng cho câu ${s.i + 1}`}
              >
                <option value={NARRATION_VALUE}>📖 Giọng kể (mặc định)</option>
                {voices.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.isCloned ? '🎭 ' : ''}{v.label}
                  </option>
                ))}
              </select>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SaveStateBadge({ state, mutedCls }: { state: 'idle' | 'saving' | 'saved' | 'error'; mutedCls: string }) {
  if (state === 'saving') {
    return (
      <span className={cn('inline-flex items-center gap-1 text-[11px]', mutedCls)}>
        <Loader2 className="h-3 w-3 animate-spin" /> Đang lưu…
      </span>
    );
  }
  if (state === 'saved') {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-green-600">
        <Check className="h-3 w-3" /> Đã lưu
      </span>
    );
  }
  if (state === 'error') {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-red-500">
        <AlertTriangle className="h-3 w-3" /> Lỗi lưu
      </span>
    );
  }
  return <span className={cn('text-[11px]', mutedCls)}>Tự động lưu</span>;
}
