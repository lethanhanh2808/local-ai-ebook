// src/components/library/CharacterDetection.tsx
// AI-powered character detection + bulk voice assignment UI.
'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import {
  Wand2, Loader2, Sparkles, Check, X, AlertCircle, User, Heart, Crown,
  Play, Square, Volume2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
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
  /** BUGFIX 2026-07-11: surfaces whether the LLM returned clean JSON
   *  or whether the regex fallback path fired (typically because the
   *  Settings.aiModel is invalid for the running oMLX server). */
  source?: 'omlx' | 'regex-fallback' | 'failed';
  warning?: string;
}

interface ExistingCharacter {
  id: string;
  name: string;
  aliases: string[];
  voiceId: string | null;
  voice?: { id: string; name: string } | null;
  gender?: string | null;
  age?: string | null;
  role?: string | null;
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

  // User-corrected properties per character name. These OVERRIDE the AI values
  // and survive "Phân tích lại" (re-run) so a manual fix isn't lost when the
  // model returns the same (wrong) guess again. Keyed by character name.
  const [userEdits, setUserEdits] = useState<Record<string, Partial<DetectedCharacter>>>({});

  // Seed corrections from characters already saved in the DB (existingCharacters).
  // This makes a manual fix persist across re-runs even when the LLM returns
  // different character names (e.g. regex fallback) — the saved row keeps the
  // user's gender/age/role/aliases and re-applies them on the next detection.
  useEffect(() => {
    setUserEdits((prev) => {
      const seeded: Record<string, Partial<DetectedCharacter>> = { ...prev };
      for (const c of existingCharacters) {
        const key = c.name.toLowerCase();
        if (!seeded[key]) {
          seeded[key] = {
            gender: (c.gender as DetectedCharacter['gender']) ?? undefined,
            age: (c.age as DetectedCharacter['age']) ?? undefined,
            role: (c.role as DetectedCharacter['role']) ?? undefined,
            aliases: c.aliases,
          };
        }
      }
      return seeded;
    });
  }, [existingCharacters]);

  // Per-character voice customization (speed + emotion). Keyed by the assigned
  // voiceId. These flow into the audiobook generator so each character can
  // sound a little different — slower/faster pace, or a default emotional tint.
  interface VoiceSettings { speed: number; emotion: string; }
  const [voiceSettings, setVoiceSettings] = useState<Record<string, VoiceSettings>>({});
  // For newly-detected characters the voice is only a built-in NAME (not a DB
  // voice UUID yet), so we can't PATCH it. Stash the customization here keyed
  // by character name and flush it into the POST when the user applies.
  const [pendingVoiceSettings, setPendingVoiceSettings] = useState<Record<string, VoiceSettings>>({});
  const [savingVoice, setSavingVoice] = useState<string | null>(null);

  const loadVoiceSettings = useCallback(async () => {
    try {
      const r = await fetch(`/api/library/${bookId}/voices`);
      if (!r.ok) return;
      const data = await r.json() as { voices: Array<{ id: string; defaultSpeed?: number | null; defaultEmotion?: string | null }> };
      const map: Record<string, VoiceSettings> = {};
      for (const v of data.voices) {
        map[v.id] = { speed: v.defaultSpeed ?? 1.0, emotion: v.defaultEmotion ?? 'neutral' };
      }
      setVoiceSettings(map);
    } catch { /* non-fatal */ }
  }, [bookId]);

  useEffect(() => { void loadVoiceSettings(); }, [loadVoiceSettings]);

  // Returns true if the id looks like a DB voice UUID (so we can PATCH it).
  const isVoiceUuid = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

