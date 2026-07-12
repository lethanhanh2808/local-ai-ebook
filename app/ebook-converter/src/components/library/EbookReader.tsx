'use client';
// src/components/library/EbookReader.tsx
// Professional EPUB reader: spread (two-column Apple Books) + scroll modes
import { useEffect, useRef, useState, useCallback, lazy, Suspense } from 'react';
import { createPortal } from 'react-dom';
import { Button, buttonClasses } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Progress } from '@/components/ui/progress';
import { KbdHint } from '@/components/ui/kbd-hint';
import { Tooltip } from '@/components/ui/tooltip';
import { Dialog, DialogBody, DialogFooter } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  ChevronLeft, ChevronRight, List, X, Home, Settings2,
  Bookmark, BookmarkCheck, AlignLeft, Minus, Plus,
  Search, Clock, RotateCcw, Maximize2, Minimize2,
  Columns, ScrollText, Wand2, Check, Loader2, Trash2,
  Volume2, VolumeX, Play, Pause, Square, Headphones,
  Mic, Bug, Terminal, Clipboard, Copy, Activity, CheckCircle2, AlertCircle,
  Eye, Filter, ArrowUpDown, User, ChevronDown, MoreVertical, Info, Images,
} from 'lucide-react';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import { VIENEU_TTS_VOICES, VIENEU_VOICE_GENDER } from '@/lib/tts/vieneu-voices';
import { detectEmotion } from '@/lib/tts/detect-emotion';
import { cleanTextForTTS, isDecorativeOnly, SILENT_WAV_BLOB } from '@/lib/tts/text-sanitizer';
import { VoicePanel } from './VoicePanel';
import { IllustrationsGallery } from './IllustrationsGallery';
import { ServiceHealth } from '@/components/status/ServiceHealth';
import { enqueueBibleRefresh } from '@/lib/character-bible-client';

// Lazy-loaded heavy panels — these are sizeable feature surfaces that most
// readers never open. Loading on demand cuts the reader's initial JS by
// ~150kb and surfaces the chapter list a few hundred ms sooner.
const AudiobookPanel = lazy(() => import('./AudiobookPanel').then((m) => ({ default: m.AudiobookPanel })));
const ReadAloudPanel  = lazy(() => import('./ReadAloudPanel').then((m) => ({ default: m.ReadAloudPanel })));
const VoiceDebugPanel = lazy(() => import('./VoiceDebugPanel').then((m) => ({ default: m.VoiceDebugPanel })));

/** Tiny fallback while a lazy panel chunk resolves. Skeleton instead of a
 *  spinner so panel height doesn't jump when content arrives. */
const PanelSkeleton = () => (
  <div className="m-3 flex h-32 items-center justify-center rounded-lg border border-border bg-muted/30 text-xs text-muted-foreground animate-pulse">
    Loading panel…
  </div>
);

// ── TTS debug instrumentation ─────────────────────────────────────────────
// Set `localStorage.setItem('ttsDebug', '1')` in the browser console (or
// window.ttsDebug=true at runtime) to enable verbose read-aloud logging.
// Off by default to avoid console spam in production; the goal is to
// surface the silent-failure paths that produce "I clicked Play and
// heard nothing" without an error message.
const TTS_DEBUG = (() => {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage?.getItem('ttsDebug') === '1'
        || (window as unknown as { ttsDebug?: boolean }).ttsDebug === true;
  } catch {
    return false;
  }
})();
function ttsDebug(...args: unknown[]): void {
  if (!TTS_DEBUG) return;
  // eslint-disable-next-line no-console
  console.log('%c[tts]', 'color:#7c3aed;font-weight:bold', ...args);
}
function ttsWarn(...args: unknown[]): void {
  // Always log warnings (silent failures are the bug we're fixing).
  // eslint-disable-next-line no-console
  console.warn('[tts]', ...args);
  // Surface to the user in the status bar — pick the first string arg
  // as the headline message.  The full payload is in the console.
  const headline = args
    .map((a) => (typeof a === 'string' ? a : null))
    .filter(Boolean)[0];
  if (headline && typeof window !== 'undefined') {
    const evt = new CustomEvent('tts:warn', { detail: { message: headline, full: args } });
    window.dispatchEvent(evt);
  }
}

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
  // Indent = 0 → Vietnamese novel style: every paragraph flush-left, blank
  // line between them. Classic book style (indent=1.5) is still selectable
  // from the Reading Settings indent chip group.
  theme: 'dark', font: 'serif', fontSize: 18, lineHeight: 1.85, width: 820, layout: 'spread', indent: 0,
  padTop: 56, padBottom: 96, padInline: 56,
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

// ── Reader surface tokens (UI Polish §4.3) ──────────────────────────────
// Map `settings.theme` to token-backed Tailwind classes. Sepia has its
// own bespoke palette because it must look distinctly warm/sepia even
// when the surrounding app is in light or dark mode; the light + dark
// branches reuse the `--reader-*` tokens defined in src/app/theme.css.
//
// The iframe chapter HTML can't see these tokens (it's a separate
// document) — the same hex values live in
// `src/app/api/library/[id]/chapters/[chapterId]/route.ts` and are served
// via ?theme=. Keep both surfaces in sync when adjusting palettes.
type ReaderSurfaceKey = 'header' | 'panel' | 'divider' | 'muted' | 'active' | 'hover' | 'input' | 'btnBorder';
function readerSurface(theme: Theme, key: ReaderSurfaceKey): string {
  switch (theme) {
    case 'dark':
      switch (key) {
        case 'header':   return 'bg-[hsl(var(--reader-paper))]/95 border-[hsl(var(--reader-divider))] text-[hsl(var(--reader-ink))]';
        case 'panel':    return 'bg-[hsl(var(--reader-paper))] border-[hsl(var(--reader-divider))] text-[hsl(var(--reader-ink))]';
        case 'divider':  return 'border-[hsl(var(--reader-divider))]';
        case 'muted':    return 'text-[hsl(var(--reader-ink-soft))]';
        case 'active':   return 'bg-blue-900/50 text-blue-200 border-blue-700';
        case 'hover':    return 'hover:bg-white/5';
        case 'input':    return 'border-[#3a3a5a] bg-[#1a1a2e]';
        case 'btnBorder':return 'hsl(var(--reader-divider))';
      }
      break;
    case 'sepia':
      switch (key) {
        // SEPIA palette aligned with THEME_COLORS.sepia in the chapter route
        // so iframe html bg + reader surface are visually continuous.
        // Two-tone cream: bg `#f4ede4` (reading surface) + htmlBg/panel/header
        // `#ede0ce` (chrome). Borders `#c8b89a`, accent `#a07840` (copper).
        // Active/hover use the accent copper rather than Tailwind amber,
        // which would render as bright yellow and clash with warm sepia.
        case 'header':   return 'bg-[#ede0ce]/95 border-[#c8b89a] text-[#3b2f20]';
        case 'panel':    return 'bg-[#ede0ce] border-[#c8b89a] text-[#3b2f20]';
        case 'divider':  return 'border-[#c8b89a]';
        case 'muted':    return 'text-[#8a7a65]';
        case 'active':   return 'bg-[#a07840]/20 text-[#5a3a1c] border-[#a07840]';
        case 'hover':    return 'hover:bg-[#a07840]/10';
        case 'input':    return 'border-[#c8b89a] bg-[#f4ede4]';
        case 'btnBorder':return '#c8b89a';
      }
      break;
    case 'light':
    default:
      switch (key) {
        case 'header':   return 'bg-white/95 border-gray-200 text-gray-900';
        case 'panel':    return 'bg-white border-gray-200 text-gray-900';
        case 'divider':  return 'border-gray-200';
        case 'muted':    return 'text-gray-500';
        case 'active':   return 'bg-blue-100 text-blue-700 border-blue-300';
        case 'hover':    return 'hover:bg-gray-100';
        case 'input':    return 'border-gray-200 bg-white';
        case 'btnBorder':return '#e2e2e2';
      }
      break;
  }
}
const FONTS = [
  { id: 'serif' as Font, sample: 'Georgia', stack: 'Georgia,serif' },
  { id: 'sans'  as Font, sample: 'Helvetica', stack: 'Inter,sans-serif' },
  { id: 'mono'  as Font, sample: 'Mono', stack: 'monospace' },
];
const WIDTHS = [
  { px: 640, label: 'Narrow' }, { px: 820, label: 'Medium' },
  { px: 1040, label: 'Wide' },   { px: 9999, label: 'Full' },
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
  try {
    const r = localStorage.getItem('epub-reader-settings');
    if (r) {
      const saved = JSON.parse(r) as Partial<ReaderSettings>;
      // MIGRATION 2026-07-11 — bump OLD-default values to NEW defaults.
      // If the saved value matches the OLD default exactly, the user never
      // touched the slider — silently upgrade to the NEW default. Real
      // user choices (e.g. width=900) are preserved.
      //
      // ALSO: padInline < 16px is treated as a bug/stale value, not a
      // deliberate choice — anything below 16 leaves text pressed against
      // the viewport edge. Bump to the NEW default (56px). The slider
      // step is 4 so 0/4/8/12 are common off-by-one artifacts.
      const OLD_DEFAULTS = {
        width: 720,
        padTop: 48,
        padBottom: 96,
        padInline: 40,
        indent: 1.5,  // OLD default was 1.5em; NEW default is 0 (flush-left novel style)
      } as const;
      const migrated = { ...saved } as Record<string, unknown>;
      for (const k of Object.keys(OLD_DEFAULTS) as Array<keyof typeof OLD_DEFAULTS>) {
        if (saved[k] === OLD_DEFAULTS[k]) {
          migrated[k] = DEFAULT_SETTINGS[k];
        }
      }
      if (typeof saved.padInline === 'number' && saved.padInline < 16) {
        migrated.padInline = DEFAULT_SETTINGS.padInline;
      }
      return { ...DEFAULT_SETTINGS, ...migrated };
    }
  } catch { /* corrupted JSON — fall through */ }
  return DEFAULT_SETTINGS;
}
function saveSettings(s: ReaderSettings) {
  try { localStorage.setItem('epub-reader-settings', JSON.stringify(s)); } catch { /**/ }
}

