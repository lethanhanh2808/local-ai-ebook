// src/components/library/VoiceAssignPage.tsx
//
// Full-page "Phân giọng" (voice assignment) experience.
//
// Dedicated, distraction-free page that shows the chapter text like the reader
// (one sentence per line, grouped by paragraph). Every sentence defaults to the
// narration (người dẫn chuyện) voice — the user does nothing unless they want a
// specific sentence read by a different voice. Clicking a sentence opens a
// lightweight picker to choose a voice (or clear back to narration).
// Assignments auto-save (debounced PUT) to the per-chapter ChapterVoicePlan.
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  Check,
  Loader2,
  Mic,
  Play,
  Square,
  User,
  Volume2,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogFooter } from '@/components/ui/dialog';

interface PlanSentence {
  i: number;
  text: string;
  charId: string | null;
  voiceId: string | null;
  source: 'narration' | 'character' | 'manual';
  para: number;
}

interface VoiceOption {
  id: string;
  label: string;
  desc?: string;
  isCloned?: boolean;
  gender?: 'male' | 'female' | null;
}

interface CharacterInfo {
  id: string;
  name: string;
  voiceId: string | null;
}

interface ChapterInfo {
  id: string;
  title: string;
}

const NARRATION_VALUE = '__narration__';

function genderBadge(g?: 'male' | 'female' | null) {
  if (g === 'male') return { label: 'Nam', cls: 'bg-blue-500/15 text-blue-600 dark:text-blue-300' };
  if (g === 'female') return { label: 'Nữ', cls: 'bg-pink-500/15 text-pink-600 dark:text-pink-300' };
  return { label: '?', cls: 'bg-muted text-muted-foreground' };
}

