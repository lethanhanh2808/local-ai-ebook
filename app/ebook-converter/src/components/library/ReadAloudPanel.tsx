// src/components/library/ReadAloudPanel.tsx
//
// Right-side slide-in panel for read-aloud (TTS) controls.
// Replaces the cramped top-of-page dropdown with a proper organized panel.
// Sections:
//   1. Default voice picker   — 10 VieNeu voices + cloned voices, with preview
//   2. Character voices       — auto-switching per character
//   3. Reading settings       — speed, expressiveness, emotion
//   4. Action footer          — Start / Stop / Pause
'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import {
  Volume2, X, Play, Pause, Square, Loader2, ChevronRight,
  User, Mic, Sparkles, Gauge, Wind, Plus, Upload, Headphones,
  Clock, FastForward,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { cn, formatDuration } from '@/lib/utils';
import { VIENEU_VOICES_LIST } from '@/lib/tts/vieneu-voices';

// Re-use the type from the static VieNeu list — its shape
// {id, label, shortLabel, gender, age, desc} is what VoiceAvatar and
// the dropdown rows expect, so deriving from it saves us from
// restating the contract.
type BuiltinVoiceEntry = (typeof VIENEU_VOICES_LIST)[number];

/** Derive a short Vietnamese flavor description from the engine's
 *  profile metadata. Same logic the static VIENEU_VOICES_LIST uses;
 *  here we apply it at runtime to whatever the active backend returns. */
function descFromVoice(v: { gender?: 'male' | 'female'; age?: 'young' | 'mature' | 'old'; tone?: string }): string {
  const gendered = v.gender === 'male' ? 'Nam' : 'Nữ';
  const ageV =
    v.age === 'young' ? 'trẻ' :
    v.age === 'mature' ? 'trưởng thành' :
    v.age === 'old' ? 'lớn tuổi' : 'trưởng thành';
  const toneV =
    v.tone === 'cheerful' ? 'vui tươi' :
    v.tone === 'calm' ? 'điềm đạm' :
    v.tone === 'cold' ? 'lạnh lùng' :
    v.tone === 'serious' ? 'rõ ràng' :
    'huyền bí';
  return `${gendered} — ${ageV}, ${toneV}`;
}

interface CharacterVoice { name: string; voiceName?: string; }

export interface CustomVoice {
  id: string;
  name: string;
  isCloned?: boolean;
}

interface ReadAloudPanelProps {
  open: boolean;
  onClose: () => void;
  embedded?: boolean;
  // State
  defaultVoice: string;
  setDefaultVoice: (v: string) => void;
  customVoices: CustomVoice[];
  setCustomVoices: (vs: CustomVoice[]) => void;
  characterList: CharacterVoice[];
  useCharacterVoice: boolean;
  setUseCharacterVoice: (v: boolean) => void;
  speed: number;
  setSpeed: (v: number) => void;
  expressiveness: number;  // 0.2-1.0 (VieNeu noise_w / noise_scale)
  setExpressiveness: (v: number) => void;
  /** Extra silence inserted between paragraphs (ms). 0 = snappiest (uses only
   * the natural trailing silence from the TTS model, ~200ms). Increase if
   * you want more breathing room between sentences. */
  paragraphGap: number;
  setParagraphGap: (v: number) => void;
  /** When ON, finishing the current chapter auto-advances to the next and
   * pre-generates the next chapter's audio in the background. Default OFF
   * so users get the current behaviour (manual chapter navigation) until
   * they explicitly opt in. */
  continuousPlay: boolean;
  setContinuousPlay: (v: boolean) => void;
  /** Background pre-gen progress — shown as a small inline badge in the
   * settings tab so the user knows the next chapter is being prepared. */
  pregenStatus: { chapterId: string; done: number; total: number } | null;
  useAIEmotion: boolean;
  setUseAIEmotion: (v: boolean) => void;
  /** How strongly the auto-emotion deltas (speed, noise scale) are applied.
   * 0 = detection still happens (label shown) but no TTS parameter changes;
   * 1 = full legacy behaviour (dramatic swings). 0.5 = gentle hint. */
  emotionIntensity: number;
  setEmotionIntensity: (v: number) => void;
  // TTS state
  ttsState: 'idle' | 'loading' | 'playing' | 'paused';
  ttsParagraphs: string[];
  ttsIndex: number;
  ttsCurrentSpeaker: string | null;
  ttsEmotionLabel: string;
  // Actions
  onStart: () => void;
  onStop: () => void;
  onTogglePause: () => void;
  onSeekParagraph?: (index: number) => void;
  onPreviewDefaultVoice: (voiceName: string) => void;
  onStopPreview: () => void;
  previewingVoice: string | null;
  // Book / character context
  bookId: string;
  onOpenVoiceLibrary: () => void;
  accentColor: string;
  // Theme
  themeCls: string;
  mutedCls: string;
  borderCls: string;
  hoverCls: string;
  activeCls: string;
}

