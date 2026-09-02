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
  AlertTriangle,
  ArrowLeft,
  Check,
  History,
  Loader2,
  Mic,
  Play,
  RefreshCw,
  Save,
  Sparkles,
  Square,
  User,
  Volume2,
  Wand2,
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
  confidence?: number;
  uncertain?: boolean;
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
  /** Full EPUB path (e.g. "chapter001.xhtml") — used for per-chapter generation. */
  file: string;
}

/** A single rolling-history snapshot of the chapter's voice plan. */
interface HistoryEntry {
  id: string;
  label: string;
  createdAt: string;
  count: number;
}

const NARRATION_VALUE = '__narration__';
const HISTORY_CAP = 30;

/** Detect sentences that are actually chapter headings / titles, not prose.
 *  The splitter catches <h1>Chương 1</h1> and the book's title as standalone
 *  "sentences" — they have no terminator so they survive the split, but they
 *  aren't real reading text. Hidden in the voice plan view so the chapter
 *  reads like a novel. Detection is intentionally narrow to avoid hiding
 *  real prose. */
function isChapterHeading(text: string): boolean {
  const t = text.trim();
  if (t.length > 80) return false;
  return /^(ch[ưu][ơo]ng|ch[ưu][ơo]ng\s+\d+|quy[ểe]n|h[ồo]i|ph[ầa]n|m[ụu]c\s+l[ụu]c)\b/i.test(t)
      || /^\d+\s*$/.test(t)
      || /^ch[ưu][ơo]ng\s+\d+[\s\-–—:.]*$/i.test(t);
}

