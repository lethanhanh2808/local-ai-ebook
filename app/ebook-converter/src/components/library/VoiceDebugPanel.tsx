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
//   • the SOURCE of the attribution (parser / regex / default) so you can
//     tell which paragraphs VnCoreNLP solved vs the local 6-pass regex
//   • the count of paragraphs attributed to each character + voice
//
// Used to triage whether mis-routed audio is from attribution (the speaker
// is wrong) or the voice map (the right speaker picks up the wrong voice).
//
// This is a pure debug tool — it has no effect on playback.

import { useMemo } from 'react';
import { cn } from '@/lib/utils';

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
  parserReachable: boolean;
}

interface ChapterAttributionStats {
  chapterId: string;
  parserHits: number;
  regexHits: number;
  llmHits: number;
  conversationHits: number;
  defaults: number;
  fromCache: boolean;
  parserReachable: boolean;
  omlxReachable: boolean;
}

interface VoiceDebugPanelProps {
  paragraphs: string[];
  ttsCharacterList: { name: string; voiceName?: string }[];
  ttsCharacterMap: Record<string, string>;
  detectSpeaker: (text: string, idx?: number) =>
    { name?: string; voiceName?: string; source?: 'parser' | 'regex' | 'llm' | 'conversation' };
  chapterAttributionRef?: { current: Map<string, ChapterAttributionInfo> };
  chapterAttributionStats?: ChapterAttributionStats | null;
  /** ID of the chapter currently displayed — used to read the right entry
   *  from chapterAttributionRef. */
  currentChapterId?: string;
  isDark: boolean;
  dividerCls: string;
  hoverCls: string;
  panelCls: string;
}

