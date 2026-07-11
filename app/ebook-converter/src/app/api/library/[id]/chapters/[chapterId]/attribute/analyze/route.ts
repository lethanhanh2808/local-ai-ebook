// src/app/library/[id]/chapters/[chapterId]/attribute/analyze/route.ts
//
// POST /api/library/[id]/chapters/[chapterId]/attribute/analyze
//
// Full-attribution pipeline streamed via Server-Sent Events. Driven by the
// "Full Analysis" Wand2 button on the chapter toolbar — the same UI that
// the cheap GET route (just regex + parser + local fusion) feeds.
//
// The pipeline:
//   1. Invalidate the cached ChapterAttribution row (so we always recompute).
//   2. Run attributeByParse (VnCoreNLP) + attributeByRegex.
//   3. Run local stateful conversation fusion.
//   4. Identify unresolved paragraphs (no speaker after step 3).
//   5. Preflight probe: one cheap chat() call. If it fails → omlxReachable
//      stays false, the LLM step is skipped, the response still streams
//      the local stateful result so the modal renders stats.
//   6. attributeByLLM: batched, concurrent (max 2 in flight), strict name
//      validation. Failed batches are counted but don't abort the pipeline.
//   7. Re-run stateful fusion with LLM evidence, persist to cache.
//
// Wire format: text/event-stream with `data: <json>\n\n` events.
//   { type: 'log',      line, phase, wallMs, meta? }   — incremental progress
//   { type: 'result',   attribution, stats, chapter, omlxReachable }   — terminal
//   { type: 'error',    message }                                 — fatal abort
// The client SSE parser in EbookReader.runFullAnalysis reads this stream
// and updates the modal log + summary cards live.
//
// The /attribute (cheap, GET) endpoint stays JSON because it's small and
// fast — no point burning SSE overhead on a 200ms response.

import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getBook } from '@/lib/db/books';
import { listCharacters } from '@/lib/db/voices';
import {
  invalidateAttribution,
  setCachedAttribution,
  type ChapterAttributionMap,
} from '@/lib/db/chapter-attribution';
import { chat } from '@/lib/ai';
import {
  ATTRIBUTION_VERSION,
  ATTRIBUTION_VERSION_LLM,
  attributeByConversation,
  attributeByLLM,
  attributeByParse,
  attributeByRegex,
  buildGenderByChar,
  callParser,
  computeStats,
  sliceParagraphs,
} from '@/lib/attribution';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Vercel hobby limit is 60s; allow 5 min here because the full pipeline
// (parser + 80 LLM batches × 90s timeout) can easily run 2-3 minutes when
// oMLX is slow or busy.
export const maxDuration = 300;

// ── oMLX preflight probe ─────────────────────────────────────────────────
// Cheap "are you alive?" call. If it fails, we skip the LLM step entirely
// rather than burning 80 × 90s on a known-down provider.
//
// BUGFIX 2026-07-11: retry up to 2x with exponential backoff before bailing.
// The single-attempt probe was producing false negatives when oMLX took a
// few seconds to warm up its first inference (the keepalive chunk confused
// streaming parses on cold start, and short-lived HTTP hiccups were
// confused for outages). 2 retries × 1s/2s backoff catches transient
// flakes without burning the user-visible 90s batch timeout budget.
async function omlxPreflight(): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const text = await chat({
        messages: [{ role: 'user', content: 'ok' }],
        max_tokens: 4,
        enable_thinking: false,
        timeoutMs: 15_000,
      });
      // Accept any non-thrown response — empty string counts as "reachable"
      // (model is alive, just gave us nothing) so the LLM batch step can
      // surface the real failure mode per-batch instead of bailing pre-flight.
      if (typeof text === 'string') return true;
    } catch {
      // fall through to retry
    }
    // Backoff before retry: 1s, 2s. No backoff after the final attempt.
    if (attempt < 2) {
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  return false;
}

