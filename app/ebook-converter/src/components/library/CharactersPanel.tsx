// src/components/library/CharactersPanel.tsx
// Redesigned "Nhân vật" (Characters) experience for the Audio Studio.
//
// A calm, card-based workspace that turns the old cramped two-column list into
// a clear three-zone flow:
//   1. Hero — one primary action: "AI phân tích nhân vật" (scans the book and
//      suggests a voice per character). A secondary "Gán giọng tự động" applies
//      the suggestions in one click.
//   2. Character grid — every detected/assigned character is a roomy card with
//      an avatar (gender/role tinted), name, role + gender + age badges,
//      aliases, a sample line, and a prominent voice picker + play button.
//   3. Detection review — when AI returns results, the same cards show a
//      suggested-voice chip and an "Áp dụng" toggle so the user can cherry-pick
//      before committing.
//
// All AI calls honour the provider configured in /settings (see
// detectorEnvOverrides in lib/ai).
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Sparkles, Loader2, AlertCircle, User,
  Play, Square, Volume2, Users, Network, Pencil,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogBody, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useToast } from '@/components/ui/toast';
import { RelationshipGraph, type GraphNode, type GraphEdge } from './RelationshipGraph';

interface BuiltinVoice {
  id: string;
  name: string;
  gender: 'male' | 'female';
  tone?: string;
}

interface CustomVoice {
  id: string;
  name: string;
  language: string;
  isDefault: boolean;
}

interface Character {
  id: string;
  name: string;
  aliases: string[];
  voiceId: string | null;
  voice?: { id: string; name: string } | null;
  sampleLines?: string[];
  role?: 'main' | 'supporting' | 'minor' | 'crowd';
  age?: 'young' | 'mature' | 'old' | null;
  gender?: 'male' | 'female' | 'unknown' | null;
  tone?: string | null;
  description?: string | null;
}

interface DetectedCharacter {
  name: string;
  aliases: string[];
  gender: 'male' | 'female' | 'unknown';
  age?: 'young' | 'mature' | 'old' | null;
  tone: string;
  role?: 'main' | 'supporting' | 'minor' | 'crowd';
  lines_estimate: number;
  sample_lines: string[];
  suggested_voice: string;
  already_in_db: boolean;
}

interface PendingDiffView {
  id: string;
  bookId: string;
  patch: {
    kind: 'new' | 'update' | 'relationship' | 'appearance';
    characterId?: string | null;
    newCharacter?: { name: string; aliases?: string[]; gender?: string; role?: string };
    updateFields?: { description?: string | null; personality?: string | null; speechStyle?: string | null; visualDescription?: string | null };
    relationship?: { fromName?: string; toName?: string; relationship?: string };
    autoReason?: string;
    evidenceQuote?: string;
  };
  status: string;
  createdAt: string;
}

interface Props {
  bookId: string;
  bookLanguage: string;
  /** Bumped by the parent after a range analysis completes so this panel
   *  re-fetches characters + the relationship graph. Without it the grid and
   *  graph would stay stale after "Phân tích". */
  refreshSignal?: number;
}

// Deterministic avatar tint per character name so each card feels distinct.
function avatarTint(name: string): { bg: string; ring: string } {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  return {
    bg: `hsl(${hue} 70% 92%)`,
    ring: `hsl(${hue} 70% 55%)`,
  };
}

const ROLE_META: Record<string, { label: string; variant: 'default' | 'secondary' | 'muted' | 'info' }> = {
  main: { label: '⭐ Chính', variant: 'default' },
  supporting: { label: 'Phụ', variant: 'secondary' },
  minor: { label: 'Vãng lai', variant: 'muted' },
  crowd: { label: 'Đám đông', variant: 'muted' },
};