// ── Built-in voices from the active TTS backend ────────────────────────
// We fetch from `/api/tts/voices` instead of importing the static VieNeu
// list, so the dropdown reflects whatever the user picked in /settings.
// Shape returned: {id, label, gender?, age?, tone?}. We derive a short
// Vietnamese desc from those fields so VoiceAvatar + rows look the same
// regardless of which backend is active.

function VoiceAvatar({ voice, selected }: { voice: BuiltinVoiceEntry; selected: boolean }) {
  const color = voice.gender === 'female' ? 'bg-pink-500/15 text-pink-700 dark:text-pink-300' : 'bg-blue-500/15 text-blue-700 dark:text-blue-300';
  const age = voice.age === 'young' ? 'Trẻ' : 'Trưởng thành';
  return (
    <div className={cn(
      'flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold',
      selected ? 'bg-primary text-primary-foreground' : color,
    )}>
      <User className="h-4 w-4" />
    </div>
  );
}

export function ReadAloudPanel({
  open, onClose, embedded = false,
  defaultVoice, setDefaultVoice,
  customVoices, setCustomVoices,
  characterList,
  useCharacterVoice, setUseCharacterVoice,
  speed, setSpeed,
  expressiveness, setExpressiveness,
  paragraphGap, setParagraphGap,
  continuousPlay, setContinuousPlay,
  pregenStatus,
  useAIEmotion, setUseAIEmotion,
  emotionIntensity, setEmotionIntensity,
  ttsState, ttsParagraphs, ttsIndex, ttsCurrentSpeaker, ttsEmotionLabel,
  onStart, onStop, onTogglePause, onSeekParagraph,
  onPreviewDefaultVoice, onStopPreview, previewingVoice,
  bookId, onOpenVoiceLibrary,
  accentColor,
  themeCls, mutedCls, borderCls, hoverCls, activeCls,
}: ReadAloudPanelProps) {
  const [activeTab, setActiveTab] = useState<'voices' | 'settings'>('voices');
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // 2026-08-30: moved from module top-level to inside the component — the
  // previous declaration violated rules-of-hooks (`useState` cannot run at
  // module scope), which Next.js's build-time ESLint rejects.
  const [builtinVoices, setBuiltinVoices] = useState<BuiltinVoiceEntry[]>([]);

  // Fetch the active backend's built-in catalog on mount. The endpoint
  // follows settings.ttsProvider so a future engine swap is a one-line
  // change in lib/tts/provider.ts.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/api/tts/voices');
        if (!r.ok) return;
        const body = await r.json() as { voices?: Array<{ id: string; label: string; gender?: 'male' | 'female'; age?: 'young' | 'mature' | 'old'; tone?: string }> };
        if (cancelled) return;
        setBuiltinVoices(
          (body.voices ?? []).map((v) => {
            const desc = descFromVoice(v);
            return {
              id: v.id,
              label: v.label ?? v.id,
              shortLabel: v.label ?? v.id,
              gender: v.gender ?? 'male',
              age: v.age ?? 'mature',
              desc,
            };
          }),
        );
      } catch {
        // Best-effort — leave empty so the dropdown hides the built-in group.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Combined list of available voices (active backend's built-ins + any custom)
  const allVoices = [
    ...builtinVoices,
    ...customVoices.map((v) => ({
      id: v.id, label: v.name, shortLabel: v.name, gender: 'male' as const, age: 'mature' as const,
      desc: v.isCloned ? '🎭 Giọng clone của bạn' : 'Giọng tùy chỉnh',
    })),
  ];

  const handleFileUpload = useCallback(async (file: File) => {
    const form = new FormData();
    form.append('file', file);
    form.append('name', file.name.replace(/\.[^.]+$/, ''));
    form.append('language', 'vi');
    form.append('description', 'Cloned via read-aloud panel');
    try {
      const r = await fetch(`/api/library/${bookId}/voices`, { method: 'POST', body: form });
      if (!r.ok) {
        const detail = await r.json().catch(() => ({}));
        throw new Error(detail.error ?? `HTTP ${r.status}`);
      }
      const data = await r.json();
      setCustomVoices([...customVoices, { id: data.voice.id, name: data.voice.name, isCloned: true }]);
    } catch (e) {
      console.error('[voice upload]', e);
    }
  }, [bookId, customVoices, setCustomVoices]);

  // Don't render until mounted (so SSR doesn't get a half-state)
  if (!open && !embedded) return null;

  const isPlaying = ttsState === 'playing' || ttsState === 'loading' || ttsState === 'paused';
  const seekMax = Math.max(0, ttsParagraphs.length - 1);
  const progressPct = ttsParagraphs.length > 0
    ? Math.round(((ttsIndex + 1) / ttsParagraphs.length) * 100)
    : 0;

  const content = (
    <>
        {/* Header */}
        {!embedded && <header className={cn('flex items-center justify-between px-4 py-3 border-b border-border shrink-0', borderCls)}>
          <div className="flex items-center gap-2">
            <Headphones className="h-4 w-4 text-primary" />
            <h2 className="font-semibold text-sm">Đọc to <span className={cn('text-[10px] font-normal', mutedCls)}>· Vietnamese Voice</span></h2>
          </div>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose} title="Đóng">
            <X className="h-4 w-4" />
          </Button>
        </header>}

        {/* Tabs */}
        <div className={cn('flex border-b border-border shrink-0', borderCls)}>
          <button
            onClick={() => setActiveTab('voices')}
            className={cn('flex-1 py-2 text-xs font-medium transition-colors',
              activeTab === 'voices' ? activeCls : mutedCls)}>
            🎙️ Giọng đọc
          </button>
          <button
            onClick={() => setActiveTab('settings')}
            className={cn('flex-1 py-2 text-xs font-medium transition-colors',
              activeTab === 'settings' ? activeCls : mutedCls)}>
            ⚙️ Cài đặt
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4 text-xs">

          {activeTab === 'voices' && (
            <>
              {/* Section: Default voice */}
              <section>
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground flex items-center gap-1.5">
                    <Mic className="h-3 w-3" /> Giọng mặc định
                  </h3>
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className={cn('text-[10px] px-2 py-0.5 rounded border border-border font-medium flex items-center gap-0.5', hoverCls)}
                    title="Upload audio mẫu (3-5s) để tạo giọng mới">
                    <Plus className="h-3 w-3" /> Clone
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="audio/*"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void handleFileUpload(f);
                      e.target.value = '';
                    }}
                  />
                </div>

                <div className="grid grid-cols-1 gap-1.5">
                  {allVoices.map((v) => {
                    const isSelected = defaultVoice === v.id;
                    const isPlayingThis = previewingVoice === v.id;
                    const isOtherPlaying = previewingVoice !== null && !isPlayingThis;
                    return (
                      <div key={v.id} className="space-y-1">
                        <div
                          className={cn(
                            'flex items-center gap-2 rounded-lg border border-border p-2 transition-all',
                            isSelected ? 'border-primary bg-primary/5' : `${borderCls} ${hoverCls}`,
                          )}>
                          <button
                            onClick={() => setDefaultVoice(v.id)}
                            className="flex items-center gap-2 flex-1 min-w-0 text-left">
                            <VoiceAvatar voice={v} selected={isSelected} />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5">
                                <p className="text-sm font-semibold truncate">{v.shortLabel}</p>
                                {isSelected && <span className="text-[9px] px-1 py-0.5 rounded bg-primary text-primary-foreground">ĐANG DÙNG</span>}
                              </div>
                              <p className={cn('text-[10px] truncate', mutedCls)}>{v.desc}</p>
                            </div>
                          </button>
                          <button
                            onClick={() => isPlayingThis ? onStopPreview() : onPreviewDefaultVoice(v.id)}
                            disabled={isOtherPlaying}
                            title={isPlayingThis ? 'Dừng nghe thử' : `Nghe thử ${v.label}`}
                            aria-label={isPlayingThis ? `Dừng nghe thử ${v.label}` : `Nghe thử ${v.label}`}
                            aria-pressed={isPlayingThis}
                            className={cn(
                              'shrink-0 h-8 w-8 rounded-full flex items-center justify-center transition-all',
                              isPlayingThis
                                ? 'bg-primary text-primary-foreground'
                                : isOtherPlaying
                                  ? 'opacity-30 cursor-not-allowed border border-border'
                                  : `border border-border ${hoverCls}`,
                            )}>
                            {isPlayingThis ? <Square className="h-3 w-3 fill-current" /> : <Play className="h-3.5 w-3.5 ml-0.5" />}
                          </button>
                        </div>
                        {/* Thin indeterminate progress while this voice is previewing —
                            visually signals "audio is playing" without needing real
                            progress data from the audio element. */}
                        {isPlayingThis && (
                          <Progress
                            label={`Đang nghe thử ${v.label}`}
                            className="h-1 mx-1"
                          />
                        )}
                      </div>
                    );
                  })}
                </div>

                <p className={cn('text-[10px] mt-2', mutedCls)}>
                  {customVoices.length > 0
                    ? `${builtinVoices.length} giọng từ backend + ${customVoices.length} giọng clone`
                    : `${builtinVoices.length} giọng có sẵn. Nhấn "Clone" để tạo giọng từ audio mẫu.`}
                </p>
              </section>

              {/* Section: Character voices */}
              <section className={cn('pt-3 border-t border-border', borderCls)}>
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground flex items-center gap-1.5">
                    <User className="h-3 w-3" /> Tự động theo nhân vật
                  </h3>
                  <button
                    onClick={() => setUseCharacterVoice(!useCharacterVoice)}
                    className={cn(
                      'text-[10px] px-2 py-0.5 rounded font-medium',
                      useCharacterVoice ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
                    )}>
                    {useCharacterVoice ? 'BẬT' : 'TẮT'}
                  </button>
                </div>

                {characterList.length === 0 ? (
                  <p className={cn('text-[10px] py-2', mutedCls)}>
                    Chưa phát hiện nhân vật nào.{' '}
                    <button onClick={onOpenVoiceLibrary} className="text-primary hover:underline">
                      Mở tab Giọng & nhân vật
                    </button>
                  </p>
                ) : (
                  <div className="space-y-1">
                    {characterList.map((c) => (
                      <div key={c.name} className={cn('flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/30', borderCls)}>
                        <User className={cn('h-3.5 w-3.5 shrink-0', mutedCls)} />
                        <span className="flex-1 truncate text-[11px]">{c.name}</span>
                        <ChevronRight className={cn('h-3 w-3', mutedCls)} />
                        <span className={cn('text-[11px] font-medium', c.voiceName ? 'text-primary' : mutedCls)}>
                          {c.voiceName ?? 'chưa gán'}
                        </span>
                      </div>
                    ))}
                    {characterList.length > 8 && (
                      <button onClick={onOpenVoiceLibrary} className="text-[10px] text-primary hover:underline mt-1">
                        + {characterList.length - 8} nhân vật khác… Xem tất cả
                      </button>
                    )}
                  </div>
                )}
              </section>
            </>
          )}

          {activeTab === 'settings' && (
            <>
              {/* Speed */}
              <section>
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground flex items-center gap-1.5">
                    <Gauge className="h-3 w-3" /> Tốc độ
                  </h3>
                  <span className="text-xs font-mono font-semibold">{speed.toFixed(2)}×</span>
                </div>
                <div className="flex gap-1.5">
                  {[0.75, 1.0, 1.25, 1.5, 2.0].map((s) => (
                    <button key={s} onClick={() => setSpeed(s)}
                      className={cn('flex-1 rounded-lg border border-border py-1.5 text-xs font-medium transition-all bg-transparent',
                        Math.abs(speed - s) < 0.01 ? activeCls : `${hoverCls} opacity-70`)}>
                      {s}×
                    </button>
                  ))}
                </div>
              </section>

              {/* Paragraph gap — silence inserted between paragraphs */}
              <section>
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground flex items-center gap-1.5">
                    <Clock className="h-3 w-3" /> Khoảng nghỉ giữa đoạn
                  </h3>
                  <span className="text-xs font-mono font-semibold">
                    {paragraphGap === 0 ? '0 (mượt)' : `${paragraphGap} ms`}
                  </span>
                </div>
                <input type="range" min={0} max={2000} step={50}
                  value={paragraphGap}
                  onChange={(e) => setParagraphGap(parseInt(e.target.value, 10))}
                  className="w-full" style={{ accentColor }} />
                <div className={cn('flex justify-between text-[10px] mt-0.5', mutedCls)}>
                  <span>Mượt · liền mạch</span><span>Chậm · dễ nghe</span>
                </div>
                <p className={cn('text-[10px] mt-1 leading-relaxed', mutedCls)}>
                  Thêm khoảng lặng giữa các đoạn văn. Mặc định 0 = nối tiếp liền mạch
                  (model TTS đã có ~200ms lặng tự nhiên ở cuối mỗi câu).
                </p>
              </section>

              {/* Continuous-play — auto-advance + background pre-gen */}
              <section>
                <h3 className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-2 flex items-center gap-1.5">
                  <FastForward className="h-3 w-3" /> Đọc liền chương
                </h3>
                <button
                  onClick={() => setContinuousPlay(!continuousPlay)}
                  className={cn(
                    'w-full flex items-center justify-between rounded-lg border border-border px-3 py-2.5 transition-all bg-transparent',
                    continuousPlay ? activeCls : `${hoverCls} opacity-80`,
                  )}>
                  <span className="text-xs font-medium">
                    {continuousPlay ? '⏭ Tự động sang chương kế tiếp' : '⏸ Dừng khi hết chương hiện tại'}
                  </span>
                  <span className={cn('text-[10px] px-1.5 py-0.5 rounded font-semibold',
                    continuousPlay ? 'bg-primary-foreground/25' : 'bg-foreground/10')}>
                    {continuousPlay ? 'BẬT' : 'TẮT'}
                  </span>
                </button>
                <p className={cn('text-[10px] mt-1.5 leading-relaxed', mutedCls)}>
                  Khi bật: hết chương sẽ tự sang chương kế. Chương tiếp theo
                  được chuẩn bị ở chế độ nền (pre-generate) nên không có độ trễ
                  giữa các chương. Vị trí đọc cũng tự cập nhật.
                </p>
                {pregenStatus && (
                  <div className={cn('mt-2 rounded-md border border-border bg-muted/30 px-2 py-1.5 text-[10px] flex items-center gap-1.5', mutedCls)}>
                    <Loader2 className="h-3 w-3 animate-spin text-primary" />
                    <span>
                      Đang chuẩn bị chương kế ({pregenStatus.done}/{pregenStatus.total} đoạn)
                    </span>
                  </div>
                )}
              </section>

              {/* Expressiveness */}
              <section>
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground flex items-center gap-1.5">
                    <Wind className="h-3 w-3" /> Biểu cảm
                  </h3>
                  <span className="text-xs font-mono font-semibold">{expressiveness.toFixed(2)}</span>
                </div>
                <input type="range" min={0.2} max={1.0} step={0.05} value={expressiveness}
                  onChange={(e) => setExpressiveness(parseFloat(e.target.value))}
                  className="w-full" style={{ accentColor }} />
                <div className={cn('flex justify-between text-[10px] mt-0.5', mutedCls)}>
                  <span>Phẳng</span><span>Tự nhiên</span>
                </div>
              </section>

              {/* AI Emotion */}
              <section>
                <h3 className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-2 flex items-center gap-1.5">
                  <Sparkles className="h-3 w-3" /> Cảm xúc tự động
                </h3>
                <button
                  onClick={() => setUseAIEmotion(!useAIEmotion)}
                  className={cn(
                    'w-full flex items-center justify-between rounded-lg border border-border px-3 py-2.5 transition-all bg-transparent',
                    useAIEmotion ? activeCls : `${hoverCls} opacity-80`,
                  )}>
                  <span className="text-xs font-medium">
                    {useAIEmotion ? '✨ Tự động theo nội dung' : '➖ Giọng đều'}
                  </span>
                  <span className={cn('text-[10px] px-1.5 py-0.5 rounded font-semibold',
                    useAIEmotion ? 'bg-primary-foreground/25' : 'bg-foreground/10')}>
                    {useAIEmotion ? 'BẬT' : 'TẮT'}
                  </span>
                </button>
                {useAIEmotion && (
                  <p className={cn('text-[10px] mt-1.5 leading-relaxed', mutedCls)}>
                    ⚡ hành động · 😤 tức giận · 💧 buồn · 💕 lãng mạn · 😰 căng thẳng · 🍃 bình yên
                  </p>
                )}
                {useAIEmotion && (
                  <div className="mt-2.5">
                    <div className="flex items-center justify-between mb-1">
                      <span className={cn('text-[10px] uppercase tracking-wider', mutedCls)}>
                        Cường độ cảm xúc
                      </span>
                      <span className="text-xs font-mono font-semibold">
                        {Math.round(emotionIntensity * 100)}%
                      </span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={emotionIntensity}
                      onChange={(e) => setEmotionIntensity(parseFloat(e.target.value))}
                      className="w-full"
                      style={{ accentColor }}
                    />
                    <div className={cn('flex justify-between text-[10px] mt-0.5', mutedCls)}>
                      <span>Tiết chế</span>
                      <span>Vừa</span>
                      <span>Mạnh</span>
                    </div>
                    {emotionIntensity === 0 && (
                      <p className={cn('text-[10px] mt-1 leading-relaxed', mutedCls)}>
                        Vẫn phát hiện cảm xúc nhưng không thay đổi tốc độ/giọng.
                      </p>
                    )}
                  </div>
                )}
              </section>

              {/* Voice library link */}
              <section className={cn('pt-3 border-t border-border', borderCls)}>
                <button
                  onClick={onOpenVoiceLibrary}
                  className={cn('w-full flex items-center justify-between rounded-lg border border-border px-3 py-2.5 transition-all bg-transparent', hoverCls)}>
                  <span className="text-xs font-medium flex items-center gap-1.5">
                    <Upload className="h-3.5 w-3.5" /> Thư viện giọng đọc
                  </span>
                  <ChevronRight className="h-4 w-4" />
                </button>
                <p className={cn('text-[10px] mt-1.5', mutedCls)}>
                  Quản lý giọng clone, gán giọng cho nhân vật
                </p>
              </section>
            </>
          )}
        </div>

        {/* Footer — action bar */}
        <footer className={cn('border-t border-border shrink-0 px-4 py-3 space-y-2', borderCls)}>
          {/* TTS status line */}
          {isPlaying && ttsParagraphs.length > 0 && (
            <div className="space-y-1.5">
              <div className="flex items-center gap-2 text-[11px]">
                <Volume2 className="h-3.5 w-3.5 shrink-0 opacity-70" />
                <div className="flex-1 min-w-0">
                  <p className="truncate">
                    Đoạn {ttsIndex + 1} / {ttsParagraphs.length} · {progressPct}%
                    {ttsCurrentSpeaker && (
                      <span className="ml-1 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-primary/15 text-primary text-[10px] font-medium">
                        {ttsCurrentSpeaker}
                      </span>
                    )}
                  </p>
                  {ttsEmotionLabel && <p className={cn('text-[10px] truncate', mutedCls)}>{ttsEmotionLabel}</p>}
                </div>
              </div>
              <input
                type="range"
                min={0}
                max={seekMax}
                step={1}
                value={Math.min(ttsIndex, seekMax)}
                onChange={(e) => onSeekParagraph?.(parseInt(e.target.value, 10))}
                disabled={!onSeekParagraph || ttsParagraphs.length < 2}
                className="w-full h-1.5 cursor-pointer"
                style={{ accentColor }}
                title="Chọn đoạn để đọc"
              />
            </div>
          )}

          {/* Action buttons */}
          {ttsState === 'idle' ? (
            <Button
              onClick={onStart}
              className="w-full"
              style={{ background: accentColor, color: '#fff' }}>
              <Play className="h-4 w-4 mr-1.5 fill-current" /> Bắt đầu đọc
            </Button>
          ) : (
            <div className="flex gap-2">
              <Button
                onClick={onTogglePause}
                variant="outline"
                className="flex-1">
                {ttsState === 'paused' ? <><Play className="h-4 w-4 mr-1.5" /> Tiếp tục</> : <><Pause className="h-4 w-4 mr-1.5" /> Tạm dừng</>}
              </Button>
              <Button
                onClick={onStop}
                variant="destructive"
                className="flex-1">
                <Square className="h-4 w-4 mr-1.5 fill-current" /> Dừng
              </Button>
            </div>
          )}
        </footer>
    </>
  );

  if (embedded) {
    return <div className={cn('flex h-full min-h-0 flex-col text-xs', themeCls)}>{content}</div>;
  }

  return (
    <>
      {/* Slide-in panel from right — must render BEFORE backdrop so the
          backdrop's z-index doesn't matter (panel is later in DOM). */}
      <aside
        className={cn(
          'fixed top-0 right-0 bottom-0 z-[60] w-full sm:w-[380px] shadow-2xl',
          'flex flex-col border-l border-border transition-transform',
          themeCls, borderCls,
        )}
      >
        {content}
      </aside>

      {/* Backdrop — sits below the panel but above the book content */}
      <div
        className="fixed inset-0 z-[55] bg-modal-overlay/40 backdrop-blur-[2px] transition-opacity"
        onClick={onClose}
      />
    </>
  );
}
