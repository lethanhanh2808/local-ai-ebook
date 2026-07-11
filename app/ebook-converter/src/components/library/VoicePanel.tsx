// src/components/library/VoicePanel.tsx
// Voice management UI – upload, test, delete voices per book.
'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import {
  Plus, Mic, Trash2, Loader2, Volume2, Star, Square, Upload, X, Play, Sparkles,
  User,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { useToast } from '@/components/ui/toast';
import { ErrorState } from '@/components/layout/ErrorState';
import { VIENEU_BUILTIN_LIST } from '@/lib/tts/vieneu-voices';
import { CharacterDetection } from './CharacterDetection';

interface Voice {
  id: string;
  name: string;
  description?: string | null;
  language: string;
  isDefault: boolean;
  refAudioPath: string;
  defaultSpeed?: number | null;
  defaultEmotion?: string | null;
  createdAt: string;
}

// ── VieNeu built-in voices (Vietnamese-native, 48 kHz) ──────────────────────
// Source: `src/lib/tts/vieneu-voices.ts` — synced from the upstream catalog
// at `app/tts-service/VieNeu-TTS/src/vieneu/assets/voices_v3_turbo.json`. The
// backend's POST /characters route auto-creates a Voice row for the built-in
// name when the user applies the assignment.
const VIENEU_BUILTIN = VIENEU_BUILTIN_LIST;

interface Character {
  id: string;
  name: string;
  aliases: string[];
  voiceId: string | null;
  voice?: { id: string; name: string } | null;
  sampleLines?: string[];  // populated from detection, used for preview
}

interface Props {
  bookId: string;
  bookLanguage: string;
  // Optional anchor passed by parent (EbookReader sidebar tabs). When
  // 'characters' the parent is showing the per-character voice-assignment
  // surface; when 'voices' it shows the library-management surface. The
  // component renders both today; the hint is kept for the upcoming
  // tab refactor (Phase 3 §3.2) and is safe to ignore for now.
  section?: 'voices' | 'characters';
  // Read-aloud "TỰ ĐỘNG THEO NHÂN VẬT" toggle. When provided, the
  // character section surfaces a BẬT/TẮT pill that mirrors the same
  // state in the Read-aloud panel, so the two UIs stay in sync.
  // Optional so the legacy callers (no toggle) keep working.
  useCharacterVoice?: boolean;
  setUseCharacterVoice?: (v: boolean) => void;
}

