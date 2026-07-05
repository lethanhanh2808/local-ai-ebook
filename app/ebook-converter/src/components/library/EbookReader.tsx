'use client';
// src/components/library/EbookReader.tsx
// Professional EPUB reader: spread (two-column Apple Books) + scroll modes
import { useEffect, useRef, useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import {
  ChevronLeft, ChevronRight, List, X, Home, Settings2,
  Bookmark, BookmarkCheck, AlignLeft, Minus, Plus,
  Search, Clock, RotateCcw, Maximize2, Minimize2,
  Columns, ScrollText, Wand2, Check, Loader2, Trash2,
  Volume2, VolumeX, Play, Pause, Square, Headphones,
  Mic, Bug,
} from 'lucide-react';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import { VoicePanel } from './VoicePanel';
import { AudiobookPanel } from './AudiobookPanel';
import { ReadAloudPanel } from './ReadAloudPanel';
import { VoiceDebugPanel } from './VoiceDebugPanel';
import { ServiceHealth } from '@/components/status/ServiceHealth';

interface Chapter { id: string; title: string; order: number; }
export interface EbookReaderProps {
  bookId: string; bookTitle: string; initialChapter?: string; initialProgress?: number;
}

type Theme  = 'light' | 'dark' | 'sepia';
type Font   = 'serif' | 'sans' | 'mono';
type Layout = 'spread' | 'scroll';

interface ReaderSettings {
  theme: Theme; font: Font; fontSize: number; lineHeight: number; width: number; layout: Layout; indent: number;
  padTop: number; padBottom: number; padInline: number;
}
const DEFAULT_SETTINGS: ReaderSettings = {
  theme: 'dark', font: 'serif', fontSize: 18, lineHeight: 1.85, width: 720, layout: 'spread', indent: 1.5,
  padTop: 48, padBottom: 96, padInline: 40,
};
const INDENT_PRESETS = [
  { em: 0,   label: 'None' },
  { em: 1,   label: '1em' },
  { em: 1.5, label: '1.5em' },
  { em: 2,   label: '2em' },
];

const THEMES = [
  { id: 'light' as Theme, label: 'Light', bg: '#fafaf9', text: '#1c1c1e' },
  { id: 'sepia' as Theme, label: 'Sepia', bg: '#f4ede4', text: '#3b2f20' },
  { id: 'dark'  as Theme, label: 'Dark',  bg: '#1a1a2e', text: '#e2e2e8' },
];
const FONTS = [
  { id: 'serif' as Font, sample: 'Georgia', stack: 'Georgia,serif' },
  { id: 'sans'  as Font, sample: 'Helvetica', stack: 'Inter,sans-serif' },
  { id: 'mono'  as Font, sample: 'Mono', stack: 'monospace' },
];
const WIDTHS = [
  { px: 560, label: 'Narrow' }, { px: 720, label: 'Medium' },
  { px: 900, label: 'Wide' },   { px: 9999, label: 'Full' },
];

interface WatermarkCandidate { text: string; count: number; percentage: number; confirmed?: boolean; }

interface BrowserSpeechRecognitionAlternative {
  transcript: string;
  confidence?: number;
}
interface BrowserSpeechRecognitionResult {
  isFinal: boolean;
  length: number;
  [index: number]: BrowserSpeechRecognitionAlternative;
}
interface BrowserSpeechRecognitionEvent {
  resultIndex: number;
  results: ArrayLike<BrowserSpeechRecognitionResult>;
}
interface BrowserSpeechRecognitionErrorEvent {
  error: string;
}
interface BrowserSpeechRecognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: BrowserSpeechRecognitionEvent) => void) | null;
  onerror: ((event: BrowserSpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}
type BrowserSpeechRecognitionConstructor = new () => BrowserSpeechRecognition;

function loadSettings(): ReaderSettings {
  try { const r = localStorage.getItem('epub-reader-settings'); if (r) return { ...DEFAULT_SETTINGS, ...JSON.parse(r) }; } catch { /**/ }
  return DEFAULT_SETTINGS;
}
function saveSettings(s: ReaderSettings) {
  try { localStorage.setItem('epub-reader-settings', JSON.stringify(s)); } catch { /**/ }
}
function loadBookmarks(id: string): number[] {
  try { const r = localStorage.getItem(`epub-bm-${id}`); return r ? JSON.parse(r) : []; } catch { return []; }
}
function saveBookmarks(id: string, marks: number[]) {
  try { localStorage.setItem(`epub-bm-${id}`, JSON.stringify(marks)); } catch { /**/ }
}
function getSpeechRecognitionCtor(): BrowserSpeechRecognitionConstructor | null {
  if (typeof window === 'undefined') return null;
  const w = window as typeof window & {
    SpeechRecognition?: BrowserSpeechRecognitionConstructor;
    webkitSpeechRecognition?: BrowserSpeechRecognitionConstructor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}
function estimateReadTime(total: number, current: number): string {
  const mins = Math.max(1, Math.round((total - current) * 3));
  if (mins < 60) return `~${mins}m left`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return m > 0 ? `~${h}h ${m}m left` : `~${h}h left`;
}

export function EbookReader({ bookId, bookTitle, initialChapter, initialProgress = 0 }: EbookReaderProps) {
  const [chapters, setChapters]   = useState<Chapter[]>([]);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [loading, setLoading]     = useState(true);
  const [settings, setSettings]   = useState<ReaderSettings>(DEFAULT_SETTINGS);
  const [tocOpen, setTocOpen]     = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [bookmarksOpen, setBookmarksOpen] = useState(false);
  const [tocSearch, setTocSearch] = useState('');
  const [jumpInput, setJumpInput] = useState('');
  const [bookmarks, setBookmarks] = useState<number[]>([]);
  // Voice-assignment debug panel — shows detected speaker + voice name per
  // paragraph so we can tell whether mis-routing is from the attribution
  // logic (speaker = wrong) or the voice map (speaker = right but voiceName
  // resolves wrong).
  const [voiceDebugOpen, setVoiceDebugOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [iframeLoading, setIframeLoading] = useState(false);
  // Spread-mode page tracking
  const [spreadPage, setSpreadPage]   = useState(0);
  const [spreadTotal, setSpreadTotal] = useState(1);
  const pendingLastPage = useRef(false);
  // Watermark panel
  const [wmOpen, setWmOpen] = useState(false);
  const [wmCandidates, setWmCandidates] = useState<WatermarkCandidate[]>([]);
  const [wmSaved, setWmSaved] = useState<string[]>([]);
  const [wmLoading, setWmLoading] = useState(false);
  const [wmSelected, setWmSelected] = useState<Set<number>>(new Set());
  // Audiobook panel (voice management + pre-generation)
  const [abOpen, setAbOpen] = useState(false);
  const [abTab, setAbTab] = useState<'audiobook' | 'voices'>('audiobook');

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // ── TTS ──────────────────────────────────────────────────
  type TtsState = 'idle' | 'loading' | 'playing' | 'paused';

  interface TtsVoice {
    id: string;
    name: string;
    isCustom?: boolean;
  }

  // ── VieNeu-TTS built-in voices (Vietnamese-native, 48 kHz) ─────────────
  const VIENEU_VOICES: TtsVoice[] = [
    { id: 'Ngọc Linh', name: 'Ngọc Linh (Nữ — trẻ, trong trẻo)' },
    { id: 'Ngọc Lan', name: 'Ngọc Lan (Nữ — trưởng thành, ấm áp)' },
    { id: 'Mỹ Duyên', name: 'Mỹ Duyên (Nữ — chín chắn, truyền cảm)' },
    { id: 'Trúc Ly',  name: 'Trúc Ly (Nữ — nhẹ nhàng, thủ thỉ)' },
    { id: 'Bình An',  name: 'Bình An (Nam — trung niên, bình tĩnh)' },
    { id: 'Thái Sơn', name: 'Thái Sơn (Nam — trẻ, khí thế)' },
    { id: 'Đức Trí',  name: 'Đức Trí (Nam — chín chắn, quyền lực)' },
    { id: 'Xuân Vĩnh',name: 'Xuân Vĩnh (Nam — trầm, trưởng thành)' },
    { id: 'Trọng Hữu',name: 'Trọng Hữu (Nam — trầm ấm, thủ thỉ)' },
    { id: 'Gia Bảo',  name: 'Gia Bảo (Nam — trẻ, năng động)' },
  ];

  // Default voice (centre of the spectrum — easy to listen to)
  const [ttsState, setTtsState]           = useState<TtsState>('idle');
  const [ttsParagraphs, setTtsParagraphs] = useState<string[]>([]);
  const [ttsIndex, setTtsIndex]           = useState(0);
  const [ttsSpeed, setTtsSpeed]           = useState(1.0);
  const [ttsVoice, setTtsVoice]           = useState<string>('Bình An');
  const [ttsNoise, setTtsNoise]           = useState(0.667);  // expressiveness
  // Extra silence between paragraphs (ms). 0 = no extra gap, just use the
  // TTS model's natural trailing silence (~200ms). User-controlled via the
  // "Khoảng nghỉ giữa đoạn" slider in ReadAloudPanel → Cài đặt tab.
  const [ttsParagraphGap, setTtsParagraphGap] = useState(0);
  // ── Continuous-play across chapters ────────────────────────────────
  // When ON, finishing one chapter auto-advances to the next chapter's TTS
  // loop. The reading position (chapter index + paragraph index) updates
  // as if you were reading — the bookmark/progress save also reflects it.
  const [ttsContinuousPlay, setTtsContinuousPlay] = useState(false);
  const ttsIsAdvancingRef = useRef(false);   // suppresses the stopTts in the chapter-change effect
  const chapterParagraphsRef = useRef<Map<string, string[]>>(new Map());  // chapterId → paragraphs
  const prefetchCacheRef = useRef<Map<string, Map<string, Promise<Blob>>>>(new Map()); // chapterId → request key → Promise<Blob>
  // VnCoreNLP / regex / LLM per-paragraph attribution map keyed by chapterId.
  // Fetched lazily by loadChapterAttribution() so we don't slow down the
  // initial chapter paint. detectSpeaker() consults this first and only
  // falls back to the local 6-pass regex when the map has no entry.
  const chapterAttributionRef = useRef<
    Map<string, {
      attribution: Record<number, { speaker: string | null; confidence: number; source: string }>;
      fromCache: boolean;
      parserReachable: boolean;
    }>
  >(new Map());
  const chapterAttributionInFlightRef = useRef<Set<string>>(new Set());
  const [chapterAttributionStats, setChapterAttributionStats] =
    useState<{
      chapterId: string;
      parserHits: number;
      regexHits: number;
      llmHits: number;
      conversationHits: number;
      defaults: number;
      fromCache: boolean;
      parserReachable: boolean;
      omlxReachable: boolean;
    } | null>(null);
  // ── Full-analysis (parser + regex + LLM) state ─────────────────────
  // Set by the Wand2 toolbar button. Drives the in-flight spinner and the
  // progress hint. Reset to null when the chapter changes.
  const [analysisInFlight, setAnalysisInFlight] = useState(false);
  const [analysisProgress, setAnalysisProgress] = useState<string | null>(null);
  const [pregenStatus, setPregenStatus] = useState<{ chapterId: string; done: number; total: number } | null>(null);
  // Ref mirrors chapters[currentIdx] so async callbacks (setTimeout) always
  // see the latest chapter even after React has re-rendered with a new
  // currentIdx (e.g. during auto-advance to next chapter).
  const currentChapterRef = useRef<Chapter | null>(null);
  useEffect(() => {
    currentChapterRef.current = chapters[currentIdx] ?? null;
  }, [chapters, currentIdx]);
  const [ttsCustomVoices, setTtsCustomVoices] = useState<TtsVoice[]>([]);
  const [ttsCharacterMap, setTtsCharacterMap] = useState<Record<string, string>>({}); // name|alias → voice name
  const [ttsCharacterList, setTtsCharacterList] = useState<{ name: string; voiceName?: string }[]>([]);
  const [ttsUseCharacterVoice, setTtsUseCharacterVoice] = useState(true);  // auto-switch voice per character
  const [ttsCurrentSpeaker, setTtsCurrentSpeaker] = useState<string | null>(null);
  const [ttsSettingsOpen, setTtsSettingsOpen] = useState(false);
  const [ttsUseAI, setTtsUseAI]           = useState(false);
  const [ttsEmotionLabel, setTtsEmotionLabel] = useState('');
  const audioRef    = useRef<HTMLAudioElement | null>(null);
  const ttsAbortRef = useRef(false);
  const ttsRunIdRef = useRef(0);
  const ttsAudioFinishRef = useRef<(() => void) | null>(null);
  const ttsStateRef = useRef<TtsState>('idle');
  const [voiceControlSupported, setVoiceControlSupported] = useState(false);
  const [voiceControlOn, setVoiceControlOn] = useState(false);
  const voiceControlOnRef = useRef(false);
  const speechRecognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const voiceCommandHandlerRef = useRef<(text: string) => void>(() => {});
  const [voiceCommandText, setVoiceCommandText] = useState('');
  const [voiceCommandError, setVoiceCommandError] = useState('');
  // ── Voice preview state (the 10 default VieNeu voices) ───────────────
  const [previewingVoice, setPreviewingVoice] = useState<string | null>(null);
  const voicePreviewAudioRef = useRef<HTMLAudioElement | null>(null);

  // ── Heuristic emotion detection (instant, no AI needed) ──────────────────
  // Maps Vietnamese text patterns → TTS parameter adjustments.
  // Covers the most common novel genres: xianxia action, romance, drama, slice-of-life.
  interface EmotionResult { label: string; emoji: string; speed: number; noiseScale: number; emotion: string; }

  function detectEmotion(text: string, baseSpeed: number, baseNoise: number): EmotionResult {
    const t = text.toLowerCase();
    const exclaims = (text.match(/!/g) ?? []).length;
    const ellipses = (text.match(/\.\.\.|…/g) ?? []).length;
    const clamp    = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

    // ⚡ Action / battle / cultivation breakthrough
    if (/kiếm|đao|thương|chiến|tấn công|bùng nổ|cuộn trào|huyết mạch|linh lực|chân khí|đánh|giết|chém|đâm|phá cảnh|huyết chiến|giao chiến|công kích|đại chiến|hủy diệt/.test(t))
      return { label: 'hành động', emoji: '⚡', emotion: 'excited', speed: clamp(baseSpeed * 1.22, 0.5, 2.5), noiseScale: clamp(baseNoise + 0.26, 0.3, 0.95) };

    // 😤 Angry / betrayal
    if (/phản bội|căm hận|thù hận|tức giận|giận dữ|phẫn nộ|không tha thứ|kẻ thù|nghịch nhân|hét lên|gầm lên|thét/.test(t) || exclaims >= 3)
      return { label: 'tức giận', emoji: '😤', emotion: 'angry', speed: clamp(baseSpeed * 1.18, 0.5, 2.5), noiseScale: clamp(baseNoise + 0.22, 0.3, 0.95) };

    // 💧 Sad / grief
    if (/nước mắt|khóc|rơi lệ|sầu|buồn|thất vọng|đau lòng|mất đi|ra đi|không trở về|vĩnh biệt|cô đơn|cô quạnh|tiếc nuối|hối hận/.test(t))
      return { label: 'buồn', emoji: '💧', emotion: 'sad', speed: clamp(baseSpeed * 0.80, 0.5, 2.5), noiseScale: clamp(baseNoise - 0.25, 0.25, 0.95) };

    // 💕 Romantic / tender
    // "nụ cười" / "mỉm cười" (a smile / gentle smile) are intentionally
    // OMITTED — they appear in narration all the time ("cô ấy có một nụ
    // cười dịu dàng") without any romance implication. Including them used
    // to mark every paragraph containing a smile as "lãng mạn" → "[cười]"
    // marker injected into nearly every sentence.
    if (/tim đập|yêu nhau|ngại ngùng|e thẹn|má đỏ|ôm lấy|vòng tay|ánh mắt ấm|nhìn nhau|yêu thương|đôi ta|nắm tay|hôn|hôn nhau|trao nhau|nụ hôn/.test(t))
      return { label: 'lãng mạn', emoji: '💕', emotion: 'romantic', speed: clamp(baseSpeed * 0.88, 0.5, 2.5), noiseScale: clamp(baseNoise - 0.12, 0.25, 0.95) };

    // 😰 Tense / suspense
    if (/nguy hiểm|căng thẳng|hồi hộp|bóng tối|im lặng đột|tiến lại|vây quanh|rùng mình|phục kích|kẻ địch xuất/.test(t) || ellipses >= 2)
      return { label: 'căng thẳng', emoji: '😰', emotion: 'tense', speed: clamp(baseSpeed * 1.07, 0.5, 2.5), noiseScale: clamp(baseNoise + 0.10, 0.3, 0.95) };

    // 🍃 Calm / peaceful
    if (/yên tĩnh|bình yên|thanh thản|nhẹ nhàng|thư thái|gió thổi nhẹ|ánh trăng|bình thản|thong thả|an bình/.test(t))
      return { label: 'bình yên', emoji: '🍃', emotion: 'calm', speed: clamp(baseSpeed * 0.90, 0.5, 2.5), noiseScale: clamp(baseNoise - 0.18, 0.25, 0.95) };

    return { label: '', emoji: '', emotion: 'neutral', speed: baseSpeed, noiseScale: baseNoise };
  }

  useEffect(() => {
    const s = loadSettings();
    setSettings(s);
  }, []);

  useEffect(() => {
    setVoiceControlSupported(!!getSpeechRecognitionCtor());
    return () => {
      voiceControlOnRef.current = false;
      speechRecognitionRef.current?.abort();
      speechRecognitionRef.current = null;
    };
  }, []);

  useEffect(() => {
    ttsStateRef.current = ttsState;
  }, [ttsState]);

  useEffect(() => {
    voiceCommandHandlerRef.current = handleVoiceCommand;
  });

  useEffect(() => {
    fetch(`/api/library/${bookId}/chapters`)
      .then((r) => r.json())
      .then((data: Chapter[]) => {
        setChapters(data);
        const startIdx = initialChapter
          ? Math.max(0, data.findIndex((c) => c.id === initialChapter))
          : Math.max(0, Math.floor((initialProgress / 100) * (data.length - 1)));
        setCurrentIdx(startIdx);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [bookId, initialChapter, initialProgress]);

  useEffect(() => { setBookmarks(loadBookmarks(bookId)); }, [bookId]);

  // Handle postMessages from iframe (chapter navigation + spread pagination)
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (!e.data?.type) return;
      const { type } = e.data as { type: string; chapterId?: string; current?: number; total?: number };
      if (type === 'epub-navigate' && e.data.chapterId) {
        const idx = chapters.findIndex((c) => c.id === e.data.chapterId);
        if (idx >= 0) goToChapter(idx);
      } else if (type === 'page-info') {
        setSpreadPage(e.data.current ?? 0);
        setSpreadTotal(e.data.total ?? 1);
      } else if (type === 'chapter-end') {
        goToChapter(currentIdx + 1);
      } else if (type === 'chapter-start') {
        pendingLastPage.current = true;
        goToChapter(currentIdx - 1);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapters, currentIdx]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); handleNext(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); handlePrev(); }
      else if (e.key === 'Escape') { setTocOpen(false); setSettingsOpen(false); setBookmarksOpen(false); setWmOpen(false); setVoiceDebugOpen(false); }
      else if (e.key === 'b' || e.key === 'B') toggleBookmark();
      else if (e.key === 't' || e.key === 'T') setTocOpen((o) => !o);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentIdx, chapters, bookmarks, settings.layout, spreadPage, spreadTotal]);

  const saveProgress = useCallback((idx: number, total: number) => {
    if (!total) return;
    const pct = Math.round((idx / Math.max(1, total - 1)) * 100);
    fetch(`/api/library/${bookId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ readProgress: pct, lastRead: new Date().toISOString() }),
    }).catch(() => {});
  }, [bookId]);

  function goToChapter(idx: number) {
    const clamped = Math.max(0, Math.min(chapters.length - 1, idx));
    setIframeLoading(true);
    setSpreadPage(0);
    setSpreadTotal(1);
    setCurrentIdx(clamped);
    setTocOpen(false);
    setBookmarksOpen(false);
    saveProgress(clamped, chapters.length);
  }

  function handleNext() {
    if (settings.layout === 'spread') {
      iframeRef.current?.contentWindow?.postMessage({ type: 'next-page' }, '*');
    } else {
      goToChapter(currentIdx + 1);
    }
  }
  function handlePrev() {
    if (settings.layout === 'spread') {
      iframeRef.current?.contentWindow?.postMessage({ type: 'prev-page' }, '*');
    } else {
      goToChapter(currentIdx - 1);
    }
  }

  const handleIframeLoad = () => {
    setIframeLoading(false);
    if (pendingLastPage.current) {
      pendingLastPage.current = false;
      setTimeout(() => {
        iframeRef.current?.contentWindow?.postMessage({ type: 'go-last-page' }, '*');
      }, 80);
    }
  };

  function updateSetting<K extends keyof ReaderSettings>(key: K, value: ReaderSettings[K]) {
    const next = { ...settings, [key]: value };
    setSettings(next);
    saveSettings(next);
  }

  function toggleBookmark() {
    const marks = bookmarks.includes(currentIdx)
      ? bookmarks.filter((m) => m !== currentIdx)
      : [...bookmarks, currentIdx].sort((a, b) => a - b);
    setBookmarks(marks);
    saveBookmarks(bookId, marks);
  }

  // Watermark detection
  async function detectWatermarks(useAI = false) {
    setWmLoading(true);
    setWmOpen(true);
    try {
      const r = await fetch(`/api/library/${bookId}/watermarks?ai=${useAI}`);
      const data = await r.json() as { candidates: WatermarkCandidate[]; saved: string[] };
      setWmCandidates(data.candidates ?? []);
      setWmSaved(data.saved ?? []);
      // Pre-select AI-confirmed ones
      const preSelected = new Set<number>();
      data.candidates?.forEach((c, i) => { if (c.confirmed) preSelected.add(i); });
      setWmSelected(preSelected);
    } finally {
      setWmLoading(false);
    }
  }

  async function saveWatermarks() {
    const toSave = wmCandidates.filter((_, i) => wmSelected.has(i)).map((c) => c.text);
    await fetch(`/api/library/${bookId}/watermarks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ watermarks: toSave }),
    });
    setWmSaved(toSave);
    setWmOpen(false);
    // Reload current chapter
    setIframeLoading(true);
    setCurrentIdx((i) => i); // trigger re-render of iframe src
  }

  async function clearWatermarks() {
    await fetch(`/api/library/${bookId}/watermarks`, { method: 'DELETE' });
    setWmSaved([]);
  }

  // ── TTS helpers ───────────────────────────────────────────

  async function loadTtsContext() {
    // Load the book's custom voices + character assignments so the read-aloud
    // can auto-switch voice based on who's "talking" in the chapter.
    try {
      const [v, c] = await Promise.all([
        fetch(`/api/library/${bookId}/voices`).then((r) => r.json()).catch(() => ({ voices: [] })),
        fetch(`/api/library/${bookId}/characters`).then((r) => r.json()).catch(() => ({ characters: [] })),
      ]);
      const voices: TtsVoice[] = (v.voices ?? [])
        .filter((vv: { refAudioPath?: string | null }) => !!vv.refAudioPath)
        .map((vv: { id: string; name: string }) => ({
          id: vv.id, name: `🎭 ${vv.name}`, isCustom: true,
        }));
      setTtsCustomVoices(voices);

      // Build a quick lookup map: character name (lowercase) → voice name to use
      const map: Record<string, string> = {};
      const list: { name: string; voiceName?: string }[] = [];
      const voicesList = v.voices ?? [];
      for (const ch of (c.characters ?? []) as Array<{ name: string; voiceId?: string | null; aliases?: string[] | null }>) {
        const voice = voicesList.find((vv: { id: string }) => vv.id === ch.voiceId);
        const voiceName = voice?.name;
        list.push({ name: ch.name, voiceName });
        if (voiceName) {
          map[ch.name.toLowerCase()] = voiceName;
          for (const alias of (ch.aliases ?? [])) map[alias.toLowerCase()] = voiceName;
        }
      }
      setTtsCharacterMap(map);
      setTtsCharacterList(list);
    } catch { /* silent */ }
  }

  /** Fetch per-paragraph attribution (parser + regex + LLM) for a chapter.
   *  Result is stored in chapterAttributionRef so detectSpeaker() can use it
   *  without re-fetching. Safe to call repeatedly — the server caches by
   *  chapter file mtime. */
  async function loadChapterAttribution(chapterId: string) {
    if (chapterAttributionInFlightRef.current.has(chapterId)) return;
    if (chapterAttributionRef.current.has(chapterId)) return; // already loaded
    chapterAttributionInFlightRef.current.add(chapterId);
    try {
      const r = await fetch(`/api/library/${bookId}/chapters/${encodeURIComponent(chapterId)}/attribute`);
      if (!r.ok) {
        // Endpoint missing or parser sidecar down — silently degrade.
        return;
      }
      const data = await r.json() as {
        attribution: Record<number, { speaker: string | null; confidence: number; source: string }>;
        fromCache: boolean;
        parserReachable: boolean;
        omlxReachable: boolean;
        stats: {
          parserHits: number;
          regexHits: number;
          llmHits: number;
          conversationHits: number;
          defaults: number;
          totalParagraphs: number;
        };
      };
      chapterAttributionRef.current.set(chapterId, {
        attribution: data.attribution ?? {},
        fromCache: !!data.fromCache,
        parserReachable: !!data.parserReachable,
      });
      setChapterAttributionStats({
        chapterId,
        parserHits: data.stats?.parserHits ?? 0,
        regexHits: data.stats?.regexHits ?? 0,
        llmHits: data.stats?.llmHits ?? 0,
        conversationHits: data.stats?.conversationHits ?? 0,
        defaults: data.stats?.defaults ?? 0,
        fromCache: !!data.fromCache,
        parserReachable: !!data.parserReachable,
        omlxReachable: !!data.omlxReachable,
      });
    } catch {
      // Silent — attribution is best-effort.
    } finally {
      chapterAttributionInFlightRef.current.delete(chapterId);
    }
  }

  /**
   * Run the FULL attribution pipeline (parser + regex + oMLX LLM fallback)
   * for the current chapter and update the in-memory attribution map.
   *
   * Triggered by the Wand2 toolbar button. The server invalidates its cache
   * before computing, so we always get a fresh result. On completion we
   * auto-open the VoiceDebugPanel so the user can immediately see which
   * paragraphs the LLM resolved vs. fell back to default voice.
   *
   * Never throws — failures are surfaced via the toast + a `omlxReachable:
   * false` UI hint, not by breaking the reader.
   */
  async function runFullAnalysis() {
    const chapterId = chapters[currentIdx]?.id;
    if (!chapterId || analysisInFlight) return;
    setAnalysisInFlight(true);
    setAnalysisProgress('Đang chạy parser + regex + oMLX…');
    try {
      const r = await fetch(
        `/api/library/${bookId}/chapters/${encodeURIComponent(chapterId)}/attribute/analyze`,
        { method: 'POST' },
      );
      if (!r.ok) {
        setAnalysisProgress('Full analysis thất bại — kiểm tra log server');
        setAnalysisInFlight(false);
        return;
      }
      const data = await r.json() as {
        attribution: Record<number, { speaker: string | null; confidence: number; source: string }>;
        parserReachable: boolean;
        omlxReachable: boolean;
        stats: {
          parserHits: number; regexHits: number; llmHits: number; conversationHits: number;
          llmFailures?: number; llmRequested?: number;
          defaults: number; totalParagraphs: number;
        };
      };
      // Replace the cached attribution for this chapter.
      chapterAttributionRef.current.set(chapterId, {
        attribution: data.attribution ?? {},
        fromCache: false,
        parserReachable: !!data.parserReachable,
      });
      setChapterAttributionStats({
        chapterId,
        parserHits: data.stats?.parserHits ?? 0,
        regexHits: data.stats?.regexHits ?? 0,
        llmHits: data.stats?.llmHits ?? 0,
        conversationHits: data.stats?.conversationHits ?? 0,
        defaults: data.stats?.defaults ?? 0,
        fromCache: false,
        parserReachable: !!data.parserReachable,
        omlxReachable: !!data.omlxReachable,
      });
      // Build a one-line summary rendered next to the toolbar.
      const llmPart = data.omlxReachable
        ? `${data.stats.llmHits} LLM`
        : data.stats.llmRequested && data.stats.llmRequested > 0
          ? `oMLX lỗi (${data.stats.llmFailures ?? 0} batch fail)`
          : 'oMLX không chạy';
      setAnalysisProgress(
        `Full analysis xong — ${data.stats.parserHits} parser, ${data.stats.regexHits} regex, ${data.stats.conversationHits ?? 0} conversation, ${llmPart}`,
      );
      setVoiceDebugOpen(true);
      // Auto-clear the success message after a few seconds (failure messages
      // stay until the user clicks again or changes chapter).
      setTimeout(() => {
        setAnalysisProgress((cur) =>
          cur && cur.startsWith('Full analysis xong') ? null : cur,
        );
      }, 6000);
    } catch (e) {
      setAnalysisProgress(
        'Full analysis lỗi: ' + (e instanceof Error ? e.message : String(e)),
      );
    } finally {
      setAnalysisInFlight(false);
    }
  }

  /**
   * Per-chapter character detection — runs the Python detector on a SINGLE
   * chapter's HTML, auto-applies new characters + voice assignments to the DB,
   * and refreshes the in-memory ttsCharacterMap so voice auto-switching
   * works for newly-discovered characters.
   *
   * Fire-and-forget — caller doesn't await. Triggered:
   *   1. When the user opens a chapter (in case previous AI-detect missed it)
   *   2. In the background while TTS is playing the current chapter, for the
   *      NEXT chapter — so by the time auto-advance reaches it, voices are ready
   */
  const detectChapterInFlightRef = useRef<Set<string>>(new Set());  // chapterIds currently being detected
  async function detectChapterCharacters(chapterId: string, opts: { silent?: boolean } = {}) {
    if (detectChapterInFlightRef.current.has(chapterId)) return; // already running
    detectChapterInFlightRef.current.add(chapterId);
    if (!opts.silent) setDetectingChapter(chapterId);
    try {
      const r = await fetch(`/api/library/${bookId}/chapters/${encodeURIComponent(chapterId)}/detect-characters`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ language: 'vi' }),
      });
      if (!r.ok) return;
      const data = await r.json() as { inserted: number; skipped: number; characters: Array<{ name: string; aliases: string[]; voiceId?: string }> };
      // Refresh the in-memory map so voice auto-switching picks up the new entries
      if (data.inserted > 0) {
        await loadTtsContext();
      }
    } catch {
      // Silent — detection failures shouldn't block TTS
    } finally {
      detectChapterInFlightRef.current.delete(chapterId);
      if (!opts.silent) setDetectingChapter(null);
    }
  }

  const [detectingChapter, setDetectingChapter] = useState<string | null>(null);

  // ── Quote-based dialogue attribution ────────────────────────────────────
  // Vietnamese novels use these patterns:
  //   1. Name + verb + ":" + quote          → "La Dạ cười nói: \"...\""
  //   2. Quote + Name + verb                → "\"...\" La Dạ cười hỏi."
  //   3. Quote + dash + Name                → "\"...\" — La Dạ"
  //   4. Pure quote, no attribution         → use default voice (narrator)
  //   5. Narration mentioning a character   → IGNORE (this is the bug fix)
  //
  // For each dialogue quote, we scan only a small "attribution window":
  //   BEFORE:  up to 80 chars before the open-quote, BUT starting AFTER
  //            the previous quote's close-quote. This prevents picking up
  //            an earlier quote's attribution for this one.
  //   AFTER:   up to 40 chars after the close-quote.
  // We pick the FIRST name + speech-verb match in that window — in
  // Vietnamese, the earliest named subject is typically the grammatical
  // subject of the verb ("A nhìn B, rồi nói: \"...\"" → A speaks).
  // Quote regexes MUST include U+201C (LEFT DOUBLE QUOTATION MARK) and
  // U+201D (RIGHT DOUBLE QUOTATION MARK) — most EPUBs use curly quotes,
  // not ASCII straight. Without them, findQuoteSpans returns zero quotes
  // and every paragraph falls back to the default voice. The debug panel
  // (VoiceDebugPanel.findFirstQuote) already includes these — mirror here.
  // We use the same set for OPEN and CLOSE (any quote char terminates a
  // span) because ASCII is symmetric and the Asian brackets are matched
  // as pairs in the source text.
  const QUOTE_OPEN_RE  = /["“”'‘'「『]/;
  const QUOTE_CLOSE_RE = /["“”'‘'」』]/;
  const SPEECH_VERBS = '(?:nói|hỏi|đáp|kêu|thì thầm|quát|hét|lẩm bẩm|nói nhỏ|cười nói|trả lời|gọi|thét|lên tiếng|quát tháo|cất tiếng|mở miệng|cất giọng|la lên|hỏi han|gào|kêu gào|tiếp lời|nói tiếp|nói khẽ|khẽ nói|hỏi lại|hỏi thăm|bảo|đọc|kể|xướng|hát|hỏi rằng|nói rằng|nói với|nói thầm|phát biểu|giải thích|giảng giải|xung phong|reo lên|hét lên)';

  function findQuoteSpans(text: string): Array<{ start: number; end: number; content: string }> {
    const spans: Array<{ start: number; end: number; content: string }> = [];
    let i = 0;
    while (i < text.length) {
      if (!QUOTE_OPEN_RE.test(text[i])) { i++; continue; }
      const start = i;
      i++;
      while (i < text.length && !QUOTE_CLOSE_RE.test(text[i])) i++;
      if (i >= text.length) break;
      const end = i + 1;
      spans.push({ start, end, content: text.slice(start + 1, end - 1) });
      i = end;
    }
    return spans;
  }

  function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\' + '$&');
  }

  // ── Vietnamese pronoun → gender map (for Pass 5a pronoun resolution) ──
  // Mirror of VIENEU_GENDER in audiobook_generator.py — keep in sync.
  // Gender is inferred from the character's voice builtin name. Cloned
  // voices fall back to "unknown" (pronoun resolution skips them).
  const VOICE_GENDER: Record<string, 'female' | 'male' | 'unknown'> = {
    'Ngọc Linh': 'female', 'Ngọc Lan': 'female', 'Mỹ Duyên': 'female',
    'Trúc Ly': 'female',
    'Bình An': 'male', 'Gia Bảo': 'male', 'Đức Trí': 'male',
    'Thái Sơn': 'male', 'Trọng Hữu': 'male', 'Xuân Vĩnh': 'male',
  };

  /** Build canonical-name → gender map from ttsCharacterMap (name/alias → voice name). */
  function buildCharacterGenderMap(): Record<string, 'female' | 'male' | 'unknown'> {
    const out: Record<string, 'female' | 'male' | 'unknown'> = {};
    // ttsCharacterMap maps lowercase name/alias → voice display name. We need
    // canonical-name → gender, so for each entry we resolve the voice name's
    // gender. Since multiple aliases can point to the same voice, multiple
    // lowercase keys will resolve to the same gender. That is fine — pass 5a
    // walks the canonical form (lowercase) and looks it up here.
    for (const [name, voiceName] of Object.entries(ttsCharacterMap)) {
      if (out[name]) continue;  // already set
      const v = VOICE_GENDER[voiceName];
      out[name] = v ?? 'unknown';
    }
    return out;
  }

  /**
   * Pass 5a helper: PRONOUN RESOLUTION.
   * Walks the BEFORE window + a wider history window looking for Vietnamese
   * pronouns (Cô / Anh / Em / Chị / Ông / Bà) used as the subject of a
   * quote-introducing verb (SPEECH_VERB or SUBJECT_ACTION_VERBS). Returns the
   * canonical character name whose gender matches the pronoun.
   */
  function resolvePronounSubject(
    text: string,
    qStart: number,
    prevQuoteEnd: number,
    knownNames: string[],
  ): string | null {
    const PRONOUN_HISTORY_WINDOW = 400;
    const ATTR_NAME_TO_VERB_GAP_LOCAL = 70;
    const PRONOUNS_FEMALE = '(?:cô|chị|bà|em gái|con gái|nàng|nữ)';
    const PRONOUNS_MALE = '(?:anh|ông|chú|bác|em trai|con trai|chàng|nam)';

    const historyStart = Math.max(0, qStart - PRONOUN_HISTORY_WINDOW);
    const history = text.slice(historyStart, qStart);

    const genderByChar = buildCharacterGenderMap();
    // Build per-gender "most recent" canonical name by walking history. We
    // update on EACH occurrence so the final value is the most recent
    // same-gender character (right-most wins).
    const lastByGender: Record<string, string> = {};
    const namesAlt = [...knownNames].sort((a, b) => b.length - a.length).map(escapeRegex).join('|');
    const reName = new RegExp(`(?:^|[^\\p{L}])(${namesAlt})`, 'giu');
    for (const m of history.matchAll(reName)) {
      const matched = m[1];
      const idx = m.index! + m[0].indexOf(matched);
      // Object-marker filter (mirror Python pass): skip names used as object.
      const beforeName = history.slice(Math.max(0, idx - 12), idx);
      if (/\s(?:nhìn|thấy|gặp|với|của|cho|cùng|gọi|kể|về|bằng|từ|đến|giúp|trả|đưa|đối với|về phía|phía sau|bên cạnh|trước mặt)\s/i.test(beforeName)) continue;
      const gender = genderByChar[matched.toLowerCase()];
      if (gender === 'female' || gender === 'male') {
        lastByGender[gender] = matched;
      }
    }
    if (Object.keys(lastByGender).length === 0) return null;

    // Look for pronoun-as-subject in BEFORE window. The pronoun must be at
    // the start of a clause (preceded by punctuation, opening quote, or BOS)
    // so we don't confuse "anh trai" (noun phrase) with "Anh" (pronoun).
    const beforeStart = Math.max(prevQuoteEnd, qStart - 80);
    const before = text.slice(beforeStart, qStart);
    const NO_QUOTE_INNER_LOCAL = `[^"“”'「」『』]{0,${ATTR_NAME_TO_VERB_GAP_LOCAL}}`;
    // SUBJECT_ACTION_VERBS — only quote-introducing verbs (no physical actions
    // like đánh / vỗ / ôm — those describe the subject's action and the quote
    // is usually the OTHER character's response).
    const SUBJECT_ACTION_VERBS_LOCAL = '(?:gọi|hét|kêu|nói|hỏi|đáp|trả lời|thét|la|reo|than|giận|dỗi|hừ|hắng|hắng giọng|cười|cười khẽ|cười nói|mỉm cười|nhếch mép|quay phắt|quay đầu|ngoái đầu|ngoảnh đầu|ngoái lại|ngoảnh lại|nhéo|vặn|xoắn|bẻ|giật|kéo|lôi|cầm|nhặt|cúi|ngẩng|nghiêng|lắc|gật|vẫy|cất tiếng|mở miệng|tiếp lời|nói tiếp|nói rằng|khẽ nói|nói khẽ|thì thầm|thủ thỉ|thề|nguyền rủa|chửi|mắng|quát|quát tháo|gào|kêu gào|gào thét|hô|hô to|hô lớn)';

    const rePronounClause = new RegExp(
      `(?:^|(?<=[,。.!?:；。、…—\\-–"'“”]))`
      + `\\s*(?:${PRONOUNS_FEMALE}|${PRONOUNS_MALE})`
      + `\\s+([^,。.!?]{0,${ATTR_NAME_TO_VERB_GAP_LOCAL}}?)`
      + `(?:${SPEECH_VERBS}|${SUBJECT_ACTION_VERBS_LOCAL})`,
      'iu',
    );
    const m = rePronounClause.exec(before);
    if (!m) return null;

    // Determine pronoun gender: try female first (Cô/Chị/Bà/Em-gái are
    // unambiguous), then male. JS \b is ASCII-only even with the `u` flag
    // (Node treats ô/ư/ơ/ă/â/ê as non-word characters), so we use explicit
    // Unicode-aware boundaries via \p{L} (matches any letter, including
    // Vietnamese diacritics). A pronoun boundary = start of string, OR
    // not preceded by a letter, AND not followed by a letter.
    const pronounText = m[0];
    let gender: 'female' | 'male' | null = null;
    if (new RegExp(`(?:^|(?<!\\p{L}))(?:${PRONOUNS_FEMALE})(?!\\p{L})`, 'iu').test(pronounText)) {
      gender = 'female';
    } else if (new RegExp(`(?:^|(?<!\\p{L}))(?:${PRONOUNS_MALE})(?!\\p{L})`, 'iu').test(pronounText)) {
      gender = 'male';
    }
    if (gender === null) return null;

    return lastByGender[gender] ?? null;
  }

  /**
   * AFTER-window pronoun resolution. Mirror of resolvePronounSubject but
   * applied to the narration that comes AFTER the quote's close.
   * Vietnamese novels often attribute a quote to a pronoun that appears
   * AFTER the quote itself, when the speaker was implicit before:
   *   "Sai!" Anh không khách khí nắm tay cốc cho cô một cái
   *     → "Anh" (he) + nắm (grasp) → ACTION → speaker is the most-recent
   *       same-gender character in the history BEFORE the quote.
   *   "Con quỷ nghịch ngợm này …" Anh đánh nhẹ vào mông cô
   *     → "Anh" (he) + đánh (hit) → ACTION → male speaker.
   *
   * Gender is resolved from each character's voice builtin name (see
   * voiceGenderByName below). Keeps the speaker coherent with the
   * closest-name-wins history in the BEFORE window.
   */
  function resolveAfterPronounSubject(
    text: string,
    qStart: number,
    after: string,
    knownNames: string[],
  ): string | null {
    const PRONOUN_HISTORY_WINDOW = 400;
    const ATTR_NAME_TO_VERB_GAP_LOCAL = 70;
    const PRONOUNS_FEMALE = '(?:cô|chị|bà|em gái|con gái|nàng|nữ)';
    const PRONOUNS_MALE = '(?:anh|ông|chú|bác|em trai|con trai|chàng|nam)';

    // 1. Build per-gender "most recent" character from the BEFORE history.
    const historyStart = Math.max(0, qStart - PRONOUN_HISTORY_WINDOW);
    const history = text.slice(historyStart, qStart);
    const genderByChar = buildCharacterGenderMap();
    const lastByGender: Record<string, string> = {};
    const namesAlt = [...knownNames].sort((a, b) => b.length - a.length).map(escapeRegex).join('|');
    const reName = new RegExp(`(?:^|[^\\p{L}])(${namesAlt})`, 'giu');
    for (const m of history.matchAll(reName)) {
      const matched = m[1];
      const idx = m.index! + m[0].indexOf(matched);
      const beforeName = history.slice(Math.max(0, idx - 12), idx);
      if (/\s(?:nhìn|thấy|gặp|với|của|cho|cùng|gọi|kể|về|bằng|từ|đến|giúp|trả|đưa|đối với|về phía|phía sau|bên cạnh|trước mặt)\s/i.test(beforeName)) continue;
      const gender = genderByChar[matched.toLowerCase()];
      if (gender === 'female' || gender === 'male') {
        lastByGender[gender] = matched;
      }
    }
    if (Object.keys(lastByGender).length === 0) return null;

    // 2. Look for a PRONOUN + (action|speech) verb in the AFTER window.
    //    The verb set is broader than resolvePronounSubject's — physical
    //    actions like đánh / nắm / véo / thở dài are common here because
    //    the quote has just been spoken and the reaction follows.
    const SUBJECT_ACTION_VERBS_AFTER = '(?:gọi|hét|kêu|nói|hỏi|đáp|trả lời|thét|la|reo|than|giận|dỗi|hừ|hắng|hắng giọng|cười|cười khẽ|cười nói|mỉm cười|nhếch mép|quay phắt|quay đầu|ngoái đầu|ngoảnh đầu|ngoái lại|ngoảnh lại|nhéo|vặn|xoắn|bẻ|giật|kéo|lôi|cầm|nhặt|cúi|ngẩng|nghiêng|lắc|gật|vẫy|cất tiếng|mở miệng|tiếp lời|nói tiếp|nói rằng|khẽ nói|nói khẽ|thì thầm|thủ thỉ|thề|nguyền rủa|chửi|mắng|quát|quát tháo|gào|kêu gào|gào thét|hô|hô to|hô lớn|đánh|đấm|nắm|véo|vỗ|thở dài|thở ra|thở|nhíu|nhíu mày|lườm|liếc|trừng|ngước|xoa|sờ|vuốt)';
    const rePronoun = new RegExp(
      `^\\s*(?:${PRONOUNS_FEMALE}|${PRONOUNS_MALE})`
      + `\\s+([^,。.!?]{0,${ATTR_NAME_TO_VERB_GAP_LOCAL}}?)`
      + `(?:${SPEECH_VERBS}|${SUBJECT_ACTION_VERBS_AFTER})`,
      'iu',
    );
    const m = rePronoun.exec(after);
    if (!m) return null;

    // 3. Determine pronoun gender. \p{L} is required for Unicode boundary
    //    detection (Node's \b is ASCII-only, treating ô/ư/ơ/ă/â/ê as
    //    non-word characters).
    const pronounText = m[0];
    let gender: 'female' | 'male' | null = null;
    if (new RegExp(`(?:^|(?<!\\p{L}))(?:${PRONOUNS_FEMALE})(?!\\p{L})`, 'iu').test(pronounText)) {
      gender = 'female';
    } else if (new RegExp(`(?:^|(?<!\\p{L}))(?:${PRONOUNS_MALE})(?!\\p{L})`, 'iu').test(pronounText)) {
      gender = 'male';
    }
    if (gender === null) return null;

    return lastByGender[gender] ?? null;
  }

  /**
   * Pass 5b helper: NAME AS SUBJECT of a quote-introducing ACTION verb.
   * When the BEFORE window ends with a known name + SUBJECT_ACTION_VERB right
   * before the quote, attribute the quote to that name. Mirror of Python
   * _resolve_subject_action_speaker in audiobook_generator.py.
   */
  function resolveSubjectActionSpeaker(before: string, namesAlt: string): string | null {
    const ATTR_NAME_TO_VERB_GAP_LOCAL = 70;
    const SUBJECT_ACTION_VERBS_LOCAL = '(?:gọi|hét|kêu|nói|hỏi|đáp|trả lời|thét|la|reo|than|giận|dỗi|hừ|hắng|hắng giọng|cười|cười khẽ|cười nói|mỉm cười|nhếch mép|quay phắt|quay đầu|ngoái đầu|ngoảnh đầu|ngoái lại|ngoảnh lại|nhéo|vặn|xoắn|bẻ|giật|kéo|lôi|cầm|nhặt|cúi|ngẩng|nghiêng|lắc|gật|vẫy|cất tiếng|mở miệng|tiếp lời|nói tiếp|nói rằng|khẽ nói|nói khẽ|thì thầm|thủ thỉ|thề|nguyền rủa|chửi|mắng|quát|quát tháo|gào|kêu gào|gào thét|hô|hô to|hô lớn)';

    const reSubjectAction = new RegExp(
      `(?:^|[^\\p{L}])(${namesAlt})`
      + `([^A-Za-zÀ-ỹ"'“”'「」『』]`
      + `{0,${ATTR_NAME_TO_VERB_GAP_LOCAL}}?)`
      + `${SUBJECT_ACTION_VERBS_LOCAL}`,
      'giu',
    );
    const matches = [...before.matchAll(reSubjectAction)];
    if (matches.length === 0) return null;
    // Pick the LATEST name (closest to quote) — the introducing action is
    // typically the most recent one. Tie-break: longer name wins.
    let best = matches[0];
    for (const cand of matches) {
      const candStart = cand.index! + cand[0].indexOf(cand[1]);
      const bestStart = best.index! + best[0].indexOf(best[1]);
      if (candStart > bestStart || (candStart === bestStart && cand[1].length > best[1].length)) {
        best = cand;
      }
    }
    const name = best[1];
    // Object-marker filter
    const nameStart = best.index! + best[0].indexOf(name);
    const beforeName = before.slice(Math.max(0, nameStart - 12), nameStart);
    if (/\s(?:nhìn|thấy|gặp|với|của|cho|cùng|gọi|kể|về|bằng|từ|đến|giúp|trả|đưa|đối với|về phía|phía sau|bên cạnh|trước mặt)\s/i.test(beforeName)) {
      return null;
    }
    return name;
  }

  function findSpeakerForQuote(
    text: string, qStart: number, qEnd: number,
    knownNames: string[], prevQuoteEnd: number,
  ): string | null {
    // BEFORE window: when a previous quote exists in this paragraph, the
    // narrator context for THIS quote is the narration between the two
    // quotes — not just the last 80 chars (the speaker is often mentioned
    // at the start of that narration, e.g.
    //   "...Anh đánh nhẹ vào mông cô, "Sai!""
    //      → "Anh" is at the start of the gap, before the 80-char cutoff).
    // Use the full gap up to ATTR_WINDOW_BEFORE for multi-quote paragraphs.
    const isMultiQuote = prevQuoteEnd > 0;
    const beforeStart = isMultiQuote
      ? prevQuoteEnd
      : Math.max(0, qStart - 80);
    const before = text.slice(beforeStart, qStart);
    // AFTER window: 40 chars after this quote's close
    const afterEnd = Math.min(text.length, qEnd + 40);
    const after = text.slice(qEnd, afterEnd);

    // Build single alternation regex of all known names (longest first
    // so longer names take priority when matching at the same position)
    const namesAlt = [...knownNames].sort((a, b) => b.length - a.length).map(escapeRegex).join('|');
    // Allow up to 70 chars between name and speech verb (covers long narration)
    const NO_QUOTE_INNER = "[^\"“”'「」『』]{0,70}";

    // Object markers — Vietnamese verbs/prepositions that take a name as
    // their OBJECT (not subject). If a known name appears AFTER one of
    // these markers (within ~12 chars), it's the object of that verb, NOT
    // the speaker of the upcoming speech verb.
    // Examples:
    //   "Cậu bé gật đầu, nhìn La Dạ, rồi nói"  → La Dạ is OBJECT of "nhìn"
    //   "La Dạ cười nói"                          → La Dạ is SUBJECT (no marker)
    //   "nói chuyện với Chương"                    → Chương is OBJECT of "với"
    const OBJECT_MARKER_RE = /\s(?:nhìn|thấy|gặp|với|của|cho|cùng|gọi|kể|về|bằng|từ|đến|giúp|trả|đưa|đối với|về phía|phía sau|bên cạnh|trước mặt)\s/i;

    // ── BEFORE: CLOSEST-SPEAKER-WINS ──────────────────────────────────
    // Scan every name occurrence in BEFORE; for each, look for a speech
    // verb within ~70 chars AFTER it. Pick the (name, verb) pair with the
    // SMALLEST name-to-verb distance — i.e. the name closest to the speech
    // verb. This naturally handles "Long cùng Ưu Nhi bàn... Long nói:"
    // where the SECOND `Long` is the speaker, not Ưu Nhi.
    //
    // Filter out matches where the candidate name is an OBJECT of a
    // preceding verb (e.g. "Long nhìn Ưu Nhi" → Ưu Nhi is object, not speaker).
    const reName = new RegExp(`(?:^|[^\\p{L}])(${namesAlt})`, 'giu');
    const reVerb = new RegExp(`([^\\p{L}]${NO_QUOTE_INNER})(${SPEECH_VERBS})`, 'iu');
    let bestName: string | null = null;
    let bestDist = Infinity;
    for (const m of before.matchAll(reName)) {
      const matched = m[1];
      const nameStart = m.index + m[0].indexOf(matched);
      const nameEnd = nameStart + matched.length;
      // Object-marker filter: ~12 chars BEFORE the name must not end with
      // an object-marker verb (otherwise the name is being USED AS OBJECT).
      const beforeName = before.slice(Math.max(0, nameStart - 12), nameStart);
      if (OBJECT_MARKER_RE.test(beforeName)) continue;
      // Look for a speech verb within ~100 chars AFTER the name (70 gap +
      // some slack for the verb itself).
      const tail = before.slice(nameEnd, Math.min(before.length, nameEnd + 100));
      const mv = reVerb.exec(tail);
      if (!mv) continue;
      const dist = matched.length + mv[1].length;  // name + gap chars
      if (dist < bestDist) {
        bestDist = dist;
        bestName = matched;
      }
    }
    if (bestName !== null) return bestName.toLowerCase();

    // AFTER (with verb): punctuation + name + (gap) + speech/action verb.
    // SUBJECT_ACTION_VERBS is included because narration after a quote often
    // uses action verbs rather than speech verbs, e.g.
    //   "...một tiếng?" Anh đánh nhẹ vào mông cô ra vẻ khiển trách.
    // The "action" verbs (đánh, nắm, hừ, thở dài …) carry the speaker.
    const SUBJECT_ACTION_VERBS_FOR_AFTER = '(?:gọi|hét|kêu|nói|hỏi|đáp|trả lời|thét|la|reo|than|giận|dỗi|hừ|hắng|hắng giọng|cười|cười khẽ|cười nói|mỉm cười|nhếch mép|quay phắt|quay đầu|ngoái đầu|ngoảnh đầu|ngoái lại|ngoảnh lại|nhéo|vặn|xoắn|bẻ|giật|kéo|lôi|cầm|nhặt|cúi|ngẩng|nghiêng|lắc|gật|vẫy|cất tiếng|mở miệng|tiếp lời|nói tiếp|nói rằng|khẽ nói|nói khẽ|thì thầm|thủ thỉ|thề|nguyền rủa|chửi|mắng|quát|quát tháo|gào|kêu gào|gào thét|hô|hô to|hô lớn|đánh|đấm|nắm|véo|thở dài|thở ra|thở|nhíu|nhíu mày|lườm|liếc|trừng|ngước|cúi)';
    const reAfter = new RegExp(
      `(^|[\\s—\\-–:：,，])(${namesAlt})([^\\p{L}]${NO_QUOTE_INNER})(?:${SPEECH_VERBS}|${SUBJECT_ACTION_VERBS_FOR_AFTER})`,
      'iu',
    );
    const mAfter = reAfter.exec(after);
    if (mAfter) return mAfter[2].toLowerCase();

    // AFTER (dash attribution): em-dash + Name (alone)
    const reDash = new RegExp(
      `^\\s*[—\\-–]\\s*(${namesAlt})\\s*[.,!?:：]?\\s*$`,
      'iu',
    );
    const mDash = reDash.exec(after);
    if (mDash) return mDash[1].toLowerCase();

    // ── Pass 5a (AFTER): PRONOUN-AS-SUBJECT IN AFTER WINDOW ──────────
    // When the quote is followed by a pronoun + verb (e.g.
    //   "Sai!" Anh không khách khí nắm tay cốc cho cô một cái
    //     → Anh (he) + nắm → ACTION → speaker is the most-recent male
    //       character in the history BEFORE the quote.
    //   "Con quỷ nghịch ngợm này …" Anh đánh nhẹ vào mông cô
    //     → Anh (he) + đánh → ACTION → male speaker.
    // The AFTER pronoun pass uses the same history-walked gender
    // resolution as the BEFORE pronoun pass — keeps speakers coherent
    // with the closest-name-wins history.
    const afterPronounResolved = resolveAfterPronounSubject(
      text, qStart, after, knownNames,
    );
    if (afterPronounResolved !== null) return afterPronounResolved.toLowerCase();

    // ── Pass 5a (BEFORE): PRONOUN-AS-SUBJECT IN BEFORE WINDOW ─────────
    // Vietnamese narration frequently uses pronouns (Cô / Anh / Em / Chị /
    // Ông / Bà …) as the subject of a quote-introducing verb:
    //   "Cô vui vẻ gọi một tiếng, ôm lấy thắt lưng anh trai, "Anh hư quá đi …""
    //     → Cô (she) + gọi (call) → SPEECH_VERB → speaker is female
    //   "Anh không khách khí nắm tay cốc cho cô một cái, "Sai!""
    //     → Anh (he) + cốc → ACTION → speaker is male
    //
    // We resolve pronouns to the most-recently-mentioned same-gender character.
    // Gender is inferred from the character's voice builtin name (see
    // voiceGenderByName below). Mirror of Python _resolve_pronoun_subject in
    // audiobook_generator.py — keep in sync.
    const genderResolved = resolvePronounSubject(
      text, qStart, prevQuoteEnd, knownNames,
    );
    if (genderResolved !== null) return genderResolved.toLowerCase();

    // ── Pass 5b: NAME AS SUBJECT of a quote-introducing ACTION verb ──
    // When the BEFORE window ends with a known name + SUBJECT_ACTION_VERB
    // (no SPEECH_VERB needed) and a quote follows, the name is the speaker.
    // Catches patterns where narration introduces dialogue via an action:
    //   "Y Đằng Ưu Nhi quay phắt đầu lại, "Long......""
    //   "Y Đằng Ưu Nhi hừ một tiếng, …, "Còn nói nữa!""
    //   "Ưu Nhi nhéo cái nơ hoàn mỹ của Y Đằng Long, …, "Nói! Mấy ngày nay anh …""
    const actionSubject = resolveSubjectActionSpeaker(before, namesAlt);
    if (actionSubject !== null) return actionSubject.toLowerCase();
    // When no SPEECH_VERBS match, look further back (~500 chars) for a
    // thought verb ("X cảm thán / nghĩ / thì thầm …") or a reactive
    // action ("X nháy mắt / vỗ vai / ghé tai …"). Attribute the upcoming
    // quote to the SUBJECT of that verb (the thinker / doer).
    //
    // Example: "...Ngay cả Y Đằng Long ... cũng không thể không âm thầm
    //   cảm thán: Tiểu Ưu Nhi thật sự trưởng thành rồi!"
    //   "Quỷ nghịch ngợm!"     ← Long to his sister, NOT Ưu Nhi
    //
    // Mirror of the Python `find_speaker_for_quote` bare-exclamation pass
    // in audiobook_generator.py — keep both in sync.
    const ATTR_THOUGHT_WINDOW_BEFORE = 500;
    const thoughtStart = Math.max(prevQuoteEnd, qStart - ATTR_THOUGHT_WINDOW_BEFORE);
    const wideBefore = text.slice(thoughtStart, qStart);

    // Real thought verbs only. Bare modifiers like "âm thầm", "thầm",
    // "trong lòng" are deliberately EXCLUDED — they almost always appear
    // before a real verb ("âm thầm cảm thán") and should be absorbed into
    // the gap so the regex matches the actual predicate.
    const THOUGHT_VERBS = '(?:cảm thán|thầm nghĩ|nghĩ thầm|thì thầm|lẩm bẩm|tự nhủ|thầm nhủ|nói thầm|bình phẩm|đánh giá|cảm nhận|hy vọng|thắc mắc|lo lắng|băn khoăn|suy nghĩ|tự hỏi|nghĩ tới|nghĩ đến|tưởng nhớ|nhớ ra|thở dài|thở ra|than thở|than rằng|tự trách)';
    const REACTIVE_ACTIONS = '(?:mỉm cười|nháy mắt|chớp mắt|vỗ vai|vỗ lưng|ôm|ghé tai|nắm tay|kéo tay|vuốt tóc|xoa đầu|gõ nhẹ|vẫy tay|giơ tay|chỉ vào|liếc nhìn|nhìn trộm)';
    const THOUGHT_NO_QUOTE = `[^"“”'「」『』]{0,120}`;

    const reThought = new RegExp(
      `(?:^|[^\\p{L}])(${namesAlt})([^\\p{L}]${THOUGHT_NO_QUOTE}?)${THOUGHT_VERBS}`,
      'giu',
    );
    const reReactive = new RegExp(
      `(?:^|[^\\p{L}])(${namesAlt})([^\\p{L}]${NO_QUOTE_INNER}?)${REACTIVE_ACTIONS}`,
      'giu',
    );

    // Prefer the match whose subject (Name) is closest to the END of the
    // BEFORE window — the most recently expressed thought wins.
    const thoughtMatches = [...wideBefore.matchAll(reThought)];
    if (thoughtMatches.length > 0) {
      const best = thoughtMatches.reduce((a, b) => (a.index! > b.index! ? a : b));
      const matched = best[1];
      const nameStart = best.index! + best[0].indexOf(matched);
      const beforeName = wideBefore.slice(Math.max(0, nameStart - 12), nameStart);
      if (!OBJECT_MARKER_RE.test(beforeName)) {
        return matched.toLowerCase();
      }
      // If the closest thinker is an object, fall through to the
      // earlier-name scan which may still find a valid thinker.
    }

    const reactiveMatches = [...wideBefore.matchAll(reReactive)];
    if (reactiveMatches.length > 0) {
      const best = reactiveMatches.reduce((a, b) => (a.index! > b.index! ? a : b));
      const matched = best[1];
      const nameStart = best.index! + best[0].indexOf(matched);
      const beforeName = wideBefore.slice(Math.max(0, nameStart - 12), nameStart);
      if (!OBJECT_MARKER_RE.test(beforeName)) {
        return matched.toLowerCase();
      }
    }

    return null;
  }

  /** Try to detect which character is "speaking" in a paragraph.
   *  Returns the voice name to use, or undefined for the default.
   *  Strict: only attributed dialogue (name + speech verb inside the
   *  quote's attribution window) is considered. Narration that mentions
   *  a character does NOT trigger that character's voice.
   *
   *  Tiered attribution:
   *    1. Server-side parser/regex attribution map (VnCoreNLP Tier 3b +
   *       regex fallback) — keyed by paragraph index, loaded once per
   *       chapter via loadChapterAttribution().
   *    2. Local 6-pass regex (findSpeakerForQuote) — used when the map has
   *       no entry for this paragraph OR when the user has toggled the
   *       parser off. */
  function detectSpeaker(
    text: string,
    paragraphIndex?: number,
  ): { name?: string; voiceName?: string; source?: 'parser' | 'regex' | 'llm' | 'conversation' } {
    if (!ttsUseCharacterVoice) return {};
    const quotes = findQuoteSpans(text);
    if (quotes.length === 0) return {};

    // ── Tier 1: server-side attribution map ───────────────────────────
    // Only used when we know our paragraph index AND the map is loaded for
    // the current chapter. The map's source can be 'parser' (VnCoreNLP),
    // 'regex' (the server's own regex fallback), or 'parser' with
    // speaker=null (low-confidence flag — fall through to local regex).
    const currentChapter = chapters[currentIdx];
    if (paragraphIndex !== undefined && currentChapter) {
      const mapEntry = chapterAttributionRef.current.get(currentChapter.id);
      if (mapEntry) {
        const attr = mapEntry.attribution[paragraphIndex];
        if (attr?.speaker) {
          const voiceName = ttsCharacterMap[attr.speaker.toLowerCase()];
          if (voiceName) {
            return { name: attr.speaker, voiceName, source: attr.source as 'parser' | 'regex' | 'llm' | 'conversation' };
          }
        }
      }
    }

    // Sort longest-first so "Chương Thái Cực" beats "Chương" at same position
    const knownNames = Object.keys(ttsCharacterMap).sort((a, b) => b.length - a.length);
    // Walk quotes last → first. The BEFORE window is bounded by the previous
    // quote's close-quote so we don't pick up an earlier quote's attribution.
    for (let i = quotes.length - 1; i >= 0; i--) {
      const q = quotes[i];
      const prevQuoteEnd = i - 1 >= 0 ? quotes[i - 1].end : 0;
      const speaker = findSpeakerForQuote(text, q.start, q.end, knownNames, prevQuoteEnd);
      if (speaker) {
        return { name: speaker, voiceName: ttsCharacterMap[speaker], source: 'regex' };
      }
    }
    return {};
  }

    // ── TTS prefetch helpers ───────────────────────────────────────────────
  // Audio is fetched lazily per paragraph. To eliminate the visible gap
  // between paragraphs (caused by fetch latency ~1-2s on slow local models),
  // we kick off prefetches for the NEXT paragraphs as soon as the current
  // one starts playing. By the time the current paragraph ends, the next
  // blob is usually already in the cache → instant playback.

  /** Key for the prefetch cache — character voice affects the result. */
  function prefetchKey(chapterId: string, idx: number, character?: string): string {
    return `${chapterId}::${idx}::${character ?? '_'}`;
  }

  /**
   * Start (or return cached) a TTS fetch for a paragraph.
   * Same request is deduped so calling this N times for the same paragraph
   * only triggers 1 network call.
   */
  function prefetchParagraph(
    chapterId: string,
    paragraphs: string[],
    idx: number,
    speed: number,
    character?: string,
    emotion = 'neutral',
    expressiveness = ttsNoise,
  ): Promise<Blob> {
    // Stable dedup key — include speed/voice so different settings don't collide.
    const key = `${idx}::${character ?? '_'}::${speed.toFixed(2)}::${ttsVoice}::${emotion}::${expressiveness.toFixed(2)}`;
    let chapterMap = prefetchCacheRef.current.get(chapterId);
    if (!chapterMap) {
      chapterMap = new Map();
      prefetchCacheRef.current.set(chapterId, chapterMap);
    }
    const existing = chapterMap.get(key) as Promise<Blob> | undefined;
    if (existing) return existing;

    const promise = (async () => {
      const resp = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: paragraphs[idx],
          speed,
          bookId,
          character,
          voice: ttsVoice,
          language: 'vi',
          emotion,
          expressiveness,
          callIdx: idx,
        }),
      });
      if (!resp.ok) throw new Error(`TTS failed: ${resp.status}`);
      return resp.blob();
    })().catch((err) => {
      // Remove failed entry so we can retry
      chapterMap!.delete(key);
      throw err;
    });
    chapterMap.set(key, promise);
    return promise;
  }

  /** Load + cache paragraphs for a chapter (HTML → paragraph text array). */
  async function getChapterParagraphs(chapterId: string): Promise<string[]> {
    const cached = chapterParagraphsRef.current.get(chapterId);
    if (cached) return cached;
    const resp = await fetch(`/api/library/${bookId}/chapters/${chapterId}?raw=1`);
    const { html } = await resp.json() as { html: string };
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    // Extract text from <p>, <h1-h6>, <li> — anything with readable text
    const blocks: string[] = [];
    doc.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, blockquote').forEach((el) => {
      const text = (el.textContent ?? '').trim();
      if (text.length > 0) blocks.push(text);
    });
    if (blocks.length === 0) {
      // Fallback: extract all body text
      const fallback = (doc.body.textContent ?? '').trim();
      if (fallback) blocks.push(fallback);
    }
    chapterParagraphsRef.current.set(chapterId, blocks);
    return blocks;
  }

  /**
   * Pre-generate ALL audio for a chapter in the background. Fires all
   * fetches in parallel (limited by the TTS server's own concurrency) and
   * populates the prefetch cache so the next chapter is ready to play
   * seamlessly when continuous-play reaches it.
   */
  async function pregenerateChapter(chapterIdx: number): Promise<void> {
    const ch = chapters[chapterIdx];
    if (!ch) return;
    // Skip if already pre-generated (cache already has entries for this chapter)
    const existingMap = prefetchCacheRef.current.get(ch.id);
    if (existingMap && existingMap.size > 0) return;

    const paragraphs = await getChapterParagraphs(ch.id);
    if (paragraphs.length === 0) return;

    // Load server-side attribution (parser + regex + LLM) so detectSpeaker()
    // can pick VnCoreNLP's answer over the local regex when both are
    // available. Fire-and-forget — pregenerate doesn't block on it.
    void loadChapterAttribution(ch.id);

    // Sequential prefetch with small concurrency so we don't hammer the
    // OMLX/VieNeu backend (single-threaded on Apple Silicon anyway).
    const CONCURRENCY = 2;
    setPregenStatus({ chapterId: ch.id, done: 0, total: paragraphs.length });

    let done = 0;

    for (let i = 0; i < paragraphs.length; i += CONCURRENCY) {
      // User pressed Stop — abandon the background pre-generation.
      // The next time pregen is triggered, this will start fresh.
      if (ttsAbortRef.current) break;
      const batch = paragraphs.slice(i, i + CONCURRENCY);
      await Promise.allSettled(
        batch.map((_, j) => {
          const idx = i + j;
          const sp = detectSpeaker(paragraphs[idx], idx);
          const emo = ttsUseAI
            ? detectEmotion(paragraphs[idx], ttsSpeed, ttsNoise)
            : { speed: ttsSpeed, noiseScale: ttsNoise, label: '', emoji: '', emotion: 'neutral' };
          return prefetchParagraph(ch.id, paragraphs, idx, emo.speed, sp.name, emo.emotion, emo.noiseScale)
            .then(() => { done++; setPregenStatus({ chapterId: ch.id, done, total: paragraphs.length }); })
            .catch(() => { /* already removed from cache; will retry on play */ });
        }),
      );
    }
    setPregenStatus(null);
  }

  /**
   * Speak a paragraph using the prefetch cache. If the blob is already in
   * the cache (prefetch finished), playback starts instantly — no fetch
   * latency in the gap. While playing, prefetches the next 3 paragraphs.
   */
  async function speakParagraph(
    chapterId: string,
    paragraphs: string[],
    idx: number,
    speed: number,
    character?: string,
    emotion = 'neutral',
    expressiveness = ttsNoise,
  ): Promise<void> {
    // Eagerly prefetch the next paragraphs so the audio is ready when the
    // current one ends. With a slow TTS backend (~15-20s per call on
    // Apple Silicon) we need a deep lookahead — 5 paragraphs ≈ 10s of
    // buffered audio (each para is ~2s). Server handles them in its own
    // queue (CONCURRENCY=2 in pregenerateChapter for pre-chapter; for
    // same-chapter prefetch we just throw all at the wall — OMLX/VieNeu
    // queue them automatically).
    for (let j = 1; j <= 5; j++) {
      const nextIdx = idx + j;
      if (nextIdx < paragraphs.length) {
        const nextSp = detectSpeaker(paragraphs[nextIdx]);
        const nextEmo = ttsUseAI
          ? detectEmotion(paragraphs[nextIdx], ttsSpeed, ttsNoise)
          : { speed: ttsSpeed, noiseScale: ttsNoise, label: '', emoji: '', emotion: 'neutral' };
        prefetchParagraph(chapterId, paragraphs, nextIdx, nextEmo.speed, nextSp.name, nextEmo.emotion, nextEmo.noiseScale).catch(() => {});
      }
    }

    const blob = await prefetchParagraph(chapterId, paragraphs, idx, speed, character, emotion, expressiveness);
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = audio;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        ttsAudioFinishRef.current = null;
        if (audioRef.current === audio) audioRef.current = null;
        URL.revokeObjectURL(url);
        if (ttsParagraphGap > 0 && !ttsAbortRef.current) {
          setTimeout(resolve, ttsParagraphGap);
        } else {
          resolve();
        }
      };
      ttsAudioFinishRef.current = finish;
      audio.onended = finish;
      audio.onerror = finish;
      audio.play().catch(finish);
    });
  }

  function finishCurrentTtsAudio() {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }
    audioRef.current = null;
    ttsAudioFinishRef.current?.();
  }

  async function startTts(fromIndex = 0) {
    const runId = ++ttsRunIdRef.current;
    // Use the ref so we always pick up the chapter at the moment we run,
    // even if currentIdx changed (auto-advance) between calls.
    const myChapter = currentChapterRef.current;
    if (!myChapter) return;
    const myChapterIdx = chapters.findIndex((c) => c.id === myChapter.id);
    if (myChapterIdx < 0) return;

    ttsAbortRef.current = false;
    ttsStateRef.current = 'loading';
    setTtsState('loading');
    // Cancel any voice-preview still playing so it doesn't overlap
    if (voicePreviewAudioRef.current) {
      voicePreviewAudioRef.current.pause();
      voicePreviewAudioRef.current = null;
      setPreviewingVoice(null);
    }

    // Load current chapter's paragraphs (from cache if we have them)
    let paras = chapterParagraphsRef.current.get(myChapter.id);
    if (!paras) {
      paras = await getChapterParagraphs(myChapter.id);
    }
    setTtsParagraphs(paras);
    if (ttsRunIdRef.current !== runId || ttsAbortRef.current) return;
    if (paras.length === 0) {
      ttsStateRef.current = 'idle';
      setTtsState('idle');
      return;
    }

    // ── Background pre-generation of NEXT chapter ─────────────────────
    // If continuous-play is on AND there's a next chapter, kick off
    // pre-fetching all its paragraphs in the background so when this
    // chapter ends the next one plays seamlessly (zero fetch latency).
    if (ttsContinuousPlay && myChapterIdx + 1 < chapters.length) {
      void pregenerateChapter(myChapterIdx + 1);  // fire-and-forget
    }

    ttsStateRef.current = 'playing';
    setTtsState('playing');
    for (let i = fromIndex; i < paras.length; i++) {
      if (ttsAbortRef.current || ttsRunIdRef.current !== runId) break;
      setTtsIndex(i);
      // Wait while paused
      await new Promise<void>((res) => {
        const check = () => {
          if (ttsAbortRef.current || ttsRunIdRef.current !== runId) { res(); return; }
          // If paused, poll until unpaused or stopped
          if (audioRef.current?.paused && ttsStateRef.current !== 'playing') {
            setTimeout(check, 100);
          } else {
            res();
          }
        };
        res(); // proceed immediately — audio element handles pause internally
      });
      if (ttsAbortRef.current || ttsRunIdRef.current !== runId) break;

      // Detect who's speaking in this paragraph (for voice auto-switching)
      const sp = detectSpeaker(paras[i], i);
      setTtsCurrentSpeaker(sp.name ?? null);

      // Apply emotion adjustment (heuristic or neutral)
      const emo = ttsUseAI ? detectEmotion(paras[i], ttsSpeed, ttsNoise) : { speed: ttsSpeed, noiseScale: ttsNoise, label: '', emoji: '', emotion: 'neutral' };
      const emotionSuffix = emo.label ? ` · ${emo.emoji} ${emo.label}` : '';
      const speakerSuffix = sp.name ? ` · ${sp.name}` : '';
      setTtsEmotionLabel(`${speakerSuffix}${emotionSuffix}`);

      await speakParagraph(myChapter.id, paras, i, emo.speed, sp.name, emo.emotion, emo.noiseScale);
      if (ttsAbortRef.current || ttsRunIdRef.current !== runId) break;
    }

    if (ttsAbortRef.current || ttsRunIdRef.current !== runId) {
      // User stopped — nothing to do
      return;
    }

    // ── Chapter finished ──────────────────────────────────────────
    // If continuous-play is enabled AND there's a next chapter, advance.
    // Otherwise, just go idle (user can manually go to next chapter).
    if (ttsContinuousPlay && myChapterIdx + 1 < chapters.length) {
      // Mark this as an auto-advance so the chapter-change useEffect
      // doesn't call stopTts() and tear down our state.
      ttsIsAdvancingRef.current = true;
      // Trigger iframe nav + state update via goToChapter (this sets currentIdx)
      // Note: goToChapter calls saveProgress too.
      goToChapter(myChapterIdx + 1);
      // Wait briefly for React to re-render with the new currentIdx (the
      // chapter-change useEffect will see ttsIsAdvancingRef and skip stopTts),
      // then kick off the next startTts. The ref auto-updates to the new
      // chapter so the recursive call will read it correctly.
      setTimeout(() => {
        if (!ttsAbortRef.current && ttsRunIdRef.current === runId) {
          void startTts(0);
        }
      }, 600);
      return;
    }

    // End of book or continuous-play off
    ttsStateRef.current = 'idle';
    setTtsState('idle');
    setTtsIndex(0);
    setTtsCurrentSpeaker(null);
  }

  function stopTts() {
    ttsRunIdRef.current += 1;
    ttsAbortRef.current = true;
    finishCurrentTtsAudio();
    ttsStateRef.current = 'idle';
    setTtsState('idle');
    setTtsIndex(0);
    setTtsParagraphs([]);
    setTtsEmotionLabel('');
    // Cancel any in-flight pre-generation (it polls ttsAbortRef between batches)
    setPregenStatus(null);
  }

  function toggleTtsPause() {
    const currentState = ttsStateRef.current;
    if (currentState === 'playing') {
      audioRef.current?.pause();
      ttsStateRef.current = 'paused';
      setTtsState('paused');
    } else if (currentState === 'paused') {
      audioRef.current?.play().catch(() => {});
      ttsStateRef.current = 'playing';
      setTtsState('playing');
    }
  }

  function restartTtsAt(index: number) {
    const ch = currentChapterRef.current;
    if (!ch) return;
    const cached = chapterParagraphsRef.current.get(ch.id);
    const total = ttsParagraphs.length || cached?.length || 0;
    const target = Math.max(0, total > 0 ? Math.min(index, total - 1) : index);
    ttsRunIdRef.current += 1;
    const resumeRunId = ttsRunIdRef.current;
    ttsAbortRef.current = true;
    finishCurrentTtsAudio();
    ttsStateRef.current = 'loading';
    setTtsState('loading');
    setTimeout(() => {
      if (ttsRunIdRef.current === resumeRunId && currentChapterRef.current?.id === ch.id) void startTts(target);
    }, 100);
  }

  function skipTtsParagraph(delta: number) {
    const ch = currentChapterRef.current;
    if (!ch) return;
    const cached = chapterParagraphsRef.current.get(ch.id);
    const total = ttsParagraphs.length || cached?.length || 0;
    if (total === 0) return;
    const target = ttsIndex + delta;
    if (target < 0) {
      setVoiceCommandText('Đang ở đầu chương');
      return;
    }
    if (target >= total) {
      changeChapterByVoice(1, true);
      return;
    }
    restartTtsAt(target);
  }

  function changeChapterByVoice(delta: number, resumeTts = ttsStateRef.current !== 'idle') {
    const target = Math.max(0, Math.min(chapters.length - 1, currentIdx + delta));
    if (target === currentIdx) return;
    let resumeRunId = 0;
    if (resumeTts) {
      ttsRunIdRef.current += 1;
      resumeRunId = ttsRunIdRef.current;
      ttsAbortRef.current = true;
      finishCurrentTtsAudio();
      ttsIsAdvancingRef.current = true;
    }
    goToChapter(target);
    if (resumeTts) {
      ttsStateRef.current = 'loading';
      setTtsState('loading');
      setTimeout(() => {
        if (ttsRunIdRef.current === resumeRunId) void startTts(0);
      }, 650);
    }
  }

  function normalizeVoiceCommand(text: string): string {
    return text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/g, 'd')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function commandIncludes(command: string, phrases: string[]): boolean {
    return phrases.some((phrase) => command.includes(phrase));
  }

  function handleVoiceCommand(transcript: string) {
    const raw = transcript.trim();
    const command = normalizeVoiceCommand(raw);
    if (!command) return;

    const feedback = (label: string) => setVoiceCommandText(`${raw} -> ${label}`);

    if (commandIncludes(command, ['tat nghe lenh', 'tat micro', 'stop listening'])) {
      stopVoiceControl();
      feedback('Tắt nghe lệnh');
      return;
    }
    if (commandIncludes(command, ['dung lai', 'ngung doc', 'dung doc', 'thoi doc', 'stop'])) {
      stopTts();
      feedback('Dừng đọc');
      return;
    }
    if (commandIncludes(command, ['tam dung', 'pause', 'cho nghi'])) {
      if (ttsStateRef.current === 'playing') toggleTtsPause();
      feedback('Tạm dừng');
      return;
    }
    if (commandIncludes(command, ['tiep tuc', 'doc tiep', 'bat dau doc', 'doc di', 'play', 'resume', 'start reading'])) {
      if (ttsStateRef.current === 'paused') toggleTtsPause();
      else if (ttsStateRef.current === 'idle') {
        void loadTtsContext();
        setTtsSettingsOpen(false);
        void startTts(0);
      }
      feedback('Tiếp tục đọc');
      return;
    }
    if (commandIncludes(command, ['doan sau', 'doan tiep', 'cau sau', 'next paragraph'])) {
      if (ttsStateRef.current !== 'idle') skipTtsParagraph(1);
      feedback('Đoạn sau');
      return;
    }
    if (commandIncludes(command, ['doan truoc', 'cau truoc', 'previous paragraph'])) {
      if (ttsStateRef.current !== 'idle') skipTtsParagraph(-1);
      feedback('Đoạn trước');
      return;
    }
    if (commandIncludes(command, ['chuong sau', 'chuong tiep', 'next chapter'])) {
      changeChapterByVoice(1);
      feedback('Chương sau');
      return;
    }
    if (commandIncludes(command, ['chuong truoc', 'previous chapter'])) {
      changeChapterByVoice(-1);
      feedback('Chương trước');
      return;
    }
    if (commandIncludes(command, ['trang sau', 'next page'])) {
      handleNext();
      feedback('Trang sau');
      return;
    }
    if (commandIncludes(command, ['trang truoc', 'previous page', 'back page'])) {
      handlePrev();
      feedback('Trang trước');
      return;
    }
    if (commandIncludes(command, ['nhanh hon', 'tang toc', 'faster'])) {
      setTtsSpeed((v) => Math.min(2.5, Math.round((v + 0.1) * 100) / 100));
      feedback('Tăng tốc');
      return;
    }
    if (commandIncludes(command, ['cham hon', 'giam toc', 'slower'])) {
      setTtsSpeed((v) => Math.max(0.5, Math.round((v - 0.1) * 100) / 100));
      feedback('Giảm tốc');
      return;
    }
    if (commandIncludes(command, ['toc do binh thuong', 'normal speed'])) {
      setTtsSpeed(1);
      feedback('Tốc độ thường');
      return;
    }
    if (commandIncludes(command, ['danh dau', 'bookmark'])) {
      toggleBookmark();
      feedback('Đánh dấu');
      return;
    }

    setVoiceCommandText(`${raw} -> không nhận ra lệnh`);
  }

  function startVoiceControl() {
    const Recognition = getSpeechRecognitionCtor();
    if (!Recognition) {
      setVoiceCommandError('Trình duyệt không hỗ trợ nhận lệnh giọng nói');
      setVoiceControlSupported(false);
      return;
    }
    const recognition = new Recognition();
    recognition.lang = 'vi-VN';
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result?.isFinal && result[0]?.transcript) {
          voiceCommandHandlerRef.current(result[0].transcript);
        }
      }
    };
    recognition.onerror = (event) => {
      const blocked = event.error === 'not-allowed' || event.error === 'service-not-allowed';
      setVoiceCommandError(blocked ? 'Micro bị chặn quyền truy cập' : `Lỗi nghe lệnh: ${event.error}`);
      if (blocked) stopVoiceControl();
    };
    recognition.onend = () => {
      if (!voiceControlOnRef.current) return;
      setTimeout(() => {
        try { recognition.start(); } catch { /* already running */ }
      }, 250);
    };

    speechRecognitionRef.current?.abort();
    speechRecognitionRef.current = recognition;
    voiceControlOnRef.current = true;
    setVoiceControlOn(true);
    setVoiceCommandError('');
    try {
      recognition.start();
    } catch (e) {
      voiceControlOnRef.current = false;
      setVoiceControlOn(false);
      setVoiceCommandError(e instanceof Error ? e.message : 'Không thể bật micro');
    }
  }

  function stopVoiceControl() {
    voiceControlOnRef.current = false;
    setVoiceControlOn(false);
    const recognition = speechRecognitionRef.current;
    if (recognition) {
      recognition.onend = null;
      try { recognition.stop(); } catch { recognition.abort(); }
    }
    speechRecognitionRef.current = null;
  }

  function toggleVoiceControl() {
    if (voiceControlOnRef.current) stopVoiceControl();
    else startVoiceControl();
  }

  // ── Default-voice preview ─────────────────────────────────────────────
  // Plays a short sample in the selected VieNeu built-in voice so users can
  // hear what each voice sounds like and pick the right default.
  async function previewDefaultVoice(voiceName: string) {
    // Stop any other preview first
    if (voicePreviewAudioRef.current) {
      voicePreviewAudioRef.current.pause();
      voicePreviewAudioRef.current = null;
    }
    setPreviewingVoice(voiceName);
    try {
      const r = await fetch('/api/tts/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          voice: voiceName,
          text: `Xin chào, mình là ${voiceName}.`,
          language: 'vi',
          speed: 1.0,
        }),
      });
      if (!r.ok) {
        const detail = await r.json().catch(() => ({}));
        throw new Error(detail.error ?? `HTTP ${r.status}`);
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      voicePreviewAudioRef.current = audio;
      audio.onended = () => { URL.revokeObjectURL(url); setPreviewingVoice(null); voicePreviewAudioRef.current = null; };
      audio.onerror = () => { URL.revokeObjectURL(url); setPreviewingVoice(null); voicePreviewAudioRef.current = null; };
      await audio.play();
    } catch (e) {
      console.warn('[tts preview]', e);
      setPreviewingVoice(null);
    }
  }

  function stopVoicePreview() {
    if (voicePreviewAudioRef.current) {
      voicePreviewAudioRef.current.pause();
      voicePreviewAudioRef.current = null;
    }
    setPreviewingVoice(null);
  }

  // Reset TTS when chapter changes
  useEffect(() => {
    // If the chapter change is from auto-advance, don't kill TTS — the new
    // startTts() call (queued by continuous-play) will load the new
    // chapter's paragraphs and continue.
    if (ttsIsAdvancingRef.current) {
      ttsIsAdvancingRef.current = false;
      return;
    }
    stopTts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentIdx]);

  // Load available voices + character map (re-run when chapter changes so
  // different books can have different voice assignments)
  useEffect(() => { void loadTtsContext(); }, [bookId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Per-chapter character detection (background, automatic) ────────────
  // Trigger detection for the CURRENT chapter when it changes (to fill in any
  // characters missed by the initial book-wide detection).
  useEffect(() => {
    const ch = chapters[currentIdx];
    if (!ch) return;
    void detectChapterCharacters(ch.id, { silent: true });
    // Fetch VnCoreNLP / regex / LLM attribution map for the current chapter
    // so detectSpeaker() can use parser-resolved speakers on first play.
    void loadChapterAttribution(ch.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentIdx, bookId]);

  // Trigger detection for the NEXT chapter in the background while the user
  // is reading the current one. This way, by the time auto-advance reaches
  // the next chapter, its voices are already assigned.
  useEffect(() => {
    const nextCh = chapters[currentIdx + 1];
    if (!nextCh) return;
    // Run after a delay so we don't fire detection immediately on chapter load
    // (the current chapter detection above is already running)
    const timer = setTimeout(() => {
      void detectChapterCharacters(nextCh.id, { silent: true });
    }, 8000);  // 8s — gives current-chapter detection time to finish
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentIdx, bookId]);

  const isBookmarked  = bookmarks.includes(currentIdx);
  const current       = chapters[currentIdx];
  const themeObj      = THEMES.find((t) => t.id === settings.theme) ?? THEMES[0];
  const isDark        = settings.theme === 'dark';
  const isSepia       = settings.theme === 'sepia';
  const accentColor   = isDark ? '#7070cc' : isSepia ? '#a07840' : '#3b82f6';

  const chapterSrc = current
    ? `/api/library/${bookId}/chapters/${current.id}?theme=${settings.theme}&font=${settings.font}&size=${settings.fontSize}&lh=${settings.lineHeight}&width=${settings.width}&layout=${settings.layout}&indent=${settings.indent}&padt=${settings.padTop}&padb=${settings.padBottom}&padx=${settings.padInline}`
    : null;

  const filteredChapters = tocSearch
    ? chapters.filter((c) => c.title.toLowerCase().includes(tocSearch.toLowerCase()))
    : chapters;

  // CSS classes per theme
  const headerCls = isDark
    ? 'bg-[#12122a]/95 border-[#2a2a4a] text-[#e2e2e8]'
    : isSepia
    ? 'bg-[#f0e6d3]/95 border-[#c8b89a] text-[#3b2f20]'
    : 'bg-white/95 border-gray-200 text-gray-900';
  const btnBorder = isDark ? '#2a2a4a' : isSepia ? '#c8b89a' : '#e2e2e2';
  const btnStyle  = { color: themeObj.text, borderColor: btnBorder, background: 'transparent' };
  const panelCls = isDark ? 'bg-[#12122a] border-[#2a2a4a] text-[#e2e2e8]'
    : isSepia ? 'bg-[#ede0ce] border-[#c8b89a] text-[#3b2f20]' : 'bg-white border-gray-200 text-gray-900';
  const dividerCls = isDark ? 'border-[#2a2a4a]' : isSepia ? 'border-[#c8b89a]' : 'border-gray-200';
  const mutedCls   = isDark ? 'text-[#888]' : isSepia ? 'text-[#8a7a65]' : 'text-gray-500';
  const activeCls  = isDark ? 'bg-blue-900/50 text-blue-200 border-blue-700'
    : isSepia ? 'bg-amber-200 text-amber-900 border-amber-500' : 'bg-blue-100 text-blue-700 border-blue-300';
  const hoverCls   = isDark ? 'hover:bg-white/5' : isSepia ? 'hover:bg-amber-100/50' : 'hover:bg-gray-100';
  const inputCls   = isDark ? 'border-[#3a3a5a] bg-[#1a1a2e]' : isSepia ? 'border-[#c8b89a] bg-[#f4ede4]' : 'border-gray-200 bg-white';

  const NavPanel = ({ side, open, children }: { side: 'left' | 'right'; open: boolean; children: React.ReactNode }) => (
    <aside
      onClick={(e) => e.stopPropagation()}
      className={cn(
        'absolute inset-y-0 z-20 flex flex-col shadow-2xl transition-transform duration-200 ease-in-out overflow-y-auto',
        panelCls,
        side === 'left' ? 'left-0 w-72 border-r' : 'right-0 w-80 border-l',
        open ? 'translate-x-0' : side === 'left' ? '-translate-x-full' : 'translate-x-full',
      )}
    >{children}</aside>
  );

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      wrapperRef.current?.requestFullscreen().then(() => setFullscreen(true)).catch(() => {});
    } else {
      document.exitFullscreen().then(() => setFullscreen(false)).catch(() => {});
    }
  };
  const closePanels = () => {
    setTocOpen(false); setSettingsOpen(false); setBookmarksOpen(false);
    setWmOpen(false); setAbOpen(false); setVoiceDebugOpen(false);
    // Stop any voice preview when panels close
    if (voicePreviewAudioRef.current) {
      voicePreviewAudioRef.current.pause();
      voicePreviewAudioRef.current = null;
    }
    setPreviewingVoice(null);
  };

  return (
    <div ref={wrapperRef} className="fixed inset-0 z-50 flex flex-col" style={{ background: themeObj.bg, color: themeObj.text }}>

      {/* ── Header ── */}
      <header className={cn('flex items-center gap-1 px-2 py-1.5 border-b z-30 shrink-0 backdrop-blur-sm', headerCls)}>
        <Link href="/library" title="Back">
          <Button variant="ghost" size="icon" className="h-8 w-8"><Home className="h-4 w-4" /></Button>
        </Link>
        <button onClick={() => { setTocOpen((o) => !o); setSettingsOpen(false); setBookmarksOpen(false); setWmOpen(false); }}
          className={cn('flex h-8 w-8 items-center justify-center rounded-md transition-colors border', tocOpen ? activeCls : `border-transparent ${hoverCls}`)}
          title="Table of Contents (T)">
          <List className="h-4 w-4" />
        </button>

        <div className="flex-1 min-w-0 text-center px-2">
          <p className="text-xs font-semibold truncate">{bookTitle}</p>
          {current && (
            <p className={cn('text-[10px] truncate flex items-center justify-center gap-1', mutedCls)}>
              {current.title}
              {detectingChapter === current.id && (
                <span className="inline-flex items-center gap-0.5 text-blue-600 dark:text-blue-400 shrink-0" title="Đang AI phân tích nhân vật và giọng cho chương này…">
                  <Loader2 className="h-2.5 w-2.5 animate-spin" />
                </span>
              )}
            </p>
          )}
        </div>

        {/* Chapter jump */}
        {chapters.length > 0 && (
          <form onSubmit={(e) => { e.preventDefault(); const n = parseInt(jumpInput, 10) - 1; if (!isNaN(n)) goToChapter(n); setJumpInput(''); }} className="hidden sm:flex items-center gap-1">
            <input type="number" min={1} max={chapters.length} value={jumpInput}
              onChange={(e) => setJumpInput(e.target.value)} placeholder={String(currentIdx + 1)}
              className={cn('w-12 rounded border text-center text-xs py-0.5 outline-none', inputCls)} title="Jump to chapter" />
            <span className={cn('text-xs', mutedCls)}>/ {chapters.length}</span>
          </form>
        )}

        {/* Reading time */}
        {chapters.length > 0 && (
          <span className={cn('hidden lg:flex items-center gap-0.5 text-[10px] shrink-0', mutedCls)}>
            <Clock className="h-3 w-3 opacity-60" />{estimateReadTime(chapters.length, currentIdx)}
          </span>
        )}

        {/* Layout toggle */}
        <div className="flex rounded-md border overflow-hidden">
          {(['spread', 'scroll'] as Layout[]).map((l) => (
            <button key={l} onClick={() => updateSetting('layout', l)} title={l === 'spread' ? 'Two-column (Apple Books)' : 'Scroll'}
              className={cn('flex h-7 w-7 items-center justify-center border-r last:border-r-0 transition-colors', settings.layout === l ? activeCls : `border-transparent ${hoverCls}`)}>
              {l === 'spread' ? <Columns className="h-3.5 w-3.5" /> : <ScrollText className="h-3.5 w-3.5" />}
            </button>
          ))}
        </div>

        <button onClick={toggleBookmark}
          className={cn('flex h-8 w-8 items-center justify-center rounded-md border transition-colors', isBookmarked ? activeCls : `border-transparent ${hoverCls}`)}
          title={isBookmarked ? 'Remove bookmark (B)' : 'Bookmark (B)'}>
          {isBookmarked ? <BookmarkCheck className="h-4 w-4" /> : <Bookmark className="h-4 w-4" />}
        </button>
        <button onClick={() => { setBookmarksOpen((o) => !o); setTocOpen(false); setSettingsOpen(false); setWmOpen(false); }}
          className={cn('flex h-8 w-8 items-center justify-center rounded-md border transition-colors', bookmarksOpen ? activeCls : `border-transparent ${hoverCls}`)}>
          <AlignLeft className="h-4 w-4" />
        </button>
        <button onClick={() => { setSettingsOpen((o) => !o); setTocOpen(false); setBookmarksOpen(false); setWmOpen(false); setAbOpen(false); }}
          className={cn('flex h-8 w-8 items-center justify-center rounded-md border transition-colors', settingsOpen ? activeCls : `border-transparent ${hoverCls}`)}>
          <Settings2 className="h-4 w-4" />
        </button>
        <button onClick={() => { setAbOpen((o) => !o); setTocOpen(false); setSettingsOpen(false); setBookmarksOpen(false); setWmOpen(false); }}
          className={cn('flex h-8 w-8 items-center justify-center rounded-md border transition-colors', abOpen ? activeCls : `border-transparent ${hoverCls}`)}
          title="Audiobook (giọng đọc trước)">
          <Headphones className="h-4 w-4" />
        </button>
        <button onClick={() => { setVoiceDebugOpen((o) => !o); setTocOpen(false); setSettingsOpen(false); setBookmarksOpen(false); setWmOpen(false); setAbOpen(false); }}
          className={cn('flex h-8 w-8 items-center justify-center rounded-md border transition-colors', voiceDebugOpen ? activeCls : `border-transparent ${hoverCls}`)}
          title="Voice assignment debug (xem ai đang nói, voice nào)">
          <Bug className="h-4 w-4" />
        </button>
        <button
          onClick={() => { void runFullAnalysis(); }}
          disabled={analysisInFlight || !chapters[currentIdx]?.id}
          title={analysisInFlight
            ? `Đang chạy full analysis…${analysisProgress ?? ''}`
            : 'Full analysis: parser + regex + oMLX (ghi đè cache)'}
          className={cn('flex h-8 w-8 items-center justify-center rounded-md border transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
            analysisInFlight ? activeCls : `border-transparent ${hoverCls}`)}>
          {analysisInFlight
            ? <Loader2 className="h-4 w-4 animate-spin" />
            : <Wand2 className="h-4 w-4" />}
        </button>
        <button onClick={toggleFullscreen} className={cn('hidden sm:flex h-8 w-8 items-center justify-center rounded-md border border-transparent', hoverCls)}>
          {fullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
        </button>
        <button
          onClick={toggleVoiceControl}
          disabled={!voiceControlSupported}
          title={voiceControlSupported ? (voiceControlOn ? 'Tắt nghe lệnh giọng nói' : 'Bật nghe lệnh giọng nói') : 'Trình duyệt không hỗ trợ nhận lệnh giọng nói'}
          className={cn('flex h-8 w-8 items-center justify-center rounded-md border transition-colors disabled:opacity-40 disabled:cursor-not-allowed',
            voiceControlOn ? activeCls : `border-transparent ${hoverCls}`)}>
          <Mic className="h-4 w-4" />
        </button>
        <ServiceHealth showWorker={false} className="hidden md:inline-flex" />
        {/* TTS toggle — opens settings panel when idle, stops when active */}
        <button
          onClick={() => {
            if (ttsState === 'idle') {
              void loadTtsContext();
              setTtsSettingsOpen((o) => !o);
            } else {
              stopTts();
            }
          }}
          title={ttsState === 'idle' ? 'Read aloud' : 'Stop reading'}
          className={cn('flex h-8 w-8 items-center justify-center rounded-md border transition-colors',
            ttsState !== 'idle' || ttsSettingsOpen ? activeCls : `border-transparent ${hoverCls}`)}>
          {ttsState === 'loading'
            ? <Loader2 className="h-4 w-4 animate-spin" />
            : ttsState !== 'idle'
            ? <VolumeX className="h-4 w-4" />
            : <Volume2 className="h-4 w-4" />}
        </button>
      </header>

      {(voiceControlOn || voiceCommandText || voiceCommandError) && (
        <div className={cn('flex items-center gap-2 px-3 py-1 border-b shrink-0 text-[11px]', headerCls)}>
          <Mic className={cn('h-3.5 w-3.5 shrink-0', voiceControlOn ? 'text-primary' : mutedCls)} />
          <span className={cn('shrink-0 font-medium', voiceControlOn ? 'text-primary' : mutedCls)}>
            {voiceControlOn ? 'Đang nghe lệnh' : 'Lệnh giọng nói'}
          </span>
          <span className={cn('min-w-0 flex-1 truncate', voiceCommandError ? 'text-red-500' : mutedCls)}>
            {voiceCommandError || voiceCommandText || 'Sẵn sàng'}
          </span>
          {voiceCommandText && (
            <button onClick={() => setVoiceCommandText('')} className={cn('rounded px-1.5 py-0.5', hoverCls)} title="Ẩn">
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      )}

      {/* ── Read-aloud side panel (right slide-in drawer) ─────────────── */}
      <ReadAloudPanel
        open={ttsSettingsOpen}
        onClose={() => setTtsSettingsOpen(false)}
        defaultVoice={ttsVoice}
        setDefaultVoice={setTtsVoice}
        customVoices={ttsCustomVoices.map((v) => ({ id: v.id, name: v.name, isCloned: v.isCustom }))}
        setCustomVoices={(vs) => setTtsCustomVoices(vs.map((v) => ({ id: v.id, name: v.name, isCustom: v.isCloned })))}
        characterList={ttsCharacterList}
        useCharacterVoice={ttsUseCharacterVoice}
        setUseCharacterVoice={setTtsUseCharacterVoice}
        speed={ttsSpeed}
        setSpeed={setTtsSpeed}
        expressiveness={ttsNoise}
        setExpressiveness={setTtsNoise}
        paragraphGap={ttsParagraphGap}
        setParagraphGap={setTtsParagraphGap}
        continuousPlay={ttsContinuousPlay}
        setContinuousPlay={setTtsContinuousPlay}
        pregenStatus={pregenStatus}
        useAIEmotion={ttsUseAI}
        setUseAIEmotion={setTtsUseAI}
        ttsState={ttsState}
        ttsParagraphs={ttsParagraphs}
        ttsIndex={ttsIndex}
        ttsCurrentSpeaker={ttsCurrentSpeaker}
        ttsEmotionLabel={ttsEmotionLabel}
        onStart={() => { setTtsSettingsOpen(false); startTts(0); }}
        onStop={stopTts}
        onTogglePause={toggleTtsPause}
        onPreviewDefaultVoice={previewDefaultVoice}
        onStopPreview={stopVoicePreview}
        previewingVoice={previewingVoice}
        bookId={bookId}
        onOpenVoiceLibrary={() => setAbOpen(true)}
        accentColor={accentColor}
        themeCls={headerCls}
        mutedCls={mutedCls}
        borderCls={dividerCls}
        hoverCls={hoverCls}
        activeCls={activeCls}
      />

      {/* ── TTS status bar (visible while reading) ── */}
      {ttsState !== 'idle' && (
        <div className={cn('flex items-center gap-2 px-3 py-1.5 border-b shrink-0 text-xs', headerCls)}>
          <Volume2 className="h-3.5 w-3.5 shrink-0 opacity-70" />
          <span className={cn('flex-1 truncate', mutedCls)}>
            {ttsState === 'loading' ? 'Đang chuẩn bị…'
              : ttsParagraphs.length > 0 ? `Đoạn ${ttsIndex + 1} / ${ttsParagraphs.length}`
              : 'Đang đọc…'}
            {ttsEmotionLabel && <span className="ml-1.5 opacity-80">{ttsEmotionLabel}</span>}
            {ttsCurrentSpeaker && (
              <span className="ml-1.5 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-primary/15 text-primary text-[10px] font-medium">
                🗣 {ttsCurrentSpeaker}
              </span>
            )}
          </span>
          {/* Speed quick-switch */}
          <div className="flex items-center gap-1 shrink-0">
            {[0.75, 1.0, 1.25, 1.5].map((s) => (
              <button key={s} onClick={() => setTtsSpeed(s)}
                className={cn('rounded px-1.5 py-0.5 text-[10px] border transition-colors',
                  ttsSpeed === s ? activeCls : `border-transparent ${hoverCls}`)}>
                {s}×
              </button>
            ))}
          </div>
          <button onClick={toggleTtsPause}
            className={cn('flex h-6 w-6 items-center justify-center rounded border', hoverCls)}
            title={ttsState === 'paused' ? 'Tiếp tục' : 'Tạm dừng'}>
            {ttsState === 'paused' ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
          </button>
          <button onClick={stopTts}
            className={cn('flex h-6 w-6 items-center justify-center rounded border', hoverCls)}
            title="Dừng">
            <Square className="h-3 w-3" />
          </button>
        </div>
      )}

      {/* ── Body ── */}
      <div className="flex flex-1 overflow-hidden relative" onClick={() => { closePanels(); setTtsSettingsOpen(false); }}>

        {/* TOC */}
        <NavPanel side="left" open={tocOpen}>
          <div className={cn('flex items-center justify-between px-3 py-2 border-b shrink-0', dividerCls)}>
            <span className="font-semibold text-sm">Contents</span>
            <span className={cn('text-xs', mutedCls)}>{chapters.length} ch.</span>
          </div>
          <div className="px-3 py-2 shrink-0">
            <div className="relative">
              <Search className={cn('absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2', mutedCls)} />
              <input type="search" placeholder="Search…" value={tocSearch} onChange={(e) => setTocSearch(e.target.value)}
                className={cn('w-full rounded-md border pl-8 pr-3 py-1.5 text-xs outline-none', inputCls)} />
            </div>
          </div>
          <nav className="flex-1 overflow-y-auto">
            <ul className="py-1">
              {filteredChapters.map((ch) => {
                const ri = chapters.findIndex((c) => c.id === ch.id);
                const active = ri === currentIdx;
                const marked = bookmarks.includes(ri);
                return (
                  <li key={ch.id}>
                    <button onClick={() => goToChapter(ri)}
                      className={cn('w-full text-left px-3 py-2 text-xs leading-snug flex items-center gap-1.5 border-l-2 transition-colors',
                        active ? activeCls : `border-transparent ${hoverCls}`)}>
                      {marked && <Bookmark className="h-2.5 w-2.5 shrink-0 fill-amber-500 text-amber-500" />}
                      <span className="flex-1 truncate">{ch.title}</span>
                      {active && <span className={cn('shrink-0 text-[9px]', mutedCls)}>now</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>
          <div className={cn('px-3 py-2 border-t text-[10px]', mutedCls, dividerCls)}>
            <div className="flex justify-between mb-1">
              <span>Progress</span>
              <span>{chapters.length > 0 ? Math.round(((currentIdx + 1) / chapters.length) * 100) : 0}%</span>
            </div>
            <div className="h-1 rounded-full bg-current/10">
              <div className="h-full rounded-full bg-current/40 transition-all"
                style={{ width: `${chapters.length > 0 ? ((currentIdx + 1) / chapters.length) * 100 : 0}%` }} />
            </div>
          </div>
        </NavPanel>

        {/* Bookmarks */}
        <NavPanel side="left" open={bookmarksOpen}>
          <div className={cn('flex items-center justify-between px-3 py-2 border-b shrink-0', dividerCls)}>
            <span className="font-semibold text-sm flex items-center gap-1.5"><Bookmark className="h-3.5 w-3.5" />Bookmarks</span>
            <span className={cn('text-xs', mutedCls)}>{bookmarks.length}</span>
          </div>
          <nav className="flex-1 overflow-y-auto">
            {bookmarks.length === 0 ? (
              <p className={cn('px-4 py-8 text-xs text-center', mutedCls)}>No bookmarks.<br />Press <kbd className="px-1 rounded border">B</kbd> to add one.</p>
            ) : bookmarks.map((idx) => {
              const ch = chapters[idx];
              if (!ch) return null;
              return (
                <button key={idx} onClick={() => goToChapter(idx)}
                  className={cn('w-full text-left px-3 py-2 text-xs leading-snug', hoverCls, idx === currentIdx && activeCls)}>
                  <span className="block truncate">{ch.title}</span>
                  <span className={cn('text-[10px]', mutedCls)}>Chapter {idx + 1}</span>
                </button>
              );
            })}
          </nav>
        </NavPanel>

        {/* Settings */}
        <NavPanel side="right" open={settingsOpen}>
          <div className={cn('flex items-center justify-between px-4 py-3 border-b shrink-0', dividerCls)}>
            <span className="font-semibold text-sm flex items-center gap-1.5"><Settings2 className="h-3.5 w-3.5" />Reading Settings</span>
            <button onClick={() => setSettingsOpen(false)} className={cn('rounded p-1', hoverCls)}><X className="h-3.5 w-3.5" /></button>
          </div>
          <div className="flex-1 space-y-5 p-4 overflow-y-auto">
            {/* Layout */}
            <div>
              <p className={cn('mb-2 text-[10px] font-semibold uppercase tracking-widest', mutedCls)}>Layout</p>
              <div className="grid grid-cols-2 gap-2">
                {[{ id: 'spread' as Layout, label: 'Book (2-col)', icon: Columns },
                  { id: 'scroll' as Layout, label: 'Scroll', icon: ScrollText }].map(({ id, label, icon: Icon }) => (
                  <button key={id} onClick={() => updateSetting('layout', id)}
                    className={cn('flex flex-col items-center gap-1 rounded-lg border py-3 text-xs font-medium transition-all bg-transparent',
                      settings.layout === id ? activeCls : `${hoverCls} opacity-70`)}>
                    <Icon className="h-4 w-4" />{label}
                  </button>
                ))}
              </div>
            </div>
            {/* Theme */}
            <div>
              <p className={cn('mb-2 text-[10px] font-semibold uppercase tracking-widest', mutedCls)}>Theme</p>
              <div className="flex gap-2">
                {THEMES.map((t) => (
                  <button key={t.id} onClick={() => updateSetting('theme', t.id)}
                    className={cn('flex-1 rounded-lg border py-2.5 text-xs font-medium transition-all', settings.theme === t.id ? 'ring-2' : 'opacity-60')}
                    style={{ background: t.bg, color: t.text }}>
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
            {/* Font */}
            <div>
              <p className={cn('mb-2 text-[10px] font-semibold uppercase tracking-widest', mutedCls)}>Typeface</p>
              <div className="flex gap-2">
                {FONTS.map((f) => (
                  <button key={f.id} onClick={() => updateSetting('font', f.id)}
                    className={cn('flex-1 rounded-lg border py-2 text-xs transition-all bg-transparent', settings.font === f.id ? activeCls + ' font-semibold' : `${hoverCls} opacity-70`)}
                    style={{ fontFamily: f.stack }}>{f.sample}</button>
                ))}
              </div>
            </div>
            {/* Font size */}
            <div>
              <div className="flex justify-between mb-2">
                <p className={cn('text-[10px] font-semibold uppercase tracking-widest', mutedCls)}>Font Size</p>
                <span className="text-xs font-mono">{settings.fontSize}px</span>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => updateSetting('fontSize', Math.max(12, settings.fontSize - 1))}
                  className={cn('flex h-7 w-7 items-center justify-center rounded border', hoverCls)}><Minus className="h-3.5 w-3.5" /></button>
                <input type="range" min={12} max={28} step={1} value={settings.fontSize}
                  onChange={(e) => updateSetting('fontSize', parseInt(e.target.value, 10))} className="flex-1" style={{ accentColor }} />
                <button onClick={() => updateSetting('fontSize', Math.min(28, settings.fontSize + 1))}
                  className={cn('flex h-7 w-7 items-center justify-center rounded border', hoverCls)}><Plus className="h-3.5 w-3.5" /></button>
              </div>
            </div>
            {/* Line height */}
            <div>
              <div className="flex justify-between mb-2">
                <p className={cn('text-[10px] font-semibold uppercase tracking-widest', mutedCls)}>Line Spacing</p>
                <span className="text-xs font-mono">{settings.lineHeight.toFixed(2)}×</span>
              </div>
              <input type="range" min={1.3} max={2.8} step={0.05} value={settings.lineHeight}
                onChange={(e) => updateSetting('lineHeight', parseFloat(e.target.value))} className="w-full" style={{ accentColor }} />
              <div className={cn('flex justify-between text-[10px] mt-1', mutedCls)}><span>Tight</span><span>Normal</span><span>Spacious</span></div>
            </div>
            {/* Indent */}
            <div>
              <p className={cn('mb-2 text-[10px] font-semibold uppercase tracking-widest', mutedCls)}>Paragraph Indent</p>
              <div className="grid grid-cols-4 gap-1.5">
                {INDENT_PRESETS.map((p) => (
                  <button key={p.em} onClick={() => updateSetting('indent', p.em)}
                    className={cn('rounded-lg border py-2 text-[10px] font-medium transition-all bg-transparent', settings.indent === p.em ? activeCls : `${hoverCls} opacity-70`)}>
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
            {/* Width (scroll mode only) */}
            {settings.layout === 'scroll' && (
              <div>
                <p className={cn('mb-2 text-[10px] font-semibold uppercase tracking-widest', mutedCls)}>Column Width</p>
                <div className="grid grid-cols-4 gap-1.5">
                  {WIDTHS.map((w) => (
                    <button key={w.px} onClick={() => updateSetting('width', w.px)}
                      className={cn('rounded-lg border py-2 text-[10px] font-medium transition-all bg-transparent', settings.width === w.px ? activeCls : `${hoverCls} opacity-70`)}>
                      {w.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {/* Padding controls */}
            <div>
              <p className={cn('mb-2 text-[10px] font-semibold uppercase tracking-widest', mutedCls)}>Padding</p>
              <div className="space-y-2.5">
                {[
                  { key: 'padTop'    as const, label: 'Top',        min: 0, max: 120 },
                  { key: 'padBottom' as const, label: 'Bottom',     min: 0, max: 160 },
                  { key: 'padInline' as const, label: 'Left / Right', min: 0, max: 120 },
                ].map(({ key, label, min, max }) => (
                  <div key={key}>
                    <div className="flex justify-between mb-1">
                      <span className={cn('text-[10px]', mutedCls)}>{label}</span>
                      <span className="text-[10px] font-mono">{settings[key]}px</span>
                    </div>
                    <input type="range" min={min} max={max} step={4} value={settings[key]}
                      onChange={(e) => updateSetting(key, parseInt(e.target.value, 10))}
                      className="w-full" style={{ accentColor }} />
                  </div>
                ))}
              </div>
            </div>
            {/* Reset */}
            <button onClick={() => { setSettings(DEFAULT_SETTINGS); saveSettings(DEFAULT_SETTINGS); }}
              className={cn('w-full flex items-center justify-center gap-1.5 rounded-lg border py-2 text-xs', hoverCls)}>
              <RotateCcw className="h-3.5 w-3.5" /> Reset defaults
            </button>
            {/* Watermark section */}
            <div className={cn('border-t pt-4', dividerCls)}>
              <p className={cn('mb-3 text-[10px] font-semibold uppercase tracking-widest', mutedCls)}>Book Cleanup</p>
              {wmSaved.length > 0 && (
                <div className={cn('mb-2 rounded-lg p-2 text-[10px]', 'bg-green-500/10 text-green-600')}>
                  {wmSaved.length} watermark{wmSaved.length > 1 ? 's' : ''} active
                  <button onClick={clearWatermarks} className="ml-2 underline">clear</button>
                </div>
              )}
              <div className="flex gap-2">
                <button onClick={() => detectWatermarks(false)}
                  className={cn('flex-1 flex items-center justify-center gap-1 rounded-lg border py-2 text-[10px] font-medium', hoverCls)}>
                  <Search className="h-3 w-3" /> Detect
                </button>
                <button onClick={() => detectWatermarks(true)}
                  className={cn('flex-1 flex items-center justify-center gap-1 rounded-lg border py-2 text-[10px] font-medium', hoverCls)}>
                  <Wand2 className="h-3 w-3" /> AI Detect
                </button>
              </div>
            </div>
            {/* Keyboard shortcuts */}
            <div className={cn('border-t pt-4 text-[10px] space-y-1.5', mutedCls, dividerCls)}>
              <p className="font-semibold uppercase tracking-widest mb-2">Shortcuts</p>
              {[['→ / Space','Next'],['←','Prev'],['T','TOC'],['B','Bookmark'],['Esc','Close']].map(([k,d]) => (
                <div key={k} className="flex justify-between items-center">
                  <kbd className="px-1.5 py-0.5 rounded border font-mono text-[9px]">{k}</kbd><span>{d}</span>
                </div>
              ))}
            </div>
          </div>
        </NavPanel>

        {/* Watermark panel */}
        <NavPanel side="right" open={wmOpen}>
          <div className={cn('flex items-center justify-between px-4 py-3 border-b shrink-0', dividerCls)}>
            <span className="font-semibold text-sm flex items-center gap-1.5"><Wand2 className="h-3.5 w-3.5" />Watermark Detector</span>
            <button onClick={() => setWmOpen(false)} className={cn('rounded p-1', hoverCls)}><X className="h-3.5 w-3.5" /></button>
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {wmLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin opacity-40" />
                <span className={cn('ml-2 text-sm', mutedCls)}>Analysing all chapters…</span>
              </div>
            ) : wmCandidates.length === 0 ? (
              <p className={cn('text-sm text-center py-8', mutedCls)}>No watermark candidates detected.</p>
            ) : (
              <>
                <p className={cn('text-xs', mutedCls)}>Select phrases to remove. They will be stripped from every chapter when reading.</p>
                <div className="space-y-2">
                  {wmCandidates.map((c, i) => (
                    <label key={i} className={cn('flex items-start gap-2 rounded-lg border p-2.5 cursor-pointer transition-colors text-xs',
                      wmSelected.has(i) ? activeCls : hoverCls)}>
                      <input type="checkbox" checked={wmSelected.has(i)} onChange={() => {
                        const next = new Set(wmSelected);
                        if (next.has(i)) next.delete(i); else next.add(i);
                        setWmSelected(next);
                      }} className="mt-0.5 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium">{c.text}</p>
                        <p className={cn('text-[10px]', mutedCls)}>{c.count} chapters ({c.percentage}%){c.confirmed ? ' ✓ AI confirmed' : ''}</p>
                      </div>
                    </label>
                  ))}
                </div>
              </>
            )}
          </div>
          {wmCandidates.length > 0 && !wmLoading && (
            <div className={cn('p-4 border-t shrink-0', dividerCls)}>
              <Button onClick={saveWatermarks} className="w-full text-xs h-9" disabled={wmSelected.size === 0}>
                <Trash2 className="h-3.5 w-3.5 mr-1.5" />Remove {wmSelected.size > 0 ? wmSelected.size : ''} selected
              </Button>
            </div>
          )}
        </NavPanel>

        {/* Audiobook panel (right side, with tabs) */}
        <aside
          onClick={(e) => e.stopPropagation()}
          className={cn('absolute inset-y-0 right-0 z-20 flex flex-col shadow-2xl transition-transform duration-200 ease-in-out overflow-hidden',
            panelCls,
            'w-96 border-l',
            abOpen ? 'translate-x-0' : 'translate-x-full',
          )}
        >
          <div className={cn('flex items-center justify-between px-4 py-3 border-b shrink-0', dividerCls)}>
            <span className="font-semibold text-sm flex items-center gap-1.5">
              <Headphones className="h-3.5 w-3.5" />Audiobook
            </span>
            <button onClick={() => setAbOpen(false)} className={cn('rounded p-1', hoverCls)}><X className="h-3.5 w-3.5" /></button>
          </div>
          {/* Tabs */}
          <div className={cn('flex border-b shrink-0', dividerCls)}>
            <button onClick={() => setAbTab('audiobook')}
              className={cn('flex-1 py-2 text-xs font-medium transition-colors border-b-2',
                abTab === 'audiobook' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground')}>
              Pre-generation
            </button>
            <button onClick={() => setAbTab('voices')}
              className={cn('flex-1 py-2 text-xs font-medium transition-colors border-b-2',
                abTab === 'voices' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground')}>
              Giọng & nhân vật
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-4">
            {abTab === 'audiobook' ? <AudiobookPanel bookId={bookId} /> : <VoicePanel bookId={bookId} bookLanguage="vi" />}
          </div>
        </aside>

        {/* Voice-assignment debug panel (right side, narrower) */}
        <aside
          onClick={(e) => e.stopPropagation()}
          className={cn('absolute inset-y-0 right-0 z-20 flex flex-col shadow-2xl transition-transform duration-200 ease-in-out overflow-hidden',
            panelCls,
            'w-[28rem] max-w-full border-l',
            voiceDebugOpen ? 'translate-x-0' : 'translate-x-full',
          )}
        >
          <div className={cn('flex items-center justify-between px-4 py-3 border-b shrink-0', dividerCls)}>
            <span className="font-semibold text-sm flex items-center gap-1.5">
              <Bug className="h-3.5 w-3.5" />Voice assignment debug
            </span>
            <button onClick={() => setVoiceDebugOpen(false)} className={cn('rounded p-1', hoverCls)}><X className="h-3.5 w-3.5" /></button>
          </div>
          <VoiceDebugPanel
            paragraphs={ttsParagraphs}
            ttsCharacterList={ttsCharacterList}
            ttsCharacterMap={ttsCharacterMap}
            detectSpeaker={detectSpeaker}
            chapterAttributionRef={chapterAttributionRef}
            chapterAttributionStats={chapterAttributionStats}
            currentChapterId={chapters[currentIdx]?.id}
            isDark={isDark}
            dividerCls={dividerCls}
            hoverCls={hoverCls}
            panelCls={panelCls}
          />
        </aside>

        {/* Chapter iframe */}
        <main className="flex-1 overflow-hidden flex flex-col">
          {loading ? (
            <div className={cn('flex-1 flex items-center justify-center text-sm', mutedCls)}>Loading book…</div>
          ) : chapterSrc ? (
            <div className="relative flex-1">
              {iframeLoading && (
                <div className="absolute inset-0 z-10 flex items-center justify-center" style={{ background: themeObj.bg }}>
                  <div className={cn('text-sm', mutedCls)}>Loading…</div>
                </div>
              )}
              <iframe key={chapterSrc} ref={iframeRef} src={chapterSrc}
                className="h-full w-full border-0" title={current?.title}
                sandbox="allow-same-origin allow-scripts" onLoad={handleIframeLoad} />
            </div>
          ) : (
            <div className={cn('flex-1 flex items-center justify-center text-sm', mutedCls)}>No chapters found.</div>
          )}
        </main>
      </div>

      {/* ── Footer ── */}
      <footer className={cn('flex items-center gap-2 px-3 py-2 border-t shrink-0 backdrop-blur-sm', headerCls)}>
        <Button variant="outline" size="sm" onClick={handlePrev}
          disabled={chapters.length === 0 || (currentIdx <= 0 && (settings.layout === 'scroll' || spreadPage <= 0))}
          style={btnStyle}
          className="gap-1 text-xs">
          <ChevronLeft className="h-3.5 w-3.5" /><span className="hidden sm:block">Prev</span>
        </Button>

        <div className="flex-1 flex flex-col items-center gap-1">
          {settings.layout === 'spread' && spreadTotal > 1 && (
            <p className={cn('text-[10px]', mutedCls)}>Page {spreadPage + 1} / {spreadTotal} in chapter</p>
          )}
          {chapters.length > 0 && chapters.length <= 30 ? (
            <div className="flex flex-wrap justify-center gap-0.5 max-w-xs">
              {chapters.map((_, idx) => (
                <button key={idx} onClick={() => goToChapter(idx)} title={chapters[idx]?.title}
                  className="rounded-full transition-all"
                  style={{
                    width: idx === currentIdx ? 10 : 6, height: idx === currentIdx ? 10 : 6,
                    background: bookmarks.includes(idx) ? '#f59e0b' : idx === currentIdx ? accentColor : 'currentColor',
                    opacity: idx === currentIdx ? 1 : bookmarks.includes(idx) ? 0.8 : 0.2,
                  }} />
              ))}
            </div>
          ) : chapters.length > 30 ? (
            <div className="w-full max-w-xs">
              <div className="h-1.5 rounded-full" style={{ background: `${accentColor}22` }}>
                <div className="h-full rounded-full transition-all" style={{ background: accentColor, width: `${chapters.length > 0 ? ((currentIdx + 1) / chapters.length) * 100 : 0}%` }} />
              </div>
              <p className={cn('text-center text-[10px] mt-0.5', mutedCls)}>{currentIdx + 1} / {chapters.length}</p>
            </div>
          ) : null}
        </div>

        <Button variant="outline" size="sm" onClick={handleNext}
          disabled={chapters.length === 0 || (currentIdx >= chapters.length - 1 && (settings.layout === 'scroll' || spreadPage >= spreadTotal - 1))}
          style={btnStyle}
          className="gap-1 text-xs">
          <span className="hidden sm:block">Next</span><ChevronRight className="h-3.5 w-3.5" />
        </Button>
      </footer>
    </div>
  );
}