// Deterministic color from a voice id so each assigned voice gets a stable,
// distinct highlight. Returns a hex string (e.g. "#d99726") so callers can
// append an alpha suffix like "+ '22'" to get a valid 8-digit hex (#RRGGBB22).
function voiceColor(voiceId: string): string {
  let h = 0;
  for (let i = 0; i < voiceId.length; i++) {
    h = (h * 31 + voiceId.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(h) % 360;
  // HSL(hue, 70%, 50%) → RGB, then to hex.
  const s = 0.7;
  const l = 0.5;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hue < 60) [r, g, b] = [c, x, 0];
  else if (hue < 120) [r, g, b] = [x, c, 0];
  else if (hue < 180) [r, g, b] = [0, c, x];
  else if (hue < 240) [r, g, b] = [0, x, c];
  else if (hue < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const toHex = (v: number) =>
    Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

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

  // (f) AI proposal + history. The AI "đề xuất" only builds a proposal; it is
  // NOT persisted until the user reviews/edits and explicitly applies it. A
  // rolling history (max HISTORY_CAP snapshots) is snapshotted BEFORE every
  // apply / restore / manual save so any change is always reversible.
  const [proposal, setProposal] = useState<PlanSentence[] | null>(null);
  const [proposalBusy, setProposalBusy] = useState(false);
  // 2026-09-01: "Làm mới" lets the user force re-suggestion when the stored
  // plan looks broken (e.g. only 2 sentences for a chapter that should have
  // 100+). Calls /voice-plan?fresh=1 which deletes + regenerates.
  const [freshBusy, setFreshBusy] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const [activeSentence, setActiveSentence] = useState<number | null>(null);
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [playingSentence, setPlayingSentence] = useState<number | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // (c) multi-select + batch assign
  const [selectionMode, setSelectionMode] = useState(false);
  // (g) "review only" filter — show just the sentences the AI couldn't
  // confidently attribute so the user can resolve them quickly.
  const [reviewOnly, setReviewOnly] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [batchVoice, setBatchVoice] = useState<string | null>(null);

  // (d) per-chapter audiobook generation
  const [genStatus, setGenStatus] = useState<'idle' | 'generating' | 'ready' | 'failed'>('idle');
  const [genProgress, setGenProgress] = useState<number>(0);
  const [genBusy, setGenBusy] = useState(false);
  const genPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // (e) AI suggest (proposal mode — does not persist)
  const [suggesting, setSuggesting] = useState(false);

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
    // A pending AI proposal belongs to the previous chapter — drop it so it
    // can't be applied to the wrong chapter.
    setProposal(null);
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

  // (c) Batch-assign one voice to all selected sentences in a single update.
  const assignVoiceMany = useCallback(
    (indices: Iterable<number>, value: string) => {
      const voiceId = value === NARRATION_VALUE ? null : value;
      const idxSet = new Set(indices);
      setSentences((prev) => {
        const next = prev.map((s, idx) =>
          idxSet.has(idx) ? { ...s, voiceId, source: 'manual' as const } : s,
        );
        dirtyRef.current = true;
        persist(next);
        return next;
      });
      setSelected(new Set());
      setBatchVoice(null);
    },
    [persist],
  );

  // (a) Play the assigned voice reading the exact sentence text.
  const stopSentencePreview = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    setPlayingSentence(null);
  }, []);

  const playSentence = useCallback(
    async (s: PlanSentence) => {
      if (playingSentence === s.i) {
        stopSentencePreview();
        return;
      }
      stopSentencePreview();
      setPlayingSentence(s.i);
      try {
        const body: Record<string, unknown> = {
          text: s.text,
          bookId,
          language: 'vi',
          emotion: undefined,
          expressiveness: undefined,
          callIdx: s.i,
        };
        if (s.voiceId != null) body.voice = s.voiceId;
        const r = await fetch('/api/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!r.ok) throw new Error('tts failed');
        const blob = await r.blob();
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audioRef.current = audio;
        audio.onended = () => { setPlayingSentence(null); audioRef.current = null; };
        await audio.play();
      } catch {
        setPlayingSentence(null);
      }
    },
    [bookId, playingSentence, stopSentencePreview],
  );

  // (d) Per-chapter audiobook generation that consumes the voice plan.
  const currentChapterFile = useMemo(
    () => chapters.find((c) => c.id === chapterId)?.file ?? null,
    [chapters, chapterId],
  );

  const pollGeneration = useCallback(() => {
    if (!bookId || !currentChapterFile) return;
    (async () => {
      try {
        const r = await fetch(`/api/library/${bookId}/audiobook`);
        if (!r.ok) return;
        const data = await r.json() as {
          chapters?: Array<{ chapterFile: string; status: string; progress?: number }>;
        };
        const row = (data.chapters ?? []).find((c) => c.chapterFile === currentChapterFile);
        if (!row) {
          setGenStatus('idle');
          setGenProgress(0);
          return;
        }
        if (row.status === 'generating') {
          setGenStatus('generating');
          setGenProgress(row.progress ?? 0);
        } else if (row.status === 'ready') {
          setGenStatus('ready');
          setGenProgress(100);
          if (genPollRef.current) { clearInterval(genPollRef.current); genPollRef.current = null; }
        } else if (row.status === 'failed') {
          setGenStatus('failed');
          setGenProgress(0);
          if (genPollRef.current) { clearInterval(genPollRef.current); genPollRef.current = null; }
        } else {
          setGenStatus('idle');
          setGenProgress(0);
        }
      } catch {
        /* best-effort */
      }
    })();
  }, [bookId, currentChapterFile]);

  const generateChapter = useCallback(
    async (entire: boolean) => {
      if (!currentChapterFile) return;
      setGenBusy(true);
      try {
        await fetch(`/api/library/${bookId}/audiobook`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            entire
              ? { action: 'generate' }
              : { action: 'regenerate_one', chapterFile: currentChapterFile },
          ),
        });
        setGenStatus('generating');
        setGenProgress(0);
        if (genPollRef.current) clearInterval(genPollRef.current);
        genPollRef.current = setInterval(() => pollGeneration(), 3000);
        pollGeneration();
      } finally {
        setGenBusy(false);
      }
    },
    [bookId, currentChapterFile, pollGeneration],
  );

  // (e) AI suggest voices — build a PROPOSAL only. The proposal is NOT
  // persisted; the user reviews/edits it and explicitly applies it (which
  // snapshots history first). This avoids accidental overwrites.
  const suggestVoices = useCallback(async () => {
    if (!chapterId) return;
    setProposalBusy(true);
    setProposal(null);
    try {
      const r = await fetch(
        `/api/library/${bookId}/chapters/${encodeURIComponent(chapterId)}/voice-plan/suggest`,
        { method: 'POST' },
      );
      if (!r.ok) throw new Error('suggest failed');
      const data = await r.json() as { sentences?: PlanSentence[] };
      if (data.sentences) {
        // Preserve order/index; only take the suggested voiceId/charId/source.
        setProposal((prev) => {
          const base = prev ?? sentences;
          const next = base.map((s, idx) => {
            const sug = data.sentences![idx];
            return sug ? { ...s, voiceId: sug.voiceId, charId: sug.charId, source: sug.source } : s;
          });
          return next;
        });
      }
    } catch {
      /* best-effort */
    } finally {
      setProposalBusy(false);
    }
  }, [bookId, chapterId, sentences]);

  // Push the CURRENT plan to history (the safety net before any apply/restore/
  // manual save). Enforced cap of HISTORY_CAP on the server.
  const pushHistory = useCallback(
    async (label: string) => {
      if (!chapterId || sentences.length === 0) return;
      try {
        await fetch(
          `/api/library/${bookId}/chapters/${encodeURIComponent(chapterId)}/voice-plan/history`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sentences, label }),
          },
        );
      } catch {
        /* best-effort — history is a safety net, never block the main action */
      }
    },
    [bookId, chapterId, sentences],
  );

  // Load the history list (newest first).
  const refreshHistory = useCallback(async () => {
    if (!chapterId) return;
    setHistoryLoading(true);
    try {
      const r = await fetch(
        `/api/library/${bookId}/chapters/${encodeURIComponent(chapterId)}/voice-plan/history`,
      );
      if (!r.ok) return;
      const data = await r.json() as { history?: HistoryEntry[] };
      setHistory(data.history ?? []);
    } catch {
      /* best-effort */
    } finally {
      setHistoryLoading(false);
    }
  }, [bookId, chapterId]);

  // Open the history dialog and refresh its contents.
  const openHistory = useCallback(() => {
    setHistoryOpen(true);
    void refreshHistory();
  }, [refreshHistory]);

  // 2026-09-01: Force a fresh re-suggest from the chapter HTML. Used by the
  // "Làm mới" button when the stored plan looks wrong (only 1-2 sentences
  // for a full chapter). Hits ?fresh=1 which the API honours by skipping
  // the cache and writing the freshly-built plan back to the DB.
  const freshPlan = useCallback(async () => {
    if (!chapterId) return;
    setFreshBusy(true);
    try {
      // Snapshot the current plan first so the destructive action is reversible.
      await pushHistory('Trước khi làm mới');
      const r = await fetch(
        `/api/library/${bookId}/chapters/${encodeURIComponent(chapterId)}/voice-plan?fresh=1`,
        { cache: 'no-store' },
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json() as { sentences?: PlanSentence[] };
      setSentences(data.sentences ?? []);
      setSaveState('saved');
      setProposal(null);
      // Refresh history so the snapshot we just took shows up in the list.
      await refreshHistory();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Lỗi làm mới');
    } finally {
      setFreshBusy(false);
    }
  }, [bookId, chapterId, pushHistory, refreshHistory]);

  // Apply the AI proposal: snapshot current plan to history, then load the
  // proposal into the editable area (dirty) so the user can still tweak before
  // the explicit Save. We persist immediately here too so the proposal is
  // committed; the user can still edit afterwards (each edit re-persists).
  const applyProposal = useCallback(async () => {
    if (!proposal || !chapterId) return;
    await pushHistory('Trước AI đề xuất');
    setSentences(proposal);
    dirtyRef.current = true;
    persist(proposal);
    setProposal(null);
    await refreshHistory();
  }, [proposal, chapterId, pushHistory, persist, refreshHistory]);

  const discardProposal = useCallback(() => {
    setProposal(null);
  }, []);

  // Manual "save a version" — snapshot current plan to history without changing
  // anything. Lets the user checkpoint before risky manual edits.
  const saveVersion = useCallback(async () => {
    await pushHistory('Lưu thủ công');
    await refreshHistory();
  }, [pushHistory, refreshHistory]);

  // Restore a history snapshot: snapshot the CURRENT plan first (so restore is
  // itself reversible), then load the snapshot into the editable area + persist.
  const restoreHistory = useCallback(
    async (historyId: string) => {
      if (!chapterId) return;
      await pushHistory('Trước khôi phục');
      const r = await fetch(
        `/api/library/${bookId}/chapters/${encodeURIComponent(chapterId)}/voice-plan/history/${historyId}`,
      );
      if (!r.ok) return;
      const data = await r.json() as { sentences?: PlanSentence[] };
      if (data.sentences) {
        setSentences(data.sentences);
        dirtyRef.current = true;
        persist(data.sentences);
        setHistoryOpen(false);
      }
    },
    [bookId, chapterId, pushHistory, persist],
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
      // Skip chapter-heading "sentences" so the body reads like a novel.
      // They still exist in the underlying plan (so audio timing is
      // unchanged); they're just hidden from the editor view.
      if (isChapterHeading(s.text)) continue;
      // "Review only" mode: keep just the sentences the AI flagged uncertain.
      if (reviewOnly && !s.uncertain) continue;
      const last = groups[groups.length - 1];
      if (last && last.para === s.para) last.items.push(s);
      else groups.push({ para: s.para, items: [s] });
    }
    return groups;
  }, [sentences, reviewOnly]);

  const assignedCount = useMemo(
    () => sentences.filter((s) => s.voiceId != null && !isChapterHeading(s.text)).length,
    [sentences],
  );

  const uncertainCount = useMemo(
    () => sentences.filter((s) => s.uncertain && !isChapterHeading(s.text)).length,
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

  // (b) Legend: one swatch per distinct assigned voice currently in use.
  const usedVoices = useMemo(() => {
    const ids = Array.from(
      new Set(
        sentences
          .filter((s) => !isChapterHeading(s.text))
          .map((s) => s.voiceId)
          .filter((v): v is string => !!v),
      ),
    );
    return ids.map((id) => ({ id, label: voiceLabel(id), color: voiceColor(id) }));
  }, [sentences, voiceLabel]);

  // Clean up the generation poll interval on unmount.
  useEffect(() => {
    return () => {
      if (genPollRef.current) { clearInterval(genPollRef.current); genPollRef.current = null; }
    };
  }, []);

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
            setSelected(new Set());
            setGenStatus('idle');
            setGenProgress(0);
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

      <div className="flex flex-wrap items-center gap-2 border-b bg-muted/30 px-4 py-2 text-xs text-muted-foreground">
        <Mic className="h-3.5 w-3.5" />
        <span>
          Mặc định mọi câu đều là <b className="text-foreground">giọng người dẫn chuyện</b>.
          Chỉ cần nhấn vào một câu để gán giọng khác.
        </span>
        <span className="ml-auto">
          Đã gán: <b className="text-foreground">{assignedCount}</b> / {sentences.length} câu
        </span>
        <button
          type="button"
          onClick={() => { setSelectionMode((v) => !v); setSelected(new Set()); }}
          className={cn(
            'rounded-md border px-2 py-1 text-xs font-medium transition-colors',
            selectionMode
              ? 'border-primary bg-primary/10 text-primary'
              : 'border-border hover:bg-accent',
          )}
        >
          {selectionMode ? 'Thoát chọn' : 'Chọn nhiều câu'}
        </button>
        <button
          type="button"
          onClick={() => setReviewOnly((v) => !v)}
          className={cn(
            'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium transition-colors',
            reviewOnly
              ? 'border-amber-500 bg-amber-500/10 text-amber-600'
              : 'border-border hover:bg-accent',
          )}
          title="Chỉ hiện những câu AI phân giọng chưa chắc chắn (cần user duyệt)"
        >
          <AlertTriangle className="h-3.5 w-3.5" />
          Câu cần review{uncertainCount > 0 ? ` (${uncertainCount})` : ''}
        </button>
        <button
          type="button"
          onClick={() => void suggestVoices()}
          disabled={proposalBusy || !chapterId}
          className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium transition-colors hover:bg-accent disabled:opacity-50"
        >
          {proposalBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
          AI đề xuất giọng
        </button>
        <button
          type="button"
          onClick={() => {
            if (typeof window !== 'undefined' && !window.confirm('Làm mới sẽ xóa phân giọng đã lưu và tạo lại từ đầu. Phiên bản hiện tại sẽ được lưu vào Lịch sử. Tiếp tục?')) return;
            void freshPlan();
          }}
          disabled={freshBusy || !chapterId}
          className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium transition-colors hover:bg-accent disabled:opacity-50"
          title="Xóa phân giọng đã lưu và tạo lại từ HTML chương — dùng khi chương hiển thị quá ít câu"
        >
          {freshBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Làm mới
        </button>
        <button
          type="button"
          onClick={() => void saveVersion()}
          disabled={!chapterId || sentences.length === 0}
          className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium transition-colors hover:bg-accent disabled:opacity-50"
          title="Lưu phiên bản hiện tại vào lịch sử (tối đa 30, tự động đè lên cũ nhất)"
        >
          <Save className="h-3.5 w-3.5" />
          Lưu phiên bản
        </button>
        <button
          type="button"
          onClick={() => openHistory()}
          disabled={!chapterId}
          className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium transition-colors hover:bg-accent disabled:opacity-50"
          title="Xem và khôi phục các phiên bản trước"
        >
          <History className="h-3.5 w-3.5" />
          Lịch sử
          {history.length > 0 && (
            <span className="ml-0.5 rounded-full bg-muted px-1.5 text-[10px] tabular-nums text-muted-foreground">
              {history.length}
            </span>
          )}
        </button>
      </div>

      {/* (f) AI proposal banner — shown after "AI đề xuất giọng" returns. The
          proposal is NOT saved yet; the user reviews/edits then applies it. */}
      {proposal && (
        <div className="flex flex-wrap items-center gap-2 border-b bg-primary/5 px-4 py-2 text-xs">
          <Sparkles className="h-3.5 w-3.5 text-primary" />
          <span>
            AI đề xuất <b className="text-foreground">{proposal.filter((s) => s.voiceId != null).length}</b> câu
            {' '}có giọng. Xem lại, chỉnh sửa nếu cần, rồi nhấn <b className="text-foreground">Áp dụng</b> để lưu.
          </span>
          <span className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => void applyProposal()}
              className="inline-flex items-center gap-1 rounded-md border border-primary bg-primary px-2.5 py-1 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
            >
              <Check className="h-3.5 w-3.5" />
              Áp dụng
            </button>
            <button
              type="button"
              onClick={() => discardProposal()}
              className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium transition-colors hover:bg-accent"
            >
              <X className="h-3.5 w-3.5" />
              Hủy
            </button>
          </span>
        </div>
      )}

      {/* (b) Legend — one swatch per distinct assigned voice in use */}
      {usedVoices.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 border-b bg-background px-4 py-1.5 text-xs">
          {usedVoices.map((v) => (
            <span key={v.id} className="inline-flex items-center gap-1.5">
              <span
                className="inline-block h-3 w-3 rounded-sm ring-1 ring-inset"
                style={{ backgroundColor: v.color + '33', boxShadow: `inset 0 0 0 1px ${v.color}` }}
              />
              <span className="text-muted-foreground">{v.label}</span>
            </span>
          ))}
        </div>
      )}

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
          <article className="mx-auto max-w-3xl px-6 py-10 font-serif text-[18px] leading-8 text-foreground">
            {paragraphs.map((group) => (
              <p key={group.para} className="mb-8 indent-8 text-left">
                {group.items.map((s) => {
                  const char = s.charId ? characters[s.charId] : null;
                  const assigned = s.voiceId != null;
                  const isCharacter = s.source === 'character' && char;
                  const isSelected = selected.has(s.i);
                  const isPlaying = playingSentence === s.i;
                  const color = assigned ? voiceColor(s.voiceId as string) : null;

                  const handleClick = () => {
                    if (selectionMode) {
                      setSelected((prev) => {
                        const next = new Set(prev);
                        if (next.has(s.i)) next.delete(s.i); else next.add(s.i);
                        return next;
                      });
                      return;
                    }
                    setActiveSentence(s.i);
                  };

                  return (
                    <span
                      key={s.i}
                      className={cn(
                        'group/sent relative mr-3 inline text-left align-baseline',
                        selectionMode && 'cursor-pointer',
                      )}
                    >
                      {selectionMode && (
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={handleClick}
                          onClick={(e) => e.stopPropagation()}
                          className="mr-1 align-middle"
                          aria-label={`Chọn câu ${s.i + 1}`}
                        />
                      )}
                      {/* Per-sentence highlight. The text and play icon are
                          both true inline elements (role="button" spans) so
                          they can flow and break freely. box-decoration-break:
                          clone keeps the assigned-voice background + ring
                          rendering on EACH line the sentence wraps to.
                          Unassigned sentences render as plain text — no chip,
                          no padding — so the chapter reads like a novel.
                          The trailing mr-2 leaves a real word-space between
                          sentences. */}
                      <span
                        className={cn(
                          'inline cursor-pointer text-left transition-colors',
                          assigned &&
                            'rounded px-1.5 py-0.5 [box-decoration-break:clone] [-webkit-box-decoration-break:clone]',
                          !assigned && !selectionMode && 'hover:bg-primary/10',
                          isCharacter && !assigned && 'underline decoration-dotted decoration-muted-foreground/40',
                          s.uncertain && 'border-l-2 border-amber-500 pl-1.5 bg-amber-500/5',
                        )}
                        style={
                          assigned && color
                            ? { backgroundColor: color + '22', boxShadow: `inset 0 0 0 1px ${color}` }
                            : undefined
                        }
                      >
                        <span
                          role="button"
                          tabIndex={0}
                          onClick={handleClick}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              handleClick();
                            }
                          }}
                          title={
                            assigned
                              ? `Giọng: ${voiceLabel(s.voiceId)} — nhấn để đổi`
                              : 'Nhấn để gán giọng'
                          }
                          className="text-left"
                        >
                          {s.text}
                        </span>
                        {s.uncertain && (
                          <span
                            title={`AI phân giọng chưa chắc chắn (độ tin cậy ${Math.round((s.confidence ?? 0) * 100)}%). Nhấn để gán/chỉnh sửa thủ công.`}
                            className="ml-0.5 inline-flex h-3.5 w-3.5 items-center justify-center rounded-full bg-amber-500/20 text-[9px] font-bold text-amber-600 align-middle"
                          >
                            ?
                          </span>
                        )}
                        {/* (a) per-sentence speaker / play icon — lives inside
                            the highlight span so the assigned-voice chip
                            reads as one unit (text + icon). Using a
                            role="button" span (not a <button>) keeps the
                            flow inline so long sentences can wrap freely. */}
                        <span
                          role="button"
                          tabIndex={0}
                          onClick={(e) => { e.stopPropagation(); void playSentence(s); }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              e.stopPropagation();
                              void playSentence(s);
                            }
                          }}
                          aria-label={isPlaying ? 'Dừng phát' : 'Nghe thử câu này'}
                          title={isPlaying ? 'Dừng phát' : 'Nghe thử câu này'}
                          aria-disabled={!isPlaying && playingSentence !== null}
                          className={cn(
                            'ml-1 inline-flex cursor-pointer items-center align-middle text-[10px] font-medium transition-opacity',
                            isPlaying
                              ? 'text-primary opacity-100'
                              : assigned
                                ? 'text-primary opacity-100'
                                : 'text-muted-foreground opacity-0 group-hover/sent:opacity-100',
                            !isPlaying && playingSentence !== null && 'pointer-events-none opacity-30',
                          )}
                        >
                          {isPlaying ? <Square className="h-2.5 w-2.5" /> : <Volume2 className="h-2.5 w-2.5" />}
                        </span>
                      </span>
                      {isCharacter && !assigned && (
                        <span
                          className="ml-1 inline-flex items-center align-middle text-[10px] font-medium text-muted-foreground"
                          title={`Nhân vật: ${char?.name}`}
                        >
                          <User className="h-3 w-3" />
                        </span>
                      )}
                    </span>
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

      {/* (c) Batch-assign bottom bar — visible in selection mode */}
      {selectionMode && (
        <div className="sticky bottom-0 z-10 flex items-center gap-3 border-t bg-background px-4 py-3 shadow-[0_-2px_8px_rgba(0,0,0,0.06)]">
          <span className="text-sm font-medium">Đã chọn <b>{selected.size}</b> câu</span>
          <div className="ml-auto flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setSelected(new Set())}
              disabled={selected.size === 0}
            >
              Bỏ chọn
            </Button>
            <Button
              size="sm"
              onClick={() => setBatchVoice(NARRATION_VALUE)}
              disabled={selected.size === 0}
            >
              Gán giọng cho {selected.size} câu
            </Button>
          </div>
        </div>
      )}

      {/* (c) Batch voice picker dialog */}
      <Dialog
        open={batchVoice !== null}
        onOpenChange={(o) => { if (!o) setBatchVoice(null); }}
        title={`Gán giọng cho ${selected.size} câu`}
        description="Chọn một giọng — tất cả câu đã chọn sẽ dùng chung giọng này."
        widthClass="max-w-md"
      >
        <DialogBody>
          <div className="mb-2 text-xs font-medium text-muted-foreground">Chọn giọng</div>
          <div className="max-h-72 space-y-1 overflow-y-auto pr-1">
            <VoiceRow
              selected={batchVoice === NARRATION_VALUE}
              onClick={() => assignVoiceMany(selected, NARRATION_VALUE)}
              icon={<Mic className="h-4 w-4" />}
              title="Giọng kể (mặc định)"
              subtitle="Người dẫn chuyện"
            />
            {voices.map((v) => {
              const g = genderBadge(v.gender);
              return (
                <VoiceRow
                  key={v.id}
                  selected={batchVoice === v.id}
                  onClick={() => assignVoiceMany(selected, v.id)}
                  icon={
                    <span className={cn('inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold', g.cls)}>
                      {g.label}
                    </span>
                  }
                  title={v.label}
                  subtitle={v.isCloned ? 'Giọng tùy chỉnh' : (v.gender === 'male' ? 'Nam' : v.gender === 'female' ? 'Nữ' : '')}
                />
              );
            })}
          </div>
        </DialogBody>
      </Dialog>

      {/* (f) History dialog — restore a previous snapshot. Every restore first
          snapshots the CURRENT plan, so it is itself reversible. Capped at 30. */}
      <Dialog
        open={historyOpen}
        onOpenChange={(o) => { if (!o) setHistoryOpen(false); }}
        title="Lịch sử phiên bản"
        description="Mỗi phiên bản lưu nguyên trạng thái phân giọng. Khôi phục sẽ chụp bản hiện tại vào lịch sử trước, nên có thể hoàn tác."
        widthClass="max-w-md"
      >
        <DialogBody>
          {historyLoading ? (
            <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Đang tải…
            </div>
          ) : history.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground">
              Chưa có phiên bản nào. Nhấn <b>Lưu phiên bản</b> hoặc <b>Áp dụng</b> đề xuất AI để tạo bản đầu tiên.
            </div>
          ) : (
            <div className="max-h-80 space-y-1 overflow-y-auto pr-1">
              {history.map((h) => (
                <div
                  key={h.id}
                  className="flex items-center gap-2 rounded-md border border-border px-2.5 py-2"
                >
                  <History className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{h.label}</div>
                    <div className="text-xs text-muted-foreground">
                      {new Date(h.createdAt).toLocaleString('vi-VN')} · {h.count} câu
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void restoreHistory(h.id)}
                  >
                    Khôi phục
                  </Button>
                </div>
              ))}
              <div className="pt-1 text-center text-[10px] text-muted-foreground">
                Tối đa {HISTORY_CAP} phiên bản — tự động đè lên bản cũ nhất khi đầy.
              </div>
            </div>
          )}
        </DialogBody>
      </Dialog>

      {/* (d) Per-chapter audiobook generation */}
      <div className="border-t bg-muted/20 px-4 py-3">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">Tạo Audio Book</span>
            {genStatus === 'generating' && (
              <span className="inline-flex items-center gap-1 text-xs text-blue-600">
                <Loader2 className="h-3 w-3 animate-spin" /> {genProgress}%
              </span>
            )}
            {genStatus === 'ready' && (
              <span className="inline-flex items-center gap-1 text-xs text-green-600">
                <Check className="h-3 w-3" /> Sẵn sàng
              </span>
            )}
            {genStatus === 'failed' && (
              <span className="inline-flex items-center gap-1 text-xs text-red-500">
                <X className="h-3 w-3" /> Lỗi
              </span>
            )}
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => void generateChapter(false)}
              disabled={genBusy || !currentChapterFile}
            >
              {genStatus === 'generating' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Tạo audio chương này
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void generateChapter(true)}
              disabled={genBusy}
            >
              Tạo toàn bộ sách
            </Button>
          </div>
        </div>
      </div>
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