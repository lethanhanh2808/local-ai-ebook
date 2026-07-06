// src/components/library/CharacterDetection.tsx
// AI-powered character detection + bulk voice assignment UI.
'use client';

import { useState, useCallback, useRef } from 'react';
import {
  Wand2, Loader2, Sparkles, Check, X, AlertCircle, User, Heart, Crown,
  Play, Square, Volume2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

interface DetectedCharacter {
  name: string;
  aliases: string[];
  gender: 'male' | 'female' | 'unknown';
  /** young | mature | old | null (estimated from speech patterns). */
  age?: 'young' | 'mature' | 'old' | null;
  tone: string;
  /** main | supporting | minor | crowd — used by the voice selector to
   *  decide between a dedicated character voice or the shared common pool. */
  role?: 'main' | 'supporting' | 'minor' | 'crowd';
  lines_estimate: number;
  sample_lines: string[];
  suggested_voice: string;
  already_in_db: boolean;
}

interface DetectionResult {
  language: string;
  summary: string;
  narrator_gender_hint: string;
  total_dialogue_lines: number;
  characters: DetectedCharacter[];
  available_voices: Array<{ id: string; gender: string; tone: string; desc: string }>;
}

interface ExistingCharacter {
  id: string;
  name: string;
  aliases: string[];
  voiceId: string | null;
  voice?: { id: string; name: string } | null;
}

interface Props {
  bookId: string;
  existingCharacters: ExistingCharacter[];
  onApplied: () => void;
}

export function CharacterDetection({ bookId, existingCharacters, onApplied }: Props) {
  const [running, setRunning] = useState(false);
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<DetectionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picks, setPicks] = useState<Record<string, string>>({});   // name → voice id
  const [picked, setPicked] = useState<Set<string>>(new Set());       // which chars to apply
  const [previewing, setPreviewing] = useState<string | null>(null);   // voice id currently being previewed
  const [previewText, setPreviewText] = useState<string>('');
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Play a short preview of any voice — works for both built-in VieNeu voices
  // AND custom uploaded voices (voice cloning).
  const previewVoice = useCallback(async (voiceId: string) => {
    setPreviewing(voiceId);
    setError(null);
    try {
      // Default preview text: a short emotional Vietnamese sentence.
      // If user provided a custom preview_text from a sample line, prefer that.
      const text = previewText.trim() || 'Xin chào bạn đọc, đây là giọng của tôi.';
      const r = await fetch('/api/tts/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          voice: voiceId,
          text,
          language: 'vi',
          speed: 1.0,
        }),
      });
      if (!r.ok) {
        const detail = await r.json().catch(() => ({}));
        throw new Error(detail.error ?? `HTTP ${r.status}`);
      }
      const blob = await r.blob();
      if (audioRef.current) {
        audioRef.current.pause();
        URL.revokeObjectURL(audioRef.current.src);
      }
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => { URL.revokeObjectURL(url); setPreviewing(null); };
      audio.onerror = () => setPreviewing(null);
      await audio.play();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Preview failed');
      setPreviewing(null);
    }
  }, [previewText]);

  const stopPreview = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    setPreviewing(null);
  };

  const runDetection = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      const r = await fetch(`/api/library/${bookId}/characters/detect`, { method: 'POST' });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        throw new Error(data.error ?? `HTTP ${r.status}`);
      }
      const data = await r.json() as DetectionResult;
      setResult(data);
      // Pre-select: pick each character's suggested voice (only new ones)
      const existingNames = new Set(existingCharacters.map((c) => c.name.toLowerCase()));
      const initial: Record<string, string> = {};
      const initialPicked = new Set<string>();
      for (const c of data.characters) {
        if (!existingNames.has(c.name.toLowerCase())) {
          initial[c.name] = c.suggested_voice;
          initialPicked.add(c.name);
        }
      }
      setPicks(initial);
      setPicked(initialPicked);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Detection failed');
    } finally {
      setRunning(false);
    }
  }, [bookId, existingCharacters]);

  const togglePicked = (name: string) => {
    setPicked((prev) => {
      const n = new Set(prev);
      if (n.has(name)) n.delete(name); else n.add(name);
      return n;
    });
  };

  const setVoice = (name: string, voiceId: string) => {
    setPicks((prev) => ({ ...prev, [name]: voiceId }));
  };

  const applySelected = async () => {
    if (!result || picked.size === 0) return;
    setApplying(true);
    setError(null);
    try {
      const characters = Array.from(picked).map((name) => {
        const det = result.characters.find((c) => c.name === name)!;
        // The picker holds the chosen voice NAME (e.g. "Bình An") for built-in
        // voices or a UUID for custom clones. We send `voiceName` to the
        // backend, which auto-creates a Voice row for built-in names so the
        // character gets a real voiceId to render in the UI (instead of
        // "Mặc định").
        const pickedVoice = picks[name] ?? det.suggested_voice;
        return {
          name,
          aliases: det.aliases,
          voiceName: pickedVoice,
          role: det.role,
          age: det.age,
          tone: det.tone,
          gender: det.gender,
        };
      });
      const r = await fetch(`/api/library/${bookId}/characters`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ characters }),
      });
      if (!r.ok) throw new Error(`Apply failed: ${r.status}`);
      onApplied();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Apply failed');
    } finally {
      setApplying(false);
    }
  };

  const existingNames = new Set(existingCharacters.map((c) => c.name.toLowerCase()));
  const availableVoices = result?.available_voices ?? [];

  return (
    <div className="space-y-4">
      <Card className="rounded-xl border border-border p-4">
        <div className="flex items-center justify-between mb-2">
          <div>
            <h3 className="text-sm font-semibold flex items-center gap-1.5">
              <Wand2 className="h-4 w-4 text-primary" />AI Character Detection
            </h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Dùng oMLX (LLM cục bộ) để phân tích sách, tìm nhân vật và gợi ý giọng phù hợp.
            </p>
          </div>
          <Button size="sm" onClick={runDetection} disabled={running}>
            {running ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Sparkles className="h-3.5 w-3.5 mr-1" />}
            {running ? 'Đang phân tích… (60-90s)' : (result ? 'Phân tích lại' : 'Phân tích nhân vật')}
          </Button>
        </div>

        {error && (
          <div className="flex items-start gap-1.5 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive mt-2">
            <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {!result && !running && !error && (
          <p className="text-xs text-muted-foreground italic mt-2">
            Click "Phân tích nhân vật" để AI quét vài chương đầu của sách. Mất khoảng 60-90 giây.
          </p>
        )}
      </Card>

      {result && (
        <>
          <Card className="rounded-xl border border-border p-4">
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs text-muted-foreground">
                <strong className="text-foreground">{result.characters.length}</strong> nhân vật được phát hiện
                {result.language && <span className="ml-2">· ngôn ngữ: <strong className="text-foreground">{result.language}</strong></span>}
                {result.summary && <span className="ml-2 block mt-1 italic">{result.summary}</span>}
              </div>
              {picked.size > 0 && (
                <Button size="sm" onClick={applySelected} disabled={applying}>
                  {applying ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Check className="h-3.5 w-3.5 mr-1" />}
                  Áp dụng {picked.size} nhân vật
                </Button>
              )}
            </div>

            <div className="space-y-2 mt-3 max-h-96 overflow-y-auto">
              {result.characters.map((c) => {
                const isExisting = existingNames.has(c.name.toLowerCase());
                const isPicked = picked.has(c.name);
                const voice = picks[c.name] ?? c.suggested_voice;
                const sample = c.sample_lines[0] ?? '';
                const GenderIcon = c.gender === 'female' ? Heart : c.gender === 'male' ? User : User;
                const genderVariant =
                  c.gender === 'female' ? 'badge-gender-female' :
                  c.gender === 'male'   ? 'badge-gender-male'   :
                                          'tone-neutral';
                const ageLabel =
                  c.age === 'young'  ? 'trẻ' :
                  c.age === 'old'    ? 'lớn tuổi' :
                                       'trưởng thành';
                const roleMeta =
                  c.role === 'main'       ? { variant: 'badge-role-main'       as const, label: '⭐ chính' } :
                  c.role === 'supporting' ? { variant: 'badge-role-supporting' as const, label: 'phụ' } :
                  c.role === 'minor'      ? { variant: 'badge-role-minor'      as const, label: 'vãng lai' } :
                  c.role === 'crowd'      ? { variant: 'badge-role-crowd'      as const, label: 'đám đông' } :
                                            null;
                return (
                  <div key={c.name}
                    className={cn('rounded-lg border border-border p-3 transition-colors',
                      isPicked ? 'border-primary/50 bg-primary/5' : 'border-border bg-card')}>
                    <div className="flex items-start gap-3">
                      <input type="checkbox" checked={isPicked} onChange={() => togglePicked(c.name)}
                        disabled={isExisting}
                        className="mt-1 shrink-0" />
                      <div className="flex-1 min-w-0">
                        {/* Name + status pill — only the actionable bits stay on the title row. */}
                        <div className="flex items-center gap-2 mb-2 flex-wrap">
                          <span className="font-semibold text-sm">{c.name}</span>
                          {isExisting && (
                            <Badge variant="badge-exists" className="text-[10px]">đã có</Badge>
                          )}
                        </div>

                        {/* 2-column key/value list — replaces 5 stacked badges. */}
                        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px] mb-2">
                          <dt className="text-muted-foreground">Giới tính</dt>
                          <dd>
                            <Badge variant={genderVariant} className="text-[10px]">
                              <GenderIcon className="h-2.5 w-2.5 mr-0.5" />
                              {c.gender}
                            </Badge>
                          </dd>

                          {c.age && (
                            <>
                              <dt className="text-muted-foreground">Tuổi</dt>
                              <dd>
                                <Badge variant="badge-age" className="text-[10px]">{ageLabel}</Badge>
                              </dd>
                            </>
                          )}

                          {c.tone !== 'unknown' && (
                            <>
                              <dt className="text-muted-foreground">Tính cách</dt>
                              <dd>
                                <Badge variant="badge-tone" className="text-[10px]">{c.tone}</Badge>
                              </dd>
                            </>
                          )}

                          {roleMeta && (
                            <>
                              <dt className="text-muted-foreground">Vai trò</dt>
                              <dd>
                                <Badge variant={roleMeta.variant} className="text-[10px]">{roleMeta.label}</Badge>
                              </dd>
                            </>
                          )}

                          {c.lines_estimate > 0 && (
                            <>
                              <dt className="text-muted-foreground">Số lời</dt>
                              <dd className="text-muted-foreground tabular-nums self-center">
                                ~{c.lines_estimate.toLocaleString('vi-VN')}
                              </dd>
                            </>
                          )}
                        </dl>

                        {c.aliases.length > 0 && (
                          <p className="text-[10px] text-muted-foreground">
                            <span className="text-foreground/70">Bí danh:</span> {c.aliases.join(', ')}
                          </p>
                        )}
                        {sample && (
                          <p className="text-[10px] italic text-muted-foreground mt-1 truncate">
                            "{sample}"
                          </p>
                        )}
                        {!isExisting && (
                          <div className="mt-2 flex items-center gap-2">
                            <label className="text-[10px] text-muted-foreground">Giọng:</label>
                            <select value={voice} onChange={(e) => setVoice(c.name, e.target.value)}
                              className="rounded border border-border bg-background px-2 py-0.5 text-xs">
                              {availableVoices.map((v) => (
                                <option key={v.id} value={v.id}>{v.id}</option>
                              ))}
                            </select>
                            <button
                              onClick={() => previewing === voice ? stopPreview() : previewVoice(voice)}
                              className={cn('flex items-center gap-1 rounded border border-border px-2 py-0.5 text-[10px] transition-colors',
                                previewing === voice ? 'bg-primary text-primary-foreground border-primary' : 'border-border hover:bg-muted')}
                              title="Nghe thử giọng này"
                            >
                              {previewing === voice
                                ? <><Square className="h-2.5 w-2.5" /> dừng</>
                                : <><Play className="h-2.5 w-2.5" /> nghe thử</>}
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>

          {/* Custom preview text — used by the ▶ buttons */}
          <details className="p-3">
            <summary className="text-xs font-medium cursor-pointer text-muted-foreground">
              <Volume2 className="h-3 w-3 inline mr-1" />Văn bản thử giọng (tùy chỉnh)
            </summary>
            <textarea
              value={previewText}
              onChange={(e) => setPreviewText(e.target.value)}
              placeholder="Mặc định: 'Xin chào bạn đọc, đây là giọng của tôi.'"
              rows={2}
              className="w-full mt-2 rounded-lg border border-border bg-background px-3 py-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring resize-none"
            />
            <p className="text-[10px] text-muted-foreground mt-1">
              Để trống để dùng câu mặc định. Bạn có thể copy 1 câu thoại của nhân vật vào đây để nghe đúng giọng đó.
            </p>
          </details>
        </>
      )}
    </div>
  );
}
