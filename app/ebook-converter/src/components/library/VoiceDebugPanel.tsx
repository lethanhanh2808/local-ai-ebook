'use client';
// src/components/library/VoiceDebugPanel.tsx
//
// Per-paragraph voice-assignment debug view for the EbookReader. Shows, for
// every paragraph in the current chapter:
//
//   • the paragraph's first ~120 chars
//   • whether it contains a quote
//   • the result of detectSpeaker() (last-to-first attribution winner)
//     — character name, voice name, and the FIRST quoted text in the
//     paragraph (so you can sanity-check which quote drove the choice)
//   • the SOURCE of the attribution (regex / conversation / llm / default)
//     so you can tell which paragraphs each layer solved
//   • the count of paragraphs attributed to each character + voice
//
// Used to triage whether mis-routed audio is from attribution (the speaker
// is wrong) or the voice map (the right speaker picks up the wrong voice).
//
// This is a pure debug tool — it has no effect on playback.

import { useEffect, useMemo, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';

export interface ChapterAttributionRow {
  speaker: string | null;
  confidence: number;
  source: string;
  reason?: string;
  evidence?: Array<{ source: string; speaker?: string | null; weight: number; detail: string }>;
  sceneId?: number;
  state?: {
    sceneId: number;
    activeCharacters: string[];
    currentSpeaker: string | null;
    previousSpeaker: string | null;
    currentFocusCharacter: string | null;
    lastActionCharacter: string | null;
    lastMentionedCharacters: string[];
    dialogueHistory: Array<{ paragraphIndex: number; speaker: string }>;
  };
}

export interface ChapterAttributionInfo {
  attribution: Record<number, ChapterAttributionRow>;
  fromCache: boolean;
  /** Per-layer per-paragraph maps populated by the most recent Full
   *  Analyzer run. Lets the panel render "regex: X / local: Y / llm: Z"
   *  chips under each paragraph — same evidence the analyzer modal
   *  shows — so the user can see HOW each layer voted, not just the
   *  final winner. */
  layers?: {
    regex: Record<number, ChapterAttributionRow>;
    local: Record<number, ChapterAttributionRow>;
    llm: Record<number, ChapterAttributionRow>;
  };
  /** Paragraph texts from the most recent analyzer run, indexed by
   *  paragraph number. The panel uses this as a paragraph source when
   *  `ttsParagraphs` is empty (i.e. the user hasn't started TTS yet) so
   *  rows render immediately after a Full Analyzer. Stored on the same
   *  ref entry as `attribution` / `layers` so both share freshness. */
  paragraphTexts?: Record<number, string>;
  /** D1 cross-chapter seed status for this chapter — populated from
   *  `/attribute`'s `crossChapter` block so the panel can paint "state
   *  carried from chapter N" vs "fresh start" vs "skipped (stale)". */
  crossChapter?: {
    seedApplied: boolean;
    seedReason: 'applied' | 'no-row' | 'stale-chapter' | 'version-mismatch' | 'empty';
    seedFromChapterIndex: number | null;
    seedLastSpeaker: string | null;
    persistedAt: number | null;
  };
  /** G4: novel proper-noun candidates detected across the chapter that
   *  are NOT in the character roster. Surfaced in the panel so the user
   *  can register them before they accumulate as unresolved-actor rows.
   *  Sorted by frequency desc, ties by alphabetical. Empty array (or
   *  undefined on legacy cached rows) means "no novel names detected." */
  potentialNewCharacters?: string[];
}

interface ChapterAttributionStats {
  chapterId: string;
  regexHits: number;
  llmHits: number;
  conversationHits: number;
  sourceDrift?: number;
  defaults: number;
  fromCache: boolean;
  omlxReachable: boolean;
}

interface VoiceDebugPanelProps {
  paragraphs: string[];
  ttsCharacterList: { name: string; voiceName?: string }[];
  ttsCharacterMap: Record<string, string>;
  detectSpeaker: (text: string, idx?: number) =>
    { name?: string; voiceName?: string; source?: 'parser' | 'regex' | 'llm' | 'conversation' | 'unresolved-actor' };
  chapterAttributionRef?: { current: Map<string, ChapterAttributionInfo> };
  chapterAttributionStats?: ChapterAttributionStats | null;
  /** ID of the chapter currently displayed — used to read the right entry
   *  from chapterAttributionRef. */
  currentChapterId?: string;
  /** Bumped by EbookReader every time the in-memory attribution cache is
   *  refreshed (e.g. after a Full Analyzer run). The panel's `useMemo`
   *  depends on this so a ref mutation alone triggers a recompute of the
   *  per-paragraph rows. Without it the panel would keep showing stale
   *  data after the analyzer finishes. */
  attributionRefreshTick?: number;
  isDark: boolean;
  dividerCls: string;
  hoverCls: string;
  panelCls: string;
}

interface ParagraphRow {
  index: number;
  firstQuote: string | null;
  speaker: { name?: string; voiceName?: string; source?: 'parser' | 'regex' | 'llm' | 'conversation' | 'unresolved-actor' };
  status: 'attributed' | 'unattributed' | 'no-quote';
  source:
    | 'parser' | 'regex' | 'llm' | 'conversation' | 'unresolved-actor' | 'default'
    | 'cache-parser' | 'cache-regex' | 'cache-llm' | 'cache-conversation' | 'cache-unresolved-actor';
  confidence: number;
  reason?: string;
  evidence?: ChapterAttributionRow['evidence'];
  sceneId?: number;
  activeCharacters?: string[];
  /** Per-evidence-layer speakers from the most recent Full Analyzer run.
   *  Painted as small "regex: X / local: Y / llm: Z" chips under each
   *  paragraph so the user can see how each layer voted. */
  layers?: {
    regex?: string | null;
    conversation?: string | null;
    llm?: string | null;
  };
  snippet: string;
}

function findFirstQuote(text: string): string | null {
  // Match the same quote styles the reader uses: " " ' ' 「」 『』
  const re = /["“”'「」『』]/;
  const m = re.exec(text);
  if (!m) return null;
  const open = m[0];
  const closePair: Record<string, string> = {
    '「': '」', '『': '』',
    '"': '"', '“': '”', '”': '"',
    "'": "'", '‘': '’', '’': "'",
  };
  // Pick the matching close. Most Vietnamese chapters use " " or " " (curly).
  const close = closePair[open] || '"';
  const start = m.index + open.length;
  const endIdx = text.indexOf(close, start);
  if (endIdx < 0) return text.slice(start, start + 60).trim();
  return text.slice(start, endIdx).trim();
}

// Maps the per-paragraph attribution source key from detectSpeaker() to a
// Badge variant. The legacy light/dark class strings are gone — colors are
// derived from the `source-*` tokens in src/components/ui/badge.tsx, which
// honour the active theme automatically.
const SOURCE_VARIANT: Record<string, { variant: 'source-parser' | 'source-regex' | 'source-llm' | 'source-conversation' | 'source-actor' | 'tone-neutral'; label: string }> = {
  parser:                  { variant: 'source-parser',       label: 'parser' },
  regex:                   { variant: 'source-regex',        label: 'regex' },
  llm:                     { variant: 'source-llm',          label: 'llm' },
  conversation:            { variant: 'source-conversation', label: 'state' },
  'unresolved-actor':      { variant: 'source-actor',        label: 'actor?' },
  'cache-parser':          { variant: 'source-parser',       label: 'parser' },
  'cache-regex':           { variant: 'source-regex',        label: 'regex' },
  'cache-llm':             { variant: 'source-llm',          label: 'llm' },
  'cache-conversation':    { variant: 'source-conversation', label: 'state' },
  'cache-unresolved-actor':{ variant: 'source-actor',        label: 'actor?' },
  default:                 { variant: 'tone-neutral',        label: '—' },
};

function SourceBadge({ source }: { source: string }) {
  const conf = SOURCE_VARIANT[source] ?? SOURCE_VARIANT.default;
  return (
    <Badge variant={conf.variant} className="font-mono uppercase tracking-wide">
      {conf.label}
    </Badge>
  );
}

function contextAround(text: string, needle?: string | null): string | null {
  if (!needle) return null;
  const idx = text.toLowerCase().indexOf(needle.toLowerCase());
  if (idx < 0) return null;
  const start = Math.max(0, idx - 5);
  const end = Math.min(text.length, idx + needle.length + 5);
  return text.slice(start, end).trim();
}

/** Paints a one-line chip showing the D1 cross-chapter seed status.
 *  Distinct colour per `seedReason` so the user can eyeball whether the
 *  carried state fired, was skipped, or never existed. */
function CrossChapterChip({
  crossChapter,
  isDark,
}: {
  crossChapter?: {
    seedApplied: boolean;
    seedReason: 'applied' | 'no-row' | 'stale-chapter' | 'version-mismatch' | 'empty';
    seedFromChapterIndex: number | null;
    seedLastSpeaker: string | null;
    persistedAt: number | null;
  };
  isDark: boolean;
}) {
  if (!crossChapter) return null;
  const { seedReason, seedFromChapterIndex, seedLastSpeaker, persistedAt } = crossChapter;
  const persisted = persistedAt != null
    ? `State persisted for chapter ${persistedAt}.`
    : null;

  let label: string;
  let cls: string;
  switch (seedReason) {
    case 'applied':
      label = `State carried from chapter ${seedFromChapterIndex ?? '?'}`
        + (seedLastSpeaker ? ` — last speaker "${seedLastSpeaker}"` : '');
      cls = isDark
        ? 'bg-success-bg/40 text-success-fg border-success-fg/40'
        : 'bg-success-bg text-success-fg border-success-fg/30';
      break;
    case 'no-row':
      label = 'Fresh start — no prior chapter state.';
      cls = isDark
        ? 'bg-muted text-muted-foreground border-border'
        : 'bg-muted text-muted-foreground border-border';
      break;
    case 'stale-chapter':
      label = `Skipped seed — re-reading chapter ${seedFromChapterIndex ?? '?'} is behind the persisted snapshot.`;
      cls = isDark
        ? 'bg-bible-pending-bg/40 text-bible-pending-fg border-bible-pending-border/50'
        : 'bg-bible-pending-bg text-bible-pending-fg border-bible-pending-border';
      break;
    case 'version-mismatch':
      label = 'Skipped seed — parser version changed; fresh start for this run.';
      cls = isDark
        ? 'bg-bible-pending-bg/40 text-bible-pending-fg border-bible-pending-border/50'
        : 'bg-bible-pending-bg text-bible-pending-fg border-bible-pending-border';
      break;
    case 'empty':
      label = 'Empty chapter — no seed needed.';
      cls = isDark
        ? 'bg-muted text-muted-foreground border-border'
        : 'bg-muted text-muted-foreground border-border';
      break;
    default:
      return null;
  }

  return (
    <div
      data-testid="voice-debug-cross-chapter"
      data-seed-reason={seedReason}
      className={cn('mt-2 inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] font-medium', cls)}
      title={persisted ?? undefined}
    >
      {label}
    </div>
  );
}

export function VoiceDebugPanel({
  paragraphs,
  ttsCharacterList,
  ttsCharacterMap,
  detectSpeaker,
  chapterAttributionRef,
  chapterAttributionStats,
  currentChapterId,
  attributionRefreshTick,
  isDark,
  dividerCls,
  hoverCls,
}: VoiceDebugPanelProps) {
  const rows = useMemo<ParagraphRow[]>(() => {
    // Intentionally invalidate after the parent mutates the attribution ref.
    void attributionRefreshTick;
    // Pull the current chapter's attribution map (parser + regex results
    // stored on the server) so we can label each row with its source.
    const info = currentChapterId
      ? chapterAttributionRef?.current.get(currentChapterId)
      : undefined;
    const cached = info?.attribution ?? {};
    const isCache = !!info?.fromCache;
    // When the parent passes an empty `paragraphs` (e.g. TTS hasn't
    // started) we still want to render rows after a Full Analyzer run.
    // The reader stamps the analyzer's paragraphTexts onto
    // `chapterAttributionRef` precisely so we have a paragraph source
    // independent of `ttsParagraphs` and `analysisModal`. Build the list
    // here so the row loop can stay identical between the TTS and
    // post-analyzer cases.
    const analyzerParagraphs = info?.paragraphTexts ?? {};
    const renderedParagraphs: string[] =
      paragraphs.length > 0
        ? paragraphs
        : Object.keys(analyzerParagraphs).length > 0
          // Index keys → dense array so .map() sees a stable iteration
          // order matching the analyzer's attribution layer indices.
          ? Object.keys(analyzerParagraphs)
            .map((k) => Number(k))
            .filter((n) => Number.isFinite(n))
            .sort((a, b) => a - b)
            .map((n) => analyzerParagraphs[n] ?? '')
          : [];
    return renderedParagraphs.map((text, idx) => {
      const firstQuote = findFirstQuote(text);
      const speaker = firstQuote
        ? detectSpeaker(text, idx)
        : { name: undefined, voiceName: undefined };
      const status: ParagraphRow['status'] = !firstQuote
        ? 'no-quote'
        : speaker.name
          ? 'attributed'
          : 'unattributed';
      // Determine source for this paragraph: prefer the live detectSpeaker
      // result (which already accounts for the cache + regex chain), but
      // fall back to the cached map entry if the local regex also got
      // nothing. This gives the user a "the parser thought it was X" hint
      // even when the local regex couldn't surface the answer.
      let source: ParagraphRow['source'] = 'default';
      let confidence = 0;
      if (speaker.source) {
        source = (isCache && speaker.source === 'parser') ? 'cache-parser'
          : (isCache && speaker.source === 'regex') ? 'cache-regex'
          : (isCache && speaker.source === 'llm') ? 'cache-llm'
          : (isCache && speaker.source === 'conversation') ? 'cache-conversation'
          : (isCache && speaker.source === 'unresolved-actor') ? 'cache-unresolved-actor'
          : speaker.source;
        confidence = 1;
      } else {
        const cachedEntry = cached[idx];
        if (cachedEntry?.speaker) {
          const cs = cachedEntry.source;
          source = cs === 'parser' ? (isCache ? 'cache-parser' : 'parser')
            : cs === 'regex'  ? (isCache ? 'cache-regex'  : 'regex')
            : cs === 'llm'    ? (isCache ? 'cache-llm'    : 'llm')
            : cs === 'conversation' ? (isCache ? 'cache-conversation' : 'conversation')
            : cs === 'unresolved-actor' ? (isCache ? 'cache-unresolved-actor' : 'unresolved-actor')
            : 'default';
          confidence = cachedEntry.confidence ?? 0;
        }
      }
      const cachedEntry = cached[idx];
      const snippet = text.length > 120 ? text.slice(0, 120).trimEnd() + '…' : text;
      // Pull per-layer speakers from the most recent analyzer run so we
      // can render the "regex: X / local: Y / llm: Z" chips below. We
      // only show layers that actually voted (have a speaker) — silent
      // layers are noise.
      const layersInfo = info?.layers;
      const layers = layersInfo
        ? {
            regex: layersInfo.regex[idx]?.speaker ?? null,
            // `local` and `conversation` are the same evidence layer in
            // the analyzer pipeline (see attribution.ts) — pick whichever
            // the cache happened to ship.
            conversation: layersInfo.local[idx]?.speaker ?? null,
            llm: layersInfo.llm[idx]?.speaker ?? null,
          }
        : undefined;
      return {
        index: idx,
        firstQuote,
        speaker,
        status,
        source,
        confidence,
        reason: cachedEntry?.reason,
        evidence: cachedEntry?.evidence,
        sceneId: cachedEntry?.sceneId ?? cachedEntry?.state?.sceneId,
        activeCharacters: cachedEntry?.state?.activeCharacters,
        layers,
        snippet,
      };
    });
  }, [paragraphs, detectSpeaker, chapterAttributionRef, currentChapterId, attributionRefreshTick]);

  // Aggregate counts: how many paragraphs each (name|voice) pair produced.
  const summary = useMemo(() => {
    const counts = new Map<string, { speaker: string; voice: string; paragraphs: number; lines: number; stateHits: number }>();
    for (const r of rows) {
      const key = `${r.speaker.name ?? '(unattributed)'}::${r.speaker.voiceName ?? '(default)'}`;
      const entry = counts.get(key) ?? {
        speaker: r.speaker.name ?? '(unattributed)',
        voice: r.speaker.voiceName ?? '(default)',
        paragraphs: 0,
        lines: 0,
        stateHits: 0,
      };
      entry.paragraphs += 1;
      if (r.firstQuote) entry.lines += 1;
      if (r.source === 'conversation' || r.source === 'cache-conversation') entry.stateHits += 1;
      counts.set(key, entry);
    }
    return [...counts.values()].sort((a, b) => b.paragraphs - a.paragraphs);
  }, [rows]);

  const stats = useMemo(() => {
    const withQuote = rows.filter((r) => r.firstQuote !== null);
    const attributed = withQuote.filter((r) => r.status === 'attributed');
    const unattributed = withQuote.filter((r) => r.status === 'unattributed');
    const regexSolved = rows.filter((r) => r.source === 'regex' || r.source === 'cache-regex').length;
    const llmSolved = rows.filter((r) => r.source === 'llm' || r.source === 'cache-llm').length;
    const conversationSolved = rows.filter((r) => r.source === 'conversation' || r.source === 'cache-conversation').length;
    return {
      total: rows.length,
      withQuote: withQuote.length,
      attributed: attributed.length,
      unattributed: unattributed.length,
      regexSolved,
      llmSolved,
      conversationSolved,
    };
  }, [rows]);

  // ── Load-more pagination (UI Polish §4.11) ─────────────────────────────
  // A long chapter can produce 500+ rows. Rendering all at once makes the
  // panel sluggish on first open and crushes Ctrl+F "find on page". We
  // show the first 50 and let the user grow the visible set in 50-row
  // increments. Resets when the row count changes (new chapter / fresh
  // analyzer run).
  const ROWS_PAGE_SIZE = 50;
  const [visibleRows, setVisibleRows] = useState(ROWS_PAGE_SIZE);
  useEffect(() => {
    setVisibleRows(ROWS_PAGE_SIZE);
  }, [rows.length]);
  const visibleRowList = rows.slice(0, visibleRows);
  const remainingRows = Math.max(0, rows.length - visibleRows);

  return (
    <div className="flex-1 overflow-y-auto">
      {/* ── Header / legend ───────────────────────────────────────────── */}
      <div className={cn('px-4 py-3 border-b border-border text-xs space-y-1', dividerCls)}>
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          <span className={cn('inline-flex items-center gap-1 rounded px-1.5 py-0.5',
            isDark ? 'bg-success-bg/40 text-success-fg' : 'bg-success-bg text-success-fg')}>
            <span className="h-1.5 w-1.5 rounded-full bg-success-fg" />
            Attributed
          </span>
          <span className={cn('inline-flex items-center gap-1 rounded px-1.5 py-0.5',
            isDark ? 'bg-bible-pending-bg/40 text-bible-pending-fg' : 'bg-bible-pending-bg text-bible-pending-fg')}>
            <span className="h-1.5 w-1.5 rounded-full bg-bible-pending-fg" />
            Unattributed (default voice)
          </span>
          <span className={cn('inline-flex items-center gap-1 rounded px-1.5 py-0.5',
            isDark ? 'bg-muted text-muted-foreground' : 'bg-muted text-muted-foreground')}>
            <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground" />
            Narration
          </span>
        </div>
        <div className="opacity-70 mt-2">
          {stats.attributed}/{stats.withQuote} dialogue paragraphs attributed •{' '}
          {stats.unattributed} fall back to default voice • {stats.total} total paragraphs
        </div>
        <CrossChapterChip
          crossChapter={(() => {
            const info = currentChapterId
              ? chapterAttributionRef?.current.get(currentChapterId)
              : undefined;
            return info?.crossChapter;
          })()}
          isDark={isDark}
        />
        {(() => {
          const info = currentChapterId
            ? chapterAttributionRef?.current.get(currentChapterId)
            : undefined;
          const novel = info?.potentialNewCharacters ?? [];
          if (novel.length === 0) return null;
          return (
            <div
              data-testid="voice-debug-potential-new"
              data-count={novel.length}
              className={cn(
                'mt-2 px-3 py-2 rounded border border-border text-xs flex flex-col gap-1.5',
                'bg-bible-pending-bg text-bible-pending-fg border-bible-pending-border',
              )}
            >
              <div className="flex items-center gap-2 font-semibold">
                <span aria-hidden="true">🆕</span>
                <span>
                  {novel.length} novel name{novel.length === 1 ? '' : 's'} detected in this chapter
                </span>
                <span className="opacity-60 font-normal">— not in your character roster</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {novel.map((name) => (
                  <span
                    key={name}
                    data-testid="voice-debug-potential-new-item"
                    data-name={name}
                    className={cn(
                      'inline-flex items-center px-2 py-0.5 rounded font-mono',
                      'bg-bible-pending-bg/60 text-bible-pending-fg',
                    )}
                  >
                    {name}
                  </span>
                ))}
              </div>
            </div>
          );
        })()}
        {chapterAttributionStats && (
          <div className="opacity-70 mt-1 flex flex-wrap gap-x-3">
            <span>
              <strong className="font-mono">{stats.regexSolved}</strong> via regex
            </span>
            <span>
              <strong className="font-mono">{stats.llmSolved}</strong> via LLM (oMLX)
            </span>
            <span>
              <strong className="font-mono">{stats.conversationSolved}</strong> via state
            </span>
            {typeof chapterAttributionStats.sourceDrift === 'number' && chapterAttributionStats.sourceDrift > 0 && (
              <span className="text-bible-pending-fg">
                • {chapterAttributionStats.sourceDrift} source drift
              </span>
            )}
            {chapterAttributionStats.omlxReachable ? (
              <span className="opacity-60">• oMLX reachable</span>
            ) : (
              <span className="text-bible-pending-fg">• oMLX unreachable — no LLM pass</span>
            )}
            {chapterAttributionStats.fromCache && (
              <span className="opacity-60">• served from cache</span>
            )}
          </div>
        )}
      </div>

      {/* ── Per-voice summary ─────────────────────────────────────────── */}
      <div className={cn('px-4 py-3 border-b border-border text-xs', dividerCls)}>
        <div className="font-semibold mb-1.5 opacity-80">Voice distribution</div>
        <table className="w-full text-left">
          <thead className="opacity-60">
            <tr>
              <th className="font-normal pr-2">Speaker</th>
              <th className="font-normal pr-2">Voice</th>
              <th className="font-normal text-right">¶</th>
              <th className="font-normal text-right">state</th>
            </tr>
          </thead>
          <tbody>
            {summary.map((s) => (
              <tr key={`${s.speaker}::${s.voice}`} className="border-t border-current/5">
                <td className={cn('pr-2 py-0.5 truncate max-w-[10rem]', s.speaker === '(unattributed)' && 'italic opacity-70')}>
                  {s.speaker}
                </td>
                <td className={cn('pr-2 py-0.5 truncate max-w-[10rem]', s.voice === '(default)' && 'italic opacity-70')}>
                  {s.voice}
                </td>
                <td className="text-right tabular-nums py-0.5">{s.paragraphs}</td>
                <td className="text-right tabular-nums py-0.5 opacity-70">
                  {s.stateHits > 0 ? s.stateHits : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ── Per-paragraph list ────────────────────────────────────────── */}
      <ul className="text-xs">
        {visibleRowList.map((r) => {
          const isAttributed = r.status === 'attributed';
          const isUnattributed = r.status === 'unattributed';
          const isNarration = r.status === 'no-quote';
          const dotColor = isAttributed
            ? 'bg-success-fg'
            : isUnattributed
              ? 'bg-bible-pending-fg'
              : 'bg-muted-foreground';
          return (
            <li
              key={r.index}
              className={cn('px-4 py-2 border-b border-border flex gap-2', dividerCls, hoverCls)}
            >
              <span className="mt-1 shrink-0">
                <span className={cn('block h-2 w-2 rounded-full', dotColor)} />
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2 mb-0.5">
                  <span className="font-mono opacity-50">#{r.index}</span>
                  {r.sceneId !== undefined && (
                    <span className="font-mono opacity-40">S{r.sceneId}</span>
                  )}
                  <SourceBadge source={r.source} />
                  {isNarration ? (
                    <span className="italic opacity-60">narration</span>
                  ) : (
                    <>
                      <span className={cn('font-medium', isUnattributed && 'italic text-bible-pending-fg')}>
                        {r.speaker.name ?? '(unattributed → default voice)'}
                      </span>
                      <span className="opacity-60">→</span>
                      <span className={cn(isUnattributed && 'italic opacity-70')}>
                        {r.speaker.voiceName ?? '(default)'}
                      </span>
                    </>
                  )}
                </div>
                {r.firstQuote !== null && (
                  <div className={cn('italic opacity-80 truncate',
                    isAttributed ? 'text-success-fg' : '')}>
                    “{r.firstQuote.slice(0, 60)}{r.firstQuote.length > 60 ? '…' : ''}”
                  </div>
                )}
                {/* Per-layer evidence chips — same shape as the analyzer
                    modal's inline badges. Only shown when the panel has
                    actually run an analyzer pass (layers is set); before
                    a Full Analyzer run we don't have layer data so we
                    skip the row entirely. */}
                {r.layers && (r.layers.regex || r.layers.conversation || r.layers.llm) && (
                  <div className="mt-0.5 flex flex-wrap gap-1 text-[9px]">
                    {r.layers.regex && (
                      <span className="px-1 rounded bg-muted text-muted-foreground">
                        regex: {r.layers.regex}
                      </span>
                    )}
                    {r.layers.conversation && (
                      <span className="px-1 rounded bg-muted text-muted-foreground">
                        local: {r.layers.conversation}
                      </span>
                    )}
                    {r.layers.llm && (
                      <span className="px-1 rounded bg-bible-pending-bg/30 text-bible-pending-fg">
                        llm: {r.layers.llm}
                      </span>
                    )}
                  </div>
                )}
                {r.reason && (
                  <div className="opacity-65 truncate">
                    {r.reason}
                  </div>
                )}
                {r.activeCharacters && r.activeCharacters.length > 0 && (
                  <div className="opacity-45 truncate">
                    active: {r.activeCharacters.join(', ')}
                  </div>
                )}
                {r.evidence && r.evidence.length > 0 && (
                  <div className="opacity-45 space-y-0.5">
                    {r.evidence.slice(0, 3).map((e, evidenceIdx) => {
                      const ctx = contextAround(r.snippet, e.speaker);
                      return (
                        <div key={`${r.index}-${evidenceIdx}`} className="truncate">
                          [{e.source} {Math.round(e.weight * 100)}%] {e.detail}
                          {ctx ? ` | "${ctx}"` : ''}
                        </div>
                      );
                    })}
                  </div>
                )}
                <div className="opacity-50 truncate">{r.snippet}</div>
              </div>
            </li>
          );
        })}
      </ul>

      {/* ── Load more ──────────────────────────────────────────────────
          Renders only when there's at least one more page of rows
          remaining. Stepping in 50-row increments keeps the panel
          responsive without losing Ctrl+F "find on page" (full list is
          not hidden — virtualization would have to give that up). */}
      {remainingRows > 0 && (
        <div className={cn('px-4 py-3 border-t border-border flex items-center justify-between gap-2', dividerCls)}>
          <span className="text-[11px] opacity-60">
            Hiển thị {visibleRowList.length}/{rows.length} paragraph
          </span>
          <button
            type="button"
            onClick={() => setVisibleRows((n) => n + ROWS_PAGE_SIZE)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1 text-xs font-medium transition-colors',
              'border-border hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            )}
          >
            <ChevronDown className="h-3.5 w-3.5" />
            Tải thêm {Math.min(ROWS_PAGE_SIZE, remainingRows)} dòng
            <span className="opacity-50 font-normal">({remainingRows} còn lại)</span>
          </button>
        </div>
      )}

      {/* ── Footer hint ──────────────────────────────────────────────── */}
      <div className={cn('px-4 py-3 text-[11px] opacity-70', dividerCls)}>
        Green = attributed to a character voice. Amber = unattributed, falls back to default voice.
        Violet badge = local regex solved it.
        Amber badge = oMLX LLM solved it. State badge = conversation memory/fusion solved it.
        Inline <code className="font-mono opacity-80">regex:/local:/llm:</code> chips show what each
        evidence layer voted — only render after a Full Analyzer run.
        If a Ưu Nhi line shows amber, the attribution logic missed — check the snippet for
        pronoun / name pattern. Run &ldquo;Full Analysis&rdquo; (Wand2 button) to retry with the LLM.
      </div>
    </div>
  );
}