export function VoiceAssignPage({ bookId, bookTitle }: { bookId: string; bookTitle: string }) {
  const [chapters, setChapters] = useState<ChapterInfo[]>([]);
  const [chapterId, setChapterId] = useState<string | null>(null);
  const [chapterTitle, setChapterTitle] = useState<string | null>(null);

  const [sentences, setSentences] = useState<PlanSentence[]>([]);
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [characters, setCharacters] = useState<Record<string, CharacterInfo>>({});

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  const [activeSentence, setActiveSentence] = useState<number | null>(null);
  const [previewing, setPreviewing] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirtyRef = useRef(false);

  // Load chapters + voices + characters once
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [chaps, bookVoices, engineVoices, chars] = await Promise.all([
          fetch(`/api/library/${bookId}/chapters`).then((r) => r.json()).catch(() => []),
          fetch(`/api/library/${bookId}/voices`).then((r) => r.json()).catch(() => ({ voices: [] })),
          fetch('/api/tts/voices').then((r) => r.json()).catch(() => ({ voices: [] })),
          fetch(`/api/library/${bookId}/characters`).then((r) => r.json()).catch(() => ({ characters: [] })),
        ]);
        if (cancelled) return;

        const chapList: ChapterInfo[] = Array.isArray(chaps) ? chaps : (chaps.chapters ?? []);
        setChapters(chapList);
        if (chapList.length && !chapterId) {
          setChapterId(chapList[0].id);
          setChapterTitle(chapList[0].title);
        }

        const opts: VoiceOption[] = [];
        for (const v of (engineVoices.voices ?? []) as Array<{ id: string; label?: string; gender?: 'male' | 'female' | null }>) {
          opts.push({ id: v.id, label: v.label ?? v.id, gender: v.gender ?? null });
        }
        for (const v of (bookVoices.voices ?? []) as Array<{ id: string; name: string; isCloned?: boolean; gender?: 'male' | 'female' | null }>) {
          opts.push({ id: v.id, label: v.name, isCloned: v.isCloned, gender: v.gender ?? null });
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId]);

  // Load the plan whenever the chapter changes
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

  const assignVoice = useCallback(
    (index: number, value: string) => {
      const voiceId = value === NARRATION_VALUE ? null : value;
      setSentences((prev) => {
        const next = prev.map((s, idx) =>
          idx === index ? { ...s, voiceId, source: 'manual' as const } : s,
        );
        dirtyRef.current = true;
        persist(next);
        return next;
      });
      setActiveSentence(null);
    },
    [persist],
  );

  const stopPreview = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    setPreviewing(null);
  }, []);

  const previewVoice = useCallback(
    async (voiceId: string) => {
      if (previewing === voiceId) {
        stopPreview();
        return;
      }
      stopPreview();
      setPreviewing(voiceId);
      try {
        const r = await fetch('/api/tts/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ voice: voiceId, text: 'Xin chào, đây là giọng đọc thử.' }),
        });
        if (!r.ok) throw new Error('preview failed');
        const blob = await r.blob();
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audioRef.current = audio;
        audio.onended = () => { setPreviewing(null); audioRef.current = null; };
        await audio.play();
      } catch {
        setPreviewing(null);
      }
    },
    [previewing, stopPreview],
  );

  const paragraphs = useMemo(() => {
    const groups: { para: number; items: PlanSentence[] }[] = [];
    for (const s of sentences) {
      const last = groups[groups.length - 1];
      if (last && last.para === s.para) last.items.push(s);
      else groups.push({ para: s.para, items: [s] });
    }
    return groups;
  }, [sentences]);

  const assignedCount = useMemo(
    () => sentences.filter((s) => s.voiceId != null).length,
    [sentences],
  );

  const voiceLabel = useCallback(
    (id: string | null) => {
      if (!id) return 'Giọng kể (mặc định)';
      const v = voices.find((x) => x.id === id);
      return v ? v.label : id;
    },
    [voices],
  );

  const activeSentenceObj = activeSentence !== null ? sentences[activeSentence] : null;

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
          <div className="truncate text-xs text-muted-foreground">Phân giọng theo câu</div>
        </div>

        <select
          value={chapterId ?? ''}
          onChange={(e) => {
            const id = e.target.value;
            const c = chapters.find((x) => x.id === id);
            setChapterId(id || null);
            setChapterTitle(c?.title ?? null);
          }}
          className="max-w-[14rem] rounded-md border border-input bg-background px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-ring"
          aria-label="Chọn chương"
        >
          {chapters.map((c) => (
            <option key={c.id} value={c.id}>{c.title}</option>
          ))}
        </select>

        <SaveStateBadge state={saveState} />
      </header>

      <div className="flex items-center gap-2 border-b bg-muted/30 px-4 py-2 text-xs text-muted-foreground">
        <Mic className="h-3.5 w-3.5" />
        <span>
          Mặc định mọi câu đều là <b className="text-foreground">giọng người dẫn chuyện</b>.
          Chỉ cần nhấn vào một câu để gán giọng khác.
        </span>
        <span className="ml-auto">
          Đã gán: <b className="text-foreground">{assignedCount}</b> / {sentences.length} câu
        </span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center gap-2 p-12 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Đang tải chương…
          </div>
        ) : error ? (
          <div className="flex items-center gap-2 p-6 text-sm text-red-500">
            <X className="h-4 w-4" /> {error}
          </div>
        ) : sentences.length === 0 ? (
          <div className="p-6 text-sm text-muted-foreground">Chương này không có câu nào.</div>
        ) : (
          <article className="mx-auto max-w-3xl px-6 py-8">
            {paragraphs.map((group) => (
              <p key={group.para} className="mb-5 text-[15px] leading-relaxed">
                {group.items.map((s) => {
                  const char = s.charId ? characters[s.charId] : null;
                  const assigned = s.voiceId != null;
                  const isCharacter = s.source === 'character' && char;
                  return (
                    <button
                      key={s.i}
                      type="button"
                      onClick={() => setActiveSentence(s.i)}
                      title={assigned ? `Giọng: ${voiceLabel(s.voiceId)} — nhấn để đổi` : 'Nhấn để gán giọng'}
                      className={cn(
                        'group relative mx-0.5 rounded px-1 py-0.5 text-left transition-colors',
                        'hover:bg-primary/10',
                        assigned
                          ? 'bg-primary/10 ring-1 ring-primary/30'
                          : isCharacter
                            ? 'underline decoration-dotted decoration-muted-foreground/40'
                            : '',
                      )}
                    >
                      {s.text}
                      {assigned && (
                        <span className="ml-1 inline-flex translate-y-[-2px] items-center align-super text-[10px] font-medium text-primary">
                          <Volume2 className="h-3 w-3" />
                        </span>
                      )}
                      {isCharacter && !assigned && (
                        <span
                          className="ml-1 inline-flex translate-y-[-2px] items-center align-super text-[10px] font-medium text-muted-foreground"
                          title={`Nhân vật: ${char?.name}`}
                        >
                          <User className="h-3 w-3" />
                        </span>
                      )}
                    </button>
                  );
                })}
              </p>
            ))}
          </article>
        )}
      </div>

      <Dialog
        open={activeSentence !== null}
        onOpenChange={(o) => { if (!o) setActiveSentence(null); }}
        title="Gán giọng cho câu"
        description="Chọn giọng đọc cho câu này. Để trống = giọng người dẫn chuyện."
        widthClass="max-w-md"
      >
        {activeSentenceObj && (
          <DialogBody>
            <div className="mb-3 rounded-md border bg-muted/30 p-3 text-sm">
              “{activeSentenceObj.text}”
            </div>

            <div className="mb-2 text-xs font-medium text-muted-foreground">Chọn giọng</div>
            <div className="max-h-72 space-y-1 overflow-y-auto pr-1">
              <VoiceRow
                selected={activeSentenceObj.voiceId == null}
                onClick={() => assignVoice(activeSentence!, NARRATION_VALUE)}
                icon={<Mic className="h-4 w-4" />}
                title="Giọng kể (mặc định)"
                subtitle="Người dẫn chuyện"
              />

              {voices.map((v) => {
                const g = genderBadge(v.gender);
                return (
                  <VoiceRow
                    key={v.id}
                    selected={activeSentenceObj.voiceId === v.id}
                    onClick={() => assignVoice(activeSentence!, v.id)}
                    icon={
                      <span className={cn('inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold', g.cls)}>
                        {g.label}
                      </span>
                    }
                    title={v.label}
                    subtitle={v.isCloned ? 'Giọng tùy chỉnh' : (v.gender === 'male' ? 'Nam' : v.gender === 'female' ? 'Nữ' : '')}
                    trailing={
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); previewVoice(v.id); }}
                        className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                        aria-label={`Nghe thử ${v.label}`}
                      >
                        {previewing === v.id ? <Square className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                      </button>
                    }
                  />
                );
              })}
            </div>
          </DialogBody>
        )}
      </Dialog>
    </div>
  );
}

