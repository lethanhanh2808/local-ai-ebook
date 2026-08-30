import { cn } from '@/lib/utils';
import { PHASE_BG, PHASE_LABEL, PHASE_VN, type AnalysisLogLine } from './reader-analysis';

export function metaToTooltip(meta: Record<string, unknown> | null | undefined): string {
  if (!meta) return '';
  return Object.entries(meta)
    .filter(([, v]) => v != null && v !== '')
    .slice(0, 10)
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join('  ');
}

export function renderLogLine(line: AnalysisLogLine, idx: number, failed: boolean) {
  return (
    <li
      key={idx}
      title={metaToTooltip(line.meta) || undefined}
      className={cn(
        'rounded-md border px-2.5 py-2 my-1',
        PHASE_BG[line.phase],
        failed && line.phase === 'error' ? 'border-red-500/50' : '',
      )}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span className="inline-block tracking-wide text-[10px] font-semibold uppercase rounded px-1 py-0.5 border border-current/30">
          {PHASE_LABEL[line.phase]}
        </span>
        <span className="text-xs font-medium truncate">{line.text}</span>
      </div>
    </li>
  );
}

export function BatchProgressCard({ lines }: { lines: AnalysisLogLine[] }) {
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

export function HumanLogSummary({ lines, failed, mutedCls }: {
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

export function clientSplitParagraphs(html: string): string[] {
  const withBreaks = html
    .replace(/<\s*\/??\s*(p|div|h[1-6]|li|blockquote|br|hr)\s*\/??\s*>/gi, '\n')
    .replace(/<br\s*\/??\s*>/gi, '\n');
  const textOnly = withBreaks.replace(/<[^>]+>/g, ' ');
  const blocks = textOnly
    .split(/\n+/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 0);
  return blocks;
}