// ── TTS settings (read-aloud sliders/toggles) ──────────────────────────────
// Persisted to localStorage so the user doesn't lose their slider positions
// on page reload. Keyed under `epub-reader-tts-v1` (versioned so a future
// schema change can migrate cleanly without wiping the older values).
interface TtsSettings {
  speed:             number;  // 0.5 – 2.5 (VieNeu TTS speed parameter)
  noise:             number;  // 0.2 – 1.0 (expressiveness / noise_scale)
  useAI:             boolean; // AI-driven emotion detection on/off
  emotionIntensity:  number;  // 0.0 – 1.0 (how hard emotion deltas push)
  voice:             string;  // builtin name from BUILTIN_VIENEU_NAMES
  continuousPlay:    boolean; // auto-advance to next chapter
  paragraphGap:      number;  // ms; 0 = no extra silence between paragraphs
}
const DEFAULT_TTS_SETTINGS: TtsSettings = {
  speed: 1.0,
  noise: 0.667,
  useAI: false,
  emotionIntensity: 0.6,  // see comment on `ttsEmotionIntensity` useState
  voice: 'Xuân Vĩnh',
  continuousPlay: false,
  paragraphGap: 0,
};
function loadTtsSettings(): TtsSettings {
  try {
    const r = localStorage.getItem('epub-reader-tts-v1');
    if (r) {
      const parsed = JSON.parse(r) as Partial<TtsSettings>;
      // Merge rather than replace so new fields added to DEFAULT_TTS_SETTINGS
      // get their default without wiping the user's other choices. Each
      // value is independently typed-checked at the call site (the
      // individual useState<number>(...) etc. throws on bad type — but we
      // validate numeric ranges here so a stray string doesn't slip in).
      const merged: TtsSettings = { ...DEFAULT_TTS_SETTINGS, ...parsed };
      if (typeof merged.speed            !== 'number') merged.speed            = DEFAULT_TTS_SETTINGS.speed;
      if (typeof merged.noise            !== 'number') merged.noise            = DEFAULT_TTS_SETTINGS.noise;
      if (typeof merged.useAI            !== 'boolean') merged.useAI            = DEFAULT_TTS_SETTINGS.useAI;
      if (typeof merged.emotionIntensity !== 'number') merged.emotionIntensity = DEFAULT_TTS_SETTINGS.emotionIntensity;
      if (typeof merged.voice            !== 'string') merged.voice            = DEFAULT_TTS_SETTINGS.voice;
      if (typeof merged.continuousPlay   !== 'boolean') merged.continuousPlay   = DEFAULT_TTS_SETTINGS.continuousPlay;
      if (typeof merged.paragraphGap     !== 'number') merged.paragraphGap     = DEFAULT_TTS_SETTINGS.paragraphGap;
      return merged;
    }
  } catch { /* corrupted JSON — fall through to defaults */ }
  return DEFAULT_TTS_SETTINGS;
}
function saveTtsSettings(s: TtsSettings) {
  try { localStorage.setItem('epub-reader-tts-v1', JSON.stringify(s)); } catch { /**/ }
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

// ── ChapterJumpMenu ──────────────────────────────────────────────────────
// Dropdown trigger for jumping to a specific chapter when the dot grid is
// too dense to hit precisely (books > 80 chapters). Radix typeahead
// filters as the user types — works on touch and desktop. Renders every
// chapter; if the count is huge (>300), use the numeric jump input in the
// toolbar instead.
interface ChapterJumpMenuProps {
  chapters: Chapter[];
  currentIdx: number;
  onJump: (idx: number) => void;
  mutedCls: string;
}
function ChapterJumpMenu({ chapters, currentIdx, onJump, mutedCls }: ChapterJumpMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Jump to chapter (currently ${currentIdx + 1} of ${chapters.length})`}
          className={cn(
            'inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[10px] font-medium',
            'border-border bg-background hover:bg-muted transition-colors',
            mutedCls,
          )}
          title="Mở danh sách chương để nhảy nhanh"
        >
          <ChevronDown className="h-3 w-3" />
          <span className="tabular-nums">{currentIdx + 1}/{chapters.length}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-80 overflow-auto min-w-[16rem]">
        {chapters.map((c, idx) => (
          <DropdownMenuItem
            key={c.id}
            onSelect={() => onJump(idx)}
            className={cn(
              'text-xs gap-2',
              idx === currentIdx && 'bg-primary/10 text-primary font-medium',
            )}
          >
            <span className="w-8 shrink-0 tabular-nums text-muted-foreground">{idx + 1}.</span>
            <span className="truncate flex-1">{c.title || `(Chương ${idx + 1})`}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ── Full Analyzer: mode union + helpers ────────────────────────────────
// Three modes the user can pick before kicking off a run. Matched against
// the server's `AnalyzeMode` type — if you add a mode here, also add it
// in the API route's parseMode() + the dropdown in the Wand2 split-button.
export type AnalyzeMode = 'combine' | 'full-llm' | 'local-only';

export interface AnalyzeModeOption {
  id: AnalyzeMode;
  /** Vietnamese short label shown in the picker. */
  label: string;
  /** One-line description shown under the label. */
  desc: string;
  /** Badge hint for the toolbar (e.g. "fast", "expensive"). */
  hint: string;
  /** Tailwind class for the hint badge. */
  hintCls: string;
}

export const ANALYZE_MODES: AnalyzeModeOption[] = [
  {
    id: 'combine',
    label: 'Combine',
    desc: 'parse + regex + local fusion → LLM chỉ những đoạn unresolved',
    hint: 'Mặc định',
    hintCls: 'bg-blue-500/15 text-blue-700 dark:text-blue-300',
  },
  {
    id: 'full-llm',
    label: 'Full LLM',
    desc: 'Gửi TẤT CẢ đoạn qua LLM (chậm, tốn token, chính xác nhất)',
    hint: 'Đắt',
    hintCls: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  },
  {
    id: 'local-only',
    label: 'Local only',
    desc: 'parse + regex + local fusion — bỏ qua LLM, không cần oMLX',
    hint: 'Nhanh',
    hintCls: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  },
];

/** Soft-warn cost heuristic for the 'Full LLM' analyzer mode (added 2026-07-12).
 *  Empirically tuned against Ornith-9B-4bit at ~12 tok/s output on M-series:
 *    - 100 paragraphs ≈ 65s
 *    - 200 paragraphs ≈ 100s
 *    - 300 paragraphs ≈ 135s
 *  Model:  0.35s per paragraph + 30s constant overhead (prompt eval + JSON overhead).
 *  Output cost: ~50 tokens/row (idx + speaker + confidence) + 200 tokens baseline
 *  for the rules + roster block.
 *  For cloud providers this will be wildly off — but it's a hint, not a commitment. */
function estimateFullLLM(paragraphCount: number, chapterCharCount: number): {
  paragraphCount: number;
  chapterCharCount: number;
  estimatedSeconds: number;
  estimatedOutputTokens: number;
} {
  const estimatedSeconds = Math.round(paragraphCount * 0.35 + 30);
  const estimatedOutputTokens = paragraphCount * 50 + 200;
  return { paragraphCount, chapterCharCount, estimatedSeconds, estimatedOutputTokens };
}

// ── Full Analyzer modal: shared subcomponents ───────────────────────────
// Color map kept here so renderLogLine + HumanLogSummary + BatchProgressCard
// all agree on the phase → Tailwind class mapping. New phases must be
// added in BOTH this map AND the server's step() phase union.
const PHASE_CLASS: Record<AnalysisLogLine['phase'], string> = {
  error:     'text-red-600 dark:text-red-400',
  llm:       'text-amber-700 dark:text-amber-300',
  fuse:      'text-emerald-700 dark:text-emerald-300',
  cache:     'text-cyan-700 dark:text-cyan-300',
  stat:      'text-emerald-800 dark:text-emerald-200 font-semibold',
  init:      'text-slate-700 dark:text-slate-300',
  parse:     'text-blue-700 dark:text-blue-300',
  regex:     'text-indigo-700 dark:text-indigo-300',
  local:     'text-purple-700 dark:text-purple-300',
  preflight: 'text-pink-700 dark:text-pink-300',
};
const PHASE_BG: Record<AnalysisLogLine['phase'], string> = {
  error:     'bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30',
  llm:       'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30',
  fuse:      'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30',
  cache:     'bg-cyan-500/15 text-cyan-700 dark:text-cyan-300 border-cyan-500/30',
  stat:      'bg-emerald-500/15 text-emerald-800 dark:text-emerald-200 border-emerald-500/40',
  init:      'bg-muted text-muted-foreground border border-border border-border',
  parse:     'bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/30',
  regex:     'bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 border-indigo-500/30',
  local:     'bg-purple-500/15 text-purple-700 dark:text-purple-300 border-purple-500/30',
  preflight: 'bg-pink-500/15 text-pink-700 dark:text-pink-300 border-pink-500/30',
};
const PHASE_LABEL: Record<AnalysisLogLine['phase'], string> = {
  init: 'INIT', parse: 'PARSE', regex: 'REGEX', local: 'LOCAL',
  preflight: 'PING', llm: 'LLM', fuse: 'FUSE', cache: 'CACHE',
  stat: 'DONE', error: 'ERROR',
};
const PHASE_VN: Record<AnalysisLogLine['phase'], string> = {
  init: 'Khởi tạo', parse: 'Phân tích câu', regex: 'Regex',
  local: 'Hội thoại local', preflight: 'Ping oMLX',
  llm: 'LLM (oMLX)', fuse: 'Hợp nhất', cache: 'Cache',
  stat: 'Hoàn tất', error: 'Lỗi',
};

interface AnalysisLogLine {
  /** The formatted human-readable line (already includes [+Nms] prefix). */
  text: string;
  /** Pipeline phase tag — drives the color-coding in the modal. */
  phase:
    | 'init' | 'parse' | 'regex' | 'local' | 'preflight'
    | 'llm' | 'fuse' | 'cache' | 'stat' | 'error';
  /** Wall-clock milliseconds since the pipeline started. */
  wallMs?: number;
  /** Delta from the previous log line — useful for spotting slow gaps. */
  sinceLast?: number;
  /** Structured counters from the server (batch index, ETA, etc.). */
  meta?: Record<string, unknown> | null;
}

function metaToTooltip(meta: Record<string, unknown> | null | undefined): string {
  if (!meta) return '';
  return Object.entries(meta)
    .filter(([, v]) => v != null && v !== '')
    .slice(0, 10)
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join('  ');
}

function renderLogLine(line: AnalysisLogLine, idx: number, failed: boolean) {
  return (
    <li
      key={idx}
      title={metaToTooltip(line.meta) || undefined}
      className={cn(
        'flex gap-2 items-start whitespace-pre-wrap break-words',
        PHASE_CLASS[line.phase],
        failed && line.phase !== 'error' ? 'opacity-60' : '',
      )}
    >
      <span
        className="inline-block w-16 shrink-0 text-right text-slate-400 dark:text-slate-500 tabular-nums"
        aria-label="wall time"
      >
        {line.wallMs != null ? `+${(line.wallMs / 1000).toFixed(1)}s` : ''}
      </span>
      {line.sinceLast != null && line.sinceLast >= 100 ? (
        <span
          className="inline-block w-14 shrink-0 text-right text-slate-400 dark:text-slate-500 tabular-nums"
          aria-label="delta since last line"
          title={`Δ since previous line: ${line.sinceLast}ms`}
        >
          Δ{line.sinceLast < 1000 ? `${line.sinceLast}ms` : `${(line.sinceLast / 1000).toFixed(1)}s`}
        </span>
      ) : (
        <span className="inline-block w-14 shrink-0" aria-hidden="true" />
      )}
      <span
        className={cn(
          'inline-block w-20 shrink-0 tracking-wide text-[10px] font-semibold uppercase',
          'rounded px-1 py-0.5 border border-border',
          PHASE_BG[line.phase],
        )}
      >
        {PHASE_LABEL[line.phase]}
      </span>
      <span className="flex-1 min-w-0">{line.text}</span>
    </li>
  );
}

function BatchProgressCard({ lines }: { lines: AnalysisLogLine[] }) {
  const first = lines[0];
  const last = lines[lines.length - 1];
  const lastMeta = (last.meta ?? {}) as Record<string, unknown>;
  const firstMeta = (first.meta ?? {}) as Record<string, unknown>;
  const totalBatches = (lastMeta.totalBatches ?? firstMeta.totalBatches ?? 0) as number;
  const succeeded = (lastMeta.succeeded ?? 0) as number;
  const failedBatches = (lastMeta.failedBatches ?? 0) as number;
  const completed = succeeded + failedBatches;
  const pct = totalBatches > 0 ? Math.min(100, Math.round((completed / totalBatches) * 100)) : 0;
  const wallStart = first.wallMs ?? 0;
  const wallEnd = last.wallMs ?? 0;
  const durMs = wallEnd - wallStart;
  const durStr = durMs < 1000 ? `${durMs}ms` : `${(durMs / 1000).toFixed(1)}s`;
  return (
    <li
      className={cn(
        'rounded-md border border-border px-3 py-2 my-1',
        'bg-amber-500/5 border-amber-500/30',
      )}
    >
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={cn(
              'inline-block tracking-wide text-[10px] font-semibold uppercase rounded px-1 py-0.5 border border-border',
              PHASE_BG.llm,
            )}
          >
            LLM
          </span>
          <span className="text-xs font-medium text-amber-800 dark:text-amber-200">
            {lines.length === 1
              ? `Batch ${firstMeta.batchIndex}/${totalBatches || '?'}`
              : `Batches ${firstMeta.batchIndex}–${lastMeta.batchIndex} / ${totalBatches || '?'}`}
          </span>
          <span className="text-[10px] text-slate-500 dark:text-slate-400 tabular-nums">
            · {completed}/{totalBatches} done ({succeeded}✓ {failedBatches}✗)
          </span>
        </div>
        <span className="text-[10px] text-slate-500 dark:text-slate-400 tabular-nums shrink-0">
          +{(wallStart / 1000).toFixed(1)}s → +{(wallEnd / 1000).toFixed(1)}s · {durStr}
        </span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-slate-300/40 dark:bg-slate-700/40 overflow-hidden flex">
        <div
          className="h-full bg-emerald-500 transition-all"
          style={{ width: `${totalBatches > 0 ? (succeeded / totalBatches) * 100 : 0}%` }}
        />
        {failedBatches > 0 && (
          <div
            className="h-full bg-red-500 transition-all"
            style={{ width: `${(failedBatches / totalBatches) * 100}%` }}
          />
        )}
      </div>
      <div className="flex items-center justify-between mt-1">
        <span className="text-[10px] text-slate-500 dark:text-slate-400 tabular-nums">
          {pct}% hoàn thành
        </span>
        {failedBatches > 0 && (
          <span className="text-[10px] text-red-600 dark:text-red-400">
            ⚠ {failedBatches} batch thất bại
          </span>
        )}
      </div>
    </li>
  );
}

function HumanLogSummary({ lines, failed, mutedCls }: {
  lines: AnalysisLogLine[];
  failed: boolean;
  mutedCls: string;
}) {
  const phaseMap = new Map<AnalysisLogLine['phase'], AnalysisLogLine>();
  for (const l of lines) phaseMap.set(l.phase, l);
  const order: AnalysisLogLine['phase'][] = [
    'init', 'parse', 'regex', 'local', 'preflight', 'llm', 'fuse', 'cache', 'stat',
  ];
  const cards = order
    .filter((p) => phaseMap.has(p))
    .map((p) => ({ phase: p, line: phaseMap.get(p)! }));
  if (failed) {
    const errLine = lines.find((l) => l.phase === 'error');
    if (errLine) cards.push({ phase: 'error', line: errLine });
  }
  return (
    <div data-testid="analyzer-log-human" className="space-y-2">
      {cards.map(({ phase, line }) => {
        const m = (line.meta ?? {}) as Record<string, unknown>;
        const stats: Array<[string, string]> = [];
        if (typeof m.bookId === 'string') stats.push(['book', m.bookId.slice(0, 8)]);
        if (typeof m.chapterId === 'string') stats.push(['chapter', m.chapterId]);
        if (typeof m.htmlChars === 'number') stats.push(['html', `${m.htmlChars.toLocaleString()} chars`]);
        if (typeof m.characterCount === 'number') stats.push(['nhân vật', String(m.characterCount)]);
        if (typeof m.paragraphCount === 'number') stats.push(['đoạn', String(m.paragraphCount)]);
        if (typeof m.sentenceCount === 'number') stats.push(['câu', String(m.sentenceCount)]);
        if (typeof m.regexHits === 'number') stats.push(['regex hits', String(m.regexHits)]);
        if (typeof m.resolved === 'number') stats.push(['resolved', String(m.resolved)]);
        if (typeof m.totalParagraphs === 'number') stats.push(['total', String(m.totalParagraphs)]);
        if (typeof m.resolvedPct === 'string') stats.push(['resolved %', m.resolvedPct]);
        if (typeof m.unresolved === 'number') stats.push(['cần LLM', String(m.unresolved)]);
        if (typeof m.durationMs === 'number') stats.push(['thời gian', m.durationMs < 1000 ? `${m.durationMs}ms` : `${(m.durationMs / 1000).toFixed(1)}s`]);
        if (typeof m.reachable === 'boolean') stats.push(['oMLX', m.reachable ? 'reachable ✓' : 'UNREACHABLE ✗']);
        if (typeof m.requested === 'number') stats.push(['LLM requested', String(m.requested)]);
        if (typeof m.succeeded === 'number' && typeof m.totalBatches === 'number') stats.push(['LLM ok', `${m.succeeded}/${m.totalBatches}`]);
        if (typeof m.failedBatches === 'number' && m.failedBatches > 0) stats.push(['LLM fail', String(m.failedBatches)]);
        if (typeof m.llmDelta === 'number') stats.push(['LLM added', m.llmDelta > 0 ? `+${m.llmDelta}` : String(m.llmDelta)]);
        if (typeof m.persistedRows === 'number') stats.push(['lưu cache', `${m.persistedRows} dòng`]);
        if (typeof m.totalDurationMs === 'number') stats.push(['tổng', m.totalDurationMs < 1000 ? `${m.totalDurationMs}ms` : `${(m.totalDurationMs / 1000).toFixed(1)}s`]);
        return (
          <div
            key={phase}
            className={cn(
              'rounded-md border border-border px-3 py-2',
              PHASE_BG[phase],
              phase === 'error' ? 'border-red-500/50' : '',
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <span className="inline-block tracking-wide text-[10px] font-semibold uppercase rounded px-1.5 py-0.5 border border-border border-current/30">
                  {PHASE_LABEL[phase]}
                </span>
                <span className="text-sm font-medium truncate">{PHASE_VN[phase]}</span>
              </div>
              {line.wallMs != null && (
                <span className={cn('text-[10px] tabular-nums shrink-0', mutedCls)}>
                  +{(line.wallMs / 1000).toFixed(1)}s
                </span>
              )}
            </div>
            <div className="mt-1 text-xs leading-relaxed">{line.text}</div>
            {stats.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] tabular-nums">
                {stats.map(([k, v]) => (
                  <span key={k} className="inline-flex items-center gap-1">
                    <span className="opacity-60">{k}:</span>
                    <span className="font-medium">{v}</span>
                  </span>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Tiny client-side paragraph splitter ─────────────────────────────────
// Used only as a fallback for the attribution-debug modal when the chapter
// API doesn't return the structured `paragraphs[]` field (raw HTML mode).
// Matches the server's sliceParagraphs() closely enough that paragraph
// indices line up with the attribution map; small differences are
// tolerable because the modal is for inspection, not as the source of truth.
function clientSplitParagraphs(html: string): string[] {
  // Strip block tags into newlines so each becomes a paragraph candidate.
  const withBreaks = html
    .replace(/<\s*\/?\s*(p|div|h[1-6]|li|blockquote|br|hr)\s*\/?\s*>/gi, '\n')
    .replace(/<br\s*\/?\s*>/gi, '\n');
  // Strip remaining tags.
  const textOnly = withBreaks.replace(/<[^>]+>/g, ' ');
  // Split on blank lines OR single newlines for tight layouts.
  const blocks = textOnly.split(/\n+/).map((s) => s.replace(/\s+/g, ' ').trim()).filter((s) => s.length > 0);
  return blocks;
}

// ── Hoisted types shared with AttributionDebugModal ────────────────────
export interface AttributionRow {
  speaker: string | null;
  confidence: number;
  source: string;
}
export type AttributionMap = Record<number, AttributionRow>;

export interface AnalysisResult {
  chapterId: string;
  chapterTitle: string;
  mode: AnalyzeMode;
  stats: {
    regexHits: number; llmHits: number;
    conversationHits: number; sourceDrift: number;
    defaults: number; totalParagraphs: number;
    llmFailures?: number; llmRequested?: number;
  };
  omlxReachable: boolean;
  durationMs: number;
  llmDurationMs: number;
  log: AnalysisLogLine[];
  attribution?: AttributionMap;
  layers?: {
    regex: AttributionMap;
    local: AttributionMap;
    llm: AttributionMap;
  };
  paragraphTexts?: string[];
  failed: boolean;
  errorMsg?: string;
  running?: boolean;
}

// ── AttributionDebugModal ──────────────────────────────────────────────
// Shows the per-paragraph result of a Full Analyzer run in a scrollable,
// filterable table. Each row has: paragraph index, text preview, assigned
// speaker, confidence, source (parser/regex/llm/conversation/default).
//
// Distinct from `VoiceDebugPanel`, which only surfaces voice-map resolution
// (paragraph → voice name → voice-id). This one is the upstream truth:
// "what did the analyzer decide, per paragraph?"
//
// Opens automatically after a successful Full Analyzer run, and is also
// reachable via the "Xem gán vai" button in the analyzer modal footer.
//
// Filters:
//   • Source   — show only rows from a given evidence layer
//   • Speaker  — show only rows assigned to a specific character
//   • Search   — substring match against paragraph text
//
// Sorts: by paragraph index (default) or by confidence (asc/desc).
function AttributionDebugModal(props: {
  open: boolean;
  onClose: () => void;
  data: AnalysisResult | null;
  paragraphs: string[];
  /** Optional click handler: jump to the paragraph in the reader. */
  onJumpToParagraph?: (paragraphIndex: number) => void;
  mutedCls: string;
  dividerCls: string;
  panelCls: string;
  hoverCls: string;
  activeCls: string;
}) {
  const { open, onClose, data, paragraphs, onJumpToParagraph, mutedCls, dividerCls, panelCls, hoverCls } = props;
  const [sourceFilter, setSourceFilter] = useState<'all' | string>('all');
  const [speakerFilter, setSpeakerFilter] = useState<'all' | string>('all');
  const [textQuery, setTextQuery] = useState('');
  const [sortBy, setSortBy] = useState<'paragraph' | 'confidence-asc' | 'confidence-desc'>('paragraph');

  // Reset filters whenever a new result comes in.
  useEffect(() => {
    if (open) {
      setSourceFilter('all');
      setSpeakerFilter('all');
      setTextQuery('');
      setSortBy('paragraph');
    }
  }, [open, data?.chapterId, data?.durationMs]);

  // ESC closes the modal.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!data || !open) return null;

  // The server ships `attribution` / `layers` with STRING keys (JSON object
  // keys are always strings, even when the original TS layer typed them as
  // numbers). Look up by `String(i)` rather than `[i]`.
  const lookup = <T,>(m: Record<number, T> | undefined, i: number): T | undefined => {
    if (!m) return undefined;
    // Cast through `unknown` — the TS type lies here because JSON keys
    // are always strings; both the server and this client serialize
    // paragraph indices via JSON, so the wire shape is `Record<string,T>`.
    return (m as unknown as Record<string, T>)[String(i)];
  };

  // Build the row set: one entry per paragraph index (0..total-1), even
  // if no attribution row exists for it (those show as "—" / default).
  const totalParagraphs = data.stats.totalParagraphs || paragraphs.length || 0;
  const rows: Array<{
    idx: number;
    text: string;
    finalSpeaker: string | null;
    finalConfidence: number;
    finalSource: string;
    // Per-layer answer for the "show evidence" toggle.
    regex: string | null;
    local: string | null;
    llm: string | null;
  }> = [];
  for (let i = 0; i < totalParagraphs; i++) {
    const finalRow  = lookup(data.attribution, i);
    const regexRow  = lookup(data.layers?.regex, i);
    const localRow  = lookup(data.layers?.local, i);
    const llmRow    = lookup(data.layers?.llm, i);
    rows.push({
      idx: i,
      text: paragraphs[i] ?? `(${i})`,
      finalSpeaker: finalRow?.speaker ?? null,
      finalConfidence: finalRow?.confidence ?? 0,
      finalSource: finalRow?.source ?? 'default',
      regex: regexRow?.speaker ?? null,
      local: localRow?.speaker ?? null,
      llm: llmRow?.speaker ?? null,
    });
  }

  // Collect unique speakers for the dropdown (from final attribution + layers).
  const speakerSet = new Set<string>();
  for (const r of rows) {
    if (r.finalSpeaker) speakerSet.add(r.finalSpeaker);
    for (const s of [r.regex, r.local, r.llm]) {
      if (s) speakerSet.add(s);
    }
  }
  const speakers = Array.from(speakerSet).sort((a, b) => a.localeCompare(b));

  // Filter.
  const filtered = rows.filter((r) => {
    if (sourceFilter !== 'all' && r.finalSource !== sourceFilter) return false;
    if (speakerFilter !== 'all' && r.finalSpeaker !== speakerFilter) return false;
    if (textQuery) {
      const q = textQuery.toLowerCase();
      if (!r.text.toLowerCase().includes(q)) return false;
    }
    return true;
  });
  // Sort.
  if (sortBy === 'confidence-asc') {
    filtered.sort((a, b) => a.finalConfidence - b.finalConfidence);
  } else if (sortBy === 'confidence-desc') {
    filtered.sort((a, b) => b.finalConfidence - a.finalConfidence);
  } else {
    filtered.sort((a, b) => a.idx - b.idx);
  }

  // Source counts (for the filter dropdown labels).
  const sourceCounts: Record<string, number> = {};
  for (const r of rows) sourceCounts[r.finalSource] = (sourceCounts[r.finalSource] ?? 0) + 1;

  // Speaker counts.
  const speakerCounts: Record<string, number> = {};
  for (const r of rows) {
    if (r.finalSpeaker) speakerCounts[r.finalSpeaker] = (speakerCounts[r.finalSpeaker] ?? 0) + 1;
  }

  const SOURCE_COLOR: Record<string, string> = {
    parser:       'bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/30',
    regex:        'bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 border-indigo-500/30',
    conversation: 'bg-purple-500/15 text-purple-700 dark:text-purple-300 border-purple-500/30',
    llm:          'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30',
    default:      'bg-muted text-muted-foreground border border-border border-border',
  };

  return (
    <div
      data-testid="attribution-debug-modal"
      role="dialog"
      aria-label="Attribution debug"
      // Right-side slide-over panel (was a centered modal with a full-screen
      // backdrop, but that hid the Voice assignment debug panel on the
      // left). No backdrop now — both side panels stay visible at the same
      // time after a Full Analyzer run. Slides in from the right.
      className={cn(
        'fixed inset-y-0 right-0 z-[60] flex flex-col w-[min(640px,55vw)] max-w-full h-full shadow-2xl border-l overflow-hidden transition-transform duration-200 ease-in-out',
        panelCls,
        'translate-x-0',
      )}
      onClick={(e) => e.stopPropagation()}
    >
        {/* Header */}
        <div className={cn('flex items-center justify-between px-5 py-3 border-b shrink-0', dividerCls)}>
          <div className="flex items-center gap-2 min-w-0">
            <Eye className="h-4 w-4 text-primary shrink-0" />
            <h3 className="font-semibold text-sm truncate">
              Attribution Debug — {data.chapterTitle ?? data.chapterId}
            </h3>
            <span className={cn('text-[11px] tabular-nums shrink-0', mutedCls)}>
              {filtered.length}/{rows.length} đoạn
            </span>
            <span className={cn('text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border border-border shrink-0', SOURCE_COLOR[data.mode] ?? SOURCE_COLOR.default)}>
              {data.mode}
            </span>
          </div>
          <button
            onClick={onClose}
            aria-label="Close attribution debug modal"
            className={cn('rounded p-1', hoverCls)}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Filter bar */}
        <div className={cn('flex flex-wrap items-center gap-2 px-5 py-2 border-b text-xs shrink-0', dividerCls)}>
          <Filter className="h-3.5 w-3.5 opacity-60" />
          {/* Source filter */}
          <select
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value)}
            className={cn('rounded border border-border px-2 py-1 text-[11px]', dividerCls)}
            aria-label="Filter by source"
          >
            <option value="all">Source: tất cả ({rows.length})</option>
            {Object.entries(sourceCounts)
              .sort((a, b) => b[1] - a[1])
              .map(([src, count]) => (
                <option key={src} value={src}>{src} ({count})</option>
              ))}
          </select>
          {/* Speaker filter */}
          <select
            value={speakerFilter}
            onChange={(e) => setSpeakerFilter(e.target.value)}
            className={cn('rounded border border-border px-2 py-1 text-[11px]', dividerCls)}
            aria-label="Filter by speaker"
          >
            <option value="all">Speaker: tất cả</option>
            {speakers.map((s) => (
              <option key={s} value={s}>
                {s} ({speakerCounts[s] ?? 0})
              </option>
            ))}
          </select>
          {/* Text search */}
          <div className="relative flex-1 min-w-[160px]">
            <Search className="h-3 w-3 absolute left-2 top-1/2 -translate-y-1/2 opacity-50" />
            <input
              type="search"
              value={textQuery}
              onChange={(e) => setTextQuery(e.target.value)}
              placeholder="Tìm trong text đoạn…"
              className={cn('w-full rounded border border-border pl-7 pr-2 py-1 text-[11px]', dividerCls)}
              aria-label="Search paragraph text"
            />
          </div>
          {/* Sort */}
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
            className={cn('rounded border border-border px-2 py-1 text-[11px]', dividerCls)}
            aria-label="Sort by"
          >
            <option value="paragraph">Sort: ¶ index</option>
            <option value="confidence-desc">Sort: confidence ↓</option>
            <option value="confidence-asc">Sort: confidence ↑</option>
          </select>
        </div>

        {/* Table */}
        <div className="flex-1 min-h-0 overflow-auto">
          {filtered.length === 0 ? (
            <div className={cn('p-8 text-center text-sm', mutedCls)}>
              Không có đoạn nào khớp filter.
            </div>
          ) : (
            <table className="w-full text-xs">
              <thead className={cn('sticky top-0 z-10', dividerCls, panelCls)}>
                <tr className="text-[10px] uppercase tracking-wide">
                  <th className="text-right px-3 py-2 w-12 font-medium">¶</th>
                  <th className="text-left px-3 py-2 font-medium">Đoạn văn</th>
                  <th className="text-left px-3 py-2 w-44 font-medium">Speaker</th>
                  <th className="text-right px-3 py-2 w-20 font-medium">Conf</th>
                  <th className="text-left px-3 py-2 w-28 font-medium">Source</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <tr
                    key={r.idx}
                    className={cn(
                      'border-b',
                      dividerCls,
                      r.finalSpeaker === null ? 'opacity-60' : '',
                      'hover:bg-muted/30',
                      onJumpToParagraph ? 'cursor-pointer' : '',
                    )}
                    onClick={() => onJumpToParagraph?.(r.idx)}
                    title={onJumpToParagraph ? `Click để nhảy tới đoạn ${r.idx}` : undefined}
                  >
                    <td className="text-right px-3 py-1.5 tabular-nums align-top text-slate-500">
                      {r.idx}
                    </td>
                    <td className="px-3 py-1.5 align-top">
                      <div className={cn('line-clamp-2 leading-relaxed', mutedCls)}>
                        {r.text}
                      </div>
                      {/* Per-layer evidence — collapsed inline to keep the
                          row scannable. Click to expand? Keep simple for
                          now: show as small badges under the text. */}
                      {(r.regex || r.local || r.llm) && (
                        <div className="mt-1 flex flex-wrap gap-1 text-[9px]">
                          {r.regex && (
                            <span className="px-1 rounded bg-indigo-500/10 text-indigo-700 dark:text-indigo-300">
                              regex: {r.regex}
                            </span>
                          )}
                          {r.local && (
                            <span className="px-1 rounded bg-purple-500/10 text-purple-700 dark:text-purple-300">
                              local: {r.local}
                            </span>
                          )}
                          {r.llm && (
                            <span className="px-1 rounded bg-amber-500/10 text-amber-700 dark:text-amber-300">
                              llm: {r.llm}
                            </span>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-1.5 align-top">
                      {r.finalSpeaker
                        ? (
                          <span className="inline-flex items-center gap-1 text-[11px] font-medium">
                            <User className="h-3 w-3 opacity-60" />
                            {r.finalSpeaker}
                          </span>
                        )
                        : <span className={cn('text-[11px] italic', mutedCls)}>(no speaker — default voice)</span>}
                    </td>
                    <td className="text-right px-3 py-1.5 tabular-nums align-top">
                      {r.finalConfidence > 0
                        ? `${(r.finalConfidence * 100).toFixed(0)}%`
                        : '—'}
                    </td>
                    <td className="px-3 py-1.5 align-top">
                      <span
                        className={cn(
                          'inline-block px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide border border-border',
                          SOURCE_COLOR[r.finalSource] ?? SOURCE_COLOR.default,
                        )}
                      >
                        {r.finalSource}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer with summary */}
        <div className={cn('flex items-center justify-between gap-2 px-5 py-2 border-t text-[11px] shrink-0', dividerCls)}>
          <div className={cn('flex flex-wrap gap-x-3', mutedCls)}>
            {Object.entries(sourceCounts)
              .sort((a, b) => b[1] - a[1])
              .map(([src, count]) => (
                <span key={src} className="inline-flex items-center gap-1">
                  <span className={cn('inline-block w-2 h-2 rounded-sm', SOURCE_COLOR[src]?.split(' ')[0] ?? 'bg-muted-foreground')} />
                  <span>{src}: {count}</span>
                </span>
              ))}
          </div>
          <span className={cn('tabular-nums', mutedCls)}>
            {data.durationMs ? `${(data.durationMs / 1000).toFixed(1)}s total` : ''}
          </span>
        </div>
    </div>
  );
}

export function EbookReader({ bookId, bookTitle, initialChapter, initialProgress = 0 }: EbookReaderProps) {
  const [chapters, setChapters]   = useState<Chapter[]>([]);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [loading, setLoading]     = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [settings, setSettings]   = useState<ReaderSettings>(DEFAULT_SETTINGS);
  const [tocOpen, setTocOpen]     = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [bookmarksOpen, setBookmarksOpen] = useState(false);
  const [tocSearch, setTocSearch] = useState('');
  const [jumpInput, setJumpInput] = useState('');
  const [bookmarks, setBookmarks] = useState<number[]>([]);
  // Voice-assignment debug panel — shows detected speaker + voice name per
  // paragraph so we can tell whether mis-routing is from the attribution
  // logic (speaker = wrong) or the voice map (speaker = right but voiceName
  // resolves wrong).
  const [voiceDebugOpen, setVoiceDebugOpen] = useState(false);
  // Attribution debug modal: shows per-paragraph what role was assigned
  // (speaker + confidence + source). Distinct from voiceDebugOpen, which
  // only shows the voice-map resolution. Auto-opens after a successful
  // Full Analyzer run so the user can immediately inspect the result.
  const [attributionDebugOpen, setAttributionDebugOpen] = useState(false);
  // Bumped every time the in-memory attribution cache is updated by a
  // Full Analyzer run. Passed to `VoiceDebugPanel` as a useMemo-dep so
  // the panel recomputes its rows when fresh attribution arrives — a ref
  // mutation alone wouldn't trigger a re-render.
  const [attributionRefreshTick, setAttributionRefreshTick] = useState(0);
  // Mode picker state — what the user picked for the next Full Analyzer
  // run. Persists to localStorage so the choice survives reloads.
  const ANALYZER_MODE_KEY = 'analyzer-mode';
  const [analyzerMode, setAnalyzerMode] = useState<AnalyzeMode>('combine');
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(ANALYZER_MODE_KEY);
      if (raw === 'combine' || raw === 'full-llm' || raw === 'local-only') setAnalyzerMode(raw);
    } catch { /* */ }
  }, []);
  const setAnalyzerModePersist = (m: AnalyzeMode) => {
    setAnalyzerMode(m);
    try { window.localStorage.setItem(ANALYZER_MODE_KEY, m); } catch { /* */ }
  };
  // Whether the dropdown next to the Wand2 button is open. Closes on
  // outside click + ESC + after a mode is picked.
  const [analyzerModePickerOpen, setAnalyzerModePickerOpen] = useState(false);
  const analyzerModeBtnRef = useRef<HTMLDivElement | null>(null);
  // ── Full-LLM pre-flight confirm (added 2026-07-12) ───────────────────
  // 'full-llm' mode sends the ENTIRE chapter in a single LLM call. On
  // chapters >300 paragraphs that's slow, expensive, and all-or-nothing on
  // failure — so we show a soft-warn Dialog before launching it. Users who
  // already have a recent cached `paragraphTexts` (from a prior analyze
  // run or the read-aloud ttsParagraphs) skip the lazy fetch entirely.
  const [fullLLMPending, setFullLLMPending] = useState(false);
  // Ref-based continuation flag. A Dialog confirm shouldn't re-enter
  // `runFullAnalysis` synchronously (React batches the state flips, and
  // gating via state alone is racy). After the user clicks "Chạy Full LLM"
  // we set this ref; the next call sees it and bypasses the gate.
  const pendingContinueFullLLMRef = useRef(false);
  const [fullLLMEstimate, setFullLLMEstimate] = useState<{
    paragraphCount: number;
    chapterCharCount: number;
    estimatedSeconds: number;
    estimatedOutputTokens: number;
  } | null>(null);
  // Heuristic cost estimate, computed per chapter when the user lands on
  // it. We don't fetch on every render — only when `currentIdx` changes,
  // and only if we don't already have paragraph text in cache.
  useEffect(() => {
    const chapterId = chapters[currentIdx]?.id;
    if (!chapterId) { setFullLLMEstimate(null); return; }
    // Best case: paragraph texts already cached from a prior analyzer run
    // or from a prior full-library reload. The reader keeps these in
    // `chapterAttributionRef` as Record<number, string>.
    const cached = chapterAttributionRef.current.get(chapterId);
    if (cached?.paragraphTexts) {
      const texts = Object.values(cached.paragraphTexts);
      if (texts.length > 0) {
        const charCount = texts.reduce((s, t) => s + t.length, 0);
        setFullLLMEstimate(estimateFullLLM(texts.length, charCount));
        return;
      }
    }
    // Fallback: lazy fetch the chapter HTML and approximate paragraph count
    // by counting <p> tags. We do NOT import `sliceParagraphs` from
    // `@/lib/attribution` because that module transitively re-exports
    // `chatJSON` → `omlx-client.ts` → `node-fetch` → `node:net`, which
    // trips Next.js webpack when bundled into the client. The `?<p>` regex
    // is good enough for a soft-warn heuristic (the dialog only fires at
    // >300 paragraphs so ±50% error is fine).
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch(
          `/api/library/${bookId}/chapters/${encodeURIComponent(chapterId)}?raw=1`,
        );
        if (!r.ok || cancelled) return;
        const { html } = await r.json() as { html?: string };
        if (cancelled || !html) return;
        // Count `<p` opening tags (case-insensitive, allow attributes).
        const tagRe = /<p\b[^>]*>/gi;
        let paraCount = 0;
        while (tagRe.exec(html) !== null) paraCount++;
        // Approximate char count = strip ALL tags then measure body length.
        const bodyOnly = html.replace(/<[^>]+>/g, '');
        setFullLLMEstimate(estimateFullLLM(paraCount, bodyOnly.length));
      } catch { /* offline or 404 — leave estimate null, dialog won't show */ }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId, currentIdx, chapters]);
  useEffect(() => {
    if (!analyzerModePickerOpen) return;
    const onClick = (e: MouseEvent) => {
      if (!analyzerModeBtnRef.current) return;
      if (!analyzerModeBtnRef.current.contains(e.target as Node)) {
        setAnalyzerModePickerOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAnalyzerModePickerOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [analyzerModePickerOpen]);
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
  const [abTab, setAbTab] = useState<'readAloud' | 'audiobook' | 'voices' | 'characters'>('readAloud');
  // Keyboard shortcuts overlay (UI Polish §5.3) — opened by pressing
  // '?' anywhere in the reader. Mirrors the legend shown in tooltips.
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // ── TTS ──────────────────────────────────────────────────
  type TtsState = 'idle' | 'loading' | 'playing' | 'paused';

  interface TtsVoice {
    id: string;
    name: string;
    isCustom?: boolean;
  }

  // ── Vietnamese Voice built-in voices (VieNeu-TTS under the hood, 48 kHz) ─────
  // Source: `src/lib/tts/vieneu-voices.ts` — synced from the upstream catalog
  // at `app/tts-service/VieNeu-TTS/src/vieneu/assets/voices_v3_turbo.json`.
  const VIENEU_VOICES: TtsVoice[] = VIENEU_TTS_VOICES.map((v) => ({ id: v.id, name: v.name }));

  // Default voice (centre of the spectrum — easy to listen to)
  const [ttsState, setTtsState]           = useState<TtsState>('idle');
  // Last read-aloud warning surfaced as a chip in the status bar so a
  // non-developer can see "why did my play button do nothing" without
  // opening DevTools. Cleared automatically on each successful /api/tts.
  const [ttsLastError, setTtsLastError]   = useState<string | null>(null);
  const [ttsParagraphs, setTtsParagraphs] = useState<string[]>([]);
  const [ttsIndex, setTtsIndex]           = useState(0);
  const [ttsSpeed, setTtsSpeed]           = useState(1.0);
  const [ttsVoice, setTtsVoice]           = useState<string>('Xuân Vĩnh');
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
  // Regex / LLM per-paragraph attribution map keyed by chapterId.
  // Fetched lazily by loadChapterAttribution() so we don't slow down the
  // initial chapter paint. detectSpeaker() consults this first and only
  // falls back to the local 6-pass regex when the map has no entry.
  const chapterAttributionRef = useRef<
    Map<string, {
      attribution: Record<number, { speaker: string | null; confidence: number; source: string }>;
      /** Per-layer per-paragraph maps from the most recent Full Analyzer
       *  run. VoiceDebugPanel reads these to render "regex:/local:/llm:"
       *  chips next to each paragraph — same evidence the analyzer modal
       *  shows. */
      layers?: {
        regex: Record<number, { speaker: string | null; confidence: number; source: string }>;
        local: Record<number, { speaker: string | null; confidence: number; source: string }>;
        llm: Record<number, { speaker: string | null; confidence: number; source: string }>;
      };
      /** Paragraph texts from the most recent analyzer run, indexed by
       *  paragraph index. VoiceDebugPanel prefers these over `ttsParagraphs`
       *  (which only populates once TTS starts) so the panel can render
       *  rows immediately after a Full Analyzer, before the user hits
       *  "Read aloud". Set at the same time as `attribution` — same
       *  freshness semantics. */
      paragraphTexts?: Record<number, string>;
      fromCache: boolean;
      crossChapter?: {
        seedApplied: boolean;
        seedReason: 'applied' | 'no-row' | 'stale-chapter' | 'version-mismatch' | 'empty';
        seedFromChapterIndex: number | null;
        seedLastSpeaker: string | null;
        persistedAt: number | null;
      };
      // G4: novel proper-noun candidates detected across the chapter.
      // Surfaced in VoiceDebugPanel so the user can register them
      // before they accumulate as unresolved-actor rows.
      potentialNewCharacters?: string[];
    }>
  >(new Map());
  const chapterAttributionInFlightRef = useRef<Set<string>>(new Set());
  const [chapterAttributionStats, setChapterAttributionStats] =
    useState<{
      chapterId: string;
      regexHits: number;
      llmHits: number;
      conversationHits: number;
      sourceDrift?: number;
      defaults: number;
      fromCache: boolean;
      omlxReachable: boolean;
    } | null>(null);
  // ── Full-analysis (regex + LLM) state ──────────────────────────────
  // Set by the Wand2 toolbar button. Drives the in-flight spinner and the
  // progress hint. Reset to null when the chapter changes.
  const [analysisInFlight, setAnalysisInFlight] = useState(false);
  const [analysisProgress, setAnalysisProgress] = useState<string | null>(null);
  // Full Analyzer result modal: holds the stats + per-step log returned by
  // /api/library/.../attribute/analyze. Opened after a successful run.
  // Non-null → modal visible.
  // (AnalysisLogLine is hoisted to module scope above so the helper
  // subcomponents PHASE_CLASS / renderLogLine / BatchProgressCard /
  // HumanLogSummary can share the type.)
  // NOTE: AttributionRow / AttributionMap / AnalysisResult are hoisted to
  // module scope above so the AttributionDebugModal can share them.
  const [analysisModal, setAnalysisModal] = useState<AnalysisResult | null>(null);
  const [logCopied, setLogCopied] = useState(false);
  // 'verbose' = every line shown as-is; 'grouped' = collapse adjacent batch
  // events into a single progress card; 'human' = summarize the whole run
  // into a small timeline of phase badges + key numbers. Persists to
  // localStorage so the user's preference survives a reload.
  const ANALYZER_LOG_MODE_KEY = 'analyzer-log-mode';
  const [logMode, setLogMode] = useState<'verbose' | 'grouped' | 'human'>('grouped');
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(ANALYZER_LOG_MODE_KEY);
      if (raw === 'verbose' || raw === 'grouped' || raw === 'human') setLogMode(raw);
    } catch { /* */ }
  }, []);
  const setLogModePersist = (m: 'verbose' | 'grouped' | 'human') => {
    setLogMode(m);
    try { window.localStorage.setItem(ANALYZER_LOG_MODE_KEY, m); } catch { /* */ }
  };
  const analysisLogRef = useRef<HTMLOListElement | null>(null);
  // "Follow tail" toggle: when on, the analyzer log auto-scrolls to the latest
  // line on every streaming update. When off, the user's scroll position is
  // preserved so they can read older lines without being yanked to the bottom.
  // Persisted to localStorage so the choice survives reloads.
  const ANALYZER_AUTO_SCROLL_KEY = 'analyzer-auto-scroll';
  const [autoScrollLog, setAutoScrollLog] = useState<boolean>(true);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(ANALYZER_AUTO_SCROLL_KEY);
      if (raw === '0' || raw === 'false') setAutoScrollLog(false);
    } catch { /* */ }
  }, []);
  const setAutoScrollLogPersist = (next: boolean) => {
    setAutoScrollLog(next);
    try { window.localStorage.setItem(ANALYZER_AUTO_SCROLL_KEY, next ? '1' : '0'); } catch { /* */ }
  };
  // AbortController for the in-flight SSE fetch — lets the user cancel by
  // closing the modal / clicking the close button / pressing ESC mid-run
  // rather than waiting 60-180s for the server to finish.
  const analysisAbortRef = useRef<AbortController | null>(null);
  // ── Resizable panel width ─────────────────────────────────────────────
  // Default bumped from 26rem (≈416px) to 44rem (≈704px) so the long batch
  // lines ("Batch 12/60 ✓ success · [44,45,46,47] · 18234ms · 12/60 done
  // (12✓ 0✗) · ETA ~88s") don't wrap awkwardly. User can drag the left edge
  // to make it narrower (down to 24rem) or wider (up to 80vw). Persists to
  // localStorage so the choice sticks across reloads.
  const ANALYZER_PANEL_WIDTH_KEY = 'analyzer-panel-width-px';
  const ANALYZER_PANEL_DEFAULT_PX = 704;       // 44rem
  const ANALYZER_PANEL_MIN_PX = 384;           // 24rem — narrower than this and copy buttons clip
  const ANALYZER_PANEL_MAX_RATIO = 0.85;       // never cover more than 85% of viewport
  const [analyzerPanelWidth, setAnalyzerPanelWidth] = useState<number>(ANALYZER_PANEL_DEFAULT_PX);
  // Load persisted width on mount (avoids SSR mismatch since we render the
  // modal client-side via createPortal anyway).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(ANALYZER_PANEL_WIDTH_KEY);
      if (raw) {
        const n = parseInt(raw, 10);
        if (!Number.isNaN(n) && n >= ANALYZER_PANEL_MIN_PX) setAnalyzerPanelWidth(n);
      }
    } catch { /* localStorage denied — silent */ }
  }, []);
  const persistPanelWidth = (px: number) => {
    try { window.localStorage.setItem(ANALYZER_PANEL_WIDTH_KEY, String(px)); } catch { /* */ }
  };
  // Drag-resize state. We track pointer position + start width so we can
  // commit only on pointerup (avoiding re-render churn on every mousemove).
  const panelResizeRef = useRef<{
    startX: number;
    startWidth: number;
    rafId: number | null;
    pendingWidth: number | null;
  } | null>(null);
  const onResizeHandlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (typeof window === 'undefined') return;
    e.preventDefault();
    e.stopPropagation();
    const maxAllowed = Math.max(
      ANALYZER_PANEL_MIN_PX,
      Math.floor(window.innerWidth * ANALYZER_PANEL_MAX_RATIO),
    );
    panelResizeRef.current = {
      startX: e.clientX,
      startWidth: analyzerPanelWidth,
      rafId: null,
      pendingWidth: null,
    };
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };
  const onResizeHandlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = panelResizeRef.current;
    if (!r) return;
    e.preventDefault();
    // Since the panel is anchored to the right edge, dragging LEFT should
    // WIDEN the panel. deltaX is negative when moving left → subtract.
    const deltaX = e.clientX - r.startX;
    const maxAllowed = Math.max(
      ANALYZER_PANEL_MIN_PX,
      Math.floor(window.innerWidth * ANALYZER_PANEL_MAX_RATIO),
    );
    const next = Math.max(
      ANALYZER_PANEL_MIN_PX,
      Math.min(maxAllowed, r.startWidth - deltaX),
    );
    r.pendingWidth = next;
    if (r.rafId != null) return; // a frame is already queued
    r.rafId = window.requestAnimationFrame(() => {
      r.rafId = null;
      if (r.pendingWidth != null) setAnalyzerPanelWidth(r.pendingWidth);
    });
  };
  const onResizeHandlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = panelResizeRef.current;
    if (!r) return;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* */ }
    if (r.rafId != null) {
      window.cancelAnimationFrame(r.rafId);
      r.rafId = null;
    }
    if (r.pendingWidth != null) {
      setAnalyzerPanelWidth(r.pendingWidth);
      persistPanelWidth(r.pendingWidth);
    }
    panelResizeRef.current = null;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  };
  // Double-click the handle → snap back to the default width (handy escape
  // hatch when the user has narrowed the panel too much).
  const onResizeHandleDoubleClick = () => {
    setAnalyzerPanelWidth(ANALYZER_PANEL_DEFAULT_PX);
    persistPanelWidth(ANALYZER_PANEL_DEFAULT_PX);
  };
  // ── Resizable Audio drawer width ────────────────────────────────────
  // Same pattern as the Analyzer above: persisted to localStorage,
  // pointer-capture for the handle, rAF-coalesced updates, double-click
  // to reset. Default bumped from 26rem (416px) to 30rem (480px) because
  // the Read-aloud tab + the tab header + the close button cramped the
  // waveform / voice controls at 416px on a 13" laptop.
  const AUDIO_PANEL_WIDTH_KEY = 'audio-panel-width-px';
  const AUDIO_PANEL_DEFAULT_PX = 480;        // 30rem — wider default for breathing room
  const AUDIO_PANEL_MIN_PX = 320;            // 20rem — narrower than this and the tab labels clip
  const AUDIO_PANEL_MAX_RATIO = 0.85;        // never cover more than 85% of viewport
  const [audioPanelWidth, setAudioPanelWidth] = useState<number>(AUDIO_PANEL_DEFAULT_PX);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(AUDIO_PANEL_WIDTH_KEY);
      if (raw) {
        const n = parseInt(raw, 10);
        if (!Number.isNaN(n) && n >= AUDIO_PANEL_MIN_PX) setAudioPanelWidth(n);
      }
    } catch { /* localStorage denied — silent */ }
  }, []);
  const persistAudioPanelWidth = (px: number) => {
    try { window.localStorage.setItem(AUDIO_PANEL_WIDTH_KEY, String(px)); } catch { /* */ }
  };
  // Mobile (<640px) collapses the audio panel to full-width — dragging a
  // 320px-wide handle over a 360px viewport is unusable, so we hide the
  // resize handle and force width:100vw. Re-evaluated on resize so
  // orientation changes don't leave the panel stuck mid-state.
  const [audioPanelMobile, setAudioPanelMobile] = useState<boolean>(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mql = window.matchMedia('(max-width: 639px)');
    const sync = () => setAudioPanelMobile(mql.matches);
    sync();
    mql.addEventListener('change', sync);
    return () => mql.removeEventListener('change', sync);
  }, []);
  // Reusing panelResizeRef is unsafe — its nullable state collides with the
  // analyzer drag, so we keep a separate ref for the audio panel.
  const audioPanelResizeRef = useRef<{
    startX: number;
    startWidth: number;
    rafId: number | null;
    pendingWidth: number | null;
  } | null>(null);
  const onAudioResizeHandlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (typeof window === 'undefined') return;
    e.preventDefault();
    e.stopPropagation();
    audioPanelResizeRef.current = {
      startX: e.clientX,
      startWidth: audioPanelWidth,
      rafId: null,
      pendingWidth: null,
    };
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };
  const onAudioResizeHandlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = audioPanelResizeRef.current;
    if (!r) return;
    e.preventDefault();
    // Drawer is right-anchored → drag left → wider (deltaX negative).
    const deltaX = e.clientX - r.startX;
    const maxAllowed = Math.max(
      AUDIO_PANEL_MIN_PX,
      Math.floor(window.innerWidth * AUDIO_PANEL_MAX_RATIO),
    );
    const next = Math.max(
      AUDIO_PANEL_MIN_PX,
      Math.min(maxAllowed, r.startWidth - deltaX),
    );
    r.pendingWidth = next;
    if (r.rafId != null) return;
    r.rafId = window.requestAnimationFrame(() => {
      r.rafId = null;
      if (r.pendingWidth != null) setAudioPanelWidth(r.pendingWidth);
    });
  };
  const onAudioResizeHandlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = audioPanelResizeRef.current;
    if (!r) return;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* */ }
    if (r.rafId != null) {
      window.cancelAnimationFrame(r.rafId);
      r.rafId = null;
    }
    if (r.pendingWidth != null) {
      setAudioPanelWidth(r.pendingWidth);
      persistAudioPanelWidth(r.pendingWidth);
    }
    audioPanelResizeRef.current = null;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  };
  const onAudioResizeHandleDoubleClick = () => {
    setAudioPanelWidth(AUDIO_PANEL_DEFAULT_PX);
    persistAudioPanelWidth(AUDIO_PANEL_DEFAULT_PX);
  };
  // Auto-scroll the log to the bottom whenever a new line streams in — only if
  // the "follow tail" toggle is on. When off, the user's scroll position is
  // preserved so they can read older log lines without being yanked down.
  useEffect(() => {
    if (!autoScrollLog) return;
    const el = analysisLogRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [analysisModal?.log.length, analysisModal?.running, autoScrollLog]);
  // SSR safety for createPortal — only render portal client-side.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  useEffect(() => {
    const syncFullscreen = () => setFullscreen(document.fullscreenElement === wrapperRef.current);
    document.addEventListener('fullscreenchange', syncFullscreen);
    return () => document.removeEventListener('fullscreenchange', syncFullscreen);
  }, []);
  const [pregenStatus, setPregenStatus] = useState<{ chapterId: string; done: number; total: number } | null>(null);
  // Ref mirrors chapters[currentIdx] so async callbacks (setTimeout) always
  // see the latest chapter even after React has re-rendered with a new
  // currentIdx (e.g. during auto-advance to next chapter).
  const currentChapterRef = useRef<Chapter | null>(null);
  useEffect(() => {
    currentChapterRef.current = chapters[currentIdx] ?? null;
  }, [chapters, currentIdx]);

  // Listen for ttsWarn → surface the headline message as a chip in the
  // status bar.  Cleared on every successful /api/tts POST (see
  // prefetchParagraph).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onWarn = (e: Event) => {
      const ce = e as CustomEvent<{ message: string; full: unknown[] }>;
      setTtsLastError(ce.detail.message);
    };
    const onOk = () => setTtsLastError(null);
    window.addEventListener('tts:warn', onWarn as EventListener);
    window.addEventListener('tts:ok', onOk as EventListener);
    return () => {
      window.removeEventListener('tts:warn', onWarn as EventListener);
      window.removeEventListener('tts:ok', onOk as EventListener);
    };
  }, []);
  const [ttsCustomVoices, setTtsCustomVoices] = useState<TtsVoice[]>([]);
  const [ttsCharacterMap, setTtsCharacterMap] = useState<Record<string, string>>({}); // name|alias → voice name
  const [ttsCharacterList, setTtsCharacterList] = useState<{ name: string; voiceName?: string }[]>([]);
  const [ttsUseCharacterVoice, setTtsUseCharacterVoice] = useState(true);  // auto-switch voice per character
  const [ttsCurrentSpeaker, setTtsCurrentSpeaker] = useState<string | null>(null);
  const [ttsSettingsOpen, setTtsSettingsOpen] = useState(false);
  const [ttsUseAI, setTtsUseAI]           = useState(false);
  // Strength of auto-emotion deltas applied by detectEmotion(). 1.0 = full
  // strength (legacy behaviour — dramatic swings on every detected keyword),
  // 0.0 = detection still happens but no speed/noise deltas are applied (flat
  // base speed + base expressiveness, only the label is shown).
  // Default 0.6 was chosen after user feedback that the legacy 1.0 felt "too
  // much" — most readers prefer a gentle hint over full dramatic swings.
  // Session-only (matches ttsSpeed/ttsNoise).
  const [ttsEmotionIntensity, setTtsEmotionIntensity] = useState(0.6);
  const ttsEmotionIntensityRef = useRef(1.0);
  useEffect(() => { ttsEmotionIntensityRef.current = ttsEmotionIntensity; }, [ttsEmotionIntensity]);
  const [ttsEmotionLabel, setTtsEmotionLabel] = useState('');
  const audioRef    = useRef<HTMLAudioElement | null>(null);
  // Holds the pre-decoded next-paragraph audio so voice-change transitions
  // are gapless. While paragraph N plays, we kick off a background task
  // that fetches paragraph N+1's blob (cached usually) and decodes it
  // into an HTMLAudioElement on this ref. When N ends, speakParagraph
  // pops the preloaded element off the ref and just calls .play() —
  // no fetch, no new Audio(), no load(), no decode latency.
  // Especially important on voice changes: the prefetch cache key
  // (which includes character + voice) is different per paragraph, so
  // without this warm-up the first appearance of a new voice has to
  // pay the full fetch+create+load+decode cost mid-transition.
  const nextAudioBufferRef = useRef<{
    audio: HTMLAudioElement;
    url: string;
    idx: number;
    chapterId: string;
  } | null>(null);
  const ttsAbortRef = useRef(false);
  const ttsRunIdRef = useRef(0);
  const ttsAudioFinishRef = useRef<(() => void) | null>(null);
  const ttsStateRef = useRef<TtsState>('idle');
  // S5 fix (2026-07-08): written by speakParagraph's finish() with the
  // reason it ended ('ended' | 'manual' | 'error' | 'play-rejected'). The
  // startTts loop reads it after each iteration; a streak of consecutive
  // 'play-rejected' results (e.g. tab lost focus → every audio.play() is
  // blocked) trips a halt so we don't skip an entire chapter silently.
  const ttsLastFinishReasonRef = useRef<string>('ended');
  // Counter — incremented on each consecutive play-rejected finish,
  // reset to 0 on any other finish reason. When it reaches the threshold
  // below, the run halts and surfaces the "tab mất focus?" chip.
  const consecutivePlayRejectsRef = useRef(0);
  const MAX_CONSECUTIVE_PLAY_REJECTS = 3;
  // S4 fix (2026-07-08): tracks the current voice-generation. Bumped on
  // every ttsVoice change so the prefetch cache (keyed by voice) can be
  // dropped wholesale — old voice blobs become garbage the moment the user
  // picks a new default. Without this, switching voices N times in a 200-
  // paragraph chapter leaks N+1 blob fetches per paragraph (≈40 MB).
  const ttsVoiceGenRef = useRef(0);
  const ttsVoiceAtChangeRef = useRef<string>('Xuân Vĩnh');
  const [voiceControlSupported, setVoiceControlSupported] = useState(false);
  const [voiceControlOn, setVoiceControlOn] = useState(false);
  const voiceControlOnRef = useRef(false);
  const speechRecognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const voiceCommandHandlerRef = useRef<(text: string) => void>(() => {});
  // Tracks wall-clock of the last successfully-matched voice command so
  // we can drop duplicate / near-simultaneous transcripts. The browser
  // sometimes re-emits the same final result, and noise bursts can fire
  // several transcripts in a row — without a cooldown, the same command
  // (or a confusing stack of them) fires twice in 200ms.
  const lastVoiceCommandAtRef = useRef<number>(0);
  const VOICE_COMMAND_COOLDOWN_MS = 1500;
  const [voiceCommandText, setVoiceCommandText] = useState('');
  const [voiceCommandError, setVoiceCommandError] = useState('');
  // ── Voice preview state (the 10 default Vietnamese Voice voices) ───────────────
  const [previewingVoice, setPreviewingVoice] = useState<string | null>(null);
  const voicePreviewAudioRef = useRef<HTMLAudioElement | null>(null);

  // ── On-the-fly TTS settings (BUGFIX 2026-07-11) ───────────────────────
  // Mirrors of the read-aloud sliders/toggles, kept in sync via dedicated
  // useEffects below. They let async paths (prefetch, warmUp, the race-
  // safety generation check inside prefetchParagraph) read the *live*
  // slider value without re-rendering or capturing stale closures.
  //
  // Why each one:
  //   - ttsSpeedRef:        drive the playbackRate live-apply effect
  //                         + belt-and-suspenders re-apply after .play()
  //   - ttsNoiseRef:        read inside warmUpNextAudio's detectEmotion call
  //   - ttsUseAIRef:        same — branches the detectEmotion path
  //   - ttsContinuousPlayRef: read inside pregenerateChapter race check
  //                            (parity with ttsSpeedRef etc.)
  //   - ttsParagraphGapRef: captured in the gap setTimeout so the next
  //                         paragraph's gap reflects the latest slider value
  //                         even if the gap-timer effect fires mid-clip
  //   - gapTimerRef:        handle to the in-flight paragraph-gap setTimeout
  //                         so we can cancel it on slider drag / stopTts
  //   - ttsSettingsGenRef:  bumped on noise/emotion/useAI change so stale
  //                         in-flight prefetches can self-evict from the
  //                         cache (mirrors the ttsVoiceGenRef pattern at 1589)
  const ttsSpeedRef          = useRef(1.0);
  const ttsNoiseRef          = useRef(0.667);
  const ttsUseAIRef          = useRef(false);
  const ttsContinuousPlayRef = useRef(false);
  const ttsParagraphGapRef   = useRef(0);
  const gapTimerRef          = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ttsSettingsGenRef    = useRef(0);

  // detectEmotion() is defined in `src/lib/tts/detect-emotion.ts` — pure
  // function, no React, unit-tested in src/tests/detect-emotion.test.ts.

  useEffect(() => {
    const s = loadSettings();
    setSettings(s);
  }, []);

  // ── Persisted TTS settings (read-aloud sliders/toggles) ─────────────
  // On mount: hydrate from localStorage so the user's chosen speed / voice /
  // intensity / etc. survive a page reload. We load in a post-mount
  // useEffect (not in the lazy useState init) so the server-rendered
  // markup uses the same default values as the client first paint — avoids
  // a React hydration mismatch warning.
  //
  // We deliberately do NOT persist session-only values:
  //   - ttsState / ttsIndex / ttsParagraphs / ttsEmotionLabel: would put
  //     the user back into a mid-playback state on reload — confusing.
  //   - previewingVoice / voicePreviewAudio: ephemeral UI.
  useEffect(() => {
    const ts = loadTtsSettings();
    setTtsSpeed(ts.speed);
    setTtsNoise(ts.noise);
    setTtsUseAI(ts.useAI);
    setTtsEmotionIntensity(ts.emotionIntensity);
    setTtsVoice(ts.voice);
    setTtsContinuousPlay(ts.continuousPlay);
    setTtsParagraphGap(ts.paragraphGap);
  }, []);
  useEffect(() => {
    saveTtsSettings({
      speed:             ttsSpeed,
      noise:             ttsNoise,
      useAI:             ttsUseAI,
      emotionIntensity:  ttsEmotionIntensity,
      voice:             ttsVoice,
      continuousPlay:    ttsContinuousPlay,
      paragraphGap:      ttsParagraphGap,
    });
  }, [ttsSpeed, ttsNoise, ttsUseAI, ttsEmotionIntensity, ttsVoice, ttsContinuousPlay, ttsParagraphGap]);

  // S4 fix (2026-07-08): when the user picks a new default voice, every
  // prefetch entry under the old voice is now garbage. Wipe the whole
  // cache so we don't leak a full set of blob URLs per voice switch. The
  // next paragraph triggers a fresh fetch (~200ms over a warm TTS server,
  // ~1s cold), which is fine — voice switching mid-playback is rare and
  // the next paragraph is almost always still ~tens of seconds away.
  // Also clear any pre-decoded "next" audio buffer for the same reason.
  useEffect(() => {
    const prev = ttsVoiceAtChangeRef.current;
    if (prev !== ttsVoice) {
      ttsVoiceAtChangeRef.current = ttsVoice;
      ttsVoiceGenRef.current += 1;
      const dropped = prefetchCacheRef.current.size;
      prefetchCacheRef.current.clear();
      prefetchChapterTouchedAtRef.current.clear();
      clearNextAudioBuffer();
      ttsDebug('ttsVoice changed — prefetch cache cleared', {
        from: prev, to: ttsVoice, gen: ttsVoiceGenRef.current, chaptersDropped: dropped,
      });
    }
  }, [ttsVoice]);

  // ── On-the-fly read-aloud settings (BUGFIX 2026-07-11) ────────────────
  // These effects turn the read-aloud sliders into true live knobs. Speed
  // is the headline: applied directly to the playing audio element so the
  // user hears the change instantly with no fetch. Expressiveness / emotion
  // intensity / AI-emotion toggle are baked into the synthesized blob, so
  // the currently-playing clip stays at its synthesized values (no audible
  // blip) but the lookahead prefetch + pre-decoded next buffer are dropped
  // and re-warmed with the new params at the natural paragraph boundary.

  // Speed: push playbackRate to the playing element AND the preloaded next
  // element. No fetch — the synthesized blob is at the voice's intrinsic
  // rate (route.ts:199 falls back to voiceSpeed when body.speed is absent),
  // and the slider value is layered on top via playbackRate. Mirrors the
  // AudiobookPlayer pattern (AudiobookPlayer.tsx:175/186).
  useEffect(() => {
    ttsSpeedRef.current = ttsSpeed;
    const audio = audioRef.current;
    if (audio) audio.playbackRate = ttsSpeed;
    const next = nextAudioBufferRef.current?.audio;
    if (next) next.playbackRate = ttsSpeed;
    ttsDebug('ttsSpeed changed — applied to live audio', { speed: ttsSpeed });
  }, [ttsSpeed]);

  // Noise / emotionIntensity / useAIEmotion: invalidate lookahead prefetch
  // for the current chapter + drop the pre-decoded next buffer + re-warm
  // with the new params. The currently-playing clip is left untouched so
  // there's no audible blip; the lookahead catches up over ~5 paragraphs.
  // Bumping ttsSettingsGenRef also causes any in-flight prefetch to evict
  // itself from the cache (see the gen check inside prefetchParagraph).
  useEffect(() => {
    ttsNoiseRef.current            = ttsNoise;
    ttsUseAIRef.current            = ttsUseAI;
    ttsEmotionIntensityRef.current = ttsEmotionIntensity;
    ttsSettingsGenRef.current     += 1;

    const ch = currentChapterRef.current;
    if (!ch) return;
    const paras = chapterParagraphsRef.current.get(ch.id);
    if (!paras || ttsIndex >= paras.length) return;

    // Drop the pre-decoded next paragraph — it was baked with old params.
    const nextBuf = nextAudioBufferRef.current;
    if (nextBuf && nextBuf.idx === ttsIndex + 1 && nextBuf.chapterId === ch.id) {
      clearNextAudioBuffer();
    }
    // Fire-and-forget re-warm with NEW noise / emotion / useAI / intensity.
    // warmUpNextAudio internally calls detectEmotion(...) which reads the
    // refs above, so the new blob is built with current slider values.
    void warmUpNextAudio(ch.id, paras, ttsIndex + 1);
    ttsDebug('emotion/noise changed — lookahead re-warmed', {
      noise: ttsNoise, emotionIntensity: ttsEmotionIntensity, useAI: ttsUseAI,
      gen: ttsSettingsGenRef.current,
    });
    // Intentional: only re-fires on these three slider values. ttsIndex /
    // warmUpNextAudio / chapter ref values are read live inside; listing
    // them as deps would either loop or chase unstable references.
  }, [ttsNoise, ttsEmotionIntensity, ttsUseAI]); // eslint-disable-line react-hooks/exhaustive-deps

  // Continuous-play kick-off: fire next-chapter pregen when the user
  // toggles ON mid-chapter (today this only happens at startTts line 3620).
  // Without this, toggling continuous-play on mid-chapter would skip the
  // pre-warm window and the first paragraph of the next chapter would
  // pay a cold-start cost.
  useEffect(() => {
    if (!ttsContinuousPlay) return;
    ttsContinuousPlayRef.current = true;
    const nextIdx = currentIdx + 1;
    if (nextIdx < chapters.length) void pregenerateChapter(nextIdx);
    // Intentional: pregenerateChapter is a stable ref-backed closure;
    // only re-fires when continuous-play toggles or chapter index moves.
  }, [ttsContinuousPlay, currentIdx, chapters.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Next-chapter pregen invalidation when continuous-play is on AND noise /
  // emotion / useAI changes. The next chapter's pre-warmed blobs are stale
  // (different params), so drop that chapter from the prefetch map and let
  // pregenerateChapter re-fire. Speed is excluded — playbackRate doesn't
  // affect pregen (it's client-side).
  useEffect(() => {
    if (!ttsContinuousPlay) return;
    const nextIdx = currentIdx + 1;
    if (nextIdx >= chapters.length) return;
    const nextChapter = chapters[nextIdx];
    prefetchCacheRef.current.delete(nextChapter.id);
    prefetchChapterTouchedAtRef.current.delete(nextChapter.id);
    void pregenerateChapter(nextIdx);
    // Intentional: chapters is read inside via the live currentChapterRef /
    // pregenerateChapter (stable ref-backed closure). Listing chapters as a
    // dep would re-fire on every state mutation that touches the array.
  }, [ttsNoise, ttsEmotionIntensity, ttsUseAI, ttsContinuousPlay, currentIdx]); // eslint-disable-line react-hooks/exhaustive-deps

  // Paragraph gap: mirror to ref + cancel any pending gap timer. The
  // speakParagraph's finish() closure reads ttsParagraphGap live, but the
  // setTimeout handle wasn't captured before — so changing the slider mid-
  // gap left an old (now-wrong) timer ticking. Cancelling is harmless: the
  // loop just continues to the next paragraph immediately.
  useEffect(() => {
    ttsParagraphGapRef.current = ttsParagraphGap;
    if (gapTimerRef.current) {
      clearTimeout(gapTimerRef.current);
      gapTimerRef.current = null;
    }
  }, [ttsParagraphGap]);

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

  const loadChapters = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch(`/api/library/${bookId}/chapters`, { signal });
      const payload = await res.json().catch(() => null) as Chapter[] | { error?: string } | null;
      if (!res.ok) {
        const message = payload && !Array.isArray(payload) ? payload.error : undefined;
        throw new Error(message ?? `Không thể tải mục lục (HTTP ${res.status})`);
      }
      if (!Array.isArray(payload)) throw new Error('Phản hồi mục lục không hợp lệ.');
      const data = payload.filter((chapter) => chapter && typeof chapter.id === 'string');
      setChapters(data);
      const requestedIdx = initialChapter ? data.findIndex((c) => c.id === initialChapter) : -1;
      const startIdx = requestedIdx >= 0
        ? requestedIdx
        : Math.max(0, Math.floor((initialProgress / 100) * Math.max(0, data.length - 1)));
      setCurrentIdx(startIdx);
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
      setChapters([]);
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [bookId, initialChapter, initialProgress]);

  useEffect(() => {
    const controller = new AbortController();
    void loadChapters(controller.signal);
    return () => controller.abort();
  }, [loadChapters]);

  useEffect(() => { setBookmarks(loadBookmarks(bookId)); }, [bookId]);

  // Handle postMessages from iframe (chapter navigation + spread pagination)
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.source !== iframeRef.current?.contentWindow) return;
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
      const target = e.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName;
        if (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A'].includes(tag)) return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); handleNext(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); handlePrev(); }
      else if (e.key === 'Escape') {
        setTocOpen(false); setSettingsOpen(false); setBookmarksOpen(false); setWmOpen(false); setGalleryOpen(false); setVoiceDebugOpen(false); setAbOpen(false); setTtsSettingsOpen(false); setAttributionDebugOpen(false);
        if (analysisModal) closeAnalysisModal();
        setShortcutsOpen(false);
      }
      else if (e.key === 'b' || e.key === 'B') toggleBookmark();
      else if (e.key === 't' || e.key === 'T') setTocOpen((o) => !o);
      else if (e.key === 'g' || e.key === 'G') setGalleryOpen((o) => !o);
      // '?' (Shift+/) opens the keyboard shortcuts overlay. Held in any
      // text-input context is ignored by the earlier tag check.
      else if (e.key === '?' || (e.shiftKey && e.key === '/')) setShortcutsOpen(true);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentIdx, chapters, bookmarks, settings.layout, spreadPage, spreadTotal]);

  /**
   * Close the analyzer modal AND cancel any in-flight SSE stream.  All four
   * close paths (✕ icon, "Đóng (ESC)" footer, backdrop click, ESC key) call
   * this helper so server work stops the moment the user dismisses it.
   */
  function closeAnalysisModal() {
    analysisAbortRef.current?.abort();
    analysisAbortRef.current = null;
    setAnalysisModal(null);
  }

  const saveProgress = useCallback((idx: number, total: number) => {
    if (!total) return;
    const pct = Math.round((idx / Math.max(1, total - 1)) * 100);
    fetch(`/api/library/${bookId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ readProgress: pct, lastRead: new Date().toISOString() }),
    }).catch(() => {});
  }, [bookId]);

  function goToChapter(idx: number) {
    if (chapters.length === 0) return;
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
    if (chapters.length === 0) return;
    if (settings.layout === 'spread') {
      iframeRef.current?.contentWindow?.postMessage({ type: 'next-page' }, '*');
    } else {
      goToChapter(currentIdx + 1);
    }
  }
  function handlePrev() {
    if (chapters.length === 0) return;
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
    setTimeout(() => {
      if (ttsStateRef.current !== 'idle') syncTtsHighlight(ttsIndex);
    }, 120);
  };

  function syncTtsHighlight(index: number | null) {
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;
    const existing = doc.querySelectorAll('[data-tts-current="true"]');
    existing.forEach((el) => {
      el.removeAttribute('data-tts-current');
      el.classList.remove('tts-current-block');
    });
    if (index === null || index < 0) return;

    let style = doc.getElementById('tts-current-style') as HTMLStyleElement | null;
    if (!style) {
      style = doc.createElement('style');
      style.id = 'tts-current-style';
      // Soft, theme-adaptive highlight: 3px solid left "accent bar" + soft
      // horizontal gradient tint + paper-depth inset shadow. Uses
      // `currentColor` so the highlight color matches the chapter text and
      // looks harmonious across light / dark / sepia themes. Border-radius
      // 4px and 220ms ease transition give a refined, less "blocky" feel
      // than the old blue-fill-and-outline style. color-mix() is supported
      // in all evergreen browsers since Chrome 111 (2023-03).
      //
      // `padding-left: 0.6rem` plus a matching `-0.6rem` margin-left gives
      // the bar ~10px of breathing room from the text WITHOUT shifting the
      // paragraph's overall box — the negative margin extends the element
      // 10px to the left into the column-gap (spread) or body padding
      // (scroll), which both have horizontal headroom.
      style.textContent = `
        .tts-current-block {
          padding-left: 0.6rem !important;
          margin-left: -0.6rem !important;
          background: linear-gradient(90deg,
            color-mix(in srgb, currentColor 14%, transparent) 0%,
            color-mix(in srgb, currentColor 4%, transparent) 75%,
            transparent 100%) !important;
          box-shadow:
            inset 3px 0 0 0 currentColor,
            inset 0 -1px 0 0 color-mix(in srgb, currentColor 16%, transparent),
            inset 0 1px 4px -2px color-mix(in srgb, currentColor 18%, transparent) !important;
          border-radius: 4px !important;
          transition: background 220ms ease, box-shadow 220ms ease !important;
        }
      `;
      doc.head.appendChild(style);
    }

    const blocks = Array.from(doc.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, blockquote'))
      .filter((el) => (el.textContent ?? '').trim().length > 0) as HTMLElement[];
    const el = blocks[index];
    if (!el) return;
    el.dataset.ttsCurrent = 'true';
    el.classList.add('tts-current-block');

    const clip = doc.getElementById('epub-clip');
    if (clip) {
      const clipRect = clip.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      clip.scrollTo({
        left: Math.max(0, clip.scrollLeft + elRect.left - clipRect.left - clip.clientWidth * 0.15),
        behavior: 'smooth',
      });
    } else {
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
    }
  }

  useEffect(() => {
    if (ttsState === 'idle') syncTtsHighlight(null);
    else syncTtsHighlight(ttsIndex);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ttsState, ttsIndex, currentIdx, iframeLoading]);

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
        omlxReachable: boolean;
        crossChapter?: {
          seedApplied: boolean;
          seedReason: 'applied' | 'no-row' | 'stale-chapter' | 'version-mismatch' | 'empty';
          seedFromChapterIndex: number | null;
          seedLastSpeaker?: string | null;
          persistedAt: number | null;
        };
        // G4: novel proper-noun candidates surfaced so the user can
        // register new characters before they accumulate as unresolved-
        // actor rows. Optional on legacy cached rows.
        potentialNewCharacters?: string[];
        stats: {
          regexHits: number;
          llmHits: number;
          conversationHits: number;
          sourceDrift?: number;
          defaults: number;
          totalParagraphs: number;
        };
      };
      chapterAttributionRef.current.set(chapterId, {
        attribution: data.attribution ?? {},
        fromCache: !!data.fromCache,
        crossChapter: data.crossChapter
          ? {
              seedApplied: !!data.crossChapter.seedApplied,
              seedReason: data.crossChapter.seedReason,
              seedFromChapterIndex: data.crossChapter.seedFromChapterIndex,
              seedLastSpeaker: data.crossChapter.seedLastSpeaker ?? null,
              persistedAt: data.crossChapter.persistedAt,
            }
          : undefined,
        // G4: forward the list so VoiceDebugPanel can render the chip.
        // Default to [] so the panel's `novel.length === 0` branch
        // correctly hides the section when no novel names exist.
        potentialNewCharacters: data.potentialNewCharacters ?? [],
      });
      setChapterAttributionStats({
        chapterId,
        regexHits: data.stats?.regexHits ?? 0,
        llmHits: data.stats?.llmHits ?? 0,
        conversationHits: data.stats?.conversationHits ?? 0,
        sourceDrift: data.stats?.sourceDrift ?? 0,
        defaults: data.stats?.defaults ?? 0,
        fromCache: !!data.fromCache,
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
  async function runFullAnalysis(mode: AnalyzeMode = 'combine') {
    const chapterId = chapters[currentIdx]?.id;
    const chapterTitle = chapters[currentIdx]?.title ?? chapterId ?? '?';
    if (!chapterId || analysisInFlight) return;
    // ── Pre-flight confirm for 'full-llm' on big chapters (added 2026-07-12) ──
    // Whole-chapter mode is all-or-nothing on the LLM call — on a 600-paragraph
    // chapter a failed chatJSON() means NO LLM rows land and the chapter falls
    // back to the regex+local baseline for 600 paragraphs. Surface this risk
    // BEFORE the user commits. Small chapters (<300 paragraphs) skip the
    // dialog because the cost is bounded.
    if (
      mode === 'full-llm'
      && !pendingContinueFullLLMRef.current
      && (fullLLMEstimate?.paragraphCount ?? 0) > 300
    ) {
      setFullLLMPending(true);
      return;  // Dialog confirm handler re-calls runFullAnalysis with the
               // continuation ref set; cancel handler leaves ref false.
    }
    // Consume the continuation flag exactly once. The Dialog confirm sets it
    // before re-calling us; the re-entrant call falls through here.
    pendingContinueFullLLMRef.current = false;
    setAnalysisInFlight(true);
    // Wall-clock start — used to synthesize `durationMs` when the server
    // returns JSON (no streaming) so the modal can still show a real total.
    const pipelineStartMs = Date.now();
    const progressText = mode === 'full-llm'
      ? 'Đang chạy Full LLM (tất cả đoạn qua LLM)…'
      : mode === 'local-only'
        ? 'Đang chạy local-only (không gọi LLM)…'
        : 'Đang chạy Combine (parser + regex + local → LLM chỉ unresolved)…';
    setAnalysisProgress(progressText);

    // Open the modal IMMEDIATELY so the user can watch the pipeline run,
    // same UX as the Audio tab (read-aloud progress). Log lines stream in
    // as each step() fires on the server.
    setAnalysisModal({
      chapterId,
      chapterTitle,
      mode,
      stats: {
        regexHits: 0, llmHits: 0, conversationHits: 0,
        sourceDrift: 0, defaults: 0, totalParagraphs: 0,
        llmFailures: 0, llmRequested: 0,
      },
      omlxReachable: false,
      durationMs: 0,
      llmDurationMs: 0,
      log: [],
      layers: { regex: {}, local: {}, llm: {} },
      failed: false,
      running: true,
    });

    // Helper to merge into modal state while preserving `running`.
    const pushModal = (patch: Partial<AnalysisResult>) => {
      setAnalysisModal((cur) => cur
        ? { ...cur, ...patch, running: patch.running ?? cur.running }
        : cur);
    };
    const appendLog = (line: AnalysisLogLine) => {
      setAnalysisModal((cur) => cur
        ? { ...cur, log: [...cur.log, line] }
        : cur);
    };

    try {
      // Cancel any prior in-flight analyzer before starting a new one.
      analysisAbortRef.current?.abort();
      const ac = new AbortController();
      analysisAbortRef.current = ac;

      const r = await fetch(
        `/api/library/${bookId}/chapters/${encodeURIComponent(chapterId)}/attribute/analyze`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode }),
          signal: ac.signal,
        },
      );
      if (!r.ok || !r.body) {
        // Fall back to a JSON error body — server may still have streamed a
        // short log before bailing.
        let errBody: { log?: string[] } = {};
        try { errBody = await r.json(); } catch { /* ignore */ }
        const errLines = errBody.log ?? [];
        for (const L of errLines) {
          appendLog({ text: L, phase: 'error' });
        }
        pushModal({
          failed: true,
          running: false,
          errorMsg: `HTTP ${r.status}`,
        });
        setAnalysisProgress('Full analysis thất bại — kiểm tra log server');
        return;
      }

      // Read the response. The endpoint has shipped in two shapes across the
      // project history:
      //   • JSON mode    — Content-Type: application/json. The body IS the
      //     final result object (one big JSON blob, no streaming). The
      //     modal renders "running…" then snaps to done when this lands.
      //   • SSE mode     — Content-Type: text/event-stream. Each `data: <json>`
      //     block carries a `log` / `result` / `error` event so the pipeline
      //     can stream progress lines into the modal log live.
      // Detect from the Content-Type header and branch. Falling through to
      // the JSON branch is critical — without it the SSE parser sees a raw
      // JSON blob with no `data:` prefix, never finds a result event, and
      // the modal dies with "No result event received" even though the
      // server succeeded (the symptom that prompted this fix).
      const ctype = r.headers.get('content-type') ?? '';
      const isSSE = ctype.includes('text/event-stream');
      let resultData: {
        attribution?: AttributionMap;
        layers?: { regex: AttributionMap; local: AttributionMap; llm: AttributionMap };
        paragraphTexts?: Record<string, string>;
        omlxReachable?: boolean;
        mode?: AnalyzeMode;
        durationMs?: number;
        llmDurationMs?: number;
        chapter?: { chapterIndex: number; chapterId: string; file: string };
        stats?: {
          regexHits: number; llmHits: number;
          conversationHits: number; sourceDrift?: number;
          llmFailures?: number; llmRequested?: number;
          defaults: number; totalParagraphs: number;
        };
      } | null = null;
      // Helper: build a typed AnalysisLogLine from a parsed SSE event. The
      // server may send events with the legacy single-string `line` (no
      // phase/meta) — default to 'parse' so it still gets color-coded.
      //
      // Strip the redundant `[+Nms +N.Xs | PHASE] ` prefix the server
      // prepends to `line` — the modal already renders `wallMs`,
      // `sinceLast`, and the phase badge as separate columns / a chip,
      // so leaving the prefix in `line.text` produces triple-encoded
      // timestamps in the output. Keep only the human-readable payload.
      const STRIP_PREFIX = /^\[\+\s*\d+\s*(?:ms)?(?:\s*\+\d+(?:\.\d+)?s)?\s*\|\s*[a-z]+\s*\]\s*/;
      const buildLogLine = (evt: { [k: string]: unknown }): AnalysisLogLine => {
        const line = typeof evt.line === 'string' ? evt.line : String(evt.line ?? '');
        const phaseRaw = typeof evt.phase === 'string' ? evt.phase : 'parse';
        const phase = (
          ['init', 'parse', 'regex', 'local', 'preflight', 'llm', 'fuse', 'cache', 'stat', 'error'] as const
        ).includes(phaseRaw as never) ? phaseRaw as AnalysisLogLine['phase'] : 'parse';
        return {
          text: line.replace(STRIP_PREFIX, ''),
          phase,
          wallMs: typeof evt.wallMs === 'number' ? evt.wallMs : undefined,
          sinceLast: typeof evt.sinceLast === 'number' ? evt.sinceLast : undefined,
          meta: (evt.meta && typeof evt.meta === 'object') ? evt.meta as Record<string, unknown> : null,
        };
      };
      // Branch on the wire format. Both branches populate `resultData`
      // (below as a known-shape object) so the post-loop code is shared.
      if (isSSE) {
        // ── SSE branch — walk the event stream, parsing `log` / `result` /
        // `error` payloads as they arrive. Each `data: <json>` block is a
        // structured event; messages are separated by an empty line.
        const reader = r.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let sep: number;
          while ((sep = buffer.indexOf('\n\n')) !== -1) {
            const raw = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            let payload = '';
            for (const line of raw.split('\n')) {
              if (line.startsWith('data:')) payload += line.slice(5).trimStart();
            }
            if (!payload) continue;
            let evt: { type: string;[k: string]: unknown };
            try { evt = JSON.parse(payload); } catch { continue; }
            if (evt.type === 'log') {
              const logLine = buildLogLine(evt);
              appendLog(logLine);
              // Optimistic "what's running" hint in the toolbar progress line.
              if (typeof window !== 'undefined' && /\bLLM\b|\boMLX\b/.test(logLine.text)) {
                setAnalysisProgress(`Đang chạy: ${logLine.text}`);
              }
            } else if (evt.type === 'result') {
              resultData = evt as unknown as typeof resultData;
            } else if (evt.type === 'error') {
              pushModal({ failed: true, running: false, errorMsg: String(evt.message ?? 'Unknown error') });
              setAnalysisProgress('Full analysis lỗi: ' + (evt.message ?? '?'));
            }
          }
        }
        // Drain trailing buffer (no trailing \n\n at end-of-stream is possible).
        if (buffer.trim()) {
          let payload = '';
          for (const line of buffer.split('\n')) {
            if (line.startsWith('data:')) payload += line.slice(5).trimStart();
          }
          if (payload) {
            try {
              const evt = JSON.parse(payload);
              if (evt.type === 'result') resultData = evt;
              else if (evt.type === 'log') appendLog(buildLogLine(evt));
              else if (evt.type === 'error') pushModal({ failed: true, running: false, errorMsg: String(evt.message ?? 'Unknown error') });
            } catch { /* ignore */ }
          }
        }
      } else {
        // ── JSON branch — the server ships the whole result in one shot.
        // The endpoint returns the bare attribution+stats payload; we
        // synthesize the streaming-only fields (`layers`, `mode`,
        // `durationMs`, `paragraphTexts`) locally and emit a single
        // "log trống" entry so the modal log isn't completely empty for a
        // run that took 0 visible ticks (long-running runs already show
        // the granular progress via the SSE branch above).
        try {
          const json = await r.json() as {
            attribution?: AttributionMap;
            omlxReachable?: boolean;
            chapter?: { chapterIndex: number; chapterId: string; file: string };
            stats?: { regexHits?: number; llmHits?: number; conversationHits?: number; sourceDrift?: number; defaults?: number; totalParagraphs?: number; llmFailures?: number; llmRequested?: number };
            // Future-proofed — the SSE result event carries these too; if
            // the server starts emitting them in JSON mode we pick them up.
            layers?: { regex: AttributionMap; local: AttributionMap; llm: AttributionMap };
            paragraphTexts?: Record<string, string>;
            mode?: AnalyzeMode;
            durationMs?: number;
            llmDurationMs?: number;
          };
          resultData = {
            attribution: json.attribution,
            chapter: json.chapter,
            omlxReachable: json.omlxReachable,
            // Synthesize the per-layer breakdown as empty — the JSON
            // endpoint doesn't ship it, but the modal will still render
            // the merged attribution result. The voice-debug panel's
            // per-evidence chips will just show empty in this branch.
            layers: json.layers ?? { regex: {}, local: {}, llm: {} },
            paragraphTexts: json.paragraphTexts,
            mode: json.mode ?? mode,
            durationMs: json.durationMs ?? Math.max(0, Date.now() - pipelineStartMs),
            llmDurationMs: json.llmDurationMs ?? 0,
            stats: json.stats ? {
              regexHits:         json.stats.regexHits         ?? 0,
              llmHits:           json.stats.llmHits           ?? 0,
              conversationHits:  json.stats.conversationHits  ?? 0,
              sourceDrift:       json.stats.sourceDrift       ?? 0,
              defaults:          json.stats.defaults          ?? 0,
              totalParagraphs:   json.stats.totalParagraphs   ?? 0,
              llmFailures:       json.stats.llmFailures       ?? 0,
              llmRequested:      json.stats.llmRequested      ?? 0,
            } : undefined,
          };
          // The JSON endpoint doesn't stream per-step events, so plant a
          // synthetic "done" log entry so the modal's log panel isn't
          // empty when the run completes. The headline number is the most
          // useful summary a user wants to scan after a full analysis.
          if (resultData.stats) {
            const total = (resultData.stats.regexHits ?? 0)
                        + (resultData.stats.llmHits ?? 0)
                        + (resultData.stats.conversationHits ?? 0);
            appendLog({
              text: `Pipeline xong — ${resultData.stats.totalParagraphs} đoạn, ${total} đã gán, ${resultData.stats.defaults} voice mặc định (${Math.round((resultData.durationMs ?? 0) / 100) / 10}s)`,
              phase: 'stat',
            });
          }
        } catch (e) {
          pushModal({ failed: true, running: false, errorMsg: 'Không đọc được JSON: ' + (e instanceof Error ? e.message : String(e)) });
          setAnalysisProgress('Full analysis lỗi: response không phải JSON');
          return;
        }
      }

      if (!resultData || !resultData.stats) {
        // Stream closed cleanly but no result event — unusual.
        pushModal({ failed: true, running: false, errorMsg: 'No result event received' });
        setAnalysisProgress('Full analysis lỗi: không nhận được kết quả');
        return;
      }

      // Update in-memory attribution cache. We also carry `layers` so the
      // Voice assignment debug panel can render per-evidence chips
      // (regex / conversation / llm) next to each paragraph — same view
      // the analyzer modal shows. We also stash `paragraphTexts` so the
      // Voice Debug panel has source paragraphs to render even before
      // the user starts TTS playback (which is what populates
      // `ttsParagraphs`). Bump `attributionRefreshTick` because refs
      // don't trigger re-renders; VoiceDebugPanel's `useMemo` reads this
      // tick so it knows to recompute its rows.
      if (resultData.attribution) {
        // Convert paragraphTexts[] (server ships it array-shaped) into
        // a {idx → text} record so the panel can index by paragraph
        // number without scanning the array each row.
        const paragraphTextsRecord: Record<number, string> = {};
        if (resultData.paragraphTexts) {
          for (const [k, v] of Object.entries(resultData.paragraphTexts)) {
            const n = Number(k);
            if (Number.isFinite(n) && typeof v === 'string') paragraphTextsRecord[n] = v;
          }
        }
        chapterAttributionRef.current.set(chapterId, {
          attribution: resultData.attribution,
          layers: resultData.layers,
          paragraphTexts: paragraphTextsRecord,
          fromCache: false,
        });
      }
      setAttributionRefreshTick((t) => t + 1);
      setChapterAttributionStats({
        chapterId,
        regexHits: resultData.stats.regexHits ?? 0,
        llmHits: resultData.stats.llmHits ?? 0,
        conversationHits: resultData.stats.conversationHits ?? 0,
        sourceDrift: resultData.stats.sourceDrift ?? 0,
        defaults: resultData.stats.defaults ?? 0,
        fromCache: false,
        omlxReachable: !!resultData.omlxReachable,
      });

      // Pull the chapter's paragraph text list so the debug modal can show the
      // paragraph alongside its assigned speaker. We prefer the structured
      // `paragraphs[]` field returned by /api/library/.../chapters/:id —
      // it's already split + ordered the same way the server's
      // sliceParagraphs() does. If only `html` is returned (raw mode),
      // we send a small inline splitter that doesn't pull the server's
      // oMLX/node-fetch chain.
      let paragraphTexts: string[] = [];
      try {
        const chResp = await fetch(
          `/api/library/${bookId}/chapters/${encodeURIComponent(chapterId)}`,
        );
        if (chResp.ok) {
          const chData = await chResp.json() as {
            paragraphs?: { index: number; text: string }[];
            html?: string;
          };
          if (Array.isArray(chData.paragraphs)) {
            const sorted = [...chData.paragraphs].sort((a, b) => a.index - b.index);
            paragraphTexts = sorted.map((p) => p.text);
          } else if (typeof chData.html === 'string') {
            // Tiny client-side splitter that matches the server's logic
            // closely enough for the debug modal. We split on block-level
            // tags (<p>, <div>, <br>, headings) and strip remaining tags.
            paragraphTexts = clientSplitParagraphs(chData.html);
          }
        }
      } catch (e) {
        console.warn('[full-analysis] failed to fetch paragraph texts for debug modal:', e);
      }

      // Final modal state with stats filled in.
      pushModal({
        stats: {
          regexHits: resultData.stats.regexHits ?? 0,
          llmHits: resultData.stats.llmHits ?? 0,
          conversationHits: resultData.stats.conversationHits ?? 0,
          sourceDrift: resultData.stats.sourceDrift ?? 0,
          defaults: resultData.stats.defaults ?? 0,
          totalParagraphs: resultData.stats.totalParagraphs ?? 0,
          llmFailures: resultData.stats.llmFailures ?? 0,
          llmRequested: resultData.stats.llmRequested ?? 0,
        },
        omlxReachable: !!resultData.omlxReachable,
        mode: resultData.mode ?? mode,
        durationMs: resultData.durationMs ?? 0,
        llmDurationMs: resultData.llmDurationMs ?? 0,
        attribution: resultData.attribution,
        layers: resultData.layers,
        paragraphTexts,
        running: false,
        failed: false,
      });

      // Toolbar summary.
      const llmPart = resultData.omlxReachable
        ? `${resultData.stats.llmHits} LLM`
        : resultData.stats.llmRequested && resultData.stats.llmRequested > 0
          ? `oMLX lỗi (${resultData.stats.llmFailures ?? 0} batch fail)`
          : 'oMLX không chạy';
      setAnalysisProgress(
        `Full analysis xong — ${resultData.stats.regexHits} regex, ${resultData.stats.conversationHits ?? 0} conversation, ${llmPart}`,
      );
      setAttributionDebugOpen(true);
      setVoiceDebugOpen(true);
      // Auto-clear the success message after a few seconds.
      setTimeout(() => {
        setAnalysisProgress((cur) =>
          cur && cur.startsWith('Full analysis xong') ? null : cur,
        );
      }, 6000);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setAnalysisProgress('Full analysis lỗi: ' + msg);
      pushModal({ failed: true, running: false, errorMsg: msg });
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
   * Fire-and-forget — caller doesn't await. It starts only when the user
   * explicitly starts read-aloud, never during ordinary chapter navigation.
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
  // Source: `src/lib/tts/vieneu-voices.ts` (Python-side mirror in
  // `app/tts-service/audiobook_generator.py:580-602` is intentionally left
  // for a separate sync to that reference project).
  const VOICE_GENDER: Record<string, 'female' | 'male' | 'unknown'> = {
    ...Object.fromEntries(
      Object.entries(VIENEU_VOICE_GENDER).map(([k, v]) => [k, v as 'female' | 'male' | 'unknown']),
    ),
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
   *    1. Server-side regex attribution map (cached per chapter) — keyed by
   *       paragraph index, loaded once per chapter via
   *       loadChapterAttribution().
   *    2. Local 6-pass regex (findSpeakerForQuote) — used when the map has
   *       no entry for this paragraph OR when the user has toggled the
   *       parser off. */
  const detectSpeaker = useCallback((
    text: string,
    paragraphIndex?: number,
  ): { name?: string; voiceName?: string; source?: 'parser' | 'regex' | 'llm' | 'conversation' } => {
    if (!ttsUseCharacterVoice) return {};
    const quotes = findQuoteSpans(text);
    if (quotes.length === 0) return {};

    // ── Tier 1: server-side attribution map ───────────────────────────
    // Only used when we know our paragraph index AND the map is loaded for
    // the current chapter. The map's source can be 'regex', 'llm',
    // 'conversation', or 'default'. speaker=null falls through to local regex.
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
  // The attribution helpers are declared in the reader scope because they
  // share its character maps; their effective inputs are covered below.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ttsUseCharacterVoice, chapters, currentIdx, ttsCharacterMap]);

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
   * Maximum number of chapters we'll keep materialized in the prefetch
   * cache before LRU-evicting the least-recently-touched one. Bounds
   * memory during long playback sessions / whole-book pre-generation.
   * 3 chapters ≈ 200-500 blobs ≈ 30-100 MB (each WAV ~150-300 KB).
   */
  const PREFETCH_CACHE_MAX_CHAPTERS = 3;
  /** Track when each chapter was last hit (Promise OR blob access). */
  const prefetchChapterTouchedAtRef = useRef<Map<string, number>>(new Map());

  function touchChapter(chapterId: string) {
    prefetchChapterTouchedAtRef.current.set(chapterId, Date.now());
  }

  /**
   * LRU-evict the oldest chapter(s) until we're under PREFETCH_CACHE_MAX_CHAPTERS.
   * Drops the Promise map for that chapter; in-flight requests still resolve
   * but their results won't be memoized. Trade-off: tiny chance of a duplicate
   * fetch on the evicted chapter if it gets re-requested. Memory bounded is
   * worth it.
   */
  function evictPrefetchIfOverLimit() {
    const cache = prefetchCacheRef.current;
    if (cache.size <= PREFETCH_CACHE_MAX_CHAPTERS) return;
    const touched = prefetchChapterTouchedAtRef.current;
    const sorted = [...cache.keys()].sort((a, b) => (touched.get(a) ?? 0) - (touched.get(b) ?? 0));
    while (cache.size > PREFETCH_CACHE_MAX_CHAPTERS && sorted.length > 0) {
      const evict = sorted.shift()!;
      cache.delete(evict);
      touched.delete(evict);
      ttsDebug('prefetchCache: LRU-evicted chapter', { chapterId: evict });
    }
  }

  /**
   * Start (or return cached) a TTS fetch for a paragraph.
   * Same request is deduped so calling this N times for the same paragraph
   * only triggers 1 network call.
   *
   * Resilience: transient network errors get one automatic retry (250 ms
   * backoff) before the rejection propagates. Reduces cold-cache hiccups
   * when the unified TTS server briefly returns 502/503 under load.
   */
  function prefetchParagraph(
    chapterId: string,
    paragraphs: string[],
    idx: number,
    _unusedSpeed: number | undefined,
    character?: string,
    emotion = 'neutral',
    expressiveness = ttsNoise,
  ): Promise<Blob> {
    // Stable dedup key — speed is NOT included; it's applied client-side via
    // playbackRate. Keeping it in the key would force a fresh fetch on every
    // slider movement. Noise / emotion / voice / character remain keyed so a
    // change to those still invalidates correctly.
    const key = `${idx}::${character ?? '_'}::${ttsVoice}::${emotion}::${expressiveness.toFixed(2)}`;
    touchChapter(chapterId);
    let chapterMap = prefetchCacheRef.current.get(chapterId);
    if (!chapterMap) {
      chapterMap = new Map();
      prefetchCacheRef.current.set(chapterId, chapterMap);
      evictPrefetchIfOverLimit();
    }
    const existing = chapterMap.get(key) as Promise<Blob> | undefined;
    if (existing) {
      touchChapter(chapterId);
      return existing;
    }

    const fetchStart = performance.now();
    const MAX_ATTEMPTS = 2;
    const RETRY_BACKOFF_MS = 250;
    // BUGFIX 2026-07-11: capture the settings-gen at fetch-start so an
    // in-flight prefetch that resolves AFTER the user moved a noise /
    // emotion / useAI slider evicts itself from the cache (it would
    // otherwise be cached against the OLD settings key — wait, no, the
    // key already locks noise in, but the warm-up that triggered this
    // fetch was based on the *old* slider values). Bumping ttsSettingsGenRef
    // on every invalidation keeps stale promises from winning the
    // last-write-wins race in nextAudioBufferRef. The outer .catch below
    // removes failed entries from the cache, so a stale throw cleanly
    // evicts.
    const myGen = ttsSettingsGenRef.current;
    // BUGFIX 2026-07-11: clean the paragraph text before sending to the
    // TTS. Many Vietnamese web-novels use visual-only ornament runs as
    // chapter / section separators (`—★—`, `*** Chương 5 ***`,
    // `────────────`). The voice either stalls or reads glyph names
    // ("em dash star em dash") which is jarring. Strip them inline; if
    // the paragraph is decorative-only, skip the network call and
    // return a shared silent WAV so the read-aloud loop just bridges
    // the gap without any audible output. The original `paragraphs[]`
    // is unchanged — UI display still shows the decorations.
    const rawText = paragraphs[idx];
    const ttsText = cleanTextForTTS(rawText);
    if (isDecorativeOnly(rawText)) {
      ttsDebug('prefetchParagraph: decorative-only — silent placeholder', {
        idx, rawSnippet: rawText.slice(0, 40),
      });
      const silentPromise = Promise.resolve(SILENT_WAV_BLOB);
      chapterMap.set(key, silentPromise);
      return silentPromise;
    }
    const attempt = async (attemptNo: number): Promise<Blob> => {
      ttsDebug('POST /api/tts', { idx, character, emotion, voice: ttsVoice, attempt: attemptNo });
      const resp = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: ttsText,
          // speed intentionally omitted — server falls back to per-voice
          // voiceSpeed (route.ts:199). The slider drives client-side
          // playbackRate instead, which makes speed changes instant.
          bookId,
          character,
          voice: ttsVoice,
          language: 'vi',
          emotion,
          expressiveness,
          callIdx: idx,
        }),
      });
      if (!resp.ok) {
        // Surface the server's body in the warn so the user/dev can see
        // WHY /api/tts returned 502/503.  The original code only logged
        // the status number, which is opaque.
        let detail = '';
        try { detail = await resp.text(); } catch { /* ignore */ }
        const transient = resp.status >= 500 || resp.status === 429;
        if (transient && attemptNo < MAX_ATTEMPTS) {
          ttsDebug('POST /api/tts transient failure — retrying', { idx, status: resp.status, attemptNo });
          await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
          return attempt(attemptNo + 1);
        }
        ttsWarn('POST /api/tts non-OK', {
          idx, status: resp.status,
          body: detail.slice(0, 300),
          backend: resp.headers.get('X-TTS-Backend'),
        });
        throw new Error(`TTS failed: ${resp.status} — ${detail.slice(0, 120)}`);
      }
      const blob = await resp.blob();
      // Race-safety: settings changed while we were fetching. Don't memoise
      // this blob — the warm-up that triggered this fetch was for the old
      // settings. Drop the cache entry (so the next reader gets a fresh
      // fetch) and throw so the warm-up's .catch evicts it from the
      // nextAudioBuffer pool.
      if (myGen !== ttsSettingsGenRef.current) {
        chapterMap!.delete(key);
        ttsDebug('prefetch stale (settings changed mid-flight) — evicted', {
          idx, myGen, currentGen: ttsSettingsGenRef.current,
        });
        throw new Error('stale prefetch (settings changed mid-flight)');
      }
      ttsDebug('POST /api/tts ok', {
        idx, ms: Math.round(performance.now() - fetchStart),
        bytes: blob.size, type: blob.type,
        backend: resp.headers.get('X-TTS-Backend'),
        voiceUsed: resp.headers.get('X-Voice-Used'),
        attempt: attemptNo,
      });
      // Clear any previous warning chip (an OK POST means the path works now).
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('tts:ok'));
      }
      return blob;
    };
    const promise = attempt(1).catch((err) => {
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
    if (existingMap && existingMap.size > 0) {
      ttsDebug('pregenerateChapter: cache hit, skipping', { chapterId: ch.id });
      return;
    }

    ttsDebug('pregenerateChapter: starting', { chapterId: ch.id, paragraphs: '(loading)' });
    const paragraphs = await getChapterParagraphs(ch.id);
    if (paragraphs.length === 0) {
      ttsDebug('pregenerateChapter: chapter has 0 paragraphs, skipping', { chapterId: ch.id });
      return;
    }
    ttsDebug('pregenerateChapter: paragraph count', { chapterId: ch.id, count: paragraphs.length });

    // Load server-side attribution (regex + optional LLM) so detectSpeaker()
    // can pick the cached answer over the local regex when both are
    // available. Fire-and-forget — pregenerate doesn't block on it.
    void loadChapterAttribution(ch.id);

    // Sequential prefetch with small concurrency so we don't hammer the
    // OMLX / Vietnamese Voice backend (single-threaded on Apple Silicon anyway).
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
            ? detectEmotion(paragraphs[idx], ttsSpeed, ttsNoise, ttsEmotionIntensityRef.current)
            : { speed: ttsSpeed, noiseScale: ttsNoise, label: '', emoji: '', emotion: 'neutral' };
          return prefetchParagraph(ch.id, paragraphs, idx, undefined, sp.name, emo.emotion, emo.noiseScale)
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
   *
   * `speed` is intentionally dropped from the signature in 2026-07-11: speed
   * is now a client-side playbackRate knob. The argument is kept as an
   * unused optional so existing callers compile without churn.
   */
  async function speakParagraph(
    chapterId: string,
    paragraphs: string[],
    idx: number,
    _unusedSpeed?: number,
    character?: string,
    emotion = 'neutral',
    expressiveness = ttsNoise,
  ): Promise<void> {
    ttsDebug('speakParagraph', { idx, character, emotion, playbackRate: ttsSpeedRef.current, preview: paragraphs[idx]?.slice(0, 60) });
    // Eagerly prefetch the next paragraphs so the audio is ready when the
    // current one ends. With a slow TTS backend (~15-20s per call on
    // Apple Silicon) we need a deep lookahead — 5 paragraphs ≈ 10s of
    // buffered audio (each para is ~2s). Server handles them in its own
    // queue (CONCURRENCY=2 in pregenerateChapter for pre-chapter; for
    // same-chapter prefetch we cap to 3 in-flight via a tiny semaphore
    // so we don't DDOS the unified TTS server if the loop fires fast).
    const LOOKAHEAD_PARAGRAPHS = 5;
    const MAX_INFLIGHT_PREFETCH = 3;
    let inflight = 0;
    const waitQueue: Array<() => void> = [];
    const withSlot = async <T,>(fn: () => Promise<T>): Promise<T> => {
      if (inflight >= MAX_INFLIGHT_PREFETCH) {
        await new Promise<void>((r) => waitQueue.push(r));
      }
      inflight++;
      try {
        return await fn();
      } finally {
        inflight--;
        const next = waitQueue.shift();
        if (next) next();
      }
    };
    for (let j = 1; j <= LOOKAHEAD_PARAGRAPHS; j++) {
      const nextIdx = idx + j;
      if (nextIdx < paragraphs.length) {
        // B3 fix (2026-07-08): pass the paragraph index to detectSpeaker
        // so the Tier-1 server-side attribution map (chapterAttributionRef)
        // is consulted. Without the index, every eager prefetch fell
        // through to Tier-2 local regex and may have resolved a different
        // character (or none). That produced two cache entries per
        // paragraph — one from the lookahead with the wrong character,
        // one from the eventual speakParagraph call with the right one —
        // and forced a re-fetch on the playback thread.
        const nextSp = detectSpeaker(paragraphs[nextIdx], nextIdx);
        const nextEmo = ttsUseAI
          ? detectEmotion(paragraphs[nextIdx], ttsSpeed, ttsNoise, ttsEmotionIntensityRef.current)
          : { speed: ttsSpeed, noiseScale: ttsNoise, label: '', emoji: '', emotion: 'neutral' };
        withSlot(() =>
          prefetchParagraph(chapterId, paragraphs, nextIdx, undefined, nextSp.name, nextEmo.emotion, nextEmo.noiseScale),
        ).catch((e) => {
          ttsWarn('eager prefetch failed', { nextIdx, err: String(e) });
        });
      }
    }

    const ttsStart = performance.now();
    let blob: Blob;
    try {
      blob = await prefetchParagraph(chapterId, paragraphs, idx, undefined, character, emotion, expressiveness);
    } catch (e) {
      ttsWarn('prefetchParagraph FAILED — first paragraph will be silent', {
        idx, character, emotion, err: String(e),
        hint: 'Check unified TTS log + /api/tts response',
      });
      throw e;
    }
    ttsDebug('prefetch ok', { idx, bytes: blob.size, ms: Math.round(performance.now() - ttsStart) });
    // If a previous call already pre-decoded this paragraph's audio
    // (warmUpNextAudio ran while the previous paragraph was playing),
    // consume it now to skip the new-Audio + load + decode latency.
    // This is what makes voice changes seamless: the new voice's WAV
    // was decoded into HTMLAudioElement.readyState >= HAVE_ENOUGH_DATA
    // before the previous paragraph finished.
    const preloaded = nextAudioBufferRef.current;
    let url: string;
    let audio: HTMLAudioElement;
    if (preloaded && preloaded.idx === idx && preloaded.chapterId === chapterId) {
      nextAudioBufferRef.current = null;
      url = preloaded.url;
      audio = preloaded.audio;
      // BUGFIX 2026-07-11: preloaded elements were built before the
      // speed slider might have moved — make sure they play at the live
      // rate when consumed.
      audio.playbackRate = ttsSpeedRef.current;
      ttsDebug('speakParagraph: using preloaded audio', { idx, chapterId });
    } else {
      url = URL.createObjectURL(blob);
      audio = new Audio(url);
      // BUGFIX 2026-07-11: keep pitch steady when playbackRate != 1.
      // Chromium/Safari preserve pitch by default but Firefox does not —
      // setting the standard property + the two vendor aliases makes the
      // behaviour consistent across engines. Without this, dragging the
      // speed slider to 0.75× / 2.0× sounds chipmunk-y / gravey.
      audio.preservesPitch = true;
      (audio as HTMLAudioElement & { mozPreservesPitch?: boolean }).mozPreservesPitch = true;
      (audio as HTMLAudioElement & { webkitPreservesPitch?: boolean }).webkitPreservesPitch = true;
      audio.playbackRate = ttsSpeedRef.current;
      // preload="auto" tells the browser to fetch the entire blob metadata +
      // body right away. Default is "metadata" which only fetches duration,
      // deferring the body fetch until .play() — produces a noticeable
      // stutter on slower connections. Explicit `audio.load()` kicks off
      // the fetch synchronously rather than waiting for play(). Together
      // they eliminate the ~50-200ms first-frame stall on cold cache.
      audio.preload = 'auto';
      try { audio.load(); } catch { /* Safari throws if src was just set; safe to ignore */ }
      // Wait for decode to finish so the upcoming .play() returns
      // instantly. Without this, the first frame still triggers the
      // decoder on the playback thread and produces a small stutter
      // that the user hears as "delay" between paragraphs.
      await new Promise<void>((resolve) => {
        if (audio.readyState >= 4) return resolve();
        const done = () => {
          audio.removeEventListener('canplaythrough', done);
          audio.removeEventListener('error', done);
          resolve();
        };
        audio.addEventListener('canplaythrough', done, { once: true });
        audio.addEventListener('error', done, { once: true });
        setTimeout(resolve, 2000); // safety net — never block the loop forever
      });
      ttsDebug('speakParagraph: audio decoded', { idx, readyState: audio.readyState });
    }
    return new Promise((resolve) => {
      audioRef.current = audio;
      let settled = false;
      const finish = (reason: string) => {
        if (settled) return;
        settled = true;
        ttsAudioFinishRef.current = null;
        if (audioRef.current === audio) audioRef.current = null;
        URL.revokeObjectURL(url);
        ttsLastFinishReasonRef.current = reason;
        ttsDebug('audio finished', { idx, reason });
        if (ttsParagraphGap > 0 && !ttsAbortRef.current) {
          // BUGFIX 2026-07-11: capture the handle so the paragraphGap
          // useEffect can cancel it on slider drag / stopTts. Previously
          // the timer was uncapturable, so a slider drag mid-gap left an
          // old (now-wrong) timer ticking.
          gapTimerRef.current = setTimeout(() => {
            gapTimerRef.current = null;
            resolve();
          }, ttsParagraphGap);
        } else {
          resolve();
        }
      };
      ttsAudioFinishRef.current = () => finish('manual');
      audio.onended   = () => finish('ended');
      audio.onerror   = (e) => {
        ttsWarn('audio.onerror fired', { idx, err: String(e), code: audio.error?.code });
        finish('error');
      };
      audio.play().then(
        () => {
          ttsDebug('audio.play() resolved', { idx });
          // BUGFIX 2026-07-11: belt-and-suspenders — older Safari versions
          // had a bug where setting audio.playbackRate on a paused /
          // pre-buffered element didn't take effect on .play(). Re-applying
          // here guarantees the live element lands on the slider value no
          // matter what. Cost: one redundant assignment per paragraph.
          audio.playbackRate = ttsSpeedRef.current;
          // Now that this paragraph is actually playing, kick off the
          // warm-up for the NEXT paragraph. It runs in the background
          // for the remaining duration of this clip, so by the time
          // `finish()` fires (natural onended), the next Audio element
          // is fully decoded and ready for an instant .play() — which
          // is what eliminates the inter-paragraph gap, including on
          // voice changes (the prefetch key is voice-aware).
          const nextIdx = idx + 1;
          if (nextIdx < paragraphs.length && !ttsAbortRef.current) {
            void warmUpNextAudio(chapterId, paragraphs, nextIdx);
          }
        },
        (err) => {
          // Autoplay rejection, decoder error, missing user gesture, etc.
          // Before the fix this was `finish` with no reason → silent skip
          // that left the user wondering why nothing played.
          // New behaviour: if this is the FIRST paragraph of the run, halt
          // the run entirely (mark aborted, flip state to idle so the
          // user can retry). Otherwise (prefetch for next paragraph), the
          // outer flow is unaffected — finish() lets the for-loop move on.
          if (idx === 0) {
            ttsWarn('audio.play() REJECTED on paragraph 0 — halting run', {
              idx,
              err: String(err),
              hint: 'Browser blocked autoplay. Click anywhere on the page, then press Play again.',
            });
            ttsAbortRef.current = true;
            ttsRunIdRef.current += 1;  // invalidate the run so the loop exits
            ttsStateRef.current = 'idle';
            setTtsState('idle');
            finish('play-rejected');
          } else {
            ttsWarn('audio.play() rejected on later paragraph', {
              idx, err: String(err),
              note: 'skipping paragraph (non-fatal — next will try)',
            });
            finish('play-rejected');
          }
        },
      );
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
    // If we're aborting the run (called from stopTts / restartTtsAt /
    // changeChapterByVoice), the pre-decoded "next" audio is for a run
    // that's about to die — discard it. The natural onended path inside
    // speakParagraph's `finish()` does NOT call this helper, so the
    // preloaded next audio stays intact for the upcoming iteration.
    clearNextAudioBuffer();
    ttsAudioFinishRef.current?.();
  }

  // Tear down the pre-decoded next audio buffer. Safe to call multiple
  // times; idempotent.
  function clearNextAudioBuffer() {
    const buf = nextAudioBufferRef.current;
    if (!buf) return;
    nextAudioBufferRef.current = null;
    try {
      buf.audio.pause();
      buf.audio.removeAttribute('src');
      buf.audio.load();
    } catch { /* ignore */ }
    try { URL.revokeObjectURL(buf.url); } catch { /* ignore */ }
  }

  // Pre-decode the audio for paragraph `idx` (fire and forget). When
  // done, the result lives on `nextAudioBufferRef` and the next call to
  // speakParagraph(idx) will pick it up and skip the per-paragraph
  // fetch + new Audio() + load() + decode dance.
  //
  // The fetched blob itself is the SAME one the prefetch cache would
  // produce — we piggyback on prefetchParagraph so the cache stays
  // consistent and the parallel eager prefetch at the top of
  // speakParagraph keeps working for paragraphs further out.
  async function warmUpNextAudio(
    chapterId: string,
    paragraphs: string[],
    idx: number,
  ): Promise<void> {
    if (idx >= paragraphs.length) return;
    if (ttsAbortRef.current) return;
    // Already warm for this exact paragraph + chapter? Keep it.
    const cur = nextAudioBufferRef.current;
    if (cur && cur.idx === idx && cur.chapterId === chapterId) return;
    // Stale (different idx / chapter from a previous iteration). Drop it.
    clearNextAudioBuffer();

    try {
      const nextSp = detectSpeaker(paragraphs[idx], idx);
      const nextEmo = ttsUseAI
        ? detectEmotion(paragraphs[idx], ttsSpeed, ttsNoise, ttsEmotionIntensityRef.current)
        : { speed: ttsSpeed, noiseScale: ttsNoise, label: '', emoji: '', emotion: 'neutral' };
      const blob = await prefetchParagraph(
        chapterId, paragraphs, idx, undefined, nextSp.name,
        nextEmo.emotion, nextEmo.noiseScale,
      );
      if (ttsAbortRef.current) return;
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      // BUGFIX 2026-07-11: same pitch-preservation as speakParagraph. The
      // pre-decoded next element lives for up to one paragraph's worth of
      // audio (~2s) — long enough that a speed slider drag during the
      // current clip would otherwise land on a chipmunk/gravely next one.
      audio.preservesPitch = true;
      (audio as HTMLAudioElement & { mozPreservesPitch?: boolean }).mozPreservesPitch = true;
      (audio as HTMLAudioElement & { webkitPreservesPitch?: boolean }).webkitPreservesPitch = true;
      audio.playbackRate = ttsSpeedRef.current;
      audio.preload = 'auto';
      try { audio.load(); } catch { /* Safari safety — same as speakParagraph */ }
      // Await decode so .play() is instant when speakParagraph picks it up.
      // Without this, .play() would still trigger the decode on the main
      // playback thread and reintroduce the gap we're trying to eliminate.
      await new Promise<void>((resolve) => {
        if (audio.readyState >= 4) return resolve();
        const done = () => {
          audio.removeEventListener('canplaythrough', done);
          audio.removeEventListener('error', done);
          resolve();
        };
        audio.addEventListener('canplaythrough', done, { once: true });
        audio.addEventListener('error', done, { once: true });
        setTimeout(resolve, 2000); // safety net — never block forever
      });
      if (ttsAbortRef.current) {
        try { URL.revokeObjectURL(url); } catch { /* ignore */ }
        return;
      }
      nextAudioBufferRef.current = { audio, url, idx, chapterId };
      ttsDebug('warmUpNextAudio ready', { idx, chapterId });
    } catch (e) {
      // Non-fatal — speakParagraph will fall back to the existing
      // fetch-then-play path. Logged for visibility.
      ttsWarn('warmUpNextAudio failed', { idx, chapterId, err: String(e) });
    }
  }

  async function startTts(fromIndex = 0) {
    const runId = ++ttsRunIdRef.current;
    ttsDebug('startTts invoked', { runId, fromIndex, ttsState: ttsStateRef.current });

    // ── Synchronously unlock browser audio within the user gesture ───────
    // The "Đọc to" button click is our user gesture, but by the time we get
    // to audio.play() in speakParagraph we've crossed multiple awaits
    // (chapter paragraphs fetch + TTS blob fetch), so the gesture context
    // is gone and audio.play() rejects with NotAllowedError silently.
    //
    // Fix: synchronously create an Audio element with a tiny in-memory
    // silent WAV and call play() on it RIGHT NOW, before any await. This
    // succeeds (it's a valid media element within a user gesture), which
    // unlocks the document's autoplay policy. Subsequent new Audio(url).play()
    // calls in speakParagraph then work without a fresh user gesture.
    //
    // We discard the unlock element after; speakParagraph creates its own.
    try {
      // 44-byte silent mono 8 kHz WAV (≈ 1 ms of silence).
      const SILENT_WAV =
        'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
      const unlock = new Audio(SILENT_WAV);
      unlock.volume = 0;       // double-safety in case any platform leaks audio
      unlock.play().then(() => { unlock.pause(); }).catch(() => { /* ignore */ });
    } catch { /* older browsers — best-effort only */ }
    // Use the ref so we always pick up the chapter at the moment we run,
    // even if currentIdx changed (auto-advance) between calls.
    const myChapter = currentChapterRef.current;
    if (!myChapter) {
      ttsWarn('startTts aborted: no current chapter (metadata not loaded yet?)');
      return;
    }
    const myChapterIdx = chapters.findIndex((c) => c.id === myChapter.id);
    if (myChapterIdx < 0) {
      ttsWarn('startTts aborted: chapter not in list', { chapterId: myChapter.id });
      return;
    }
    ttsDebug('startTts chapter resolved', {
      chapterId: myChapter.id, chapterTitle: myChapter.title, chapterIdx: myChapterIdx,
    });

    ttsAbortRef.current = false;
    consecutivePlayRejectsRef.current = 0;  // S5: reset streak counter
    ttsStateRef.current = 'loading';
    setTtsState('loading');
    // Cancel any voice-preview still playing so it doesn't overlap
    if (voicePreviewAudioRef.current) {
      voicePreviewAudioRef.current.pause();
      voicePreviewAudioRef.current = null;
      setPreviewingVoice(null);
    }

    // Character discovery is expensive (often 20–60s). Start it only after
    // the user explicitly asks for TTS; ordinary reading/navigation keeps the
    // lightweight cached attribution path below and never wakes the LLM.
    void detectChapterCharacters(myChapter.id);

    // Load current chapter's paragraphs (from cache if we have them)
    let paras = chapterParagraphsRef.current.get(myChapter.id);
    if (!paras) {
      ttsDebug('fetching paragraphs for chapter', { chapterId: myChapter.id });
      const fetchStart = performance.now();
      try {
        paras = await getChapterParagraphs(myChapter.id);
      } catch (e) {
        ttsWarn('getChapterParagraphs failed', { chapterId: myChapter.id, err: String(e) });
        ttsStateRef.current = 'idle';
        setTtsState('idle');
        return;
      }
      ttsDebug('paragraphs fetched', { count: paras.length, ms: Math.round(performance.now() - fetchStart) });
    } else {
      ttsDebug('paragraphs cache hit', { count: paras.length });
    }
    setTtsParagraphs(paras);
    if (ttsRunIdRef.current !== runId || ttsAbortRef.current) {
      ttsDebug('startTts aborted during/after paragraph load (runId/abort changed)');
      return;
    }
    if (paras.length === 0) {
      ttsWarn('startTts aborted: chapter has 0 paragraphs', { chapterId: myChapter.id });
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
    // S2 fix (2026-07-08): startTts is invoked fire-and-forget from a
    // button click / setTimeout / voice command — there was no outer
    // .catch on it. If the very first paragraph's prefetchParagraph
    // throws (TTS server down, malformed text, etc.), the rejection
    // bubbled up unhandled, ttsState stayed at 'playing' forever, and
    // the user had to click Stop. Now any error inside the loop rolls
    // the state machine back to idle and surfaces a single chip.
    try {
      for (let i = fromIndex; i < paras.length; i++) {
      if (ttsAbortRef.current || ttsRunIdRef.current !== runId) break;
      setTtsIndex(i);
      syncTtsHighlight(i);
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
      const emo = ttsUseAI ? detectEmotion(paras[i], ttsSpeed, ttsNoise, ttsEmotionIntensityRef.current) : { speed: ttsSpeed, noiseScale: ttsNoise, label: '', emoji: '', emotion: 'neutral' };
      const emotionSuffix = emo.label ? ` · ${emo.emoji} ${emo.label}` : '';
      const speakerSuffix = sp.name ? ` · ${sp.name}` : '';
      setTtsEmotionLabel(`${speakerSuffix}${emotionSuffix}`);

      await speakParagraph(myChapter.id, paras, i, undefined, sp.name, emo.emotion, emo.noiseScale);
      if (ttsAbortRef.current || ttsRunIdRef.current !== runId) break;
      // S5 fix (2026-07-08): if audio.play() has been rejected N times in
      // a row (e.g. tab lost focus, audio context suspended, OS muted the
      // tab), the loop was silently skipping every paragraph and the user
      // had no idea why "nothing was playing". Trip a halt after the
      // threshold and surface a chip so the user knows to refocus the tab.
      if (ttsLastFinishReasonRef.current === 'play-rejected') {
        consecutivePlayRejectsRef.current += 1;
        if (consecutivePlayRejectsRef.current >= MAX_CONSECUTIVE_PLAY_REJECTS) {
          ttsWarn('startTts halted — consecutive play() rejections', {
            count: consecutivePlayRejectsRef.current,
            chapterIdx: myChapterIdx,
            hint: 'Browser is blocking autoplay. Click the reader, then press Play again.',
          });
          setTtsEmotionLabel('⚠️ Tạm dừng — tab mất focus?');
          ttsAbortRef.current = true;
          ttsRunIdRef.current += 1;
          ttsStateRef.current = 'idle';
          setTtsState('idle');
          finishCurrentTtsAudio();
          return;
        }
      } else {
        consecutivePlayRejectsRef.current = 0;
      }
    }
    } catch (err) {
      // S2 fix (2026-07-08): roll the state machine back to idle and
      // surface a single chip instead of leaving the run in 'playing'
      // with no audio. User can retry from Stop → Play.
      const msg = err instanceof Error ? err.message : String(err);
      ttsWarn('startTts loop failed — rolling back to idle', { runId, err: msg });
      ttsAbortRef.current = true;
      ttsRunIdRef.current += 1;  // invalidate any pending iterations
      ttsStateRef.current = 'idle';
      setTtsState('idle');
      setTtsIndex(0);
      setTtsParagraphs([]);
      setTtsEmotionLabel('');
      setTtsCurrentSpeaker(null);
      syncTtsHighlight(null);
      clearNextAudioBuffer();
      return;
    }

    if (ttsAbortRef.current || ttsRunIdRef.current !== runId) {
      // User stopped — nothing to do
      return;
    }

    // ── Chapter finished ──────────────────────────────────────────
    // If continuous-play is enabled AND there's a next chapter, advance.
    // Otherwise, just go idle (user can manually go to next chapter).

    // Character Bible auto-refresh — fire after each chapter so the bible
    // accumulates new characters / relationships / speech-style hints the
    // LLM discovers. Debounced 5 s and deduped server-side via BullMQ
    // jobId so a flurry of "advance" events collapses to one worker call.
    // `bookId` is captured by closure; safe to use from this async path.
    enqueueBibleRefresh({
      bookId,
      chapterIndex: myChapterIdx,
      reason: 'chapter-close',
    });

    if (ttsContinuousPlay && myChapterIdx + 1 < chapters.length) {
      // Mark this as an auto-advance so the chapter-change useEffect
      // doesn't call stopTts() and tear down our state.
      ttsIsAdvancingRef.current = true;
      const nextChapter = chapters[myChapterIdx + 1];
      // Trigger iframe nav + state update via goToChapter (this sets currentIdx)
      // Note: goToChapter calls saveProgress too.
      goToChapter(myChapterIdx + 1);
      // S1 fix (2026-07-08): previously the auto-advance fired `startTts(0)`
      // 600 ms later and the first paragraph of the new chapter paid the
      // full fetch + new Audio + load + canplaythrough cost — 1.5–3 s of
      // silence at every chapter boundary in continuous-play. The blob was
      // usually already in the prefetch cache (pregenerateChapter was
      // kicked off at the start of this chapter), so we just needed to
      // decode it into an HTMLAudioElement while we wait for React to
      // re-render with the new chapter. That gives the upcoming
      // speakParagraph(0, ...) a preloaded audio to pop off the ref.
      setTimeout(() => {
        void (async () => {
          if (ttsAbortRef.current || ttsRunIdRef.current !== runId) return;
          // Pre-decode paragraph 0 of the next chapter. chapterParagraphsRef
          // is already populated by pregenerateChapter (which ran when
          // THIS chapter started), so the blob fetch is a cache hit and
          // only the decode is the new work.
          try {
            if (nextChapter) {
              const nextParas = chapterParagraphsRef.current.get(nextChapter.id);
              if (nextParas && nextParas.length > 0) {
                await warmUpNextAudio(nextChapter.id, nextParas, 0);
              }
            }
          } catch (e) {
            ttsWarn('chapter-transition warmup failed — falling back to cold start', {
              nextChapterId: nextChapter?.id, err: String(e),
            });
          }
          if (ttsAbortRef.current || ttsRunIdRef.current !== runId) return;
          void startTts(0);
        })();
      }, 200);   // 200 ms is enough for goToChapter's React state to settle
                 // (we don't need 600 ms any more — the heavy work is now
                 // the warm-up, which we kicked off BEFORE startTts).
      return;
    }

    // End of book or continuous-play off
    ttsStateRef.current = 'idle';
    setTtsState('idle');
    setTtsIndex(0);
    setTtsCurrentSpeaker(null);
  }

  function stopTts() {
    ttsDebug('stopTts called', { runId: ttsRunIdRef.current, state: ttsStateRef.current });
    ttsRunIdRef.current += 1;
    ttsAbortRef.current = true;
    // BUGFIX 2026-07-11: cancel any pending paragraph-gap timer so the
    // loop doesn't fire `resolve()` for a paragraph the user has already
    // abandoned. Without this, the gap timer was independent of the run
    // id and could let the next speakParagraph kick in even after Stop.
    if (gapTimerRef.current) {
      clearTimeout(gapTimerRef.current);
      gapTimerRef.current = null;
    }
    finishCurrentTtsAudio();
    ttsStateRef.current = 'idle';
    setTtsState('idle');
    setTtsIndex(0);
    setTtsParagraphs([]);
    setTtsEmotionLabel('');
    // Cancel any in-flight pre-generation (it polls ttsAbortRef between batches)
    setPregenStatus(null);
    syncTtsHighlight(null);
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
      // S6 fix (2026-07-08): also gate on ttsAbortRef — if the user hit
      // Stop (or another restartTtsAt) inside the 100 ms debounce window,
      // ttsRunIdRef would already be different and this guard would catch
      // it, but if a future refactor ever decouples runId from abort, the
      // abort check keeps us from re-spawning a fresh run after Stop.
      if (ttsRunIdRef.current === resumeRunId && !ttsAbortRef.current && currentChapterRef.current?.id === ch.id) void startTts(target);
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
        // S6 fix (2026-07-08): also gate on ttsAbortRef — see the
        // matching note in restartTtsAt. Belt-and-suspenders against any
        // future refactor that decouples runId from abort.
        if (ttsRunIdRef.current === resumeRunId && !ttsAbortRef.current) void startTts(0);
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

  // Sensitivity fix (2026-07-08): substring matching was too eager — a
  // trailing word like "play" or "stop" anywhere in the transcript fired
  // the command, even when the user was just reading aloud or the mic
  // picked up background TV. New rules:
  //   • wordMatches() requires the phrase to align to word boundaries
  //     (so "play" matches the token "play" but NOT "playing"/"display"
  //     /"replay"/"parlay").
  //   • Min-length gate — a 1-word transcript can't match a 2-word
  //     phrase like "tiep tuc", so accidental single words don't trigger.
  //   • Cooldown gate — same/near-simultaneous transcripts can't
  //     double-fire (browser sometimes re-emits final results).
  //   • English single-word fallbacks ("play"/"stop"/"pause") are still
  //     accepted as standalone tokens but no longer as substrings.
  function wordMatches(command: string, phrase: string): boolean {
    const phraseTokens = phrase.split(' ').filter(Boolean);
    if (phraseTokens.length === 0) return false;
    const cmdTokens = command.split(' ').filter(Boolean);
    if (cmdTokens.length < phraseTokens.length) return false;
    // Word-boundary anchored substring search. Pad both sides so we can
    // look for " phrase " cleanly, then check the start/end edges.
    const padded = ` ${command} `;
    const target = ` ${phrase} `;
    if (padded.includes(target)) return true;
    if (padded.startsWith(`${phrase} `)) return true;
    if (padded.endsWith(` ${phrase}`)) return true;
    return false;
  }

  function handleVoiceCommand(transcript: string) {
    const raw = transcript.trim();
    const command = normalizeVoiceCommand(raw);
    if (!command) return;

    // Cooldown — drop any transcript that arrives within 1.5s of the
    // previous one. Stops the browser re-emitting the same final result
    // and stops noise bursts from firing multiple commands in a row.
    const now = Date.now();
    if (now - lastVoiceCommandAtRef.current < VOICE_COMMAND_COOLDOWN_MS) return;
    lastVoiceCommandAtRef.current = now;

    const feedback = (label: string) => setVoiceCommandText(`${raw} -> ${label}`);

    if (wordMatches(command, 'tat nghe lenh') || wordMatches(command, 'tat micro') || wordMatches(command, 'stop listening')) {
      stopVoiceControl();
      feedback('Tắt nghe lệnh');
      return;
    }
    if (wordMatches(command, 'dung lai') || wordMatches(command, 'ngung doc') || wordMatches(command, 'dung doc') || wordMatches(command, 'thoi doc')) {
      stopTts();
      feedback('Dừng đọc');
      return;
    }
    // "stop" as a standalone token — keeps English-mix ergonomic but can
    // no longer fire from "stopped" / "stopwatch" / etc.
    if (wordMatches(command, 'stop')) {
      stopTts();
      feedback('Dừng đọc');
      return;
    }
    if (wordMatches(command, 'tam dung') || wordMatches(command, 'cho nghi') || wordMatches(command, 'pause')) {
      if (ttsStateRef.current === 'playing') toggleTtsPause();
      feedback('Tạm dừng');
      return;
    }
    if (wordMatches(command, 'tiep tuc') || wordMatches(command, 'doc tiep') || wordMatches(command, 'bat dau doc') || wordMatches(command, 'doc di') || wordMatches(command, 'resume') || wordMatches(command, 'start reading')) {
      if (ttsStateRef.current === 'paused') toggleTtsPause();
      else if (ttsStateRef.current === 'idle') {
        void loadTtsContext();
        setTtsSettingsOpen(false);
        void startTts(0);
      }
      feedback('Tiếp tục đọc');
      return;
    }
    // "play" as a standalone token. Previously this was matched as a raw
    // substring, so "playing" / "display" / "parlay" / mid-sentence "play
    // nhạc" all fired it. Now strictly token-aligned, and we still only
    // resume/start — never interrupt active playback.
    if (wordMatches(command, 'play')) {
      if (ttsStateRef.current === 'paused') toggleTtsPause();
      else if (ttsStateRef.current === 'idle') {
        void loadTtsContext();
        setTtsSettingsOpen(false);
        void startTts(0);
      }
      feedback('Tiếp tục đọc');
      return;
    }
    if (wordMatches(command, 'doan sau') || wordMatches(command, 'doan tiep') || wordMatches(command, 'cau sau') || wordMatches(command, 'next paragraph')) {
      if (ttsStateRef.current !== 'idle') skipTtsParagraph(1);
      feedback('Đoạn sau');
      return;
    }
    if (wordMatches(command, 'doan truoc') || wordMatches(command, 'cau truoc') || wordMatches(command, 'previous paragraph')) {
      if (ttsStateRef.current !== 'idle') skipTtsParagraph(-1);
      feedback('Đoạn trước');
      return;
    }
    if (wordMatches(command, 'chuong sau') || wordMatches(command, 'chuong tiep') || wordMatches(command, 'next chapter')) {
      changeChapterByVoice(1);
      feedback('Chương sau');
      return;
    }
    if (wordMatches(command, 'chuong truoc') || wordMatches(command, 'previous chapter')) {
      changeChapterByVoice(-1);
      feedback('Chương trước');
      return;
    }
    if (wordMatches(command, 'trang sau') || wordMatches(command, 'next page')) {
      handleNext();
      feedback('Trang sau');
      return;
    }
    if (wordMatches(command, 'trang truoc') || wordMatches(command, 'previous page') || wordMatches(command, 'back page')) {
      handlePrev();
      feedback('Trang trước');
      return;
    }
    if (wordMatches(command, 'nhanh hon') || wordMatches(command, 'tang toc') || wordMatches(command, 'faster')) {
      setTtsSpeed((v) => Math.min(2.5, Math.round((v + 0.1) * 100) / 100));
      feedback('Tăng tốc');
      return;
    }
    if (wordMatches(command, 'cham hon') || wordMatches(command, 'giam toc') || wordMatches(command, 'slower')) {
      setTtsSpeed((v) => Math.max(0.5, Math.round((v - 0.1) * 100) / 100));
      feedback('Giảm tốc');
      return;
    }
    if (wordMatches(command, 'toc do binh thuong') || wordMatches(command, 'normal speed')) {
      setTtsSpeed(1);
      feedback('Tốc độ thường');
      return;
    }
    if (wordMatches(command, 'danh dau') || wordMatches(command, 'bookmark')) {
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
    // S3 fix (2026-07-08): track the URL outside the try-block so we can
    // revoke it in BOTH the normal-end and play()-rejection paths.
    // Before: `URL.createObjectURL(blob)` ran but `onerror` doesn't fire
    // on autoplay rejection, `onended` doesn't fire if the audio never
    // started, and the catch-block didn't revoke the URL. Repeated
    // previews accumulated leaked blob URLs in memory.
    let url: string | null = null;
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
      url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      voicePreviewAudioRef.current = audio;
      const cleanup = () => {
        try { URL.revokeObjectURL(url!); } catch { /* already revoked */ }
        setPreviewingVoice(null);
        voicePreviewAudioRef.current = null;
      };
      audio.onended = cleanup;
      audio.onerror = cleanup;
      // play() can reject with NotAllowedError if the tab lost focus, or
      // with AbortError on rapid previews. Either way `onended`/`onerror`
      // don't fire — so revoke here as well.
      audio.play().catch((err) => {
        console.warn('[tts preview] play() rejected — revoking URL', err);
        cleanup();
      });
    } catch (e) {
      if (url) { try { URL.revokeObjectURL(url); } catch { /* ignore */ } }
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

  // Load only cached attribution on navigation. Character discovery is much
  // more expensive and is triggered from startTts() after an explicit action.
  useEffect(() => {
    const ch = chapters[currentIdx];
    if (!ch) return;
    void loadChapterAttribution(ch.id);
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

  // CSS classes per theme — token-backed via `readerSurface(...)`. Sepia
  // has bespoke colours because it must look distinctly warm even when
  // the surrounding app is in light or dark mode; light + dark reuse the
  // `--reader-*` tokens declared in src/app/theme.css.
  const headerCls = readerSurface(settings.theme, 'header');
  const panelCls  = readerSurface(settings.theme, 'panel');
  const dividerCls = readerSurface(settings.theme, 'divider');
  const mutedCls  = readerSurface(settings.theme, 'muted');
  const activeCls = readerSurface(settings.theme, 'active');
  const hoverCls  = readerSurface(settings.theme, 'hover');
  const inputCls  = readerSurface(settings.theme, 'input');
  const btnBorder = readerSurface(settings.theme, 'btnBorder');
  const btnStyle  = { color: themeObj.text, borderColor: btnBorder, background: 'transparent' };
  const ttsSeekMax = Math.max(0, ttsParagraphs.length - 1);
  const ttsProgressPct = ttsParagraphs.length > 0
    ? Math.round(((ttsIndex + 1) / ttsParagraphs.length) * 100)
    : 0;

  const NavPanel = ({ side, open, children }: { side: 'left' | 'right'; open: boolean; children: React.ReactNode }) => (
    !open ? null :
    <aside
      onClick={(e) => e.stopPropagation()}
      aria-label={side === 'left' ? 'Reader navigation panel' : 'Reader settings panel'}
      className={cn(
        'absolute inset-y-0 z-20 flex flex-col shadow-2xl transition-transform duration-200 ease-in-out overflow-y-auto',
        panelCls,
        side === 'left' ? 'left-0 w-72 border-r' : 'right-0 w-80 border-l',
        'translate-x-0',
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
        <Link href="/library" title="Back to library" aria-label="Back to library" className={buttonClasses({ variant: 'ghost', size: 'icon', className: 'h-8 w-8' })}>
          <Home className="h-4 w-4" />
        </Link>
        <Link href={`/library/${bookId}`} title="Thông tin sách & AI Illustrations" aria-label="Thông tin sách" className={buttonClasses({ variant: 'ghost', size: 'icon', className: 'hidden h-8 w-8 md:inline-flex' })}>
          <Info className="h-4 w-4" />
        </Link>
        {/* Gallery of all AI-generated chapter illustrations. Click a
            thumbnail in the side panel to jump to that chapter. The
            panel sits on the right so the current chapter stays visible
            alongside, mirroring the Watermark / Bookmarks / TTS panels. */}
        <Tooltip content={<span>Gallery ảnh (G)</span>} side="bottom" className="hidden md:inline-flex">
          <button type="button" onClick={() => { setGalleryOpen((o) => !o); setTocOpen(false); setSettingsOpen(false); setBookmarksOpen(false); setWmOpen(false); }}
            aria-label="Image gallery"
            aria-expanded={galleryOpen}
            data-testid="gallery-toggle"
            className={cn('flex h-8 w-8 items-center justify-center rounded-md transition-colors border border-border', galleryOpen ? activeCls : `border-transparent ${hoverCls}`)}
            title="Gallery ảnh">
            <Images className="h-4 w-4" />
          </button>
        </Tooltip>
        <Tooltip content={<span className="inline-flex items-center gap-1.5">Mục lục <KbdHint keys={['T']} /></span>} side="bottom">
          <button type="button" onClick={() => { setTocOpen((o) => !o); setSettingsOpen(false); setBookmarksOpen(false); setWmOpen(false); }}
            data-testid="toc-toggle"
            aria-label="Table of Contents"
            aria-expanded={tocOpen}
            className={cn('flex h-8 w-8 items-center justify-center rounded-md transition-colors border border-border', tocOpen ? activeCls : `border-transparent ${hoverCls}`)}
            title="Mục lục (T)">
            <List className="h-4 w-4" />
          </button>
        </Tooltip>

        <div className="flex-1 min-w-0 text-center px-2">
              <h1 className="text-xs font-semibold truncate">{bookTitle}</h1>
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
              className={cn('w-12 rounded border border-border text-center text-xs py-0.5 outline-none focus-visible:ring-2 focus-visible:ring-ring', inputCls)} title="Jump to chapter" aria-label="Số chương muốn mở" />
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
        <div className="hidden md:flex rounded-md border border-border overflow-hidden">
          {(['spread', 'scroll'] as Layout[]).map((l) => (
            <Tooltip key={l} content={l === 'spread' ? 'Hai cột (Apple Books)' : 'Cuộn dọc'} side="bottom">
              <button onClick={() => updateSetting('layout', l)} title={l === 'spread' ? 'Hai cột (Apple Books)' : 'Cuộn dọc'}
                type="button" aria-label={l === 'spread' ? 'Hai cột' : 'Cuộn dọc'} aria-pressed={settings.layout === l}
                className={cn('flex h-7 w-7 items-center justify-center border-r last:border-r-0 transition-colors', settings.layout === l ? activeCls : `border-transparent ${hoverCls}`)}>
                {l === 'spread' ? <Columns className="h-3.5 w-3.5" /> : <ScrollText className="h-3.5 w-3.5" />}
              </button>
            </Tooltip>
          ))}
        </div>

        <Tooltip content={<span className="inline-flex items-center gap-1.5">{isBookmarked ? 'Bỏ bookmark' : 'Bookmark'} <KbdHint keys={['B']} /></span>} side="bottom" className="hidden md:inline-flex">
          <button onClick={toggleBookmark}
            type="button" aria-label={isBookmarked ? 'Bỏ bookmark chương này' : 'Bookmark chương này'} aria-pressed={isBookmarked}
            className={cn('flex h-8 w-8 items-center justify-center rounded-md border border-border transition-colors', isBookmarked ? activeCls : `border-transparent ${hoverCls}`)}
            title={isBookmarked ? 'Bỏ bookmark (B)' : 'Bookmark (B)'}>
            {isBookmarked ? <BookmarkCheck className="h-4 w-4" /> : <Bookmark className="h-4 w-4" />}
          </button>
        </Tooltip>
        <button type="button" onClick={() => { setBookmarksOpen((o) => !o); setTocOpen(false); setSettingsOpen(false); setWmOpen(false); }}
          aria-label="Danh sách bookmark" aria-expanded={bookmarksOpen}
          className={cn('hidden md:flex h-8 w-8 items-center justify-center rounded-md border border-border transition-colors', bookmarksOpen ? activeCls : `border-transparent ${hoverCls}`)}>
          <AlignLeft className="h-4 w-4" />
        </button>
        <button type="button" onClick={() => { setSettingsOpen((o) => !o); setTocOpen(false); setBookmarksOpen(false); setWmOpen(false); setAbOpen(false); }}
          aria-label="Cài đặt trình đọc" aria-expanded={settingsOpen}
          className={cn('hidden md:flex h-8 w-8 items-center justify-center rounded-md border border-border transition-colors', settingsOpen ? activeCls : `border-transparent ${hoverCls}`)}>
          <Settings2 className="h-4 w-4" />
        </button>
        <button type="button" onClick={() => { setAbOpen((o) => !o); setTocOpen(false); setSettingsOpen(false); setBookmarksOpen(false); setWmOpen(false); setTtsSettingsOpen(false); }}
          aria-label="Audio, đọc thành tiếng và giọng" aria-expanded={abOpen}
          className={cn('hidden sm:flex h-8 w-8 items-center justify-center rounded-md border border-border transition-colors', abOpen ? activeCls : `border-transparent ${hoverCls}`)}
          title="Audio: Read aloud, Audiobook, Voices">
          <Headphones className="h-4 w-4" />
        </button>
        <button onClick={() => { setVoiceDebugOpen((o) => !o); setTocOpen(false); setSettingsOpen(false); setBookmarksOpen(false); setWmOpen(false); setAbOpen(false); }}
          data-testid="voice-debug-toggle"
          aria-label="Open voice debug panel"
          className={cn('hidden md:flex h-8 w-8 items-center justify-center rounded-md border border-border transition-colors', voiceDebugOpen ? activeCls : `border-transparent ${hoverCls}`)}
          title="Voice assignment debug (xem ai đang nói, voice nào)">
          <Bug className="h-4 w-4" />
        </button>
        <div
          ref={analyzerModeBtnRef}
          // NOTE: no `overflow-hidden` here on purpose — the dropdown
          // menu (absolutely positioned below) gets clipped by it, which
          // hid the mode picker entirely. Each child button gets its
          // own rounded corners so the visual still feels unified.
          className="relative hidden md:flex items-stretch h-8 rounded-md border border-border border-transparent"
          data-testid="analyzer-mode-split"
        >
          {/* Main button — runs with the currently-selected mode. Shows the
              mode name so users know what they're about to run AND that
              there's a mode picker next to it (the ▾ chevron was easy to
              miss on its own). */}
          <button
            onClick={() => { void runFullAnalysis(analyzerMode); }}
            disabled={analysisInFlight || !chapters[currentIdx]?.id}
            title={analysisInFlight
              ? `Đang chạy full analysis (mode = ${analyzerMode})…${analysisProgress ?? ''}`
              : `Full analysis — mode = ${analyzerMode}. Click ▾ bên phải để đổi mode.`}
            aria-label={`Run full analysis (mode = ${analyzerMode})`}
            data-testid="analyzer-run-btn"
            className={cn(
              'flex items-center justify-center gap-1.5 px-2.5 rounded-l-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
              analysisInFlight ? activeCls : hoverCls,
            )}
          >
            {analysisInFlight
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : <Wand2 className="h-4 w-4" />}
            <span className="text-[11px] font-medium capitalize">
              {analyzerMode === 'combine' ? 'Combine'
                : analyzerMode === 'full-llm' ? 'Full LLM'
                : 'Local'}
            </span>
          </button>
          {/* Divider */}
          <div className={cn('w-px shrink-0', dividerCls)} />
          {/* Dropdown trigger — opens mode picker. Wider + bordered so it's
              obviously clickable on its own. */}
          <button
            onClick={() => setAnalyzerModePickerOpen((o) => !o)}
            disabled={analysisInFlight}
            aria-label="Pick analyzer mode"
            aria-haspopup="menu"
            aria-expanded={analyzerModePickerOpen}
            data-testid="analyzer-mode-toggle"
            title={`Đổi mode (hiện tại: ${analyzerMode})`}
            className={cn(
              'flex items-center justify-center w-7 rounded-r-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
              analyzerModePickerOpen ? activeCls : hoverCls,
            )}
          >
            <ChevronDown className={cn(
              'h-3.5 w-3.5 transition-transform',
              analyzerModePickerOpen ? 'rotate-180' : '',
            )} />
          </button>
          {/* Dropdown menu */}
          {analyzerModePickerOpen && (
            <div
              role="menu"
              data-testid="analyzer-mode-menu"
              className={cn(
                'absolute right-0 top-9 z-50 w-72 rounded-md border border-border shadow-xl p-1',
                panelCls,
                dividerCls,
                'animate-in fade-in slide-in-from-top-2',
              )}
              onClick={(e) => e.stopPropagation()}
            >
              <div className={cn('px-3 py-2 text-[10px] uppercase tracking-wide', mutedCls)}>
                Chọn mode cho Full Analyzer
              </div>
              {ANALYZE_MODES.map((opt) => {
                const isSelected = analyzerMode === opt.id;
                return (
                  <button
                    key={opt.id}
                    role="menuitemradio"
                    aria-checked={isSelected}
                    data-testid={`analyzer-mode-${opt.id}`}
                    onClick={() => {
                      setAnalyzerModePersist(opt.id);
                      setAnalyzerModePickerOpen(false);
                    }}
                    className={cn(
                      'w-full text-left rounded px-3 py-2 flex flex-col gap-0.5 transition-colors',
                      isSelected ? 'bg-primary/15 ring-1 ring-primary/40' : hoverCls,
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{opt.label}</span>
                      <span className={cn('text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded', opt.hintCls)}>
                        {opt.hint}
                      </span>
                      {isSelected && (
                        <Check className="h-3 w-3 ml-auto text-primary" />
                      )}
                    </div>
                    <div className={cn('text-[11px] leading-snug', mutedCls)}>
                      {opt.desc}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <button type="button" onClick={toggleFullscreen} aria-label={fullscreen ? 'Thoát toàn màn hình' : 'Toàn màn hình'} aria-pressed={fullscreen} className={cn('hidden sm:flex h-8 w-8 items-center justify-center rounded-md border border-border border-transparent', hoverCls)}>
          {fullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
        </button>
        <button
          type="button"
          onClick={toggleVoiceControl}
          disabled={!voiceControlSupported}
          title={voiceControlSupported ? (voiceControlOn ? 'Tắt nghe lệnh giọng nói' : 'Bật nghe lệnh giọng nói') : 'Trình duyệt không hỗ trợ nhận lệnh giọng nói'}
          aria-label={voiceControlOn ? 'Tắt điều khiển giọng nói' : 'Bật điều khiển giọng nói'}
          aria-pressed={voiceControlOn}
          className={cn('hidden md:flex h-8 w-8 items-center justify-center rounded-md border border-border transition-colors disabled:opacity-40 disabled:cursor-not-allowed',
            voiceControlOn ? activeCls : `border-transparent ${hoverCls}`)}>
          <Mic className="h-4 w-4" />
        </button>
        <ServiceHealth showWorker={false} className="hidden md:inline-flex" />
        {/* TTS toggle — opens settings panel when idle, stops when active. Visual
            hierarchy: filled primary when actively reading, outlined when
            idle, so the eye finds the most-used action first. */}
        <button
          onClick={() => {
            if (ttsState === 'idle') {
              void loadTtsContext();
              setAbTab('readAloud');
              setAbOpen(true);
              setTtsSettingsOpen(false);
            } else {
              stopTts();
            }
          }}
          title={ttsState === 'idle' ? 'Read aloud controls' : 'Stop reading'}
          aria-label={ttsState === 'idle' ? 'Open read aloud controls' : 'Stop reading aloud'}
          aria-pressed={ttsState !== 'idle'}
          className={cn(
            'flex h-8 items-center gap-1.5 rounded-md border border-border px-2 transition-colors shrink-0',
            ttsState === 'playing'
              ? 'bg-primary text-primary-foreground border-primary shadow-sm'
              : ttsState === 'loading'
                ? 'bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/30'
                : ttsState !== 'idle'
                  ? `${activeCls} border-primary/40`
                  : `border-transparent ${hoverCls}`,
          )}>
          {ttsState === 'loading'
            ? <Loader2 className="h-4 w-4 animate-spin" />
            : ttsState !== 'idle'
            ? <VolumeX className="h-4 w-4" />
            : <Volume2 className="h-4 w-4" />}
          <span className="hidden sm:inline text-[11px] font-medium">
            {ttsState === 'playing' ? 'Dừng' : ttsState === 'paused' ? 'Tiếp' : ttsState === 'loading' ? '…' : 'Đọc'}
          </span>
        </button>

        {/* Mobile overflow menu — surfaces the secondary controls we hid
            below the `md:` breakpoint. Tap outside / ESC dismisses via
            Radix. Mirrors desktop actions without duplicating handlers. */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Mở menu công cụ khác"
              className={cn(
                'md:hidden flex h-8 w-8 items-center justify-center rounded-md border border-border border-transparent shrink-0',
                hoverCls,
              )}
              title="Mở menu công cụ khác"
            >
              <MoreVertical className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[14rem]">
            <DropdownMenuItem asChild className="gap-2">
              <Link href={`/library/${bookId}`}>
                <Info className="h-3.5 w-3.5" /> Thông tin sách
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => { setGalleryOpen(true); setTocOpen(false); setSettingsOpen(false); setBookmarksOpen(false); setWmOpen(false); }}
              className="gap-2"
            >
              <Images className="h-3.5 w-3.5" /> Gallery ảnh
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={toggleBookmark} className="gap-2">
              {isBookmarked ? <BookmarkCheck className="h-3.5 w-3.5" /> : <Bookmark className="h-3.5 w-3.5" />}
              {isBookmarked ? 'Bỏ bookmark chương này' : 'Bookmark chương này'}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => { setBookmarksOpen(true); setTocOpen(false); setSettingsOpen(false); setWmOpen(false); }}
              className="gap-2"
            >
              <AlignLeft className="h-3.5 w-3.5" /> Danh sách bookmark
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => { setSettingsOpen(true); setTocOpen(false); setBookmarksOpen(false); setWmOpen(false); setAbOpen(false); }}
              className="gap-2"
            >
              <Settings2 className="h-3.5 w-3.5" /> Cài đặt trình đọc
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => updateSetting('layout', settings.layout === 'spread' ? 'scroll' : 'spread')}
              className="gap-2"
            >
              {settings.layout === 'spread'
                ? <><ScrollText className="h-3.5 w-3.5" />Scroll layout</>
                : <><Columns className="h-3.5 w-3.5" />Spread layout (2 cột)</>}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => {
                setVoiceDebugOpen((o) => !o);
                setTocOpen(false); setSettingsOpen(false); setBookmarksOpen(false);
                setWmOpen(false); setAbOpen(false);
              }}
              className="gap-2"
            >
              <Bug className="h-3.5 w-3.5" />
              <span className="flex-1">Voice debug</span>
              {voiceDebugOpen && <Check className="h-3 w-3 text-primary" />}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => { void runFullAnalysis(analyzerMode); }}
              disabled={analysisInFlight || !chapters[currentIdx]?.id}
              className="gap-2"
            >
              {analysisInFlight
                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                : <Wand2 className="h-3.5 w-3.5" />}
              <span className="flex-1 capitalize">
                {analysisInFlight ? 'Đang chạy' : `Full Analyzer (${analyzerMode})`}
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={toggleVoiceControl}
              disabled={!voiceControlSupported}
              className="gap-2"
            >
              <Mic className="h-3.5 w-3.5" />
              <span className="flex-1">Điều khiển giọng nói</span>
              {voiceControlOn && <Check className="h-3 w-3 text-primary" />}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={toggleFullscreen}
              className="gap-2"
            >
              {fullscreen
                ? <><Minimize2 className="h-3.5 w-3.5" />Thoát toàn màn hình</>
                : <><Maximize2 className="h-3.5 w-3.5" />Toàn màn hình</>}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      {/* ── Full-LLM soft-warn dialog (added 2026-07-12) ──────────────────
          Pre-flight confirm for the 'Full LLM' analyzer mode on chapters
          with >300 paragraphs. Surfaces the cost estimate (paragraphs,
          chars, seconds, output tokens) so the user knows what they're
          committing to BEFORE the ~minute-long LLM call starts. Cancel
          closes without invoking the analyzer; confirm sets the
          continuation ref and re-enters runFullAnalysis — which now
          bypasses this gate because pendingContinueFullLLMRef === true. */}
      <Dialog
        open={fullLLMPending}
        onOpenChange={(open) => { if (!open) setFullLLMPending(false); }}
        title="Full LLM trên chương lớn"
        description="Bạn sắp gửi TOÀN BỘ chương qua một LLM call. Có thể chậm và tốn token."
        widthClass="max-w-md"
      >
        <DialogBody>
          {fullLLMEstimate && (
            <div className="space-y-3 text-sm">
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground">Số đoạn:</span>
                <span className="font-medium tabular-nums">{fullLLMEstimate.paragraphCount}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground">Độ dài chương:</span>
                <span className="font-medium tabular-nums">
                  {(fullLLMEstimate.chapterCharCount / 1000).toFixed(1)}k chars
                </span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground">Ước tính thời gian:</span>
                <span className="font-medium tabular-nums">~{fullLLMEstimate.estimatedSeconds}s</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground">Output tokens:</span>
                <span className="font-medium tabular-nums">~{fullLLMEstimate.estimatedOutputTokens}</span>
              </div>
              <p className="text-xs text-amber-600 dark:text-amber-400 pt-2 border-t border-border/50 leading-relaxed">
                Nếu LLM trả về JSON không hợp lệ (timeout, bị cắt giữa chừng,
                model hallucinate idx), kết quả có thể bị mất một phần và những
                đoạn đó sẽ fallback về voice mặc định. Chạy lại với mode
                &quot;Combine&quot; để retry chỉ những đoạn chưa gán.
              </p>
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          <button
            type="button"
            onClick={() => setFullLLMPending(false)}
            className={cn(buttonClasses({ variant: 'ghost', size: 'sm' }))}
          >
            Hủy
          </button>
          <button
            type="button"
            onClick={() => {
              setFullLLMPending(false);
              pendingContinueFullLLMRef.current = true;
              void runFullAnalysis('full-llm');
            }}
            className={cn(buttonClasses({ variant: 'default', size: 'sm' }))}
          >
            Chạy Full LLM
          </button>
        </DialogFooter>
      </Dialog>

      {/* ── Keyboard shortcuts overlay (UI Polish §5.3) ─────────────────
          Opens on '?' / Shift+/. ESC closes. Uses the hand-rolled
          focus-trapping modal substrate (matches Analyzer drawer
          behaviour) rather than <Dialog> because it must sit above
          EVERY reader surface (z-100). */}
      {shortcutsOpen && mounted && createPortal(
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="shortcuts-overlay-title"
          className="fixed inset-0 z-[100] flex items-center justify-center bg-modal-overlay/50 p-4 animate-in fade-in"
          onClick={() => setShortcutsOpen(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className={cn(
              'w-full max-w-md rounded-lg border border-border shadow-2xl p-5 space-y-4',
              'animate-in zoom-in-95 fade-in',
              panelCls,
            )}>
            <div className="flex items-center justify-between">
              <h2 id="shortcuts-overlay-title" className="font-semibold text-sm flex items-center gap-1.5">
                <KbdHint keys={['?']} />
                <span>Phím tắt</span>
              </h2>
              <button
                type="button"
                onClick={() => setShortcutsOpen(false)}
                aria-label="Đóng"
                className={cn('rounded p-1', hoverCls)}
                title="Đóng (ESC)">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <ul className="space-y-2 text-xs">
              <li className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Trang sau / Phát</span>
                <KbdHint keys={['→']} /><span className="text-muted-foreground">/</span><KbdHint keys={['Space']} />
              </li>
              <li className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Trang trước</span>
                <KbdHint keys={['←']} />
              </li>
              <li className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Mục lục</span>
                <KbdHint keys={['T']} />
              </li>
              <li className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Bookmark</span>
                <KbdHint keys={['B']} />
              </li>
              <li className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Đóng panel / overlay</span>
                <KbdHint keys={['Esc']} />
              </li>
              <li className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Mở hộp phím tắt này</span>
                <KbdHint keys={['?']} />
              </li>
            </ul>
            <p className={cn('text-[10px] pt-1 border-t', dividerCls, mutedCls)}>
              Nhấn <KbdHint keys={['?']} /> bất kỳ lúc nào để mở lại hộp này.
            </p>
          </div>
        </div>,
        document.body,
      )}

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
            <button type="button" onClick={() => setVoiceCommandText('')} className={cn('rounded px-1.5 py-0.5', hoverCls)} title="Ẩn" aria-label="Ẩn lệnh giọng nói">
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      )}

      {/* ── TTS status bar (visible while reading OR while an error is showing) ── */}
      {(ttsState !== 'idle' || ttsLastError) && (
        <div
          role="status"
          aria-live="polite"
          className={cn(
            'space-y-1.5 px-3 py-1.5 shrink-0 text-xs transition-colors',
            ttsState === 'playing'
              ? 'border-b-2 border-primary/40 bg-primary/[0.04]'
              : 'border-b',
            headerCls,
          )}
        >
          {ttsLastError && (
            <div className="flex items-center gap-1.5 rounded bg-red-500/15 text-red-600 dark:text-red-400 px-2 py-1">
              <Bug className="h-3 w-3 shrink-0" />
              <span className="flex-1 truncate" title={ttsLastError}>
                Read-aloud: {ttsLastError}
              </span>
              <button
                type="button"
                onClick={() => setTtsLastError(null)}
                className="rounded px-1 hover:bg-red-500/20"
                title="Dismiss"
                aria-label="Dismiss read-aloud error"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          )}
          <div className="flex items-center gap-2">
            <Volume2 className="h-3.5 w-3.5 shrink-0 opacity-70" />
            <span className={cn('flex-1 truncate', mutedCls)}>
              {ttsState === 'loading' ? 'Đang chuẩn bị…'
                : ttsParagraphs.length > 0 ? `Đoạn ${ttsIndex + 1} / ${ttsParagraphs.length} · ${ttsProgressPct}%`
                : 'Đang đọc…'}
              {ttsEmotionLabel && <span className="ml-1.5 opacity-80">{ttsEmotionLabel}</span>}
              {ttsCurrentSpeaker && (
                <span className="ml-1.5 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-primary/15 text-primary text-[10px] font-medium">
                  {ttsCurrentSpeaker}
                </span>
              )}
            </span>
            <div className="hidden sm:flex items-center gap-1 shrink-0">
              {[0.75, 1.0, 1.25, 1.5].map((s) => (
                <button key={s} type="button" onClick={() => setTtsSpeed(s)} aria-label={`Tốc độ đọc ${s}x`} aria-pressed={ttsSpeed === s}
                  className={cn('rounded px-1.5 py-0.5 text-[10px] border border-border transition-colors',
                    ttsSpeed === s ? activeCls : `border-transparent ${hoverCls}`)}>
                  {s}×
                </button>
              ))}
            </div>
            <button type="button" onClick={toggleTtsPause}
              className={cn('flex h-6 w-6 items-center justify-center rounded border border-border', hoverCls)}
              title={ttsState === 'paused' ? 'Tiếp tục' : 'Tạm dừng'} aria-label={ttsState === 'paused' ? 'Tiếp tục đọc' : 'Tạm dừng đọc'}>
              {ttsState === 'paused' ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
            </button>
            <button type="button" onClick={stopTts}
              className={cn('flex h-6 w-6 items-center justify-center rounded border border-border', hoverCls)}
              title="Dừng" aria-label="Dừng đọc thành tiếng">
              <Square className="h-3 w-3" />
            </button>
          </div>
          <input
            type="range"
            min={0}
            max={ttsSeekMax}
            step={1}
            value={Math.min(ttsIndex, ttsSeekMax)}
            onChange={(e) => restartTtsAt(parseInt(e.target.value, 10))}
            disabled={ttsParagraphs.length < 2}
            className="w-full h-1.5 cursor-pointer"
            style={{ accentColor }}
            title="Chọn đoạn để đọc"
            aria-label="Chọn đoạn để đọc"
            aria-valuetext={ttsParagraphs.length ? `Đoạn ${ttsIndex + 1} trên ${ttsParagraphs.length}` : undefined}
          />
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
              <input type="search" placeholder="Search…" value={tocSearch} onChange={(e) => setTocSearch(e.target.value)} aria-label="Tìm chương"
                className={cn('w-full rounded-md border border-border pl-8 pr-3 py-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring', inputCls)} />
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
                      data-testid={`toc-chapter-${ri}`}
                      data-chapter-id={ch.id}
                      aria-current={active ? 'page' : undefined}
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
              <p className={cn('px-4 py-8 text-xs text-center', mutedCls)}>No bookmarks.<br />Press <kbd className="px-1 rounded border border-border">B</kbd> to add one.</p>
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
            <button type="button" onClick={() => setSettingsOpen(false)} aria-label="Đóng cài đặt trình đọc" className={cn('rounded p-1', hoverCls)}><X className="h-3.5 w-3.5" /></button>
          </div>
          <div className="flex-1 space-y-5 p-4 overflow-y-auto">
            {/* Layout */}
            <div>
              <p className={cn('mb-2 text-[10px] font-semibold uppercase tracking-widest', mutedCls)}>Layout</p>
              <div className="grid grid-cols-2 gap-2">
                {[{ id: 'spread' as Layout, label: 'Book (2-col)', icon: Columns },
                  { id: 'scroll' as Layout, label: 'Scroll', icon: ScrollText }].map(({ id, label, icon: Icon }) => (
                  <button key={id} type="button" onClick={() => updateSetting('layout', id)} aria-pressed={settings.layout === id}
                    className={cn('flex flex-col items-center gap-1 rounded-lg border border-border py-3 text-xs font-medium transition-all bg-transparent',
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
                  <button key={t.id} type="button" onClick={() => updateSetting('theme', t.id)} aria-pressed={settings.theme === t.id}
                    className={cn('flex-1 rounded-lg border border-border py-2.5 text-xs font-medium transition-all', settings.theme === t.id ? 'ring-2' : 'opacity-60')}
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
                  <button key={f.id} type="button" onClick={() => updateSetting('font', f.id)} aria-pressed={settings.font === f.id}
                    className={cn('flex-1 rounded-lg border border-border py-2 text-xs transition-all bg-transparent', settings.font === f.id ? activeCls + ' font-semibold' : `${hoverCls} opacity-70`)}
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
                <button type="button" onClick={() => updateSetting('fontSize', Math.max(12, settings.fontSize - 1))} aria-label="Giảm cỡ chữ"
                  className={cn('flex h-7 w-7 items-center justify-center rounded border border-border', hoverCls)}><Minus className="h-3.5 w-3.5" /></button>
                <input type="range" min={12} max={28} step={1} value={settings.fontSize}
                  onChange={(e) => updateSetting('fontSize', parseInt(e.target.value, 10))} className="flex-1" style={{ accentColor }} aria-label="Cỡ chữ" aria-valuetext={`${settings.fontSize}px`} />
                <button type="button" onClick={() => updateSetting('fontSize', Math.min(28, settings.fontSize + 1))} aria-label="Tăng cỡ chữ"
                  className={cn('flex h-7 w-7 items-center justify-center rounded border border-border', hoverCls)}><Plus className="h-3.5 w-3.5" /></button>
              </div>
            </div>
            {/* Line height */}
            <div>
              <div className="flex justify-between mb-2">
                <p className={cn('text-[10px] font-semibold uppercase tracking-widest', mutedCls)}>Line Spacing</p>
                <span className="text-xs font-mono">{settings.lineHeight.toFixed(2)}×</span>
              </div>
              <input type="range" min={1.3} max={2.8} step={0.05} value={settings.lineHeight}
                onChange={(e) => updateSetting('lineHeight', parseFloat(e.target.value))} className="w-full" style={{ accentColor }} aria-label="Giãn dòng" aria-valuetext={`${settings.lineHeight.toFixed(2)} lần`} />
              <div className={cn('flex justify-between text-[10px] mt-1', mutedCls)}><span>Tight</span><span>Normal</span><span>Spacious</span></div>
            </div>
            {/* Indent */}
            <div>
              <p className={cn('mb-2 text-[10px] font-semibold uppercase tracking-widest', mutedCls)}>Paragraph Indent</p>
              <div className="grid grid-cols-4 gap-1.5">
                {INDENT_PRESETS.map((p) => (
                  <button key={p.em} type="button" onClick={() => updateSetting('indent', p.em)} aria-pressed={settings.indent === p.em}
                    className={cn('rounded-lg border border-border py-2 text-[10px] font-medium transition-all bg-transparent', settings.indent === p.em ? activeCls : `${hoverCls} opacity-70`)}>
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
            {/* Width — always shown; in scroll mode it caps max-width,
                in spread mode it caps the column-pair width so each column
                stays readable on wide viewports. See buildSpreadCss and
                buildScrollCss in the chapters route. */}
            <div>
              <p className={cn('mb-2 text-[10px] font-semibold uppercase tracking-widest', mutedCls)}>Column Width</p>
              <div className="grid grid-cols-4 gap-1.5">
                {WIDTHS.map((w) => (
                  <button key={w.px} type="button" onClick={() => updateSetting('width', w.px)} aria-pressed={settings.width === w.px}
                    className={cn('rounded-lg border border-border py-2 text-[10px] font-medium transition-all bg-transparent', settings.width === w.px ? activeCls : `${hoverCls} opacity-70`)}>
                    {w.label}
                  </button>
                ))}
              </div>
              <p className={cn('mt-1.5 text-[10px]', mutedCls)}>
                {settings.layout === 'spread'
                  ? 'Total spread width — each column will be roughly half this value.'
                  : `Body text wraps at ${settings.width}px max.`}
              </p>
            </div>
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
                      className="w-full" style={{ accentColor }} aria-label={`Padding ${label}`} aria-valuetext={`${settings[key]}px`} />
                  </div>
                ))}
              </div>
            </div>
            {/* Reset */}
            <button type="button" onClick={() => { setSettings(DEFAULT_SETTINGS); saveSettings(DEFAULT_SETTINGS); }}
              className={cn('w-full flex items-center justify-center gap-1.5 rounded-lg border border-border py-2 text-xs', hoverCls)}>
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
                  className={cn('flex-1 flex items-center justify-center gap-1 rounded-lg border border-border py-2 text-[10px] font-medium', hoverCls)}>
                  <Search className="h-3 w-3" /> Detect
                </button>
                <button onClick={() => detectWatermarks(true)}
                  className={cn('flex-1 flex items-center justify-center gap-1 rounded-lg border border-border py-2 text-[10px] font-medium', hoverCls)}>
                  <Wand2 className="h-3 w-3" /> AI Detect
                </button>
              </div>
            </div>
            {/* Keyboard shortcuts */}
            <div className={cn('border-t pt-4 text-[10px] space-y-1.5', mutedCls, dividerCls)}>
              <p className="font-semibold uppercase tracking-widest mb-2">Shortcuts</p>
              {[['→ / Space','Next'],['←','Prev'],['T','TOC'],['B','Bookmark'],['Esc','Close']].map(([k,d]) => (
                <div key={k} className="flex justify-between items-center">
                  <kbd className="px-1.5 py-0.5 rounded border border-border font-mono text-[9px]">{k}</kbd><span>{d}</span>
                </div>
              ))}
            </div>
          </div>
        </NavPanel>

        {/* Watermark panel */}
        <NavPanel side="right" open={wmOpen}>
          <div className={cn('flex items-center justify-between px-4 py-3 border-b shrink-0', dividerCls)}>
            <span className="font-semibold text-sm flex items-center gap-1.5"><Wand2 className="h-3.5 w-3.5" />Watermark Detector</span>
            <button type="button" onClick={() => setWmOpen(false)} aria-label="Đóng Watermark Detector" className={cn('rounded p-1', hoverCls)}><X className="h-3.5 w-3.5" /></button>
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
                    <label key={i} className={cn('flex items-start gap-2 rounded-lg border border-border p-2.5 cursor-pointer transition-colors text-xs',
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

        {/* Image gallery panel — every AI-generated chapter illustration
            as a thumbnail. Click jumps the reader to that chapter. Closes
            any other right-side panel. */}
        <NavPanel side="right" open={galleryOpen}>
          <div className={cn('flex items-center justify-between px-4 py-3 border-b shrink-0', dividerCls)}>
            <span className="font-semibold text-sm flex items-center gap-1.5">
              <Images className="h-3.5 w-3.5" /> Gallery ảnh
            </span>
            <button type="button" onClick={() => setGalleryOpen(false)} aria-label="Đóng gallery" className={cn('rounded p-1', hoverCls)}>
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-4">
            <IllustrationsGallery
              bookId={bookId}
              currentChapterIdx={currentIdx}
              onJumpChapter={(idx) => { goToChapter(idx); setGalleryOpen(false); }}
            />
          </div>
        </NavPanel>

        {/* Audio panel: live read-aloud, pre-generated audiobook, and voices */}
        {abOpen && (
        <aside
          onClick={(e) => e.stopPropagation()}
          className={cn('absolute inset-y-0 right-0 z-20 flex flex-col shadow-2xl transition-transform duration-200 ease-in-out overflow-hidden',
            panelCls,
            'max-w-full border-l',
            'translate-x-0',
          )}
          style={{ width: audioPanelMobile ? '100vw' : `${audioPanelWidth}px` }}
        >
          {/* Left-edge resize handle (panel is right-anchored). Hidden on
              mobile because the panel is full-width and there's nothing
              to resize. */}
          {!audioPanelMobile && (
            <div
              data-testid="audio-panel-resize-handle"
              role="separator"
              aria-orientation="vertical"
              aria-label="Kéo để thay đổi chiều rộng bảng Audio — double-click để reset"
              onPointerDown={onAudioResizeHandlePointerDown}
              onPointerMove={onAudioResizeHandlePointerMove}
              onPointerUp={onAudioResizeHandlePointerUp}
              onPointerCancel={onAudioResizeHandlePointerUp}
              onDoubleClick={onAudioResizeHandleDoubleClick}
              className={cn(
                'group absolute inset-y-0 left-0 w-2 -translate-x-1/2 cursor-col-resize',
                'flex items-center justify-center',
                'z-30',
              )}
            >
              <div className={cn(
                'h-full w-[3px] rounded-full transition-colors',
                'bg-transparent group-hover:bg-blue-500/60 group-active:bg-blue-500',
              )} />
            </div>
          )}
          <div className={cn('flex items-center justify-between px-4 py-3 border-b shrink-0', dividerCls)}>
            <span className="font-semibold text-sm flex items-center gap-1.5">
              <Headphones className="h-3.5 w-3.5" />Audio
            </span>
            <button type="button" onClick={() => setAbOpen(false)} aria-label="Đóng bảng Audio" className={cn('rounded p-1', hoverCls)}><X className="h-3.5 w-3.5" /></button>
          </div>
          {/* Tabs */}
          <div className={cn('flex border-b shrink-0', dividerCls)} role="tablist" aria-label="Audio tools">
            <button type="button" role="tab" aria-selected={abTab === 'readAloud'} onClick={() => setAbTab('readAloud')}
              className={cn('flex-1 py-2 text-xs font-medium transition-colors border-b-2',
                abTab === 'readAloud' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground')}>
              Read aloud
            </button>
            <button type="button" role="tab" aria-selected={abTab === 'audiobook'} onClick={() => setAbTab('audiobook')}
              className={cn('flex-1 py-2 text-xs font-medium transition-colors border-b-2',
                abTab === 'audiobook' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground')}>
              Audiobook
            </button>
            <button type="button" role="tab" aria-selected={abTab === 'voices'} onClick={() => setAbTab('voices')}
              className={cn('flex-1 py-2 text-xs font-medium transition-colors border-b-2',
                abTab === 'voices' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground')}>
              Giọng
            </button>
            <button type="button" role="tab" aria-selected={abTab === 'characters'} onClick={() => setAbTab('characters')}
              className={cn('flex-1 py-2 text-xs font-medium transition-colors border-b-2',
                abTab === 'characters' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground')}>
              Nhân vật
            </button>
          </div>
          <div className={cn('flex-1 min-h-0 overflow-y-auto', abTab === 'readAloud' ? '' : 'p-4')}>
            {abTab === 'readAloud' ? (
              <Suspense fallback={<PanelSkeleton />}>
                <ReadAloudPanel
                  embedded
                  open
                  onClose={() => setAbOpen(false)}
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
                  emotionIntensity={ttsEmotionIntensity}
                  setEmotionIntensity={setTtsEmotionIntensity}
                  ttsState={ttsState}
                  ttsParagraphs={ttsParagraphs}
                  ttsIndex={ttsIndex}
                  ttsCurrentSpeaker={ttsCurrentSpeaker}
                  ttsEmotionLabel={ttsEmotionLabel}
                  onStart={() => startTts(0)}
                  onStop={stopTts}
                  onTogglePause={toggleTtsPause}
                  onSeekParagraph={restartTtsAt}
                  onPreviewDefaultVoice={previewDefaultVoice}
                  onStopPreview={stopVoicePreview}
                  previewingVoice={previewingVoice}
                  bookId={bookId}
                  onOpenVoiceLibrary={() => { setAbOpen(true); setAbTab('voices'); }}
                  accentColor={accentColor}
                  themeCls={panelCls}
                  mutedCls={mutedCls}
                  borderCls={dividerCls}
                  hoverCls={hoverCls}
                  activeCls={activeCls}
                />
              </Suspense>
            ) : abTab === 'audiobook' ? (
              <Suspense fallback={<PanelSkeleton />}>
                <AudiobookPanel bookId={bookId} />
              </Suspense>
            ) : abTab === 'voices' ? (
              <VoicePanel
                bookId={bookId}
                bookLanguage="vi"
                section="voices"
                useCharacterVoice={ttsUseCharacterVoice}
                setUseCharacterVoice={setTtsUseCharacterVoice}
              />
            ) : (
              <VoicePanel
                bookId={bookId}
                bookLanguage="vi"
                section="characters"
                useCharacterVoice={ttsUseCharacterVoice}
                setUseCharacterVoice={setTtsUseCharacterVoice}
              />
            )}
          </div>
        </aside>
        )}

        {/* Voice-assignment debug panel (left side) — moved from right to avoid
            overlapping with the Audio panel (right). On the left it slides
            over the table-of-contents / bookmarks area instead. */}
        {voiceDebugOpen && (
        <aside
          onClick={(e) => e.stopPropagation()}
          className={cn('absolute inset-y-0 left-0 z-20 flex flex-col shadow-2xl transition-transform duration-200 ease-in-out overflow-hidden',
            panelCls,
            'w-[26rem] max-w-full border-r',
            'translate-x-0',
          )}
        >
          <div className={cn('flex items-center justify-between px-4 py-3 border-b shrink-0', dividerCls)}>
            <span className="font-semibold text-sm flex items-center gap-1.5">
              <Bug className="h-3.5 w-3.5" />Voice assignment debug
            </span>
            <button type="button" onClick={() => setVoiceDebugOpen(false)} aria-label="Đóng Voice assignment debug" className={cn('rounded p-1', hoverCls)}><X className="h-3.5 w-3.5" /></button>
          </div>
          <Suspense fallback={<PanelSkeleton />}>
            <VoiceDebugPanel
              // Prefer the analyzer's paragraph texts (populated by the
              // most recent Full Analyzer run) when they match the current
              // chapter. `ttsParagraphs` is only populated when TTS playback
              // starts, so without this fallback the panel would be empty
              // if the user runs the analyzer before pressing play.
              paragraphs={
                analysisModal && analysisModal.chapterId === chapters[currentIdx]?.id
                  ? (analysisModal.paragraphTexts ?? [])
                  : ttsParagraphs
              }
              ttsCharacterList={ttsCharacterList}
              ttsCharacterMap={ttsCharacterMap}
              detectSpeaker={detectSpeaker}
              chapterAttributionRef={chapterAttributionRef}
              chapterAttributionStats={chapterAttributionStats}
              currentChapterId={chapters[currentIdx]?.id}
              attributionRefreshTick={attributionRefreshTick}
              isDark={isDark}
              dividerCls={dividerCls}
              hoverCls={hoverCls}
              panelCls={panelCls}
            />
          </Suspense>
        </aside>
        )}

        {/* Chapter iframe */}
        <section className="flex-1 overflow-hidden flex flex-col" aria-label="Nội dung sách">
          {loading ? (
            <div role="status" className={cn('flex-1 flex items-center justify-center gap-2 text-sm', mutedCls)}>
              <Loader2 className="h-4 w-4 animate-spin" /> Đang tải sách…
            </div>
          ) : loadError ? (
            <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
              <AlertCircle className="h-8 w-8 text-red-500" />
              <div>
                <p className="text-sm font-semibold">Không thể mở sách</p>
                <p className={cn('mt-1 max-w-md text-xs', mutedCls)}>{loadError}</p>
              </div>
              <Button variant="outline" size="sm" onClick={() => void loadChapters()}>
                <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Thử lại
              </Button>
            </div>
          ) : chapterSrc ? (
            <div className="relative flex-1">
              {iframeLoading && (
                <div className="absolute inset-0 z-10 flex items-center justify-center" style={{ background: themeObj.bg }}>
                  <div className={cn('text-sm', mutedCls)}>Loading…</div>
                </div>
              )}
              <iframe key={chapterSrc} ref={iframeRef} src={chapterSrc}
                className="h-full w-full border-0" title={current?.title ?? `Nội dung ${bookTitle}`}
                sandbox="allow-same-origin allow-scripts" onLoad={handleIframeLoad} />
            </div>
          ) : (
            <div className={cn('flex-1 flex items-center justify-center text-sm', mutedCls)}>No chapters found.</div>
          )}
        </section>
      </div>

      {/* ── Footer ── */}
      <footer className={cn('flex items-center gap-2 px-3 py-2 border-t shrink-0 backdrop-blur-sm', headerCls)}>
        <Button variant="outline" size="sm" onClick={handlePrev}
          disabled={chapters.length === 0 || (currentIdx <= 0 && (settings.layout === 'scroll' || spreadPage <= 0))}
          style={btnStyle}
          aria-label="Previous chapter"
          className="gap-1 text-xs">
          <ChevronLeft className="h-3.5 w-3.5" /><span className="hidden sm:block">Prev</span>
        </Button>

        <div className="flex-1 flex flex-col items-center gap-1">
          {/* ── Intra-chapter progress: thin 1px-tall bar driven by the
              iframe's page-info postMessage. Shows where you are inside
              the current chapter as a continuous percentage, complementing
              the chapter-level dots below. */}
          {chapters.length > 0 && spreadTotal > 1 && (
            <Progress
              value={Math.round(((spreadPage + 1) / spreadTotal) * 100)}
              ariaLabel={`Trang ${spreadPage + 1}/${spreadTotal} trong chương hiện tại`}
              className="h-[2px] w-full max-w-xs"
              indicatorClassName="bg-primary/70"
            />
          )}
          {settings.layout === 'spread' && spreadTotal > 1 && (
            <p className={cn('text-[10px]', mutedCls)}>Page {spreadPage + 1} / {spreadTotal} in chapter</p>
          )}
          {chapters.length > 0 && chapters.length <= 80 ? (
            // ── Condensed dots — ≤80 chapters, each dot 3px (4px active). ──
            <div className="flex flex-wrap justify-center items-center gap-1 max-w-md">
              {chapters.map((_, idx) => {
                const isActive = idx === currentIdx;
                const isBookmarked = bookmarks.includes(idx);
                return (
                  <button key={idx} onClick={() => goToChapter(idx)} title={chapters[idx]?.title}
                    data-testid={`chapter-dot-${idx}`}
                    data-chapter-index={idx}
                    aria-label={`Jump to chapter ${idx + 1}${isBookmarked ? ' (bookmarked)' : ''}`}
                    aria-current={isActive ? 'true' : undefined}
                    className="rounded-full transition-all"
                    style={{
                      width: isActive ? 4 : 3,
                      height: isActive ? 4 : 3,
                      background: isBookmarked ? '#f59e0b' : isActive ? accentColor : 'currentColor',
                      opacity: isActive ? 1 : isBookmarked ? 0.8 : 0.25,
                    }} />
                );
              })}
            </div>
          ) : chapters.length > 80 && chapters.length <= 300 ? (
            // ── Dot grid (same dots) + DropdownMenu "Jump to…" trigger for
            //     touch devices where small targets are hard to hit. ──
            <div className="flex items-center gap-2 max-w-md w-full">
              <div className="flex flex-wrap justify-center items-center gap-1 flex-1 min-w-0">
                {chapters.map((_, idx) => {
                  const isActive = idx === currentIdx;
                  const isBookmarked = bookmarks.includes(idx);
                  return (
                    <button key={idx} onClick={() => goToChapter(idx)} title={chapters[idx]?.title}
                      data-testid={`chapter-dot-${idx}`}
                      data-chapter-index={idx}
                      aria-label={`Jump to chapter ${idx + 1}${isBookmarked ? ' (bookmarked)' : ''}`}
                      aria-current={isActive ? 'true' : undefined}
                      className="rounded-full transition-all"
                      style={{
                        width: isActive ? 4 : 3,
                        height: isActive ? 4 : 3,
                        background: isBookmarked ? '#f59e0b' : isActive ? accentColor : 'currentColor',
                        opacity: isActive ? 1 : isBookmarked ? 0.8 : 0.25,
                      }} />
                  );
                })}
              </div>
              <ChapterJumpMenu
                chapters={chapters}
                currentIdx={currentIdx}
                onJump={goToChapter}
                mutedCls={mutedCls}
              />
            </div>
          ) : chapters.length > 300 ? (
            // ── Long books (>300 ch): progress bar + jump menu (mobile). ──
            <div className="w-full max-w-xs flex items-center gap-2">
              <div className="flex-1">
                <div className="h-1.5 rounded-full" style={{ background: `${accentColor}22` }}>
                  <div className="h-full rounded-full transition-all" style={{ background: accentColor, width: `${chapters.length > 0 ? ((currentIdx + 1) / chapters.length) * 100 : 0}%` }} />
                </div>
                <p className={cn('text-center text-[10px] mt-0.5', mutedCls)}>{currentIdx + 1} / {chapters.length}</p>
              </div>
              <ChapterJumpMenu
                chapters={chapters}
                currentIdx={currentIdx}
                onJump={goToChapter}
                mutedCls={mutedCls}
              />
            </div>
          ) : null}
        </div>

        <Button variant="outline" size="sm" onClick={handleNext}
          disabled={chapters.length === 0 || (currentIdx >= chapters.length - 1 && (settings.layout === 'scroll' || spreadPage >= spreadTotal - 1))}
          style={btnStyle}
          aria-label="Next chapter"
          className="gap-1 text-xs">
          <span className="hidden sm:block">Next</span><ChevronRight className="h-3.5 w-3.5" />
        </Button>
      </footer>

      {/* ── Full Analyzer drawer — shown after Wand2 click ──
          Docks to the RIGHT side of the viewport (mirrors the Audio panel's
          layout). Rendered through a portal so it escapes the reader's
          full-screen `fixed inset-0 z-50` wrapper — otherwise the modal is
          trapped in the reader's stacking context and either fails to
          paint or paints behind sibling panels.

          Backdrop is a separate full-screen dim layer; the drawer itself
          slides in from the right via translate-x-0/translate-x-full. */}
      {analysisModal && mounted && createPortal(
        // Backdrop is purely decorative now — clicking it does NOT close
        // the modal, only ✕ / Đóng (ESC) / Hủy / ESC key do. The dim layer
        // is here to make the drawer read clearly against the reader text.
        <div
          data-testid="analyzer-modal-backdrop"
          aria-hidden="true"
          className="fixed inset-0 z-[100] bg-modal-overlay/50 animate-in fade-in pointer-events-none"
        />,
        document.body,
      )}
      {analysisModal && mounted && createPortal(
        <aside
          data-testid="analyzer-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="analyzer-modal-title"
          onClick={(e) => e.stopPropagation()}
          className={cn(
            'fixed inset-y-0 right-0 z-[101] flex shadow-2xl transition-transform duration-200 ease-in-out',
            panelCls,
            'border-l',
            'translate-x-0',                  /* slide-in state — no translate-x-full when open */
          )}
          style={{ width: `${analyzerPanelWidth}px`, maxWidth: '100vw' }}
        >
          {/* ── Left-edge resize handle ─────────────────────────────────
              Drag horizontally to widen/narrow. Cursor + user-select are
              swapped at the document level during drag so the cursor
              doesn't flicker when crossing child boundaries. Double-click
              snaps back to the default 44rem width. */}
          <div
            data-testid="analyzer-modal-resize-handle"
            role="separator"
            aria-orientation="vertical"
            aria-label="Kéo để thay đổi chiều rộng bảng — double-click để reset"
            title="Kéo để thay đổi chiều rộng — double-click để reset về mặc định"
            onPointerDown={onResizeHandlePointerDown}
            onPointerMove={onResizeHandlePointerMove}
            onPointerUp={onResizeHandlePointerUp}
            onPointerCancel={onResizeHandlePointerUp}
            onDoubleClick={onResizeHandleDoubleClick}
            className={cn(
              'group absolute inset-y-0 left-0 w-2 -translate-x-1/2 cursor-col-resize',
              'flex items-center justify-center',
              'z-[102]',
            )}
          >
            <div
              className={cn(
                'h-full w-[3px] rounded-full transition-colors',
                'bg-transparent group-hover:bg-blue-500/60 group-active:bg-blue-500',
              )}
            />
          </div>
          <div
            className={cn(
              'flex flex-col h-full overflow-hidden',
              'animate-in slide-in-from-right',
            )}
          >
            {/* Header */}
            <div className={cn('flex items-center justify-between px-5 py-3 border-b shrink-0', dividerCls)}>
              <div className="min-w-0 flex-1">
                <h2 id="analyzer-modal-title" className="font-semibold text-sm flex items-center gap-1.5">
                  <Wand2 className="h-4 w-4 text-primary" />
                  Full Analyzer {analysisModal.running ? '— đang chạy…' : '— kết quả'}
                  {analysisModal.running && (
                    <span className="ml-2 inline-flex items-center gap-1.5 rounded-full bg-blue-500/15 text-blue-600 dark:text-blue-400 px-2 py-0.5 text-[10px] font-medium">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      {analysisModal.log.length} dòng
                    </span>
                  )}
                  {analysisModal.failed && (
                    <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-red-500/15 text-red-600 dark:text-red-400 px-2 py-0.5 text-[10px] font-medium">
                      <AlertCircle className="h-3 w-3" />thất bại
                    </span>
                  )}
                </h2>
                <p className={cn('text-xs truncate mt-0.5', mutedCls)}>
                  {chapters.find((c) => c.id === analysisModal.chapterId)?.title ?? analysisModal.chapterTitle}
                </p>
              </div>
              {/* "Follow tail" toggle — when off, the log keeps its scroll
                  position while streaming so the user can read older lines. */}
              <label
                className="flex items-center gap-1.5 text-[10px] text-muted-foreground shrink-0 mr-1 cursor-pointer select-none"
                title="Tự cuộn xuống dòng mới nhất. Tắt để giữ vị trí cuộn khi đọc log cũ."
              >
                <Switch
                  checked={autoScrollLog}
                  onCheckedChange={setAutoScrollLogPersist}
                  aria-label="Auto-scroll to latest log line"
                  className="scale-90"
                />
                <span>Follow tail</span>
              </label>
              <button
                onClick={() => closeAnalysisModal()}
                aria-label="Close analyzer modal"
                className={cn('rounded p-1 shrink-0 ml-2', hoverCls)}
                title="Đóng (ESC)">
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Summary panel */}
            <div className={cn('px-5 py-4 border-b shrink-0', dividerCls)}>
              <div className="flex items-center gap-2 mb-3">
                <Activity className="h-3.5 w-3.5 text-primary" />
                <span className="font-medium text-xs uppercase tracking-wide opacity-70">Tóm tắt</span>
                {analysisModal.running && (
                  <span className="inline-flex items-center gap-1.5 text-[11px] text-blue-600 dark:text-blue-400">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    đang stream kết quả…
                  </span>
                )}
                <span className={cn('ml-auto text-[11px]', mutedCls)}>
                  {analysisModal.running
                    ? '… đang đo'
                    : analysisModal.durationMs > 0
                      ? `${(analysisModal.durationMs / 1000).toFixed(1)}s tổng`
                      : ''}
                  {!analysisModal.running && analysisModal.llmDurationMs > 0 &&
                    ` · LLM ${(analysisModal.llmDurationMs / 1000).toFixed(1)}s`}
                </span>
              </div>
              {analysisModal.running ? (
                /* While the SSE stream is live, we don't have any stats yet
                   — show a shimmer placeholder instead of zeros that would
                   confuse the user into thinking the run is already done. */
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                  {['Tổng đoạn', 'Đã gán', 'Voice mặc định', 'Source drift'].map((label) => (
                    <div key={label} className={cn('rounded-md border border-border px-3 py-2 opacity-50', dividerCls)}>
                      <div className={cn('text-[10px] uppercase tracking-wide', mutedCls)}>{label}</div>
                      <div className="text-lg font-semibold mt-0.5 flex items-center gap-1">
                        <Loader2 className="h-3.5 w-3.5 animate-spin opacity-60" />
                        <span className="text-xs font-normal opacity-60">đang chạy…</span>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                {/* Total paragraphs */}
                <div className={cn('rounded-md border border-border px-3 py-2', dividerCls)}>
                  <div className={cn('text-[10px] uppercase tracking-wide', mutedCls)}>Tổng đoạn</div>
                  <div className={cn('text-lg font-semibold mt-0.5')}>{analysisModal.stats.totalParagraphs}</div>
                </div>
                {/* Resolved */}
                <div className={cn('rounded-md border border-border px-3 py-2', dividerCls)}>
                  <div className={cn('text-[10px] uppercase tracking-wide', mutedCls)}>Đã gán</div>
                  <div className={cn('text-lg font-semibold mt-0.5 text-emerald-600 dark:text-emerald-400')}>
                    {analysisModal.stats.regexHits
                      + analysisModal.stats.llmHits + analysisModal.stats.conversationHits}
                  </div>
                </div>
                {/* Defaults */}
                <div className={cn('rounded-md border border-border px-3 py-2', dividerCls)}>
                  <div className={cn('text-[10px] uppercase tracking-wide', mutedCls)}>Voice mặc định</div>
                  <div className={cn('text-lg font-semibold mt-0.5', analysisModal.stats.defaults > 0 ? 'text-amber-600 dark:text-amber-400' : '')}>
                    {analysisModal.stats.defaults}
                  </div>
                </div>
                {/* Source drift */}
                <div className={cn('rounded-md border border-border px-3 py-2', dividerCls)}>
                  <div className={cn('text-[10px] uppercase tracking-wide', mutedCls)}>Source drift</div>
                  <div className={cn('text-lg font-semibold mt-0.5')}>{analysisModal.stats.sourceDrift}</div>
                </div>

                {/* Evidence-source breakdown */}
                <div className={cn('rounded-md border border-border px-3 py-2 col-span-2 sm:col-span-4', dividerCls)}>
                  <div className={cn('text-[10px] uppercase tracking-wide mb-1', mutedCls)}>Nguồn suy ra</div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 text-[11px] font-medium">
                      <span className="font-semibold">{analysisModal.stats.regexHits}</span> regex
                    </span>
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-purple-500/15 text-purple-600 dark:text-purple-400 text-[11px] font-medium">
                      <span className="font-semibold">{analysisModal.stats.llmHits}</span> LLM
                    </span>
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-sky-500/15 text-sky-600 dark:text-sky-400 text-[11px] font-medium">
                      <span className="font-semibold">{analysisModal.stats.conversationHits}</span> conversation
                    </span>
                  </div>
                </div>

                {/* Service reachability — oMLX is the only gate that can
                    drop the LLM step (regex + conversation-fusion always run). */}
                <div className={cn('rounded-md border border-border px-3 py-2 col-span-2', dividerCls)}>
                  <div className={cn('text-[10px] uppercase tracking-wide mb-1', mutedCls)}>Services</div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={cn(
                      'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium',
                      analysisModal.omlxReachable
                        ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                        : 'bg-red-500/15 text-red-600 dark:text-red-400',
                    )}>
                      {analysisModal.omlxReachable
                        ? <CheckCircle2 className="h-3 w-3" />
                        : <AlertCircle className="h-3 w-3" />}
                      oMLX {analysisModal.omlxReachable
                        ? `OK${analysisModal.stats.llmRequested ? ` · ${analysisModal.stats.llmRequested} batch` : ''}`
                        : 'down'}
                    </span>
                    {analysisModal.stats.llmFailures !== undefined && analysisModal.stats.llmFailures > 0 && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-500/15 text-red-600 dark:text-red-400 text-[11px] font-medium">
                        <AlertCircle className="h-3 w-3" />
                        {analysisModal.stats.llmFailures} batch LLM fail
                      </span>
                    )}
                  </div>
                </div>

                {/* Error */}
                {analysisModal.failed && analysisModal.errorMsg && (
                  <div className="rounded-md border border-border border-red-500/30 bg-red-500/10 px-3 py-2 col-span-2 sm:col-span-4 text-xs text-red-600 dark:text-red-400">
                    <strong>Lỗi:</strong> {analysisModal.errorMsg}
                  </div>
                )}
              </div>
              )}
            </div>

            {/* Pipeline log */}
            <div className={cn('flex flex-wrap items-center justify-between gap-2 px-5 py-2 border-b shrink-0', dividerCls)}>
              <div className="flex items-center gap-2 min-w-0">
                <Terminal className="h-3.5 w-3.5 opacity-70 shrink-0" />
                <span className="font-medium text-xs shrink-0">Pipeline log</span>
                {analysisModal.running && (
                  <span className="inline-flex items-center gap-1 text-[10px] text-blue-600 dark:text-blue-400 shrink-0">
                    <span className="relative flex h-2 w-2">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-500 opacity-75" />
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
                    </span>
                    LIVE
                  </span>
                )}
                <span className={cn('text-[10px] tabular-nums shrink-0', mutedCls)}>
                  ({analysisModal.log.length} dòng)
                </span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {/* Mode switcher — verbose shows every line, grouped collapses
                    adjacent batch events into a single card, human only shows
                    phase boundaries + the headline numbers. */}
                <div
                  className="inline-flex rounded border border-border overflow-hidden text-[11px]"
                  role="tablist"
                  aria-label="Chế độ hiển thị log"
                >
                  {(['verbose', 'grouped', 'human'] as const).map((m) => (
                    <button
                      key={m}
                      role="tab"
                      aria-selected={logMode === m}
                      onClick={() => setLogModePersist(m)}
                      title={
                        m === 'verbose' ? 'Hiện tất cả dòng — bao gồm từng batch LLM'
                        : m === 'grouped' ? 'Gộp các dòng batch LLM liên tiếp thành thẻ tiến độ'
                        : 'Chỉ hiện ranh giới phase + số liệu chính'
                      }
                      className={cn(
                        'px-2 py-1 capitalize transition-colors',
                        logMode === m
                          ? 'bg-primary text-primary-foreground'
                          : 'hover:bg-muted/40',
                      )}
                    >
                      {m === 'verbose' ? 'Chi tiết' : m === 'grouped' ? 'Gộp' : 'Tóm tắt'}
                    </button>
                  ))}
                </div>
                <button
                  onClick={async () => {
                    try {
                      // Copy the raw human-readable text, not the JSON-encoded
                      // structured line objects, so the clipboard payload is
                      // immediately greppable in a terminal.
                      const text = analysisModal.log.map((l) => l.text).join('\n');
                      await navigator.clipboard.writeText(text);
                      setLogCopied(true);
                      setTimeout(() => setLogCopied(false), 1500);
                    } catch {
                      /* clipboard denied — silent */
                    }
                  }}
                  className={cn('inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] border border-border', hoverCls)}
                  title="Copy log to clipboard"
                >
                  {logCopied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                  {logCopied ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>
            <div className={cn('flex-1 min-h-0 overflow-auto px-5 py-3', mutedCls)}>
              {analysisModal.log.length === 0 ? (
                <div
                  ref={analysisLogRef as unknown as React.RefObject<HTMLDivElement>}
                  data-testid="analyzer-log"
                  className={cn('text-[11px] leading-relaxed font-mono whitespace-pre-wrap break-words',
                    analysisModal.failed ? 'text-red-600/90 dark:text-red-400/90' : '')}
                >
                  (log trống — pipeline không chạy đến bước nào)
                </div>
              ) : logMode === 'human' ? (
                // ── Human summary view ─────────────────────────────────
                // Show only phase boundaries + key counters, with the wall
                // time of each. Best for "what just happened?" lookback.
                <HumanLogSummary lines={analysisModal.log} failed={analysisModal.failed} mutedCls={mutedCls} />
              ) : (
                <ol
                  ref={analysisLogRef}
                  data-testid="analyzer-log"
                  className="text-[11px] leading-relaxed font-mono space-y-0.5"
                >
                  {(() => {
                    // ── Grouped view ────────────────────────────────────
                    // Collapse adjacent LLM batch lines into a single
                    // progress card so the panel doesn't drown in 60+
                    // near-identical rows. Non-batch lines pass through.
                    if (logMode === 'verbose') {
                      return analysisModal.log.map((line, idx) => renderLogLine(line, idx, analysisModal.failed));
                    }
                    const groups: Array<{ kind: 'line'; line: AnalysisLogLine; idx: number } |
                                         { kind: 'batches'; lines: AnalysisLogLine[] }> = [];
                    let batchBuf: AnalysisLogLine[] = [];
                    const flushBatches = () => {
                      if (batchBuf.length === 0) return;
                      groups.push({ kind: 'batches', lines: batchBuf });
                      batchBuf = [];
                    };
                    analysisModal.log.forEach((line, idx) => {
                      // A line is "batch-like" if its phase is 'llm' AND the
                      // meta has a batchIndex field (so init / skip lines
                      // are excluded — they're real headings).
                      const isBatch = line.phase === 'llm'
                        && line.meta
                        && typeof (line.meta as Record<string, unknown>).batchIndex === 'number';
                      if (isBatch) {
                        batchBuf.push(line);
                      } else {
                        flushBatches();
                        groups.push({ kind: 'line', line, idx });
                      }
                    });
                    flushBatches();
                    return groups.map((g, gi) =>
                      g.kind === 'line'
                        ? renderLogLine(g.line, gi, analysisModal.failed)
                        : <BatchProgressCard key={`b-${gi}`} lines={g.lines} />,
                    );
                  })()}
                </ol>
              )}
            </div>

            {/* Footer */}
            <div className={cn('flex items-center justify-end gap-2 px-5 py-3 border-t shrink-0', dividerCls)}>
              {analysisModal.running && (
                <span className={cn('mr-auto text-[11px]', mutedCls)}>
                  Đang stream pipeline log từ server — có thể đóng bất kỳ lúc nào để dừng.
                </span>
              )}
              {analysisModal.running && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => closeAnalysisModal()}
                  className="text-xs border-red-500/40 text-red-600 dark:text-red-400"
                  title="Hủy server-side analyze + đóng modal"
                >
                  Hủy
                </Button>
              )}
              {!analysisModal.running && analysisModal.attribution && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setAttributionDebugOpen(true)}
                  className="text-xs"
                  title="Mở bảng debug gán vai — xem từng đoạn được gán cho nhân vật nào"
                >
                  <Eye className="h-3.5 w-3.5 mr-1" />
                  Xem gán vai
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => closeAnalysisModal()}
                className="text-xs"
              >
                Đóng (ESC)
              </Button>
            </div>
          </div>
        </aside>,
        document.body,
      )}

      {/* Attribution debug modal — shows per-paragraph speaker/source/conf.
          Auto-opens after a successful Full Analyzer run; also reachable
          via "Xem gán vai" button in the analyzer footer. */}
      {mounted && (
        <AttributionDebugModal
          open={attributionDebugOpen}
          onClose={() => setAttributionDebugOpen(false)}
          data={analysisModal}
          paragraphs={analysisModal?.paragraphTexts ?? []}
          mutedCls={mutedCls}
          dividerCls={dividerCls}
          panelCls={panelCls}
          hoverCls={hoverCls}
          activeCls={activeCls}
        />
      )}
    </div>
  );
}