interface ParagraphRow {
  index: number;
  firstQuote: string | null;
  speaker: { name?: string; voiceName?: string; source?: 'parser' | 'regex' | 'llm' | 'conversation' };
  status: 'attributed' | 'unattributed' | 'no-quote';
  source: 'parser' | 'regex' | 'llm' | 'conversation' | 'default' | 'cache-parser' | 'cache-regex' | 'cache-llm' | 'cache-conversation';
  confidence: number;
  reason?: string;
  evidence?: ChapterAttributionRow['evidence'];
  sceneId?: number;
  activeCharacters?: string[];
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

const SOURCE_BADGE: Record<string, { label: string; dark: string; light: string }> = {
  parser: {
    label: 'parser',
    dark: 'bg-sky-900/50 text-sky-200 border-sky-700/50',
    light: 'bg-sky-100 text-sky-800 border-sky-300',
  },
  regex: {
    label: 'regex',
    dark: 'bg-violet-900/40 text-violet-200 border-violet-700/50',
    light: 'bg-violet-100 text-violet-800 border-violet-300',
  },
  llm: {
    label: 'llm',
    dark: 'bg-amber-900/50 text-amber-200 border-amber-700/50',
    light: 'bg-amber-100 text-amber-800 border-amber-300',
  },
  conversation: {
    label: 'state',
    dark: 'bg-emerald-900/45 text-emerald-200 border-emerald-700/50',
    light: 'bg-emerald-100 text-emerald-800 border-emerald-300',
  },
  'cache-parser': {
    label: 'parser',
    dark: 'bg-sky-900/30 text-sky-300 border-sky-800/40',
    light: 'bg-sky-50 text-sky-700 border-sky-200',
  },
  'cache-regex': {
    label: 'regex',
    dark: 'bg-violet-900/30 text-violet-300 border-violet-800/40',
    light: 'bg-violet-50 text-violet-700 border-violet-200',
  },
  'cache-llm': {
    label: 'llm',
    dark: 'bg-amber-900/30 text-amber-300 border-amber-800/40',
    light: 'bg-amber-50 text-amber-700 border-amber-200',
  },
  'cache-conversation': {
    label: 'state',
    dark: 'bg-emerald-900/30 text-emerald-300 border-emerald-800/40',
    light: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  },
  default: {
    label: '—',
    dark: 'bg-slate-800 text-slate-400 border-slate-700',
    light: 'bg-slate-100 text-slate-500 border-slate-300',
  },
};

function SourceBadge({ source, isDark }: { source: string; isDark: boolean }) {
  const conf = SOURCE_BADGE[source] ?? SOURCE_BADGE.default;
  return (
    <span className={cn(
      'inline-flex items-center rounded border px-1.5 py-0 text-[10px] font-mono uppercase tracking-wide',
      isDark ? conf.dark : conf.light,
    )}>
      {conf.label}
    </span>
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
  isDark,
  dividerCls,
  hoverCls,
}: VoiceDebugPanelProps) {
  const rows = useMemo<ParagraphRow[]>(() => {
    // Pull the current chapter's attribution map (parser + regex results
    // stored on the server) so we can label each row with its source.
    const info = currentChapterId
      ? chapterAttributionRef?.current.get(currentChapterId)
      : undefined;
    const cached = info?.attribution ?? {};
    const isCache = !!info?.fromCache;
    return paragraphs.map((text, idx) => {
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
            : 'default';
          confidence = cachedEntry.confidence ?? 0;
        }
      }
      const cachedEntry = cached[idx];
      const snippet = text.length > 120 ? text.slice(0, 120).trimEnd() + '…' : text;
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
        snippet,
      };
    });
  }, [paragraphs, detectSpeaker, chapterAttributionRef, currentChapterId]);

  // Aggregate counts: how many paragraphs each (name|voice) pair produced.
  const summary = useMemo(() => {
    const counts = new Map<string, { speaker: string; voice: string; paragraphs: number; lines: number; parserHits: number; stateHits: number }>();
    for (const r of rows) {
      const key = `${r.speaker.name ?? '(unattributed)'}::${r.speaker.voiceName ?? '(default)'}`;
      const entry = counts.get(key) ?? {
        speaker: r.speaker.name ?? '(unattributed)',
        voice: r.speaker.voiceName ?? '(default)',
        paragraphs: 0,
        lines: 0,
        parserHits: 0,
        stateHits: 0,
      };
      entry.paragraphs += 1;
      if (r.firstQuote) entry.lines += 1;
      if (r.source === 'parser' || r.source === 'cache-parser') entry.parserHits += 1;
      if (r.source === 'conversation' || r.source === 'cache-conversation') entry.stateHits += 1;
      counts.set(key, entry);
    }
    return [...counts.values()].sort((a, b) => b.paragraphs - a.paragraphs);
  }, [rows]);

  const stats = useMemo(() => {
    const withQuote = rows.filter((r) => r.firstQuote !== null);
    const attributed = withQuote.filter((r) => r.status === 'attributed');
    const unattributed = withQuote.filter((r) => r.status === 'unattributed');
    const parserSolved = rows.filter((r) => r.source === 'parser' || r.source === 'cache-parser').length;
    const regexSolved = rows.filter((r) => r.source === 'regex' || r.source === 'cache-regex').length;
    const llmSolved = rows.filter((r) => r.source === 'llm' || r.source === 'cache-llm').length;
    const conversationSolved = rows.filter((r) => r.source === 'conversation' || r.source === 'cache-conversation').length;
    return {
      total: rows.length,
      withQuote: withQuote.length,
      attributed: attributed.length,
      unattributed: unattributed.length,
      parserSolved,
      regexSolved,
      llmSolved,
      conversationSolved,
    };
  }, [rows]);

  return (
    <div className="flex-1 overflow-y-auto">
      {/* ── Header / legend ───────────────────────────────────────────── */}
      <div className={cn('px-4 py-3 border-b text-xs space-y-1', dividerCls)}>
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          <span className={cn('inline-flex items-center gap-1 rounded px-1.5 py-0.5',
            isDark ? 'bg-emerald-900/40 text-emerald-200' : 'bg-emerald-100 text-emerald-800')}>
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            Attributed
          </span>
          <span className={cn('inline-flex items-center gap-1 rounded px-1.5 py-0.5',
            isDark ? 'bg-amber-900/40 text-amber-200' : 'bg-amber-100 text-amber-800')}>
            <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
            Unattributed (default voice)
          </span>
          <span className={cn('inline-flex items-center gap-1 rounded px-1.5 py-0.5',
            isDark ? 'bg-slate-800 text-slate-300' : 'bg-slate-200 text-slate-700')}>
            <span className="h-1.5 w-1.5 rounded-full bg-slate-400" />
            Narration
          </span>
        </div>
        <div className="opacity-70 mt-2">
          {stats.attributed}/{stats.withQuote} dialogue paragraphs attributed •{' '}
          {stats.unattributed} fall back to default voice • {stats.total} total paragraphs
        </div>
        {chapterAttributionStats && (
          <div className="opacity-70 mt-1 flex flex-wrap gap-x-3">
            <span>
              <strong className="font-mono">{stats.parserSolved}</strong> via parser
              (VnCoreNLP)
            </span>
            <span>
              <strong className="font-mono">{stats.regexSolved}</strong> via regex
            </span>
            <span>
              <strong className="font-mono">{stats.llmSolved}</strong> via LLM (oMLX)
            </span>
            <span>
              <strong className="font-mono">{stats.conversationSolved}</strong> via state
            </span>
            {chapterAttributionStats.parserReachable ? (
              <span className="opacity-60">• parser reachable</span>
            ) : (
              <span className="text-amber-500">• parser unreachable — all from regex</span>
            )}
            {chapterAttributionStats.omlxReachable ? (
              <span className="opacity-60">• oMLX reachable</span>
            ) : (
              <span className="text-amber-500">• oMLX unreachable — no LLM pass</span>
            )}
            {chapterAttributionStats.fromCache && (
              <span className="opacity-60">• served from cache</span>
            )}
          </div>
        )}
      </div>

      {/* ── Per-voice summary ─────────────────────────────────────────── */}
      <div className={cn('px-4 py-3 border-b text-xs', dividerCls)}>
        <div className="font-semibold mb-1.5 opacity-80">Voice distribution</div>
        <table className="w-full text-left">
          <thead className="opacity-60">
            <tr>
              <th className="font-normal pr-2">Speaker</th>
              <th className="font-normal pr-2">Voice</th>
              <th className="font-normal text-right">¶</th>
              <th className="font-normal text-right">parser</th>
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
                  {s.parserHits > 0 ? s.parserHits : '—'}
                </td>
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
        {rows.map((r) => {
          const isAttributed = r.status === 'attributed';
          const isUnattributed = r.status === 'unattributed';
          const isNarration = r.status === 'no-quote';
          const dotColor = isAttributed
            ? 'bg-emerald-500'
            : isUnattributed
              ? 'bg-amber-500'
              : 'bg-slate-400';
          return (
            <li
              key={r.index}
              className={cn('px-4 py-2 border-b flex gap-2', dividerCls, hoverCls)}
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
                  <SourceBadge source={r.source} isDark={isDark} />
                  {isNarration ? (
                    <span className="italic opacity-60">narration</span>
                  ) : (
                    <>
                      <span className={cn('font-medium', isUnattributed && 'italic text-amber-500')}>
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
                    isAttributed ? 'text-emerald-700 dark:text-emerald-300' : '')}>
                    “{r.firstQuote.slice(0, 60)}{r.firstQuote.length > 60 ? '…' : ''}”
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
                  <div className="opacity-45 truncate">
                    evidence: {r.evidence.slice(0, 3).map((e) => `${e.source} ${Math.round(e.weight * 100)}%`).join(' · ')}
                  </div>
                )}
                <div className="opacity-50 truncate">{r.snippet}</div>
              </div>
            </li>
          );
        })}
      </ul>

      {/* ── Footer hint ──────────────────────────────────────────────── */}
      <div className={cn('px-4 py-3 text-[11px] opacity-70', dividerCls)}>
        Green = attributed to a character voice. Amber = unattributed, falls back to default voice.
        Sky badge = VnCoreNLP parser solved it. Violet badge = local regex solved it.
        Amber badge = oMLX LLM solved it. State badge = conversation memory/fusion solved it.
        If a Ưu Nhi line shows amber, the attribution logic missed — check the snippet for
        pronoun / name pattern. Run "Full Analysis" (Wand2 button) to retry with the LLM.
      </div>
    </div>
  );
}