  const updateVoiceSetting = useCallback(async (charName: string, voiceId: string, patch: Partial<VoiceSettings>) => {
    if (isVoiceUuid(voiceId)) {
      // Existing voice — persist immediately via PATCH.
      setVoiceSettings((prev) => ({
        ...prev,
        [voiceId]: { speed: prev[voiceId]?.speed ?? 1.0, emotion: prev[voiceId]?.emotion ?? 'neutral', ...patch },
      }));
      setSavingVoice(voiceId);
      try {
        const body: Record<string, unknown> = {};
        if (patch.speed !== undefined) body.defaultSpeed = patch.speed;
        if (patch.emotion !== undefined) body.defaultEmotion = patch.emotion;
        const r = await fetch(`/api/library/${bookId}/voices/${voiceId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Lưu cài đặt giọng thất bại');
      } finally {
        setSavingVoice(null);
      }
    } else {
      // Newly-detected character — voice is a built-in name, not a UUID yet.
      // Stash locally; flushed to the DB on "Áp dụng".
      setPendingVoiceSettings((prev) => ({
        ...prev,
        [charName]: { speed: prev[charName]?.speed ?? 1.0, emotion: prev[charName]?.emotion ?? 'neutral', ...patch },
      }));
    }
  }, [bookId]);

  const applyEdit = useCallback((name: string, patch: Partial<DetectedCharacter>) => {
    setUserEdits((prev) => ({ ...prev, [name]: { ...prev[name], ...patch } }));
  }, []);

  // Merge AI detection with any user corrections (user wins).
  const mergedCharacters = useCallback((): DetectedCharacter[] => {
    if (!result) return [];
    return result.characters.map((c) => {
      const edit = userEdits[c.name];
      if (!edit) return c;
      return {
        ...c,
        gender: edit.gender ?? c.gender,
        age: edit.age ?? c.age,
        role: edit.role ?? c.role,
        aliases: edit.aliases ?? c.aliases,
      };
    });
  }, [result, userEdits]);

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
        const det = mergedCharacters().find((c) => c.name === name)!;
        // The picker holds the chosen voice NAME (e.g. "Xuân Vĩnh") for built-in
        // voices or a UUID for custom clones. We send `voiceName` to the
        // backend, which auto-creates a Voice row for built-in names so the
        // character gets a real voiceId to render in the UI (instead of
        // "Mặc định").
        const pickedVoice = picks[name] ?? det.suggested_voice;
        const pending = pendingVoiceSettings[name];
        return {
          name,
          aliases: det.aliases,
          voiceName: pickedVoice,
          role: det.role,
          age: det.age,
          tone: det.tone,
          gender: det.gender,
          // Flush any per-voice customization the user set before applying.
          ...(pending ? { defaultSpeed: pending.speed, defaultEmotion: pending.emotion } : {}),
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
              Dùng AI để phân tích sách, tìm nhân vật và gợi ý giọng phù hợp.
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
            Click &ldquo;Phân tích nhân vật&rdquo; để AI quét vài chương đầu của sách. Mất khoảng 60-90 giây.
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
                {result.source && result.source !== 'omlx' && (
                  <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-amber-100 text-amber-800 px-2 py-0.5 text-[10px] font-medium">
                    ⚠ {result.source === 'failed' ? 'LLM thất bại' : 'regex fallback'}
                  </span>
                )}
                {result.warning && (
                  <span className="block mt-1 italic text-amber-700">{result.warning}</span>
                )}
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
              {mergedCharacters().map((c) => {
                const isExisting = existingNames.has(c.name.toLowerCase());
                const isPicked = picked.has(c.name);
                const voice = picks[c.name] ?? c.suggested_voice;
                const sample = c.sample_lines[0] ?? '';
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

                        {/* Editable properties — user can correct AI mistakes
                            (gender/age/role/aliases) before applying. Corrections
                            are kept in `userEdits` and survive "Phân tích lại". */}
                        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11px] mb-2">
                          <div className="flex items-center justify-between gap-1">
                            <span className="text-muted-foreground">Giới tính</span>
                            <Select
                              value={c.gender ?? 'unknown'}
                              onValueChange={(v) => applyEdit(c.name, { gender: v as DetectedCharacter['gender'] })}
                            >
                              <SelectTrigger className="h-7 w-[92px] text-[11px]">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="unknown" className="text-[11px]">Không rõ</SelectItem>
                                <SelectItem value="male" className="text-[11px]">Nam</SelectItem>
                                <SelectItem value="female" className="text-[11px]">Nữ</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>

                          <div className="flex items-center justify-between gap-1">
                            <span className="text-muted-foreground">Tuổi</span>
                            <Select
                              value={c.age ?? 'unknown'}
                              onValueChange={(v) => applyEdit(c.name, { age: v as DetectedCharacter['age'] })}
                            >
                              <SelectTrigger className="h-7 w-[92px] text-[11px]">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="unknown" className="text-[11px]">Không rõ</SelectItem>
                                <SelectItem value="young" className="text-[11px]">Trẻ</SelectItem>
                                <SelectItem value="mature" className="text-[11px]">Trưởng thành</SelectItem>
                                <SelectItem value="old" className="text-[11px]">Già</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>

                          <div className="flex items-center justify-between gap-1">
                            <span className="text-muted-foreground">Vai trò</span>
                            <Select
                              value={c.role ?? 'supporting'}
                              onValueChange={(v) => applyEdit(c.name, { role: v as DetectedCharacter['role'] })}
                            >
                              <SelectTrigger className="h-7 w-[92px] text-[11px]">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="main" className="text-[11px]">Chính</SelectItem>
                                <SelectItem value="supporting" className="text-[11px]">Phụ</SelectItem>
                                <SelectItem value="minor" className="text-[11px]">Vãng lai</SelectItem>
                                <SelectItem value="crowd" className="text-[11px]">Đám đông</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>

                          <div className="flex items-center justify-between gap-1">
                            <span className="text-muted-foreground">Tính cách</span>
                            <Badge variant="badge-tone" className="text-[10px]">{c.tone}</Badge>
                          </div>
                        </div>

                        <div className="mb-2 flex items-center gap-2">
                          <span className="text-[11px] text-muted-foreground shrink-0">Bí danh</span>
                          <Input
                            value={c.aliases.join(', ')}
                            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                              applyEdit(c.name, {
                                aliases: e.target.value.split(',').map((s: string) => s.trim()).filter(Boolean),
                              })}
                            placeholder="cách nhau bởi dấu phẩy"
                            className="h-7 text-[11px]"
                          />
                        </div>
                        {sample && (
                          <p className="text-[10px] italic text-muted-foreground mt-1 truncate">
                            &ldquo;{sample}&rdquo;
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

                        {/* Per-character voice customization — only meaningful once a
                            voice is assigned (existing or just picked). Speed + emotion
                            are saved on the Voice row and flow into the audiobook. */}
                        {(() => {
                          const assignedVoiceId = isExisting
                            ? existingCharacters.find((x) => x.name.toLowerCase() === c.name.toLowerCase())?.voiceId
                            : (picks[c.name] ?? c.suggested_voice);
                          if (!assignedVoiceId) return null;
                          // New detections store customization locally (keyed by
                          // name) until the voice row is created on "Áp dụng".
                          // Existing characters read from the saved voice settings.
                          const vs = isVoiceUuid(assignedVoiceId)
                            ? (voiceSettings[assignedVoiceId] ?? { speed: 1.0, emotion: 'neutral' })
                            : (pendingVoiceSettings[c.name] ?? { speed: 1.0, emotion: 'neutral' });
                          const isSaving = savingVoice === assignedVoiceId;
                          return (
                            <div className="mt-2 rounded-md bg-muted/40 p-2">
                              <div className="mb-1 flex items-center gap-1 text-[10px] font-medium text-muted-foreground">
                                <Volume2 className="h-2.5 w-2.5" /> Tùy chỉnh giọng
                                {isSaving && <Loader2 className="h-2.5 w-2.5 animate-spin" />}
                              </div>
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-[10px] text-muted-foreground">Tốc độ</span>
                                <div className="flex items-center gap-1.5">
                                  <input
                                    type="range" min={0.5} max={2} step={0.1}
                                    value={vs.speed}
                                    onChange={(e) => updateVoiceSetting(c.name, assignedVoiceId, { speed: parseFloat(e.target.value) })}
                                    className="h-1 w-24 cursor-pointer accent-primary"
                                  />
                                  <span className="w-8 text-right text-[10px] tabular-nums text-muted-foreground">
                                    {vs.speed.toFixed(1)}×
                                  </span>
                                </div>
                              </div>
                              <div className="mt-1 flex items-center justify-between gap-2">
                                <span className="text-[10px] text-muted-foreground">Sắc thái</span>
                                <Select
                                  value={vs.emotion}
                                  onValueChange={(v) => updateVoiceSetting(c.name, assignedVoiceId, { emotion: v })}
                                >
                                  <SelectTrigger className="h-7 w-[110px] text-[11px]">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="neutral" className="text-[11px]">Bình thường</SelectItem>
                                    <SelectItem value="calm" className="text-[11px]">Điềm tĩnh</SelectItem>
                                    <SelectItem value="sad" className="text-[11px]">Buồn</SelectItem>
                                    <SelectItem value="tense" className="text-[11px]">Căng thẳng</SelectItem>
                                    <SelectItem value="romantic" className="text-[11px]">Lãng mạn</SelectItem>
                                    <SelectItem value="angry" className="text-[11px]">Giận dữ</SelectItem>
                                    <SelectItem value="excited" className="text-[11px]">Hào hứng</SelectItem>
                                  </SelectContent>
                                </Select>
                              </div>
                            </div>
                          );
                        })()}
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