export function VoicePanel({
  bookId, bookLanguage, section: _section,
  useCharacterVoice, setUseCharacterVoice,
}: Props) {
  const toast = useToast();
  const [voices, setVoices] = useState<Voice[]>([]);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [showUploadForm, setShowUploadForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newLang, setNewLang] = useState(bookLanguage || 'vi');
  const [newDefault, setNewDefault] = useState(false);
  const [newSpeed, setNewSpeed] = useState(1.0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const charAudioRef = useRef<HTMLAudioElement | null>(null);
  const [testingVoiceId, setTestingVoiceId] = useState<string | null>(null);
  const [previewingChar, setPreviewingChar] = useState<string | null>(null);
  const [charPreviewError, setCharPreviewError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  // Auto-assign state — separate from CharacterDetection's internal flow so
  // this button works even if the user never opened the AI panel above.
  const [autoAssigning, setAutoAssigning] = useState(false);
  const [autoAssignMsg, setAutoAssignMsg] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setFetchError(null);
    try {
      const [v, c] = await Promise.all([
        fetch(`/api/library/${bookId}/voices`).then((r) => r.json()),
        fetch(`/api/library/${bookId}/characters`).then((r) => r.json()),
      ]);
      setVoices(v.voices ?? []);
      setCharacters(c.characters ?? []);
    } catch (e) {
      setFetchError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [bookId]);

  useEffect(() => { void fetchAll(); }, [fetchAll]);

  const handleUpload = async (file: File) => {
    if (!newName.trim()) { setError('Tên giọng không được trống'); return; }
    setUploading(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('name', newName.trim());
      fd.append('description', newDesc.trim());
      fd.append('language', newLang);
      fd.append('isDefault', String(newDefault));
      fd.append('defaultSpeed', String(newSpeed));
      const r = await fetch(`/api/library/${bookId}/voices`, { method: 'POST', body: fd });
      if (!r.ok) throw new Error((await r.json()).error ?? 'Upload failed');
      setNewName(''); setNewDesc(''); setNewDefault(false); setShowUploadForm(false);
      await fetchAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Lỗi');
    } finally {
      setUploading(false);
    }
  };

  const handleTest = async (voice: Voice) => {
    setTestingVoiceId(voice.id);
    try {
      const r = await fetch(`/api/library/${bookId}/voices/${voice.id}?action=test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Xin chào, đây là giọng đọc thử nghiệm của cuốn sách này.', speed: voice.defaultSpeed ?? 1 }),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? 'TTS failed');
      const audioBlob = await r.blob();
      if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
      const url = URL.createObjectURL(audioBlob);
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => { URL.revokeObjectURL(url); setTestingVoiceId(null); };
      audio.onerror = () => { URL.revokeObjectURL(url); setTestingVoiceId(null); };
      await audio.play();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Lỗi');
      setTestingVoiceId(null);
    }
  };

  const stopTest = () => {
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
    setTestingVoiceId(null);
  };

  // ── Per-character voice preview ─────────────────────────────────────────
  // Synthesizes a short line in the character's assigned voice so users can
  // hear what that character will sound like in the audiobook. Works for
  // BOTH custom cloned voices AND the 10 built-in VieNeu voices — the
  // backend's POST /characters auto-creates a Voice row for built-in names
  // on first assignment, so `voices.find(v.id === c.voiceId)` resolves
  // both cases the same way after applying.
  const previewCharacter = useCallback(async (char: Character) => {
    setCharPreviewError(null);
    setPreviewingChar(char.id);
    const v = voices.find((vv) => vv.id === char.voiceId);
    if (!v) { setCharPreviewError('Nhân vật chưa được gán giọng'); setPreviewingChar(null); return; }
    // Pick a sample line — prefer the character's detected sample from
    // CharacterDetection, else a generic short line.
    const sampleLine = char.sampleLines?.[0] || `Xin chào, mình là ${char.name}.`;
    try {
      const r = await fetch('/api/tts/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voice: v.name, text: sampleLine, language: 'vi', speed: 1.0 }),
      });
      if (!r.ok) {
        const detail = await r.json().catch(() => ({}));
        throw new Error(detail.error ?? `HTTP ${r.status}`);
      }
      const blob = await r.blob();
      if (charAudioRef.current) { charAudioRef.current.pause(); charAudioRef.current = null; }
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      charAudioRef.current = audio;
      audio.onended = () => { URL.revokeObjectURL(url); setPreviewingChar(null); charAudioRef.current = null; };
      audio.onerror = () => { URL.revokeObjectURL(url); setPreviewingChar(null); charAudioRef.current = null; };
      await audio.play();
    } catch (e) {
      setCharPreviewError(e instanceof Error ? e.message : 'Lỗi');
      setPreviewingChar(null);
    }
  }, [voices]);

  // ── Resolve the voice name to send to /api/tts/preview for a character ──
  // Works whether the assignment is a built-in (stored as Voice row with
  // refAudioPath = "") OR a custom cloned voice (UUID, has refAudioPath).
  // Falls back to the name from the dropdown picker for optimistic preview
  // before the Voice row is created on the server.
  const resolveVoiceName = useCallback((char: Character): string | null => {
    const v = voices.find((vv) => vv.id === char.voiceId);
    if (v) return v.name;
    // Optimistic: if the dropdown shows a built-in that hasn't been applied yet
    // (no Voice row in DB yet), the picker value equals the voice name.
    const builtin = VIENEU_BUILTIN.find((vv) => vv.id === char.voiceId);
    if (builtin) return builtin.name;
    return null;
  }, [voices]);

  const stopCharPreview = () => {
    if (charAudioRef.current) {
      charAudioRef.current.pause();
      charAudioRef.current = null;
    }
    setPreviewingChar(null);
  };

  const handleDelete = (voice: Voice) => {
    toast.confirm({
      title: `Xoá giọng "${voice.name}"?`,
      confirmLabel: 'Xoá',
      destructive: true,
      onConfirm: async () => {
        await fetch(`/api/library/${bookId}/voices?voiceId=${voice.id}`, { method: 'DELETE' });
        await fetchAll();
      },
    });
  };

  const toggleDefault = async (voice: Voice) => {
    await fetch(`/api/library/${bookId}/voices/${voice.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isDefault: !voice.isDefault }),
    });
    await fetchAll();
  };

  const setCharVoice = async (charId: string, voiceId: string | null) => {
    // The dropdown's `value` is either:
    //   - A custom voice UUID      → backend expects { voiceId }
    //   - A built-in name (e.g. "Xuân Vĩnh") → backend expects { voiceName }
    //     (the backend auto-creates a Voice row so it can be previewed/edited)
    //   - "" (empty placeholder)  → unassign (voiceId: null)
    const char = characters.find((c) => c.id === charId);
    const name = char?.name ?? '';
    let payload: { name: string; voiceId?: string | null; voiceName?: string };
    if (!voiceId) {
      payload = { name, voiceId: null };
    } else if (VIENEU_BUILTIN.some((v) => v.id === voiceId)) {
      payload = { name, voiceName: voiceId };
    } else {
      payload = { name, voiceId };
    }
    await fetch(`/api/library/${bookId}/characters`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ characters: [payload] }),
    });
    await fetchAll();
  };

  /**
   * One-click "Gán giọng tự động": runs AI character detection and applies
   * the suggested voice to every character that doesn't already have one
   * assigned. Won't overwrite manual choices — characters with voiceId
   * already set are skipped.
   */
  const autoAssignVoices = useCallback(async () => {
    setAutoAssigning(true);
    setAutoAssignMsg(null);
    setError(null);
    try {
      // Run the same detect endpoint CharacterDetection uses internally.
      // The Python script picks up the user's aiModel from Settings DB.
      const r = await fetch(`/api/library/${bookId}/characters/detect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxCharacters: 8, language: bookLanguage }),
      });
      if (!r.ok) throw new Error(`Phân tích thất bại: HTTP ${r.status}`);
      const data = await r.json() as {
        characters?: Array<{
          name: string;
          aliases?: string[];
          suggested_voice?: string;
          role?: string;
          age?: string | null;
          tone?: string;
        }>;
      };
      const detected = data.characters ?? [];

      // Robust name matcher: lowercase + strip punctuation + collapse
      // whitespace. AI models sometimes add trailing dots, brackets, or
      // double-spaces to character names — exact match would miss them.
      const normalize = (s: string) =>
        s.toLowerCase().replace(/[.,!?;:'"`~()\[\]{}]/g, '').replace(/\s+/g, ' ').trim();
      const existingByName = new Map(characters.map((c) => [normalize(c.name), c]));

      if (detected.length === 0) {
        // Distinguish "AI failed to detect" from "all already assigned" —
        // the previous message was misleading when detection returned 0.
        setAutoAssignMsg(
          `⚠ AI không phát hiện nhân vật nào trong lần phân tích này (mô hình có thể trả về kết quả khác nhau mỗi lần). ` +
          `Hãy thử bấm "Phân tích nhân vật" ở panel phía trên để chạy lại, hoặc gán giọng thủ công cho từng nhân vật.`,
        );
        return;
      }

      // Filter: only assign voices to characters that DON'T already have one.
      // This respects manual choices and is idempotent. Use normalized match
      // so "Nhâm Thiếu Hoài." still maps to "Nhâm Thiếu Hoài".
      const toAssign = detected.filter((d) => {
        const existing = existingByName.get(normalize(d.name));
        if (!existing) return true;          // AI found a NEW character — assign
        return !existing.voiceId;            // existing but no voice — assign
      });
      const skippedAlreadyAssigned = detected.filter((d) => {
        const existing = existingByName.get(normalize(d.name));
        return existing && !!existing.voiceId;
      }).length;

      if (toAssign.length === 0) {
        setAutoAssignMsg(
          `✓ Tất cả ${detected.length} nhân vật AI phát hiện đều đã có giọng — không cần gán thêm.`,
        );
        return;
      }

      const payloads = toAssign
        // Only forward entries that have an actual suggested_voice — without
        // one, the backend would store voiceId=null and the character would
        // still show "Mặc định".
        .filter((d) => d.suggested_voice)
        .map((d) => ({
          name: d.name,
          aliases: d.aliases ?? [],
          voiceName: d.suggested_voice,
          role: d.role,
          age: d.age,
          tone: d.tone,
        }));

      if (payloads.length === 0) {
        setAutoAssignMsg(
          `⚠ AI phát hiện ${detected.length} nhân vật nhưng không trả về giọng gợi ý nào. ` +
          `Hãy thử bấm "Phân tích nhân vật" ở panel phía trên để chạy lại.`,
        );
        return;
      }

      const r2 = await fetch(`/api/library/${bookId}/characters`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ characters: payloads }),
      });
      if (!r2.ok) throw new Error(`Apply failed: HTTP ${r2.status}`);

      await fetchAll();
      const summary = skippedAlreadyAssigned > 0
        ? `Đã gán ${payloads.length}, bỏ qua ${skippedAlreadyAssigned} đã có sẵn`
        : `Đã gán ${payloads.length}`;
      setAutoAssignMsg(
        `✓ ${summary}: ${payloads.map((p) => `${p.name} → ${p.voiceName}`).join(', ')}`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Lỗi không xác định');
    } finally {
      setAutoAssigning(false);
    }
  }, [bookId, bookLanguage, characters, fetchAll]);

  if (loading) {
    return <div className="p-6 text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Đang tải…</div>;
  }

  if (fetchError) {
    return (
      <ErrorState
        onRetry={() => void fetchAll()}
        message={fetchError}
        details={String(fetchError)}
        retrying={loading}
      />
    );
  }

  return (
    <div className="space-y-5">
      {/* AI Character Detection */}
      <CharacterDetection
        bookId={bookId}
        existingCharacters={characters}
        onApplied={async () => { await fetchAll(); }}
      />

      {/* Voices list */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold flex items-center gap-1.5"><Mic className="h-4 w-4" />Giọng đọc ({voices.length})</h3>
          <Button size="sm" variant={showUploadForm ? 'ghost' : 'default'} onClick={() => setShowUploadForm((v) => !v)}>
            {showUploadForm ? <><X className="h-3.5 w-3.5 mr-1" />Đóng</> : <><Plus className="h-3.5 w-3.5 mr-1" />Thêm giọng</>}
          </Button>
        </div>

        {showUploadForm && (
          <Card className="rounded-xl border border-border p-4 space-y-3 mb-3">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Tên giọng (vd: Người kể chuyện, Linh, Phong)</label>
              <input type="text" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Narrator"
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Mô tả (tuỳ chọn)</label>
              <input type="text" value={newDesc} onChange={(e) => setNewDesc(e.target.value)} placeholder="Giọng nam trầm, chậm rãi"
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Ngôn ngữ</label>
                <select value={newLang} onChange={(e) => setNewLang(e.target.value)}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background">
                  <option value="vi">Tiếng Việt</option>
                  <option value="en">English</option>
                  <option value="zh">中文</option>
                  <option value="ja">日本語</option>
                  <option value="ko">한국어</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Tốc độ mặc định</label>
                <input type="number" value={newSpeed} step={0.05} min={0.5} max={2}
                  onChange={(e) => setNewSpeed(parseFloat(e.target.value))}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background" />
              </div>
            </div>
            <label className="flex items-center gap-2 text-xs cursor-pointer">
              <input type="checkbox" checked={newDefault} onChange={(e) => setNewDefault(e.target.checked)} />
              Đặt làm giọng mặc định (Người kể chuyện)
            </label>
            <div className="rounded-lg border-2 border-dashed bg-muted/30 p-3 text-center">
              <input ref={fileInputRef} type="file" accept="audio/*" className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) handleUpload(f); }} />
              <Button size="sm" variant="outline" onClick={() => fileInputRef.current?.click()} disabled={uploading || !newName.trim()}>
                {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Upload className="h-3.5 w-3.5 mr-1" />}
                {uploading ? 'Đang upload…' : 'Chọn file mẫu (WAV/MP3, 10-30 giây)'}
              </Button>
              <p className="text-[10px] text-muted-foreground mt-2">
                File mẫu tốt: 10-30 giây, giọng rõ, không nhạc nền, không tạp âm.
              </p>
            </div>
          </Card>
        )}

        {voices.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4">Chưa có giọng nào. Upload một file mẫu để bắt đầu.</p>
        ) : (
          <div className="space-y-2">
            {voices.map((v) => (
              <div key={v.id} className={cn('rounded-lg border border-border p-3 flex items-center gap-2', v.isDefault && 'border-primary/50 bg-primary/5')}>
                <button onClick={() => toggleDefault(v)} className="shrink-0"
                  title={v.isDefault ? 'Bỏ mặc định' : 'Đặt mặc định'}>
                  <Star className={cn('h-4 w-4', v.isDefault ? 'fill-amber-400 text-amber-400' : 'text-muted-foreground/40')} />
                </button>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{v.name}</p>
                  <p className="text-[10px] text-muted-foreground truncate">
                    {v.language.toUpperCase()} • {v.defaultSpeed ? `${v.defaultSpeed}×` : '1×'}
                    {v.description && ` • ${v.description}`}
                  </p>
                </div>
                <Button size="sm" variant="ghost" onClick={() => testingVoiceId === v.id ? stopTest() : handleTest(v)}
                  className="h-7 w-7 p-0">
                  {testingVoiceId === v.id ? <Square className="h-3 w-3" /> : <Volume2 className="h-3.5 w-3.5" />}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => handleDelete(v)} className="h-7 w-7 p-0 text-destructive hover:text-destructive">
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            ))}
          </div>
        )}
        {error && <p className="text-xs text-destructive mt-2">{error}</p>}
      </div>

      {/* Characters */}
      {characters.length > 0 && (
        <div className="pt-3 border-t border-border">
          {/* Header mirrors ReadAloudPanel's "TỰ ĐỘNG THEO NHÂN VẬT" so the
              two surfaces stay visually consistent — same uppercase
              section title + optional BẬT pill that the slider panel
              shows. The pill is rendered only when the parent supplies
              a setter (EbookReader does; standalone callers don't). */}
          <div className="flex items-center justify-between mb-2 gap-2">
            <h3 className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground flex items-center gap-1.5">
              <User className="h-3 w-3" /> Tự động theo nhân vật ({characters.length})
            </h3>
            {setUseCharacterVoice && (
              <button
                onClick={() => setUseCharacterVoice(!useCharacterVoice)}
                className={cn(
                  'text-[10px] px-2 py-0.5 rounded font-medium',
                  useCharacterVoice
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground',
                )}
              >
                {useCharacterVoice ? 'BẬT' : 'TẮT'}
              </button>
            )}
          </div>
          <p className="text-[10px] text-muted-foreground mb-2">
            Gán giọng cho từng nhân vật để khi đọc audio sẽ dùng đúng giọng.
          </p>

          {autoAssignMsg && (
            <p className="text-[10px] text-green-600 dark:text-green-400 mb-2 px-2 py-1 rounded bg-green-50 dark:bg-green-950/30">
              {autoAssignMsg}
            </p>
          )}

          {/* AI auto-assign — moved into a full-width secondary button below
              the description so the section header stays a clean label. */}
          <Button
            size="sm"
            variant="outline"
            onClick={autoAssignVoices}
            disabled={autoAssigning}
            className="h-7 text-xs mb-2 w-full"
            title="Dùng AI để gán giọng phù hợp cho từng nhân vật (chỉ áp dụng cho nhân vật chưa có giọng)"
          >
            {autoAssigning
              ? <><Loader2 className="h-3 w-3 mr-1 animate-spin" />Đang gán…</>
              : <><Sparkles className="h-3 w-3 mr-1" />Gán giọng tự động</>}
          </Button>

          <div className="space-y-1">
            {characters.map((c) => {
              const previewing = previewingChar === c.id;
              const assignedVoiceName = resolveVoiceName(c);
              // Show preview button whenever a voice is assigned (built-in OR custom)
              const hasAssignedVoice = !!assignedVoiceName;
              return (
                <div key={c.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/30">
                  <User className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <p className="text-[11px] font-medium flex-1 truncate">{c.name}</p>
                  {hasAssignedVoice && (
                    <button
                      onClick={() => previewing ? stopCharPreview() : previewCharacter(c)}
                      className={cn(
                        'flex items-center justify-center w-6 h-6 rounded border border-border transition-colors shrink-0',
                        previewing
                          ? 'bg-primary text-primary-foreground border-primary'
                          : 'border-border hover:bg-muted',
                      )}
                      title={previewing ? 'Dừng' : `Nghe thử giọng ${assignedVoiceName}`}
                    >
                      {previewing ? <Square className="h-3 w-3" /> : <Play className="h-3 w-3" />}
                    </button>
                  )}
                  <select
                    value={c.voiceId ?? ''}
                    onChange={(e) => setCharVoice(c.id, e.target.value || null)}
                    className="rounded-md border border-border bg-background px-2 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring max-w-[160px]"
                  >
                    <option value="">— Mặc định —</option>
                    {/* Built-in VieNeu voices (always available, no upload needed) */}
                    <optgroup label="🎙️ VieNeu có sẵn (10)">
                      {VIENEU_BUILTIN.map((v) => (
                        <option key={`builtin-${v.id}`} value={v.id}>
                          {v.name}{v.gender === 'female' ? ' ♀' : ' ♂'}
                        </option>
                      ))}
                    </optgroup>
                    {/* Custom cloned voices (only show if any exist) */}
                    {voices.length > 0 && (
                      <optgroup label="🎭 Giọng clone của bạn">
                        {voices.map((v) => (
                          <option key={v.id} value={v.id}>{v.name}</option>
                        ))}
                      </optgroup>
                    )}
                  </select>
                </div>
              );
            })}
          </div>
          {charPreviewError && <p className="text-xs text-destructive mt-2">{charPreviewError}</p>}
        </div>
      )}
    </div>
  );
}