export function CharactersPanel({ bookId, bookLanguage, refreshSignal }: Props) {
  const toast = useToast();
  const [characters, setCharacters] = useState<Character[]>([]);
  const [builtinVoices, setBuiltinVoices] = useState<BuiltinVoice[]>([]);
  const [customVoices, setCustomVoices] = useState<CustomVoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Detection flow (legacy single-shot detection removed; range analysis now
  // lives in BibleAnalysisControls above).

  // Auto-assign flow
  const [autoAssigning, setAutoAssigning] = useState(false);
  const [autoMsg, setAutoMsg] = useState<string | null>(null);

  // Per-character audio preview
  const [previewing, setPreviewing] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Relationship graph data (from the bible view)
  const [graphNodes, setGraphNodes] = useState<GraphNode[]>([]);
  const [graphEdges, setGraphEdges] = useState<GraphEdge[]>([]);
  const [selectedGraphId, setSelectedGraphId] = useState<string | null>(null);

  // Pending bible diffs awaiting review (from the bible view)
  const [pendingDiffs, setPendingDiffs] = useState<PendingDiffView[]>([]);

  // Current profile values (by characterId) so the diff review UI can show
  // "hiện tại" vs "đề xuất" side by side.
  const [profilesById, setProfilesById] = useState<Record<string, {
    description?: string | null; personality?: string | null; speechStyle?: string | null; visualDescription?: string | null;
  }>>({});

  // Character edit dialog
  const [editing, setEditing] = useState<Character | null>(null);
  const [editName, setEditName] = useState('');
  const [editAliases, setEditAliases] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editRole, setEditRole] = useState<string>('supporting');
  const [editGender, setEditGender] = useState<string>('unknown');
  const [editAge, setEditAge] = useState<string>('unknown');
  const [editSaving, setEditSaving] = useState(false);

  // Per-character customization (speed + emotion), keyed by CHARACTER id so two
  // characters that share a voice keep independent settings.
  const [charSettings, setCharSettings] = useState<Record<string, { speed: number; emotion: string }>>({});
  const [savingVoice, setSavingVoice] = useState<string | null>(null);

  const loadVoiceSettings = useCallback(async () => {
    try {
      const r = await fetch(`/api/library/${bookId}/characters`);
      if (!r.ok) return;
      const data = await r.json() as { characters: Array<{ id: string; defaultSpeed?: number | null; defaultEmotion?: string | null }> };
      const map: Record<string, { speed: number; emotion: string }> = {};
      for (const c of data.characters) {
        map[c.id] = { speed: c.defaultSpeed ?? 1.0, emotion: c.defaultEmotion ?? 'neutral' };
      }
      setCharSettings(map);
    } catch { /* non-fatal */ }
  }, [bookId]);

  const updateVoiceSetting = useCallback(async (characterId: string, patch: { speed?: number; emotion?: string }) => {
    setCharSettings((prev) => ({
      ...prev,
      [characterId]: { speed: prev[characterId]?.speed ?? 1.0, emotion: prev[characterId]?.emotion ?? 'neutral', ...patch },
    }));
    setSavingVoice(characterId);
    try {
      const body: Record<string, unknown> = {};
      if (patch.speed !== undefined) body.defaultSpeed = patch.speed;
      if (patch.emotion !== undefined) body.defaultEmotion = patch.emotion;
      const r = await fetch(`/api/library/${bookId}/characters/${characterId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Lưu cài đặt giọng thất bại');
    } finally {
      setSavingVoice(null);
    }
  }, [bookId, toast]);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [c, bv, cv, bible] = await Promise.all([
        fetch(`/api/library/${bookId}/characters`).then((r) => r.json()),
        fetch('/api/tts/voices').then((r) => r.json()),
        fetch(`/api/library/${bookId}/voices`).then((r) => r.json()),
        fetch(`/api/library/${bookId}/characters/bible`).then((r) => r.json()).catch(() => null),
      ]);
      // Load per-voice speed/emotion settings for the customization controls.
      await loadVoiceSettings();
      const baseChars = (c.characters ?? []) as Array<{
        id: string; name: string; aliases?: Array<{ alias: string }>; voiceId: string | null;
        role?: 'main' | 'supporting' | 'minor' | 'crowd'; gender?: 'male' | 'female' | 'unknown' | null;
        age?: 'young' | 'mature' | 'old' | null; tone?: string | null;
      }>;
      // Merge bible profile data (description, aliases, tone) into the cards.
      const profiles = (bible?.profiles ?? {}) as Record<string, { description?: string | null }>;
      const merged: Character[] = baseChars.map((ch) => ({
        id: ch.id,
        name: ch.name,
        aliases: (ch.aliases ?? []).map((a) => (typeof a === 'string' ? a : a.alias)),
        voiceId: ch.voiceId,
        role: ch.role,
        gender: ch.gender,
        age: ch.age,
        tone: ch.tone,
        description: profiles[ch.id]?.description ?? null,
      }));
      setCharacters(merged);
      setBuiltinVoices(
        (bv.voices ?? []).map((v: { id: string; label: string; gender?: 'male' | 'female'; tone?: string }) => ({
          id: v.id, name: v.label ?? v.id, gender: v.gender ?? 'male', tone: v.tone,
        })),
      );
      setCustomVoices(cv.voices ?? []);
      if (bible) {
        const chars = (bible.characters ?? []) as Array<{ id: string; name: string; role?: GraphNode['role']; gender?: GraphNode['gender'] }>;
        setGraphNodes(chars.map((ch) => ({ id: ch.id, name: ch.name, role: ch.role, gender: ch.gender })));
        const rels = (bible.relationships ?? []) as Array<{ id: string; fromCharId: string; toCharId: string; relationship: string }>;
        setGraphEdges(rels.map((r) => ({
          id: r.id,
          from: r.fromCharId,
          to: r.toCharId,
          relationship: r.relationship,
        })));
        setPendingDiffs((bible.pendingDiffs ?? []) as PendingDiffView[]);
        setProfilesById((bible.profiles ?? {}) as Record<string, {
          description?: string | null; personality?: string | null; speechStyle?: string | null; visualDescription?: string | null;
        }>);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Lỗi tải dữ liệu');
    } finally {
      setLoading(false);
    }
  }, [bookId]);

  useEffect(() => { void fetchAll(); }, [fetchAll]);

  // Re-fetch whenever the parent bumps refreshSignal (e.g. after a range
  // analysis completes) so newly-detected characters + the graph appear.
  useEffect(() => {
    if (refreshSignal && refreshSignal > 0) void fetchAll();
  }, [refreshSignal]);

  const stopPreview = useCallback(() => {
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
    setPreviewing(null);
  }, []);

  // Resolve the voice name to send to /api/tts/preview for a character.
  const resolveVoiceName = useCallback((char: Character): string | null => {
    if (char.voiceId) {
      const cv = customVoices.find((v) => v.id === char.voiceId);
      if (cv) return cv.name;
      const bv = builtinVoices.find((v) => v.id === char.voiceId);
      if (bv) return bv.name;
    }
    return null;
  }, [customVoices, builtinVoices]);

  const previewCharacter = useCallback(async (char: Character) => {
    const name = resolveVoiceName(char);
    if (!name) { toast('error', 'Nhân vật chưa được gán giọng'); return; }
    const sample = char.sampleLines?.[0] || `Xin chào, mình là ${char.name}.`;
    // Honour the per-character speed + emotion the user set in the card.
    const settings = charSettings[char.id];
    const speed = settings?.speed ?? 1.0;
    const emotion = settings?.emotion ?? 'neutral';
    setPreviewing(char.id);
    try {
      const r = await fetch('/api/tts/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voice: name, text: sample, language: 'vi', speed, emotion }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
      const blob = await r.blob();
      if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => { URL.revokeObjectURL(url); setPreviewing(null); audioRef.current = null; };
      audio.onerror = () => { URL.revokeObjectURL(url); setPreviewing(null); audioRef.current = null; };
      await audio.play();
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Lỗi nghe thử');
      setPreviewing(null);
    }
  }, [resolveVoiceName, toast, charSettings]);

  const setCharVoice = useCallback(async (charId: string, voiceId: string | null) => {
    const char = characters.find((c) => c.id === charId);
    const name = char?.name ?? '';
    let payload: { name: string; voiceId?: string | null; voiceName?: string };
    if (!voiceId) payload = { name, voiceId: null };
    else if (builtinVoices.some((v) => v.id === voiceId)) payload = { name, voiceName: voiceId };
    else payload = { name, voiceId };
    await fetch(`/api/library/${bookId}/characters`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ characters: [payload] }),
    });
    await fetchAll();
  }, [bookId, bookLanguage, characters, builtinVoices, fetchAll]);

  // ── Character edit (name / aliases / role / gender / age / description) ──
  const openEdit = useCallback((char: Character) => {
    setEditing(char);
    setEditName(char.name);
    setEditAliases(char.aliases.join(', '));
    setEditDescription(char.description ?? '');
    setEditRole(char.role ?? 'supporting');
    setEditGender(char.gender ?? 'unknown');
    setEditAge(char.age ?? 'unknown');
  }, []);

  const saveEdit = useCallback(async () => {
    if (!editing) return;
    setEditSaving(true);
    try {
      const aliases = editAliases.split(',').map((s) => s.trim()).filter(Boolean);
      // Update core fields via the characters upsert (name is the key, so it
      // stays fixed; aliases/role/gender/age are mutable).
      await fetch(`/api/library/${bookId}/characters`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          characters: [{
            name: editing.name,
            aliases,
            role: editRole,
            gender: editGender,
            age: editAge,
          }],
        }),
      });
      // Update the description via the profile PATCH (source='user').
      await fetch(`/api/library/${bookId}/characters/${editing.id}/profile`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: editDescription || null }),
      });
      setEditing(null);
      await fetchAll();
      toast('success', `Đã cập nhật ${editing.name}`);
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Lỗi lưu');
    } finally {
      setEditSaving(false);
    }
  }, [editing, bookId, editAliases, editRole, editGender, editAge, editDescription, fetchAll, toast]);

  // ── Pending diff review ──────────────────────────────────────────────────
  const applyDiff = useCallback(async (diffId: string) => {
    try {
      const r = await fetch(`/api/library/${bookId}/characters/bible/diffs/${diffId}/apply`, { method: 'POST' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setPendingDiffs((prev) => prev.filter((d) => d.id !== diffId));
      await fetchAll();
      toast('success', 'Đã áp dụng thay đổi');
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Lỗi áp dụng');
    }
  }, [bookId, fetchAll, toast]);

  const rejectDiff = useCallback(async (diffId: string) => {
    try {
      const r = await fetch(`/api/library/${bookId}/characters/bible/diffs/${diffId}/reject`, { method: 'POST' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setPendingDiffs((prev) => prev.filter((d) => d.id !== diffId));
      toast('info', 'Đã bỏ qua thay đổi');
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Lỗi từ chối');
    }
  }, [bookId, toast]);

  // Map characterId → display name so pending diffs show a real name, not a UUID.
  const charNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of characters) m.set(c.id, c.name);
    return m;
  }, [characters]);

  // Bulk-apply every non-conflicting pending diff at once.
  const [applyingAll, setApplyingAll] = useState(false);
  const applyAllDiffs = useCallback(async () => {
    setApplyingAll(true);
    try {
      const r = await fetch(`/api/library/${bookId}/characters/bible/diffs/apply-all`, { method: 'POST' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json() as { appliedIds?: string[]; skipped?: number };
      setPendingDiffs((prev) => prev.filter((d) => !(data.appliedIds ?? []).includes(d.id)));
      await fetchAll();
      toast('success', `Đã áp dụng ${data.appliedIds?.length ?? 0} đề xuất${data.skipped ? ` · ${data.skipped} bỏ qua (xung đột)` : ''}`);
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Lỗi áp dụng tất cả');
    } finally {
      setApplyingAll(false);
    }
  }, [bookId, fetchAll, toast]);

  // ── AI suggestion for pending diffs ────────────────────────────────────────
  // Each diff can hold an AI recommendation: { decision, reason, merged? }.
  // The user reviews it and applies (accept / merge) or ignores it.
  const [suggestions, setSuggestions] = useState<Record<string, { decision: 'accept' | 'reject' | 'merge'; reason: string; merged?: Partial<{ description: string; personality: string; speechStyle: string; visualDescription: string }> }>>({});
  const [suggestingIds, setSuggestingIds] = useState<Set<string>>(new Set());
  const [suggestingAll, setSuggestingAll] = useState(false);

  const suggestDiffs = useCallback(async (ids: string[]) => {
    if (ids.length === 0) return;
    setSuggestingIds((prev) => new Set([...prev, ...ids]));
    try {
      const r = await fetch(`/api/library/${bookId}/characters/bible/diffs/suggest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ diffIds: ids }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json() as { ok: boolean; results?: Array<{ diffId: string; decision: 'accept' | 'reject' | 'merge'; reason: string; merged?: Partial<{ description: string; personality: string; speechStyle: string; visualDescription: string }> }> };
      setSuggestions((prev) => {
        const next = { ...prev };
        for (const res of data.results ?? []) next[res.diffId] = { decision: res.decision, reason: res.reason, merged: res.merged };
        return next;
      });
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Lỗi gợi ý AI');
    } finally {
      setSuggestingIds((prev) => {
        const next = new Set(prev);
        ids.forEach((id) => next.delete(id));
        return next;
      });
    }
  }, [bookId, toast]);

  const suggestAllDiffs = useCallback(async () => {
    if (pendingDiffs.length === 0) return;
    setSuggestingAll(true);
    try {
      await suggestDiffs(pendingDiffs.map((d) => d.id));
    } finally {
      setSuggestingAll(false);
    }
  }, [pendingDiffs, suggestDiffs]);

  // Apply a single diff, optionally with an AI-merged value set.
  const applyDiffWith = useCallback(async (diffId: string, merged?: Partial<{ description: string; personality: string; speechStyle: string; visualDescription: string }>) => {
    try {
      const r = await fetch(`/api/library/${bookId}/characters/bible/diffs/${diffId}/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: merged ? JSON.stringify({ merged }) : undefined,
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setPendingDiffs((prev) => prev.filter((d) => d.id !== diffId));
      setSuggestions((prev) => { const n = { ...prev }; delete n[diffId]; return n; });
      await fetchAll();
      toast('success', 'Đã áp dụng thay đổi');
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Lỗi áp dụng');
    }
  }, [bookId, fetchAll, toast]);

  // ── AI detection ──────────────────────────────────────────────────────────
  // (Legacy single-shot detection + review UI removed; range analysis now
  //  lives in BibleAnalysisControls above.)

  // ── One-click auto-assign (detect + apply for unassigned) ──────────────────
  const autoAssignVoices = useCallback(async () => {
    setAutoAssigning(true);
    setAutoMsg(null);
    setError(null);
    try {
      const r = await fetch(`/api/library/${bookId}/characters/detect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxCharacters: 8, language: bookLanguage }),
      });
      if (!r.ok) throw new Error(`Phân tích thất bại: HTTP ${r.status}`);
      const data = await r.json() as { characters?: DetectedCharacter[] };
      const detected = data.characters ?? [];
      if (detected.length === 0) {
        setAutoMsg('⚠ AI không phát hiện nhân vật nào. Hãy dùng khung "Phân tích nhân vật" ở trên để quét theo chương.');
        return;
      }
      const normalize = (s: string) => s.toLowerCase().replace(/[.,!?;:'"`~()\[\]{}]/g, '').replace(/\s+/g, ' ').trim();
      const existingByName = new Map(characters.map((c) => [normalize(c.name), c]));
      const toAssign = detected
        .filter((d) => {
          const ex = existingByName.get(normalize(d.name));
          return !ex || !ex.voiceId;
        })
        .filter((d) => d.suggested_voice)
        .map((d) => ({
          name: d.name,
          aliases: d.aliases ?? [],
          voiceName: d.suggested_voice,
          role: d.role,
          age: d.age,
          tone: d.tone,
        }));
      if (toAssign.length === 0) {
        setAutoMsg('✓ Tất cả nhân vật AI phát hiện đều đã có giọng — không cần gán thêm.');
        return;
      }
      const r2 = await fetch(`/api/library/${bookId}/characters`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ characters: toAssign }),
      });
      if (!r2.ok) throw new Error(`HTTP ${r2.status}`);
      await fetchAll();
      setAutoMsg(`✓ Đã gán ${toAssign.length} giọng: ${toAssign.map((p) => p.name).join(', ')}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Lỗi không xác định');
    } finally {
      setAutoAssigning(false);
    }
  }, [bookId, bookLanguage, characters, fetchAll]);

  const assignedCount = useMemo(
    () => characters.filter((c) => c.voiceId).length,
    [characters],
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 p-12 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Đang tải nhân vật…
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <Card className="overflow-hidden border-border">
        <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Users className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-base font-semibold">Nhân vật &amp; Giọng đọc</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {characters.length} nhân vật · {assignedCount} đã gán giọng
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={autoAssignVoices}
              disabled={autoAssigning}
              title="Dùng AI gán giọng cho các nhân vật chưa có"
            >
              {autoAssigning ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Sparkles className="h-3.5 w-3.5 mr-1" />}
              Gán giọng tự động
            </Button>
          </div>
        </div>

        {error && (
          <div className="flex items-start gap-2 border-t border-border bg-destructive/10 px-5 py-3 text-xs text-destructive">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}
        {autoMsg && !error && (
          <div className="border-t border-border bg-emerald-50 px-5 py-3 text-xs text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
            {autoMsg}
          </div>
        )}
      </Card>

      {/* ── Character grid ───────────────────────────────────────────────── */}
      {characters.length === 0 ? (
        <Card className="border-dashed">
          <div className="flex flex-col items-center gap-3 p-10 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <User className="h-6 w-6" />
            </div>
            <div>
              <p className="text-sm font-medium">Chưa có nhân vật nào</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Dùng khung <span className="font-medium">“Phân tích nhân vật”</span> ở trên để quét sách theo chương và gợi ý giọng đọc.
              </p>
            </div>
          </div>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {characters.map((c) => (
            <CharacterCard
              key={c.id}
              char={c}
              builtinVoices={builtinVoices}
              customVoices={customVoices}
              previewing={previewing === c.id}
              onPreview={() => previewCharacter(c)}
              onStopPreview={stopPreview}
              onVoiceChange={(v) => setCharVoice(c.id, v)}
              onEdit={() => openEdit(c)}
              voiceSettings={charSettings}
              savingVoice={savingVoice}
              onVoiceSettingChange={updateVoiceSetting}
            />
          ))}
        </div>
      )}

      {/* ── Pending AI suggestions awaiting review ──────────────────────── */}
      {pendingDiffs.length > 0 && (
        <Card className="border-amber-500/30 bg-amber-500/5">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-500/20 px-4 py-3">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <AlertCircle className="h-4 w-4 text-amber-500" />
              Đề xuất chờ duyệt ({pendingDiffs.length})
            </div>
            <div className="flex items-center gap-1.5">
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2 text-[11px]"
                onClick={suggestAllDiffs}
                disabled={suggestingAll}
                title="Dùng AI đánh giá từng đề xuất"
              >
                {suggestingAll && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                Gợi ý AI (tất cả)
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2 text-[11px]"
                onClick={applyAllDiffs}
                disabled={applyingAll}
              >
                {applyingAll && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                Áp dụng tất cả
              </Button>
            </div>
          </div>
          <div className="flex flex-col gap-2 p-3">
            {pendingDiffs.map((d) => {
              const charName = d.patch.characterId ? (charNameById.get(d.patch.characterId) ?? d.patch.characterId) : null;
              const title =
                d.patch.kind === 'new'
                  ? `Nhân vật mới: ${d.patch.newCharacter?.name ?? '—'}`
                  : d.patch.kind === 'relationship'
                    ? `Quan hệ: ${d.patch.relationship?.fromName} → ${d.patch.relationship?.toName}`
                    : `Cập nhật: ${charName ?? '—'}`;
              const isConflict = d.patch.autoReason === 'conflict-with-user-edit';
              const sug = suggestions[d.id];
              const suggesting = suggestingIds.has(d.id);
              // For update diffs, show current vs proposed side by side.
              const fieldLabels: Record<string, string> = {
                description: 'Mô tả', personality: 'Tính cách', speechStyle: 'Cách nói', visualDescription: 'Ngoại hình',
              };
              const updateFields = d.patch.updateFields ?? {};
              const currentProfile = d.patch.characterId ? profilesById[d.patch.characterId] : undefined;
              const fieldRows = (['description', 'personality', 'speechStyle', 'visualDescription'] as const)
                .filter((f) => updateFields[f] != null)
                .map((f) => ({
                  field: f,
                  label: fieldLabels[f],
                  current: currentProfile?.[f] ?? null,
                  proposed: updateFields[f] as string,
                  merged: sug?.merged?.[f] as string | undefined,
                }));
              return (
                <div
                  key={d.id}
                  className={cn(
                    'flex flex-col gap-2 rounded-lg border bg-background/60 p-3',
                    isConflict ? 'border-destructive/30' : 'border-amber-500/20',
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">{title}</span>
                    <div className="flex items-center gap-1.5">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-[11px]"
                        onClick={() => suggestDiffs([d.id])}
                        disabled={suggesting}
                        title="AI đánh giá đề xuất này"
                      >
                        {suggesting && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                        Gợi ý AI
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-[11px] text-muted-foreground"
                        onClick={() => rejectDiff(d.id)}
                      >
                        Bỏ qua
                      </Button>
                    </div>
                  </div>

                  {/* Current vs proposed comparison for update diffs */}
                  {d.patch.kind === 'update' && fieldRows.length > 0 && (
                    <div className="flex flex-col gap-2 rounded-md bg-muted/30 p-2">
                      {fieldRows.map((row) => (
                        <div key={row.field} className="text-[11px]">
                          <div className="mb-1 font-medium text-muted-foreground">{row.label}</div>
                          <div className="grid grid-cols-2 gap-2">
                            <div className="rounded bg-background/70 p-1.5">
                              <div className="mb-0.5 text-[10px] uppercase tracking-wide text-muted-foreground/70">Hiện tại</div>
                              <div className="whitespace-pre-wrap text-foreground/80">{row.current ?? '—'}</div>
                            </div>
                            <div className="rounded bg-background/70 p-1.5">
                              <div className="mb-0.5 text-[10px] uppercase tracking-wide text-muted-foreground/70">Đề xuất</div>
                              <div className="whitespace-pre-wrap text-foreground/80">{row.proposed}</div>
                            </div>
                          </div>
                          {sug?.decision === 'merge' && row.merged && row.merged !== row.proposed && (
                            <div className="mt-1 rounded bg-primary/10 p-1.5">
                              <div className="mb-0.5 text-[10px] uppercase tracking-wide text-primary/70">AI gộp</div>
                              <div className="whitespace-pre-wrap text-foreground">{row.merged}</div>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Evidence quote */}
                  {d.patch.evidenceQuote && (
                    <p className="text-[11px] italic text-muted-foreground">“{d.patch.evidenceQuote}”</p>
                  )}

                  {/* AI suggestion result */}
                  {sug && (
                    <div className={cn(
                      'rounded-md border p-2 text-[11px]',
                      sug.decision === 'accept' ? 'border-emerald-500/30 bg-emerald-500/5'
                        : sug.decision === 'reject' ? 'border-destructive/30 bg-destructive/5'
                          : 'border-sky-500/30 bg-sky-500/5',
                    )}>
                      <span className="font-semibold">
                        {sug.decision === 'accept' ? 'AI: Nên chấp nhận' : sug.decision === 'reject' ? 'AI: Nên bỏ qua' : 'AI: Nên gộp'}
                      </span>
                      {' — '}{sug.reason}
                    </div>
                  )}

                  {/* Action buttons */}
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-[11px]"
                      onClick={() => applyDiffWith(d.id, sug?.decision === 'merge' ? sug.merged : undefined)}
                      disabled={isConflict}
                      title={isConflict ? 'Xung đột với chỉnh sửa của bạn — cần duyệt thủ công' : undefined}
                    >
                      {sug?.decision === 'merge' ? 'Áp dụng (gộp)' : 'Áp dụng'}
                    </Button>
                    {sug?.decision === 'merge' && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-2 text-[11px]"
                        onClick={() => applyDiffWith(d.id)}
                      >
                        Chỉ đề xuất
                      </Button>
                    )}
                    {isConflict && (
                      <span className="text-[11px] italic text-destructive/80">
                        Xung đột với chỉnh sửa của bạn — bỏ qua hoặc sửa thủ công.
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* ── Relationship graph (bottom of page) ─────────────────────────── */}
      {graphNodes.length > 0 && (
        <Card className="border-border">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Network className="h-4 w-4 text-primary" />
              Sơ đồ quan hệ nhân vật
            </div>
            {selectedGraphId && (
              <Button variant="ghost" size="sm" onClick={() => setSelectedGraphId(null)}>
                Bỏ chọn
              </Button>
            )}
          </div>
          <div className="p-3">
            <RelationshipGraph
              nodes={graphNodes}
              edges={graphEdges}
              selectedId={selectedGraphId}
              onSelect={setSelectedGraphId}
            />
            {selectedGraphId && (
              <p className="mt-2 text-xs text-muted-foreground">
                Đang xem: <span className="font-medium text-foreground">
                  {graphNodes.find((n) => n.id === selectedGraphId)?.name}
                </span>
                {' '}— {graphEdges.filter((e) => e.from === selectedGraphId || e.to === selectedGraphId).length} mối quan hệ.
              </p>
            )}
          </div>
        </Card>
      )}

      {/* ── Edit character dialog ───────────────────────────────────────── */}
      <Dialog
        open={!!editing}
        onOpenChange={(o) => { if (!o) setEditing(null); }}
        title="Chỉnh sửa nhân vật"
        description={editing ? `Cập nhật thông tin và ghi chú cho ${editing.name}.` : undefined}
        widthClass="max-w-md"
      >
        {editing && (
          <DialogBody className="flex flex-col gap-4">
            <div className="flex items-center gap-3 rounded-lg bg-muted/40 p-3">
              <div
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-base font-semibold"
                style={{ background: avatarTint(editing.name).bg, color: avatarTint(editing.name).ring }}
              >
                {editing.name.slice(0, 1).toUpperCase()}
              </div>
              <div className="min-w-0">
                <div className="text-sm font-semibold">{editing.name}</div>
                <div className="text-[11px] text-muted-foreground">Tên không thể đổi (dùng làm khóa)</div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">Vai trò</label>
                <select
                  value={editRole}
                  onChange={(e) => setEditRole(e.target.value)}
                  className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                >
                  <option value="main">Chính</option>
                  <option value="supporting">Phụ</option>
                  <option value="minor">Nhỏ</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">Giới tính</label>
                <select
                  value={editGender}
                  onChange={(e) => setEditGender(e.target.value)}
                  className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                >
                  <option value="unknown">Không rõ</option>
                  <option value="male">Nam</option>
                  <option value="female">Nữ</option>
                </select>
              </div>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Độ tuổi</label>
              <select
                value={editAge}
                onChange={(e) => setEditAge(e.target.value)}
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                <option value="unknown">Không rõ</option>
                <option value="young">Trẻ</option>
                <option value="adult">Trưởng thành</option>
                <option value="old">Già</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Bí danh (phân cách bằng dấu phẩy)
              </label>
              <Input
                value={editAliases}
                onChange={(e) => setEditAliases(e.target.value)}
                placeholder="Tên gọi khác…"
                className="text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Mô tả / ghi chú</label>
              <textarea
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                placeholder="Đặc điểm, tính cách, ngữ cảnh…"
                rows={3}
                className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              />
            </div>
          </DialogBody>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => setEditing(null)} disabled={editSaving}>
            Hủy
          </Button>
          <Button onClick={saveEdit} disabled={editSaving}>
            {editSaving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            Lưu
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}

// ── Assigned character card (grid) ───────────────────────────────────────────
interface CharacterCardProps {
  char: Character;
  builtinVoices: BuiltinVoice[];
  customVoices: CustomVoice[];
  previewing: boolean;
  onPreview: () => void;
  onStopPreview: () => void;
  onVoiceChange: (voiceId: string | null) => void;
  onEdit: () => void;
  voiceSettings: Record<string, { speed: number; emotion: string }>;
  savingVoice: string | null;
  onVoiceSettingChange: (characterId: string, patch: { speed?: number; emotion?: string }) => void;
}

function CharacterCard({
  char,
  builtinVoices,
  customVoices,
  previewing,
  onPreview,
  onStopPreview,
  onVoiceChange,
  onEdit,
  voiceSettings,
  savingVoice,
  onVoiceSettingChange,
}: CharacterCardProps) {
  const tint = avatarTint(char.name);
  const roleMeta = ROLE_META[char.role ?? 'supporting'] ?? ROLE_META.supporting;
  const hasVoice = !!char.voiceId;
  // Per-character settings, keyed by character id (not voiceId) so two
  // characters sharing a voice stay independent.
  const vs = voiceSettings[char.id] ?? { speed: 1.0, emotion: 'neutral' };
  const isSaving = savingVoice === char.id;
  const roleAccent: Record<string, string> = {
    main: 'border-l-4 border-l-amber-400',
    supporting: 'border-l-4 border-l-sky-400',
    minor: 'border-l-4 border-l-slate-300',
    crowd: 'border-l-4 border-l-slate-200',
  };
  // Every section below has a FIXED height (shrink-0) so that:
  //   1. the card height is identical for every character, and
  //   2. the voice picker + customization rows line up perfectly across the grid,
  //      regardless of how much data (name length, description, voice) each card has.
  return (
    <Card className={cn('flex flex-col gap-3 p-4', roleAccent[char.role ?? 'supporting'])}>
      {/* HEADER — fixed height (h-[76px]) so the name/role/attributes rows never
          wrap and never shift the sections below. */}
      <div className="flex h-[76px] shrink-0 items-start gap-3">
        <div
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl text-lg font-bold shadow-sm"
          style={{ background: tint.bg, color: tint.ring }}
        >
          {char.name.slice(0, 1).toUpperCase()}
        </div>
        <div className="flex min-w-0 flex-1 flex-col justify-center">
          <div className="flex items-center">
            <Tooltip side="top" content={char.name}>
              <span className="block max-w-full truncate text-[15px] font-semibold leading-tight">{char.name}</span>
            </Tooltip>
          </div>
          {/* Role badge on its own line under the name so a long name never
              pushes/clips the role label. */}
          <div className="mt-0.5 flex h-4 shrink-0 items-center">
            <Badge variant={roleMeta.variant} className="shrink-0 text-[10px]">{roleMeta.label}</Badge>
          </div>

          {/* Attribute rows — gender/age on one line, tone on its own line so a
              long tone label is never clipped. Missing values render as a faint
              dash so the silhouette stays identical across cards. */}
          <div className="mt-1 flex h-5 shrink-0 items-center gap-1 overflow-hidden whitespace-nowrap">
            <Badge variant="muted" className="shrink-0 text-[10px]">
              {char.gender === 'female' ? 'Nữ' : char.gender === 'male' ? 'Nam' : '—'}
            </Badge>
            <Badge variant="muted" className="shrink-0 text-[10px]">
              {char.age === 'young' ? 'Trẻ' : char.age === 'old' ? 'Già' : char.age === 'mature' ? 'Trưởng thành' : '—'}
            </Badge>
          </div>
          <div className="mt-1 flex h-5 shrink-0 items-center gap-1 overflow-hidden whitespace-nowrap">
            <span
              className="inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-medium"
              style={char.tone && char.tone !== 'unknown'
                ? { background: tint.bg, color: tint.ring }
                : { background: 'transparent', color: 'rgb(148 163 184)' }}
            >
              Giọng: {char.tone && char.tone !== 'unknown' ? char.tone : '—'}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 flex-col gap-1.5">
          <button
            type="button"
            onClick={onEdit}
            className="flex h-8 w-8 items-center justify-center rounded-full border border-input bg-background transition-colors hover:bg-primary hover:text-primary-foreground"
            aria-label="Chỉnh sửa nhân vật"
            title="Chỉnh sửa"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={previewing ? onStopPreview : onPreview}
            disabled={!hasVoice}
            className={cn(
              'flex h-8 w-8 items-center justify-center rounded-full border transition-colors',
              hasVoice
                ? 'border-input bg-background hover:bg-primary hover:text-primary-foreground'
                : 'cursor-not-allowed border-dashed opacity-40',
            )}
            aria-label={previewing ? 'Dừng nghe thử' : 'Nghe thử giọng'}
            title={hasVoice ? (previewing ? 'Dừng' : 'Nghe thử') : 'Chưa gán giọng'}
          >
            {previewing ? <Square className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>

      {/* ALIASES + DESCRIPTION — fixed height (h-[92px]) so the body block is
          identical on every card. Text is clamped; empty → dash. Hovering the
          block reveals the full, unclamped text in a tooltip. */}
      <Tooltip
        side="top"
        maxHeight={14}
        className="w-full"
        content={
          <div className="space-y-1">
            <p className="text-[11px]">
              <span className="opacity-60">Bí danh:</span> {char.aliases.length > 0 ? char.aliases.join(', ') : '—'}
            </p>
            <p className="text-[11px] leading-relaxed">{char.description || '—'}</p>
          </div>
        }
      >
        <div className="flex h-[92px] w-full shrink-0 cursor-default flex-col">
          <p className="line-clamp-1 text-[11px] text-muted-foreground">
            <span className="opacity-60">Bí danh:</span> {char.aliases.length > 0 ? char.aliases.join(', ') : '—'}
          </p>
          <p className="mt-1 line-clamp-4 text-[11px] leading-relaxed text-muted-foreground/80">
            {char.description || '—'}
          </p>
        </div>
      </Tooltip>

      {/* VOICE PICKER — fixed height (h-9) on every card. */}
      <Select
        value={char.voiceId ?? ''}
        onValueChange={(v) => onVoiceChange(v === '__none__' ? null : v)}
      >
        <SelectTrigger className="h-9 shrink-0 text-xs">
          <SelectValue placeholder="Chọn giọng đọc…" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__none__" className="text-xs text-muted-foreground">— Chưa gán —</SelectItem>
          {customVoices.map((v: CustomVoice) => (
            <SelectItem key={v.id} value={v.id} className="text-xs">{v.name}</SelectItem>
          ))}
          {builtinVoices.map((v: BuiltinVoice) => (
            <SelectItem key={v.id} value={v.id} className="text-xs">
              {v.name} · {v.gender === 'female' ? 'Nữ' : 'Nam'}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* PER-VOICE CUSTOMIZATION — fixed height (h-[64px]) on every card.
          Renders a muted placeholder when no voice is assigned so the row
          height never changes. Speed + emotion sit side-by-side in a 2-col
          grid so the emotion Select never spills outside the block. */}
      <div className="flex h-[64px] shrink-0 items-center rounded-md bg-muted/40 p-2">
        {hasVoice && vs ? (
          <div className="w-full">
            <div className="mb-1 flex items-center gap-1 text-[10px] font-medium text-muted-foreground">
              <Volume2 className="h-2.5 w-2.5" /> Tùy chỉnh giọng
              {isSaving && <Loader2 className="h-2.5 w-2.5 animate-spin" />}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="flex min-w-0 flex-col gap-0.5">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-muted-foreground">Tốc độ</span>
                  <span className="text-[10px] tabular-nums text-muted-foreground">{vs.speed.toFixed(1)}×</span>
                </div>
                <input
                  type="range" min={0.5} max={2} step={0.1}
                  value={vs.speed}
                  onChange={(e) => onVoiceSettingChange(char.id, { speed: parseFloat(e.target.value) })}
                  className="h-1 w-full cursor-pointer accent-primary"
                />
              </div>
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-[10px] text-muted-foreground">Sắc thái</span>
                <Select
                  value={vs.emotion}
                  onValueChange={(v) => onVoiceSettingChange(char.id, { emotion: v })}
                >
                  <SelectTrigger className="h-7 w-full text-[11px]">
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
          </div>
        ) : (
          <p className="w-full text-center text-[10px] italic text-muted-foreground/50">
            Chưa gán giọng — gán để tùy chỉnh tốc độ và sắc thái.
          </p>
        )}
      </div>
    </Card>
  );
}