// ── VoiceRow: a single selectable voice in the picker ──────────────────────────
// Rendered as a <div role="button"> (not a <button>) so the nested preview
// <button> is valid HTML — a <button> cannot contain another <button>.
function VoiceRow({
  selected,
  onClick,
  icon,
  title,
  subtitle,
  trailing,
}: {
  selected: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  trailing?: React.ReactNode;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      className={cn(
        'flex w-full cursor-pointer items-center gap-2.5 rounded-md border px-2.5 py-2 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
        selected
          ? 'border-primary bg-primary/10'
          : 'border-border hover:bg-accent',
      )}
    >
      <span className="flex h-5 w-5 shrink-0 items-center justify-center text-muted-foreground">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{title}</span>
        {subtitle && <span className="block truncate text-xs text-muted-foreground">{subtitle}</span>}
      </span>
      {trailing}
      {selected && <Check className="h-4 w-4 shrink-0 text-primary" />}
    </div>
  );
}

// ── SaveStateBadge ────────────────────────────────────────────────────────────
function SaveStateBadge({ state }: { state: 'idle' | 'saving' | 'saved' | 'error' }) {
  if (state === 'saving') {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
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
        <X className="h-3 w-3" /> Lỗi lưu
      </span>
    );
  }
  return <span className="text-[11px] text-muted-foreground">Tự động lưu</span>;
}