// ── LLM-first roster extraction ──────────────────────────────────────────
// When the user clicks "Full Analyzer" with an empty character roster, we
// can't run speaker attribution against `knownNames === []`. Rather than
// bail and tell the user to run "Phân tích nhân vật" separately, we run
// the LLM-first detector inline first (5-10 min for a full book) and then
// proceed with attribution. The detector result is persisted into the
// `Character` table via the same centralized voice-selector path the
// detection page uses.
async function autoExtractRoster(
  bookId: string,
  controller: ReadableStreamDefaultController<Uint8Array>,
  log: (controller: ReadableStreamDefaultController<Uint8Array>, line: string, phase: 'init' | 'parse' | 'regex' | 'local' | 'preflight' | 'llm' | 'fuse' | 'cache' | 'stat' | 'error', extra?: { meta?: unknown }) => void,
): Promise<{ ok: boolean; charactersAdded: number; reason?: string }> {
  try {
    log(controller, 'Roster trống — chạy LLM-first detector để extract nhân vật...', 'init');
    // Delegate to the same detection route the UI uses. This goes through
    // the Python character_detector.py (3-stage pipeline once we ship the
    // LLM-first rewrite) and persists to the Character table.
    const origin = process.env.NEXTAUTH_URL || 'http://127.0.0.1:3100';
    const r = await fetch(`${origin}/api/library/${bookId}/characters/detect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoApply: true }),  // persist immediately
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      log(controller, `Detector thất bại (HTTP ${r.status}) — sẽ tiếp tục attribution với roster rỗng`, 'error',
        { meta: { detectorStatus: r.status, detectorBody: detail.slice(0, 300) } });
      return { ok: false, charactersAdded: 0, reason: `HTTP ${r.status}` };
    }
    const data = await r.json() as { inserted?: number; source?: string };
    const source = data.source ?? 'unknown';
    log(controller,
      `Detector hoàn tất (source=${source}, inserted=${data.inserted ?? 0}). Tiếp tục attribution...`,
      'init',
      { meta: { detectorInserted: data.inserted ?? 0, detectorSource: source } });
    return { ok: true, charactersAdded: data.inserted ?? 0 };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(controller, `Detector lỗi — ${msg}`, 'error', { meta: { detectorError: msg } });
    return { ok: false, charactersAdded: 0, reason: msg };
  }
}

// ── Main handler ─────────────────────────────────────────────────────────
export async function POST(
  req: NextRequest,
  props: { params: Promise<{ id: string; chapterId: string }> }
) {
  const params = await props.params;
  const book = await getBook(params.id);
  if (!book) {
    return new Response(JSON.stringify({ error: 'Book not found' }), {
      status: 404, headers: { 'Content-Type': 'application/json' },
    });
  }
  // Read body early so we can validate mode before opening the stream.
  const rawBody = await req.json().catch(() => ({})) as { mode?: string };
  const mode = rawBody.mode === 'full-llm' || rawBody.mode === 'local-only'
    ? rawBody.mode
    : 'combine';
  // BUGFIX 2026-07-11: when the caller didn't specify a mode explicitly,
  // 'combine' is the default — but with an empty roster the LLM step would
  // bail before doing anything useful. Treat the default as 'full-llm' when
  // the roster is empty so we auto-extract and continue. Local-only mode
  // stays strictly local (no roster extraction).
  const callerChoseMode = typeof rawBody.mode === 'string';

  const t0 = Date.now();
  const encoder = new TextEncoder();
  let closed = false;

  // Mutable accumulator for the final `result` event payload. The handler
  // collects attribution + stats as each phase finishes, then writes the
  // single `result` event when the stream closes.
  let finalPayload: {
    attribution: ChapterAttributionMap;
    chapter: { chapterIndex: number; chapterId: string; file: string } | null;
    omlxReachable: boolean;
    stats: ReturnType<typeof computeStats> & { llmFailures: number; llmRequested: number };
    durationMs: number;
    llmDurationMs: number;
  } | null = null;
  let fatalError: string | null = null;

  const write = (controller: ReadableStreamDefaultController<Uint8Array>, ev: unknown) => {
    if (closed) return;
    try {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
    } catch { closed = true; }
  };
  const log = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    line: string,
    phase: 'init' | 'parse' | 'regex' | 'local' | 'preflight' | 'llm' | 'fuse' | 'cache' | 'stat' | 'error',
    extra: { meta?: unknown } = {},
  ) => {
    write(controller, { type: 'log', line, phase, wallMs: Date.now() - t0, ...(extra.meta !== undefined ? { meta: extra.meta } : {}) });
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const onAbort = () => { closed = true; };
      req.signal.addEventListener('abort', onAbort);
      try {
        // ── Phase 1: load chapter HTML ──────────────────────────────────
        const origin = req.nextUrl.origin;
        const chapterResp = await fetch(
          `${origin}/api/library/${params.id}/chapters/${encodeURIComponent(params.chapterId)}?raw=1`,
        );
        if (!chapterResp.ok) {
          write(controller, { type: 'error', message: `Failed to load chapter HTML (HTTP ${chapterResp.status})` });
          return;
        }
        const { html } = await chapterResp.json() as { html: string };
        if (!html) {
          write(controller, { type: 'result', attribution: {}, chapter: null, omlxReachable: false,
            stats: { parserHits: 0, regexHits: 0, llmHits: 0, conversationHits: 0, sourceDrift: 0, defaults: 0, totalParagraphs: 0, llmFailures: 0, llmRequested: 0 },
            durationMs: Date.now() - t0, llmDurationMs: 0 });
          return;
        }

        // ── Phase 2: load characters, paragraphs, file path ─────────────
        const filePath = await (await import('@/lib/storage')).resolveBookPath(book);
        if (!fs.existsSync(filePath)) {
          write(controller, { type: 'error', message: 'EPUB file missing on disk' });
          return;
        }
        const { parseEpub } = await import('@/lib/pipeline/epub-parser');
        const epub = await parseEpub(filePath);
        const chapterIndex = epub.htmlFiles.findIndex(
          (f) => path.basename(f, path.extname(f)) === params.chapterId
            || path.basename(f) === params.chapterId,
        );
        if (chapterIndex < 0) {
          write(controller, { type: 'error', message: 'Chapter not found in EPUB' });
          return;
        }
        let mtime = 0;
        try { mtime = Math.floor(fs.statSync(filePath).mtimeMs); } catch { /* keep 0 */ }

        let chars = await listCharacters(params.id);
        let knownNames = chars.flatMap((c) => [c.name, ...(c.aliases ?? [])]);
        const genderByChar = buildGenderByChar(
          chars.map((c) => ({ name: c.name, aliases: c.aliases ?? [], gender: c.gender ?? null })),
        );
        const paragraphs = sliceParagraphs(html);
        let characterContext = chars.map((c) => ({
          name: c.name,
          aliases: c.aliases ?? [],
          gender: c.gender ?? null,
        }));
        log(controller, `Load ${paragraphs.length} đoạn + ${chars.length} nhân vật`, 'init');

        // ── Phase 3: invalidate cache ───────────────────────────────────
        await invalidateAttribution(params.id, chapterIndex);
        log(controller, 'Cache invalidated', 'init');

        // ── Phase 4: parser + regex layers ──────────────────────────────
        const parserText = paragraphs.map((p) => p.text).join('\n');
        const parserResp = await callParser(parserText);
        let parserOut: ChapterAttributionMap = {};
        let parserReachable = true;
        if (parserResp) {
          parserOut = attributeByParse(paragraphs, parserResp.sentences, knownNames, genderByChar);
          log(controller, `Parser: ${Object.keys(parserOut).length} đoạn gán từ VnCoreNLP`, 'parse');
        } else {
          parserReachable = false;
          log(controller, 'Parser: VnCoreNLP không khả dụng (bỏ qua)', 'parse');
        }
        const regexOut = attributeByRegex(paragraphs, knownNames);
        log(controller, `Regex: ${Object.keys(regexOut).length} đoạn gán từ pattern`, 'regex');

        // ── Phase 5: local baseline fusion ──────────────────────────────
        const localBaseline = attributeByConversation({
          paragraphs, characters: characterContext, parserOut, regexOut,
        });
        const localResolved = Object.values(localBaseline).filter((a) => a.speaker).length;
        log(controller, `Local fusion: ${localResolved} đoạn gán (parser + regex + stateful)`, 'local');

        // ── Phase 6: oMLX preflight + LLM batches (skip in local-only) ──
        let llmOut: ChapterAttributionMap = {};
        let llmFailures = 0;
        let llmRequested = 0;
        let llmDurationMs = 0;
        let omlxReachable = false;
        // BUGFIX 2026-07-11: when the roster is empty AND the caller didn't
        // pin us to local-only, run the LLM-first detector inline first so
        // the user gets a working pipeline on a single click instead of
        // having to click "Phân tích nhân vật" and then re-click Full Analyzer.
        if (mode !== 'local-only' && knownNames.length === 0) {
          const extracted = await autoExtractRoster(params.id, controller, log);
          if (extracted.ok && extracted.charactersAdded > 0) {
            // Re-load the roster — now non-empty.
            const freshChars = await listCharacters(params.id);
            chars = freshChars;
            knownNames = freshChars.flatMap((c) => [c.name, ...(c.aliases ?? [])]);
            characterContext = freshChars.map((c) => ({
              name: c.name,
              aliases: c.aliases ?? [],
              gender: c.gender ?? null,
            }));
            log(controller,
              `Roster populated: ${knownNames.length} names — tiếp tục attribution`,
              'init',
              { meta: { rosterSize: knownNames.length } });
          } else {
            log(controller,
              'Detector không thêm nhân vật nào — chạy attribution với roster rỗng, regex layer sẽ chỉ match quoted speakers không tên',
              'llm',
              { meta: { skipped: 'no-characters-after-detect', reason: extracted.reason ?? 'unknown' } });
          }
        }

        // Decide whether the LLM layer has anything to do BEFORE we burn a
        // preflight ping on oMLX. Three reasons to skip, each surfacing a
        // distinct log line so the user can tell at a glance which knob to
        // turn:
        //   1. caller asked for local-only mode
        //   2. nothing unresolved after parser + regex + stateful fusion
        //   3. no character roster — the LLM cannot validate speaker names
        //      against a roster of knownNames, so its answers would be
        //      discarded by validateLLMRow anyway.
        const unresolved = paragraphs
          .filter((p) => !localBaseline[p.index]?.speaker)
          .map((p) => p.index);
        if (mode === 'local-only') {
          log(controller, 'Mode local-only — bỏ qua LLM', 'preflight');
        } else if (knownNames.length === 0) {
          log(controller,
            `Chưa có nhân vật trong DB (0 names) — bỏ qua LLM. Chạy "Phân tích nhân vật" trước để populate roster.`,
            'llm',
            { meta: { skipped: 'no-characters', unresolvedCount: unresolved.length } });
        } else if (unresolved.length === 0) {
          log(controller,
            `Local fusion đã gán hết ${paragraphs.length}/${paragraphs.length} đoạn — LLM không cần chạy`,
            'llm',
            { meta: { skipped: 'all-resolved' } });
        } else {
          omlxReachable = await omlxPreflight();
          log(controller, omlxReachable ? `Preflight: oMLX OK` : `Preflight: oMLX down — bỏ qua LLM`, 'preflight');

          if (omlxReachable) {
            const batches = Math.ceil(unresolved.length / 4);  // matches LLM_BATCH_SIZE
            log(controller, `LLM: ${unresolved.length} đoạn chưa gán → ${batches} batch (≤2 song song)`, 'llm');
            const llmStart = Date.now();
            // Smoothed ETA — average batch duration × remaining batches.
            let avgBatchMs = 0;
            let batchesDone = 0;
            const llmResult = await attributeByLLM({
              paragraphs,
              unresolvedIndices: unresolved,
              knownNames,
              characterContext,
              parserOut,
              regexOut,
              onBatch: (info) => {
                batchesDone++;
                // Exponential moving average so early batches (often warm-up
                // for cold oMLX) don't poison the ETA forever.
                const alpha = 0.4;
                avgBatchMs = avgBatchMs === 0
                  ? info.durationMs
                  : avgBatchMs * (1 - alpha) + info.durationMs * alpha;
                const remaining = Math.max(0, info.total - batchesDone);
                const etaSec = Math.round((remaining * avgBatchMs) / 1000);
                const status = info.error
                  ? `✗ ${info.error.slice(0, 30)}`
                  : info.ok
                    ? '✓'
                    : '· 0 rows';
                log(controller,
                  `Batch ${info.idx}/${info.total} ${status} · [${info.indices.join(',')}] · ${Math.round(info.durationMs / 100) / 10}s · ETA ~${etaSec}s · ${batchesDone}/${info.total} done (${batchesDone - llmFailures}✓ ${llmFailures}✗)`,
                  'llm',
                  { meta: {
                    batchIndex: info.idx,
                    batchTotal: info.total,
                    batchOk: info.ok,
                    paragraphs: info.indices,
                    durationMs: info.durationMs,
                    etaSec,
                  } });
              },
            });
            llmDurationMs = Date.now() - llmStart;
            llmOut = llmResult.map;
            llmFailures = llmResult.failedBatches;
            llmRequested = llmResult.requested;
          }
        }

        // ── Phase 7: fuse + cache + stats ───────────────────────────────
        const merged = attributeByConversation({
          paragraphs, characters: characterContext,
          parserOut, regexOut, llmOut,
        });
        const mergedResolved = Object.values(merged).filter((a) => a.speaker).length;
        log(controller, `Fuse: ${mergedResolved}/${paragraphs.length} đoạn gán hợp nhất (parser + regex + local + LLM)`, 'fuse');

        try {
          await setCachedAttribution(
            params.id, chapterIndex, merged, mtime, ATTRIBUTION_VERSION_LLM,
          );
          log(controller, 'Cache: persisted', 'cache');
        } catch (e) {
          log(controller, `Cache: write failed — ${e instanceof Error ? e.message : String(e)}`, 'cache');
          console.error('[attribute/analyze] cache write failed:', e);
        }

        const baseStats = computeStats(paragraphs, merged);
        const stats = { ...baseStats, llmFailures, llmRequested };
        log(controller, `Stats: ${stats.totalParagraphs} đoạn, ${stats.regexHits} regex + ${stats.llmHits} LLM + ${stats.conversationHits} conversation, ${stats.defaults} voice mặc định (${Math.round((Date.now() - t0) / 100) / 10}s tổng)`, 'stat');

        finalPayload = {
          attribution: merged,
          chapter: { chapterIndex, chapterId: params.chapterId, file: epub.htmlFiles[chapterIndex] },
          omlxReachable,
          stats,
          durationMs: Date.now() - t0,
          llmDurationMs,
        };
        // Streamed final payload. Client reads `resultData` from this event.
        write(controller, {
          type: 'result',
          attribution: finalPayload.attribution,
          layers: { parser: parserOut, regex: regexOut, local: localBaseline, llm: llmOut },
          paragraphTexts: Object.fromEntries(paragraphs.map((p) => [p.index, p.text.slice(0, 800)])),
          mode,
          stats: finalPayload.stats,
          chapter: finalPayload.chapter,
          omlxReachable: finalPayload.omlxReachable,
          durationMs: finalPayload.durationMs,
          llmDurationMs: finalPayload.llmDurationMs,
        });
      } catch (e) {
        fatalError = e instanceof Error ? e.message : String(e);
        write(controller, { type: 'error', message: fatalError });
      } finally {
        if (fatalError && !closed) {
          // Already emitted error event above. Just close.
        }
        try { controller.close(); } catch { /* */ }
        closed = true;
        req.signal.removeEventListener('abort', onAbort);
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
