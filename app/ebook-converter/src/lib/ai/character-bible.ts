// src/lib/ai/character-bible.ts
//
// "Character Bible" — Vietnamese-language LLM curator that reads the latest
// chapter (or a capped slice of an entire book) and proposes a *delta*
// against the current bible. Two consumers call this:
//
//   1. The HTTP refresh route (manual user click)
//   2. The BullMQ worker (auto-on-close after a chapter finishes reading)
//
// Mode contract:
//   - `autoMerge: true`  →  "auto-on-close" path. New characters + non-
//                            conflicting LLM-field writes are applied
//                            immediately. Anything that would overwrite a
//                            `source='user'` field goes to PendingBibleDiff.
//   - `autoMerge: false` →  "manual" path. Builds the full patch set,
//                            returns it to the caller for review. Nothing
//                            is written to the DB except PendingBibleDiff
//                            rows (so the user can review & apply later).
//
// Source-sacred merge rules (enforced in `applyBiblePatch()` and the
// CRUD helpers in src/lib/db/character-bible.ts):
//   - A field with `source='user'` can ONLY be changed by another user
//     edit. LLM refresh proposals become PendingBibleDiff rows with
//     `autoReason='conflict-with-user-edit'` and `conflictWith=<field>`.
//   - A field that was written by a previous LLM refresh can be replaced
//     by a later LLM refresh (no special protection). The proposed value
//     still goes through PendingBibleDiff so the user can sanity-check
//     but with `autoReason='replaces-existing-llm-field'` so the UI can
//     flag it differently.
//   - 'new' characters always auto-apply (autoMerge mode).
//   - 'appearance' ledger bumps always auto-apply (idempotent counter).
//   - 'relationship' edges never auto-overwrite `source='user'` rows;
//     they queue.
import { chatJSON, JsonChatError } from './index';
import {
  getCharacterBible,
  setProfile,
  addOrUpdateRelationship,
  recordAppearances,
  ensureCharacter,
  resolveCharacterIds,
  findCharacterIdByName,
  queueDiff,
  mergeLlmProfilePatch,
  recomputeCharacterRoles,
  canonicalizeRelationship,
  type ProfileSource,
  type CharacterBibleView,
  type BibleDiffPatch,
} from '@/lib/db/character-bible';
import { prisma } from '@/lib/db/client';
import { getSettings } from '@/lib/db/settings';

// ── Public result shape ──────────────────────────────────────────────────

export interface RefreshBibleOptions {
  /** REQUIRED: which chapter to analyse. Whole-book mode is intentionally
   *  not supported — a full-novel scan blows past the prompt budget (a
   *  single 40 k-char chapter already pushed us into "Unexpected end of
   *  JSON input" territory) and a single bad merge corrupts the whole
   *  bible. Per-chapter accumulation + combination is the canonical
   *  pattern: each chapter enqueue produces a small delta that gets
   *  merged into the bible immediately (or queued as a PendingBibleDiff
   *  when it conflicts with a user edit). */
  chapterIndex: number;
  chapterFile?: string | null;
  /** Default true — the BullMQ auto path. Manual user refresh passes
   *  false so it can preview the patch without committing. */
  autoMerge?: boolean;
  /** Called with progress events; used by the SSE route to stream to the
   *  browser. May be omitted for the BullMQ worker call. */
  onProgress?: (e: BibleProgressEvent) => void | Promise<void>;
  /** Hard cap on total chapter characters fed to the LLM (default 12 000).
   *  Kept modest so the model returns within the upstream gateway's timeout
   *  (the MiniMax gateway returns 504 when a request runs too long). 12 k
   *  chars is plenty for one chapter's character-relevant prose; larger
   *  prompts risk both truncation mid-array AND gateway time-outs. */
  maxChapterChars?: number;
  /** Override model name; defaults to the user-selected AI provider model. */
  model?: string;
  /** Bypass the BibleRefreshLog idempotency guard and re-run even when a
   *  prior refresh has already populated the log. Defaults to false so
   *  accidental double-clicks / job retries don't double-count. */
  forceRerun?: boolean;
}

export type BibleProgressEvent =
  | { kind: 'reading-bible' }
  | { kind: 'fetching-chapter'; chapterIndex: number; chapterFile: string }
  | { kind: 'reading-chapter'; chars: number }
  | { kind: 'calling-llm' }
  | { kind: 'llm-retry'; attempt: number; backoffMs: number; reason: string }
  | { kind: 'llm-done'; tokens: number; durationMs: number }
  | { kind: 'applying'; autoApplied: number; queued: number; conflicts: number }
  | { kind: 'done'; autoApplied: number; queued: number; conflicts: number; durationMs: number }
  | { kind: 'error'; message: string };

export interface RefreshBibleResult {
  patches: BibleDiffPatch[];
  autoApplied: number;
  queued: number;
  conflicts: number;
  durationMs: number;
  /** When autoMerge was false, the queued count here is the size of the
   *  PendingBibleDiff write-back (full set); conflicts is the subset of
   *  those that needed user review. */
}

// ── Public entry ─────────────────────────────────────────────────────────

/**
 * Read the current bible, fetch the target chapter text, ask the LLM for
 * a delta, then apply-or-queue based on `autoMerge`.
 *
 * Errors bubble; the caller decides whether to swallow them.
 */
export async function refreshBible(
  bookId: string,
  opts: RefreshBibleOptions,
): Promise<RefreshBibleResult> {
  const autoMerge = opts.autoMerge ?? true;
  const t0 = Date.now();
  const emit = async (e: BibleProgressEvent) => {
    if (opts.onProgress) {
      try { await opts.onProgress(e); } catch { /* non-fatal */ }
    }
  };

  await emit({ kind: 'reading-bible' });
  const bible = await getCharacterBible(bookId);

  // Per-chapter-only: a whole-novel scan is not supported (see the comment
  // on RefreshBibleOptions.chapterIndex). Reject anything that isn't a
  // concrete chapter index so callers can't accidentally request a giant
  // prompt.
  if (!Number.isInteger(opts.chapterIndex) || opts.chapterIndex < 0) {
    await emit({ kind: 'error', message: 'chapterIndex is required and must be >= 0' });
    throw new Error('refreshBible: chapterIndex is required and must be >= 0 (whole-book scans are disabled)');
  }

  // Idempotency guard — see BibleRefreshLog. A second refresh on the same
  // chapter at the same version returns a no-op result instead of
  // re-running the LLM (which would double-count appearances and queue
  // duplicate patches). Callers that explicitly want a re-run pass
  // `forceRerun: true` in opts.
  if (!opts.forceRerun) {
    const prior = await prisma.bibleRefreshLog.findUnique({
      where: { bookId_chapterIndex: { bookId, chapterIndex: opts.chapterIndex } },
    });
    if (prior && prior.status === 'applied') {
      // Don't emit 'done' here — the caller (HTTP route) emits a single
      // final 'done' event after refreshBible() resolves. Pre-fix this
      // emitted twice and downstream SSE consumers parsed JSON twice.
      return {
        patches: [], autoApplied: 0, queued: 0, conflicts: 0,
        durationMs: Date.now() - t0,
      };
    }
  }

  // 1. Fetch the chapter text(s) we will feed to the LLM.
  await emit({ kind: 'fetching-chapter', chapterIndex: opts.chapterIndex, chapterFile: opts.chapterFile ?? '' });
  // Honor an explicit per-call override, else the user-configured Settings
  // value (bibleChapterChars), else the 12k safety default.
  const maxChars = opts.maxChapterChars
    ?? (await getSettings().then((s) => s.bibleChapterChars))
    ?? 12_000;
  const inputs = await fetchChapterInputs(bookId, opts.chapterIndex, opts.chapterFile ?? null, maxChars);
  if (inputs.length === 0) {
    await emit({ kind: 'error', message: 'no chapter text found' });
    return { patches: [], autoApplied: 0, queued: 0, conflicts: 0, durationMs: Date.now() - t0 };
  }
  const chapterText = inputs.map((i) => `[Chapter ${i.chapterIndex} — ${i.chapterFile}]\n${i.text}`).join('\n\n');
  await emit({ kind: 'reading-chapter', chars: chapterText.length });

  // 2. Build the prompt and call the LLM.
  await emit({ kind: 'calling-llm' });
  const sysPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt({
    bible,
    chapterText,
    chapterIndices: inputs.map((i) => i.chapterIndex),
  });
  let patches: RawBiblePatch[] = [];
  let tokens = 0;
  try {
    const llmStart = Date.now();
    // Outer retry loop for transient gateway errors. rawChat() already
    // retries 5xx/408/429 inside (~7 s total budget), but the openresty
    // 504s in front of MiniMax have a longer recovery window — when the
    // gateway is briefly overloaded the failure can persist for 30-60s.
    // We add an outer loop of 3 attempts with 5/10/20 s backoff so a
    // temporary spike doesn't permanently fail a chapter. Total wall
    // budget here is ~35 s; gated by `isTransientGatewayError()` so we
    // DON'T retry deterministic failures (4xx auth/billing/format) or
    // model-side JSON parse errors (those won't fix themselves on retry).
    const maxOuterRetries = 3;
    let attempt = 0;
    let lastErr: unknown;
    while (true) {
      try {
        patches = await chatJSON<RawBiblePatch[]>({
          messages: [
            { role: 'system', content: sysPrompt },
            { role: 'user', content: userPrompt },
          ],
          // Force chain-of-thought OFF — for some Vietnamese-trained local
          // models (and the "MiniMax" provider) thinking tokens eat a large
          // slice of the output budget and the actual JSON array gets
          // truncated mid-element. This is what was producing "Unexpected
          // end of JSON input". The bible task doesn't need reasoning.
          enable_thinking: false,
          temperature: 0.2,
          // 2026-09-01: honor Settings.aiMaxTokens (via chatJSON fallback)
          // instead of hardcoding 8192. Vietnamese character-bible arrays can
          // grow quickly when a chapter introduces many new characters. The
          // chat() helper clamps to 16384 internally as a safety net so a
          // user-set "Generous" preset (e.g. for reasoning models) still works
          // without us picking an arbitrary number per call site.
          // Retry transient upstream failures (504 gateway time-outs from the
          // MiniMax gateway, empty/dropped responses) so a flaky request
          // doesn't fail the whole chapter — see rawChat() in src/lib/ai/index.ts.
          // maxRetries: 1 — let rawChat do ONE inner retry (so a fast
          // 504/empty-response gets a quick second chance with 1s backoff)
          // but no more. The outer retry loop below handles longer-window
          // recovery. With maxRetries=1 a single chatJSON takes at most
          // ~2 × timeoutMs + 1s ≈ 180s; outer loop adds 3 × that + 35s
          // backoffs ≈ 575s — just under the route's 600s SSE budget.
          maxRetries: 1,
          // 2026-09-02: tighten per-attempt timeout. rawChat's default is
          // 10 minutes, which means a hung upstream (the openresty 504s
          // sometimes hold the connection open instead of returning a
          // status) blocks the whole SSE stream for ~10 min before the
          // outer retry can fire. 90 s is enough for a healthy MiniMax
          // generation (longest observed: ~55 s for a 25-character bible)
          // but fails fast on a hanging gateway, so the 5/10/20 s backoffs
          // in the outer loop get a chance to recover.
          timeoutMs: 90_000,
          model: opts.model,
        });
        lastErr = undefined;
        break;
      } catch (e) {
        lastErr = e;
        if (!isTransientGatewayError(e) || attempt >= maxOuterRetries) {
          throw e;
        }
        // Exponential backoff: 5s, 10s, 20s — the openresty 504s typically
        // resolve in this window. Emit a progress event so the UI can show
        // "retrying..." instead of a silent pause.
        const backoff = 5000 * 2 ** attempt;
        await emit({ kind: 'llm-retry', attempt: attempt + 1, backoffMs: backoff, reason: extractErrorMessage(e).slice(0, 200) });
        await new Promise((r) => setTimeout(r, backoff));
        attempt++;
      }
    }
    // `patches` is assigned on the success branch above; this assert
    // exists only to satisfy TS's "used before assignment" check given
    // the unusual control flow.
    if (lastErr !== undefined) throw lastErr;
    if (patches === undefined) throw new Error('refreshBible: LLM call returned no patches without throwing');
    tokens = Array.isArray(patches) ? patches.length : 0;
    await emit({ kind: 'llm-done', tokens, durationMs: Date.now() - llmStart });
  } catch (e) {
    // JsonChatError carries the raw model output so the user can see what
    // the LLM actually said (truncation / "..." / empty body) instead of
    // a confusing "Unexpected end of JSON input".
    const msg = e instanceof JsonChatError
      ? e.message
      : extractErrorMessage(e);
    await emit({ kind: 'error', message: msg });
    // CRITICAL: still record the failure in BibleRefreshLog. Without this, a
    // failed chapter is left with NO log entry, so the UI shows it as
    // "not analyzed" and every subsequent run re-attempts it (and fails
    // again the same way). Marking it `failed` lets the status endpoint
    // display it correctly and the skip logic leave it alone until the
    // user explicitly forces a re-run.
    await writeRefreshLog(bookId, opts.chapterIndex, {
      appliedCount: 0, queuedCount: 0, conflictCount: 0, durationMs: Date.now() - t0,
      status: 'failed', lastError: msg.slice(0, 500),
    });
    return { patches: [], autoApplied: 0, queued: 0, conflicts: 0, durationMs: Date.now() - t0 };
  }
  if (!Array.isArray(patches) || patches.length === 0) {
    // Still record this run in the idempotency log — "saw this chapter,
    // found nothing new" is a legitimate outcome that the next call
    // shouldn't have to re-derive. Caller emits 'done' on resolve.
    await writeRefreshLog(bookId, opts.chapterIndex, {
      appliedCount: 0, queuedCount: 0, conflictCount: 0, durationMs: Date.now() - t0, status: 'applied',
    });
    return { patches: [], autoApplied: 0, queued: 0, conflicts: 0, durationMs: Date.now() - t0 };
  }

  // 3. Normalize names → ids before applying.
  await emit({ kind: 'applying', autoApplied: 0, queued: 0, conflicts: 0 });
  const normalized = await normalizePatches(bookId, patches);

  // 4. Apply or queue.
  let autoApplied = 0;
  let queued = 0;
  let conflicts = 0;
  for (const patch of normalized) {
    const { applied, isConflict } = await applyBiblePatch(bookId, patch, autoMerge);
    if (applied) autoApplied++;
    else queued++;
    if (isConflict) conflicts++;
  }

  // 4b. Re-classify roles from accumulated evidence. The LLM bible analysis
  //     does not emit a `role` for existing characters, so a protagonist who
  //     was first seen as `supporting` (the default) never gets promoted.
  //     recomputeCharacterRoles() promotes `supporting` → `main` when a
  //     character has both many appearances and many relationships. It is
  //     idempotent and never demotes a `main` the user set.
  try {
    await recomputeCharacterRoles(bookId);
  } catch { /* non-fatal — role is cosmetic */ }

  // 5. Write (or update) the idempotency log so the next call on the same
  //    chapter short-circuits. We log AFTER apply so a crash mid-run doesn't
  //    leave a 'success' entry that would suppress a retry.
  const durationMs = Date.now() - t0;
  await writeRefreshLog(bookId, opts.chapterIndex, {
    appliedCount: autoApplied,
    queuedCount: queued,
    conflictCount: conflicts,
    durationMs,
    status: 'applied',
  });

  // Don't emit 'done' from refreshBible() — the caller (HTTP route)
  // emits a single terminal 'done' once refreshBible() resolves.
  return { patches: normalized, autoApplied, queued, conflicts, durationMs };
}

/** Write a row to the BibleRefreshLog. Centralises the upsert so the empty-
 *  patches early-exit and the post-apply path use the same shape. Errors
 *  are warned but don't fail the user-visible refresh — the log is best-
 *  effort, the bible apply is the real work. */
async function writeRefreshLog(
  bookId: string,
  chapterIndex: number,
  args: { appliedCount: number; queuedCount: number; conflictCount: number; durationMs: number; status: string; lastError?: string | null },
): Promise<void> {
  try {
    await prisma.bibleRefreshLog.upsert({
      where: { bookId_chapterIndex: { bookId, chapterIndex } },
      create: {
        bookId,
        chapterIndex,
        version: 1,
        status: args.status,
        appliedCount: args.appliedCount,
        queuedCount: args.queuedCount,
        conflictCount: args.conflictCount,
        durationMs: args.durationMs,
        lastError: args.lastError ?? null,
      },
      update: {
        version: { increment: 1 },
        status: args.status,
        appliedCount: args.appliedCount,
        queuedCount: args.queuedCount,
        conflictCount: args.conflictCount,
        durationMs: args.durationMs,
        lastError: args.lastError ?? null,
      },
    });
  } catch (e) {
    console.warn('[character-bible] failed to write refresh log:', e instanceof Error ? e.message : e);
  }
}

// ── LLM input builders ───────────────────────────────────────────────────

function buildSystemPrompt(): string {
  // Vietnamese only — the model is being used on Vietnamese prose. Be very
  // strict about emitting JSON arrays (not objects) so the parser doesn't
  // mistake a top-level description for an outer envelope.
  return [
    'Bạn chuyên gia văn học Việt Nam. Nhiệm vụ: duy trì một "character bible"',
    '(từ điển nhân vật) cho một cuốn tiểu thuyết tiếng Việt.',
    '',
    'Đầu vào gồm: (1) bible hiện tại của cuốn sách (có thể trống), và',
    '(2) văn bản HTML của một hoặc vài chương mới. Bạn phải trả về JSON',
    'đúng schema, không thêm giải thích, không markdown, không nhận xét',
    'ngoài lề. Mọi thay đổi phải kèm `evidence_quote` (1-2 câu trích từ',
    'văn bản).',
    '',
    'QUY TẮC BẮT BUỘC:',
    '- Chỉ thêm nhân vật / mối quan hệ / lời nói khi có bằng chứng rõ ràng',
    '  trong chương vừa đọc. Không bịa.',
    '- Mỗi `evidence_quote` phải ngắn (<200 ký tự), trích nguyên văn, có',
    '  dấu nháy. Nếu không tìm được quote, BỎ QUA thay vì đoán.',
    // NEW ↓ — duplicate-char guard
    '- Tên nhân vật trong `update_target_name`, `from_name`, `to_name`, và',
    '  `character_name` PHẢI là một trong các tên trong "DANH SÁCH TÊN',
    '  CHUẨN" ở prompt phía dưới. KHÔNG được dùng biệt danh (alias). KHÔNG',
    '  đặt kind="new" cho một tên đã tồn tại trong danh sách đó. Nếu nghi',
    '  ngờ 2 tên cùng một người, đặt tên mới vào `aliases` của patch',
    '  kind="new" thay vì tạo nhân vật mới.',
    // NEW ↓ — alias / bí danh capture for cổ trang + hiện đại
    '- `aliases` (mảng) của patch kind="new" PHẢI chứa MỌI cách nhân vật đó',
    '  được gọi trong chương, để hệ thống gán giọng không bị lọt:',
    '  • Tên thật / tên tự / bí danh / hiệu (ví dụ: "Giang Hạo" có thể có',
    '    "Vệ Quốc Công" nếu đó là tước vị của hắn).',
    '  • Chức quan / tước vị / danh xưng chính thức (Công tước, Tướng quân,',
    '    Thái tử, Trưởng môn, sư phụ…) — chỉ khi danh xưng đó CHỈ chỉ mỗi',
    '    nhân vật này (không phải chức vụ chung của nhiều người).',
    '  • Cách nhân vật tự xưng hoặc được người khác gọi (xưng hô riêng).',
    '- TUY NHIÊN, KHÔNG đưa vào aliases các từ xưng hô chung của ngai vàng',
    '  mà bất kỳ vua/chúa nào cũng được gọi: "Bệ hạ", "trẫm", "hoàng thượng",',
    '  "thiên tử", "nữ hoàng", "đại vương"… — những từ này chỉ người đang',
    '  cầm quyền, không phải tên riêng của một nhân vật. Chỉ thêm vào aliases',
    '  khi có bằng chứng rõ ràng chương này gọi ĐÚNG nhân vật đó bằng từ đó',
    '  (vd: "Giang Hạo, Bệ hạ" — sai; "Nữ Đế Cơ Lạc Dao, Bệ hạ" — đúng cho',
    '  Nữ Đế, không phải Giang Hạo).',
    '- Mỗi alias phải đi kèm `evidence_quote` chứng minh chương gọi nhân vật',
    '  đó bằng alias đó. Nếu không chắc, BỎ QUA alias đó.',
    '- CẬP NHẬT description/personality/speech_style/visual_description',
    '  phải dựa trên thông tin MỚI từ chương này. KHÔNG lặp lại y nguyên',
    '  giá trị cũ — nếu không có gì mới, BỎ QUA patch update đó.',
    '- `visual_description` mô tả ngoại hình (1 câu, ≤60 từ, tiếng Anh):',
    '  giới tính, tuổi, tóc/mắt màu + kiểu, trang phục/trang sức/vũ khí',
    '  đặc trưng, tư thế. KHÔNG nêu tên. KHÔNG bịa — nếu văn bản không',
    '  mô tả thì ghi "unspecified". Field này dùng làm anchor cho ảnh minh',
    '  hoạ chương nên nhân vật phải mặc cùng trang phục giữa các chương.',
    '- Mối quan hệ phải là directed: từ A đến B (ví dụ: Linh là mẹ của',
    '  Lan → from_name=Linh, to_name=Lan, relationship="mother").',
    '- Nhãn `relationship` ưu tiên dạng snake_case_en (mother, father,',
    '  older_brother, mentor, ...). Nhãn tiếng Việt ("mẹ", "anh trai")',
    '  cũng được nhưng sẽ được chuẩn hoá.',
    '- Trường hợp nhân vật phụ xuất hiện 1 lần nhưng có vai trò rõ → dùng',
    '  kind="new", role="minor". Vai trò ẩn danh ("tiếng la", "người qua',
    '  đường") → role="crowd".',
    '',
    'OUTPUT: một JSON array. Mỗi phần tử là một patch theo schema dưới.',
    'Nếu chương không có gì mới, trả về mảng rỗng [].',
  ].join('\n');
}

function buildUserPrompt(input: {
  bible: CharacterBibleView;
  chapterText: string;
  chapterIndices: number[];
}): string {
  // FIX #5: nameById was populated only from the relationships loop (run
  // twice with the same effect — dead code at the second loop). Characters
  // with no relationships yet appeared in the prompt as `?id=abcd1234`,
  // and the LLM then had no way to know what to call them and invented a
  // `kind:'new'` patch. Now we pull from bible.characters (which the DB
  // layer just started returning) so EVERY Character has a name here.
  const nameById: Record<string, string> = {};
  for (const c of input.bible.characters) {
    nameById[c.id] = c.name;
  }
  // Belt-and-braces: fall back to relationship endpoints for any character
  // not in the roster (shouldn't happen but is defensive).
  for (const r of input.bible.relationships) {
    if (!nameById[r.fromCharId]) nameById[r.fromCharId] = r.fromCharName;
    if (!nameById[r.toCharId])   nameById[r.toCharId]   = r.toCharName;
  }

  // NEW: canonical-names cheat-sheet — the single biggest fix against
  // duplicate-character creation. The LLM sees the list and is contractually
  // forbidden from inventing a `kind:'new'` for any name that resolves to
  // an entry here.
  const canonicalSection = input.bible.characters.length === 0
    ? '(Chưa có nhân vật nào)'
    : input.bible.characters.map((c) => {
        const aliasSuffix = c.aliases.length > 0
          ? `  (aliases: ${c.aliases.join(', ')})`
          : '';
        return `- ${c.name}${aliasSuffix}`;
      }).join('\n');

  const profileSection = Object.entries(input.bible.profiles).length === 0
    ? '(Chưa có profile nào)'
    : Object.entries(input.bible.profiles).map(([charId, p]) => {
        const nm = nameById[charId] ?? `?id=${charId.slice(0, 8)}`;
        const fields = [
          p.description ? `description: ${truncate(p.description, 200)}` : null,
          p.personality ? `personality: ${truncate(p.personality, 150)}` : null,
          p.speechStyle ? `speech_style: ${truncate(p.speechStyle, 150)}` : null,
          p.visualDescription ? `visual_description: ${truncate(p.visualDescription, 200)}` : null,
          `source: ${p.source} | version: ${p.version}`,
        ].filter(Boolean).join('\n    ');
        return `- ${nm}\n    ${fields}`;
      }).join('\n');

  const relSection = input.bible.relationships.length === 0
    ? '(Chưa có quan hệ nào)'
    : input.bible.relationships.map((r) =>
        `- ${r.fromCharName} → ${r.toCharName}: ${r.relationship}` +
        (r.asOfChapterIdx != null ? ` (as of ch.${r.asOfChapterIdx})` : '') +
        (r.notes ? ` — ${truncate(r.notes, 120)}` : '')
      ).join('\n');

  const appearanceSection = Object.entries(input.bible.appearances).length === 0
    ? '(Chưa có appearance ledger nào)'
    : Object.entries(input.bible.appearances).map(([charId, perChapter]) => {
        const nm = nameById[charId] ?? `?id=${charId.slice(0, 8)}`;
        const chapters = Object.keys(perChapter).map((c) => `ch.${c}`).join(', ');
        return `- ${nm}: ${chapters}`;
      }).join('\n');

  const schemaSpec = [
    'SCHEMA — mỗi phần tử mảng là một patch:',
    '{',
    '  "kind": "new" | "update" | "relationship" | "appearance",',
    '  // new',
    '  "new_character": { "name": string, "aliases"?: string[], "gender"?: "male"|"female", "role"?: "main"|"supporting"|"minor"|"crowd" },',
    '  // update (chỉ truyền field muốn cập nhật)',
    '  "update_target_name": string, // tên trong DANH SÁCH TÊN CHUẨN',
    '  "update_fields": { "description"?: string, "personality"?: string, "speech_style"?: string, "visual_description"?: string },',
    '  // relationship',
    '  "from_name": string, // tên trong DANH SÁCH TÊN CHUẨN',
    '  "to_name": string,   // tên trong DANH SÁCH TÊN CHUẨN',
    '  "relationship": string, // mother | father | child | sibling | mentor | rival | lover | friend | enemy | colleague | …',
    '  "as_of_chapter_idx"?: number,',
    '  "notes"?: string,',
    '  // appearance',
    '  "character_name": string, // tên trong DANH SÁCH TÊN CHUẨN — BẮT BUỘC',
    '  "chapter_index": number,',
    '  // common — bắt buộc cho mọi patch',
    '  "evidence_quote": string // trích dẫn ngắn từ chương',
    '}',
  ].join('\n');

  return [
    'CHAPTER INDEX ĐANG XÉT: ' + input.chapterIndices.join(', '),
    '',
    '=== DANH SÁCH TÊN CHUẨN (canonical names cheat-sheet) ===',
    'Dùng CHÍNH XÁC các tên dưới đây cho mọi `*_name` field. Mỗi nhân vật',
    'chỉ được đại diện bởi MỘT tên trong danh sách này. Không tạo',
    '`kind:"new"` cho tên đã có. Không dùng biệt danh làm `update_target_name`.',
    canonicalSection,
    '',
    '=== CHARACTER BIBLE HIỆN TẠI ===',
    'Profiles:',
    profileSection,
    '',
    'Quan hệ:',
    relSection,
    '',
    'Xuất hiện:',
    appearanceSection,
    '',
    '=== CHƯƠNG MỚI ===',
    truncate(input.chapterText, 50_000),
    '',
    '=== YÊU CẦU ===',
    schemaSpec,
    '',
    'Trả về CHÍNH XÁC JSON array (mảng), không kèm giải thích.',
  ].join('\n');
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

// ── LLM-output shape (raw → sanitized → normalized) ──────────────────────

interface RawBiblePatch {
  kind?: 'new' | 'update' | 'relationship' | 'appearance';
  new_character?: {
    name?: string;
    aliases?: string[];
    gender?: 'male' | 'female';
    role?: 'main' | 'supporting' | 'minor' | 'crowd';
  };
  update_target_name?: string;
  update_fields?: {
    description?: string;
    personality?: string;
    speech_style?: string;
    visual_description?: string;
  };
  from_name?: string;
  to_name?: string;
  relationship?: string;
  as_of_chapter_idx?: number;
  notes?: string;
  // For kind='appearance' the LLM MUST now provide a character_name from
  // the canonical-names cheat-sheet. Without this we used to silently drop
  // appearance patches because there was no way to bind them to a row.
  character_name?: string;
  chapter_index?: number;
  evidence_quote?: string;
}

/** Stage 1: sanitize the LLM output BEFORE applying. Each raw patch either
 *  survives (with shape corrections), is converted to a different kind, or
 *  becomes a queueable "unknown-target" diff so the user can review it
 *  instead of silently losing the LLM's work.
 *
 *  Returns:
 *    { apply: RawBiblePatch[], queue: Array<{ reason; patch }> } */
function sanitizePatches(
  raw: RawBiblePatch[],
  nameToId: Record<string, string | null>,
): {
  apply: RawBiblePatch[];
  queue: Array<{ reason: string; patch: RawBiblePatch }>;
} {
  const apply: RawBiblePatch[] = [];
  const queue: Array<{ reason: string; patch: RawBiblePatch }> = [];
  for (const p of raw) {
    if (!p.kind) continue;
    const quote = (p.evidence_quote ?? '').trim();

    // Rule 1: every patch needs evidence. Without it the user can't verify
    //          the LLM's claim, so the patch goes to the review queue with
    //          a clear "no-evidence" tag rather than getting silently dropped
    //          (the previous behaviour was an unconditional `continue`).
    if (!quote || quote.length < 5) {
      queue.push({ reason: 'evidence-too-short-or-missing', patch: p });
      continue;
    }

    // Rule 2: kind="new" but the LLM used a name we already have. The whole
    //          point of the canonical names cheat-sheet is to prevent this.
    //          When it still happens (LLMs ignore instructions), convert to
    //          an "update with add-aliases" so no duplicate row appears.
    if (p.kind === 'new' && p.new_character?.name) {
      const name = p.new_character.name.trim();
      const existingId = nameToId[name] ?? null;
      if (existingId) {
        const aliases = (p.new_character.aliases ?? []).map((a) => a.trim()).filter(Boolean);
        if (aliases.length > 0) {
          // Convert: update kind with empty fields + an alias attach
          apply.push({
            ...p,
            kind: 'update',
            update_target_name: name,
            update_fields: {},
            new_character: { ...p.new_character, name, aliases },
          });
          continue;
        }
        // No aliases to attach either — this is just the LLM hallucinating
        // a duplicate; queue for user review.
        queue.push({ reason: 'new-character-already-exists', patch: p });
        continue;
      }
    }

    // Rule 3: kind="update" whose target doesn't resolve. Before, this
    //          silently dropped. Now it queues with a reason so the user
    //          can decide whether to apply to an existing character or
    //          rename it.
    if (p.kind === 'update' && p.update_target_name) {
      const targetName = p.update_target_name.trim();
      const charId = nameToId[targetName] ?? null;
      if (!charId) {
        queue.push({ reason: 'unknown-target-name', patch: p });
        continue;
      }
    }

    // Rule 4: kind="relationship" — canonicalize the label so "mother",
    //          "mẹ", "mẹ nuôi" all collapse to a single edge. Self-loops
    //          (from === to) get rejected.
    if (p.kind === 'relationship') {
      if (!p.from_name || !p.to_name || !p.relationship) {
        queue.push({ reason: 'relationship-missing-fields', patch: p });
        continue;
      }
      const from = p.from_name.trim();
      const to = p.to_name.trim();
      if (from.toLowerCase() === to.toLowerCase()) {
        queue.push({ reason: 'relationship-self-loop', patch: p });
        continue;
      }
      p.relationship = canonicalizeRelationship(p.relationship);
    }

    // Rule 5: kind="appearance" without character_name can't be linked to a
    //          row. Before this was silently dropped; now it's queued.
    if (p.kind === 'appearance') {
      if (!p.character_name) {
        queue.push({ reason: 'appearance-missing-character-name', patch: p });
        continue;
      }
      const charId = nameToId[p.character_name.trim()] ?? null;
      if (!charId) {
        queue.push({ reason: 'appearance-unknown-character', patch: p });
        continue;
      }
    }

    apply.push(p);
  }
  return { apply, queue };
}

/** Stage 2: convert sanitized raw patches into BibleDiffPatch rows with all
 *  names resolved to characterIds. */
async function normalizePatches(
  bookId: string,
  raw: RawBiblePatch[],
): Promise<BibleDiffPatch[]> {
  // Pre-resolve name→id for any characters referenced
  const allNames = new Set<string>();
  for (const p of raw) {
    if (p.kind === 'update' && p.update_target_name) allNames.add(p.update_target_name.trim());
    if (p.kind === 'relationship') {
      if (p.from_name) allNames.add(p.from_name.trim());
      if (p.to_name) allNames.add(p.to_name.trim());
    }
    if (p.kind === 'new' && p.new_character?.name) allNames.add(p.new_character.name.trim());
    if (p.kind === 'appearance' && p.character_name) allNames.add(p.character_name.trim());
  }
  const nameToId = await resolveCharacterIds(bookId, Array.from(allNames));

  // Stage 1 — sanitize. Anything that can't be safely applied becomes a
  // queueable diff instead of getting silently dropped (the previous behaviour
  // dropped "unknown-target" updates and "appearance-without-name" patches
  // without telling the user anything happened).
  const { apply, queue } = sanitizePatches(raw, nameToId);
  for (const q of queue) {
    // Preserve the original LLM-emitted name(s) so the apply path can
    // re-resolve a missing characterId later (e.g. when the target name
    // didn't exist at analysis time but does now, or when a name has a
    // typo that the user wants to fix). Without these, an Apply click
    // would 422 with "update-missing-target-or-fields" because the queued
    // diff's characterId is null. The UI also uses them to label the
    // queued diff ("Cập nhật: Vũ An Bang").
    const targetName =
      q.patch.kind === 'update' ? (q.patch.update_target_name ?? '').trim() || undefined :
      q.patch.kind === 'appearance' ? (q.patch.character_name ?? '').trim() || undefined :
      undefined;
    const fromName = q.patch.kind === 'relationship' ? (q.patch.from_name ?? '').trim() || undefined : undefined;
    const toName = q.patch.kind === 'relationship' ? (q.patch.to_name ?? '').trim() || undefined : undefined;
    await queueDiff(bookId, {
      kind: q.patch.kind === 'new' ? 'new' :
            q.patch.kind === 'update' ? 'update' :
            q.patch.kind === 'relationship' ? 'relationship' :
            'appearance',
      characterId: null,
      evidenceQuote: q.patch.evidence_quote ?? '',
      autoReason: q.reason.startsWith('new-character-already-exists')
        ? 'conflict-with-user-edit'
        : q.reason.startsWith('unknown-target') || q.reason.startsWith('appearance-unknown')
          ? 'conflict-with-user-edit'
          : q.reason.startsWith('evidence') || q.reason.startsWith('relationship-self-loop')
            ? 'conflict-with-user-edit'
            : 'conflict-with-user-edit',
      // The full raw patch body is preserved inside newCharacter so the UI
      // can show it verbatim without losing information.
      ...(q.patch.kind === 'new'
        ? { newCharacter: q.patch.new_character ? {
            name: q.patch.new_character.name ?? '',
            aliases: q.patch.new_character.aliases ?? [],
            gender: (q.patch.new_character.gender ?? null) as 'male' | 'female' | null,
            role: q.patch.new_character.role ?? 'supporting',
          } : undefined }
        : {}),
      ...(q.patch.kind === 'update'
        ? { updateFields: {
            description: q.patch.update_fields?.description,
            personality: q.patch.update_fields?.personality,
            speechStyle: q.patch.update_fields?.speech_style,
            visualDescription: q.patch.update_fields?.visual_description,
          }, relationship: undefined, targetName }
        : {}),
      ...(q.patch.kind === 'relationship'
        ? { relationship: { fromName, toName, relationship: q.patch.relationship ?? '' }, fromName, toName }
        : {}),
      ...(q.patch.kind === 'appearance'
        ? { targetName, appearance: {
            chapterIndex: typeof q.patch.chapter_index === 'number' ? q.patch.chapter_index : 0,
            mentions: 1,
          } }
        : {}),
      conflictWith: q.reason,
    } as BibleDiffPatch);
  }

  const out: BibleDiffPatch[] = [];
  for (const p of apply) {
    const quote = (p.evidence_quote ?? '').trim().slice(0, 300);
    if (p.kind === 'new') {
      const nc = p.new_character;
      const name = (nc?.name ?? '').trim();
      if (!name || !quote) continue;
      out.push({
        kind: 'new',
        characterId: null,
        newCharacter: {
          name,
          aliases: (nc?.aliases ?? []).map((a) => a.trim()).filter(Boolean),
          gender: (nc?.gender ?? null) as 'male' | 'female' | null,
          role: nc?.role ?? 'supporting',
        },
        evidenceQuote: quote,
        autoReason: 'new-character',
      });
      continue;
    }
    if (p.kind === 'update') {
      const targetName = (p.update_target_name ?? '').trim();
      const charId = targetName ? (nameToId[targetName] ?? null) : null;
      if (!charId) continue;
      const u = p.update_fields ?? {};
      const updateFields: BibleDiffPatch['updateFields'] = {};
      if (typeof u.description === 'string') updateFields.description = u.description;
      if (typeof u.personality === 'string') updateFields.personality = u.personality;
      if (typeof u.speech_style === 'string') updateFields.speechStyle = u.speech_style;
      if (typeof u.visual_description === 'string') updateFields.visualDescription = u.visual_description;
      if (Object.keys(updateFields).length === 0) {
        // The patch made it through sanitization but had no actual field
        // payload (e.g. it was a 'new-already-exists' conversion that
        // already absorbed the aliases). Nothing to apply.
        continue;
      }
      out.push({
        kind: 'update',
        characterId: charId,
        updateFields,
        evidenceQuote: quote,
        autoReason: 'replaces-existing-llm-field',
      });
      continue;
    }
    if (p.kind === 'relationship') {
      const from = (p.from_name ?? '').trim();
      const to = (p.to_name ?? '').trim();
      const rel = (p.relationship ?? '').trim();
      if (!from || !to || !rel) continue;
      out.push({
        kind: 'relationship',
        characterId: nameToId[from] ?? null,
        relationship: {
          fromCharId: nameToId[from] ?? undefined,
          toCharId: nameToId[to] ?? undefined,
          fromName: from,
          toName: to,
          relationship: rel,
          notes: p.notes,
          asOfChapterIdx: p.as_of_chapter_idx,
        },
        evidenceQuote: quote,
        autoReason: 'replaces-existing-llm-field',
      });
      continue;
    }
    if (p.kind === 'appearance') {
      const charName = (p.character_name ?? '').trim();
      const charId = nameToId[charName] ?? null;
      if (!charId) continue;
      out.push({
        kind: 'appearance',
        characterId: charId,
        appearance: {
          chapterIndex: p.chapter_index ?? 0,
          mentions: 1,
        },
        evidenceQuote: quote,
        autoReason: 'non-conflicting-update',
      });
      continue;
    }
  }
  return out;
}

// ── Apply a single normalized patch ──────────────────────────────────────

export interface ApplyResult { applied: boolean; isConflict: boolean; }

export async function applyBiblePatch(
  bookId: string,
  patch: BibleDiffPatch,
  autoMerge: boolean,
): Promise<ApplyResult> {
  // Common sanity check: patch must always carry an evidence quote.
  if (!patch.evidenceQuote) {
    // Treat as conflict — user must explicitly accept a quote-less patch.
    await queueDiff(bookId, { ...patch, autoReason: 'conflict-with-user-edit' });
    return { applied: false, isConflict: true };
  }

  // Manual refresh is review-only. The old implementation applied profile
  // and relationship patches before it looked at autoMerge, even though the
  // API promised that autoMerge=false writes only PendingBibleDiff rows.
  if (!autoMerge) {
    await queueDiff(bookId, { ...patch, autoReason: 'user-hold' });
    return { applied: false, isConflict: false };
  }

  if (patch.kind === 'new') {
    const nc = patch.newCharacter;
    if (!nc) return { applied: false, isConflict: false };
    if (autoMerge) {
      await ensureCharacter({
        bookId,
        name: nc.name,
        aliases: nc.aliases,
        gender: nc.gender ?? null,
        role: nc.role ?? 'supporting',
      });
      return { applied: true, isConflict: false };
    }
    return { applied: false, isConflict: false };
  }

  if (patch.kind === 'update') {
    if (!patch.characterId || !patch.updateFields) return { applied: false, isConflict: false };
    const { applied, skipped, conflicts } = await mergeLlmProfilePatch({
      characterId: patch.characterId,
      // Preserve absence. Converting an omitted field to null made a
      // description-only patch erase (or conflict with) personality and
      // speech style.
      description: patch.updateFields.description,
      personality: patch.updateFields.personality,
      speechStyle: patch.updateFields.speechStyle,
      visualDescription: patch.updateFields.visualDescription,
    });
    // Three buckets:
    //   1) Non-conflicting fields written → treat as applied
    //   2) User-locked fields → queue with conflict-with-user-edit
    //   3) LLM-on-LLM drift → queue with replaces-existing-llm-field
    //      (existing LLM value differs from the new value; the user
    //      should decide whether to keep the original or accept the new)
    if (conflicts.length > 0) {
      // Do NOT overwrite — queue so the user reviews the drift.
      await queueDiff(bookId, {
        ...patch,
        autoReason: 'replaces-existing-llm-field',
        conflictWith: conflicts.join(','),
      });
      return { applied: applied.length > 0, isConflict: true };
    }
    if (applied.length > 0) {
      return { applied: true, isConflict: false };
    }
    // No actually-new fields were written. If any were skipped (user-
    // locked), queue with conflict-with-user-edit; else the manual mode
    // wants to see it.
    const conflict = skipped.length > 0;
    if (conflict || !autoMerge) {
      await queueDiff(bookId, {
        ...patch,
        autoReason: 'conflict-with-user-edit',
        conflictWith: skipped.join(','),
      });
    }
    return { applied: false, isConflict: conflict };
  }

  if (patch.kind === 'relationship') {
    const r = patch.relationship;
    if (!r) return { applied: false, isConflict: false };
    // Sanitization in normalizePatches() already canonicalized the
    // relationship label (mother / mẹ / mẹ nuôi → mother). Re-canonicalize
    // here as a belt-and-braces guard against patches arriving from queues
    // or external callers.
    const canonicalRel = canonicalizeRelationship(r.relationship);
    // May need to create one or both endpoints when the LLM introduced a
    // new character as part of the same patch. Resolve names now.
    let fromId = r.fromCharId ?? null;
    let toId = r.toCharId ?? null;
    if (!fromId && r.fromName) {
      const ensured = await ensureCharacter({
        bookId, name: r.fromName, role: 'supporting',
      });
      fromId = ensured.id;
    }
    if (!toId && r.toName) {
      const ensured = await ensureCharacter({
        bookId, name: r.toName, role: 'supporting',
      });
      toId = ensured.id;
    }
    if (!fromId || !toId) return { applied: false, isConflict: false };
    const result = await addOrUpdateRelationship({
      bookId,
      fromCharId: fromId,
      toCharId: toId,
      relationship: canonicalRel,
      asOfChapterIdx: r.asOfChapterIdx ?? null,
      notes: r.notes ?? null,
      source: 'llm',
      // FIX #3 (source-sacred leak): the previous code passed
      // `force: !autoMerge` here, which meant manual refresh (autoMerge=false)
      // SILENTLY overwrote user-edited relationship edges. The whole
      // source-sacred rule is supposed to forbid that. Both auto-merge and
      // manual refresh now obey it: a user-locked row always queues.
      force: false,
    });
    if (result.updated) return { applied: true, isConflict: false };
    // refused because of a user-locked row
    await queueDiff(bookId, {
      ...patch,
      relationship: { ...r, relationship: canonicalRel, fromCharId: fromId, toCharId: toId },
      autoReason: 'conflict-with-user-edit',
      conflictWith: 'relationship.source=user',
    });
    return { applied: false, isConflict: true };
  }

  if (patch.kind === 'appearance') {
    if (!patch.appearance) return { applied: false, isConflict: false };
    if (!patch.characterId) return { applied: false, isConflict: false };
    if (autoMerge) {
      const cs = await prisma.character.findUnique({ where: { id: patch.characterId } });
      if (!cs) return { applied: false, isConflict: false };
      // Idempotency: recordAppearances() always increments; the next-pass
      // BibleRefreshLog check in refreshBible() short-circuits second runs,
      // so this won't double-count when the user clicks refresh twice on
      // the same chapter (it'll see "already applied, skip").
      await recordAppearances({
        bookId, chapterIndex: patch.appearance.chapterIndex, names: [cs.name],
      });
      return { applied: true, isConflict: false };
    }
    return { applied: false, isConflict: false };
  }

  return { applied: false, isConflict: false };
}

/** Apply a list of patches in sequence; used by the manual apply route. */
export async function applyBiblePatches(
  bookId: string,
  patches: BibleDiffPatch[],
  autoMerge: boolean,
): Promise<{ applied: number; queued: number; conflicts: number }> {
  let applied = 0, queued = 0, conflicts = 0;
  for (const patch of patches) {
    const r = await applyBiblePatch(bookId, patch, autoMerge);
    if (r.applied) applied++;
    else queued++;
    if (r.isConflict) conflicts++;
  }
  return { applied, queued, conflicts };
}

/** Manually set a single profile field — always source='user'. Used by
 *  the PATCH /characters/[id]/profile endpoint. */
export async function setUserProfile(args: {
  characterId: string;
  description?: string | null;
  personality?: string | null;
  speechStyle?: string | null;
  visualDescription?: string | null;
}): Promise<void> {
  const fieldSources: Partial<Record<
    'description' | 'personality' | 'speechStyle' | 'visualDescription',
    'user'
  >> = {};
  for (const field of ['description', 'personality', 'speechStyle', 'visualDescription'] as const) {
    if (args[field] !== undefined) fieldSources[field] = 'user';
  }
  await setProfile({
    characterId: args.characterId,
    description: args.description,
    personality: args.personality,
    speechStyle: args.speechStyle,
    visualDescription: args.visualDescription,
    source: 'user',
    fieldSources,
    force: true,
  });
}

/** Apply a diff the user explicitly accepted.
 *
 * This is intentionally separate from `applyBiblePatch(autoMerge=false)`:
 * the latter means "preview/queue only", while this function means "commit
 * and make the accepted values user-authoritative". Both single-apply and
 * bulk-apply routes use this path so a status can never be flipped to
 * `applied` without actually mutating the bible.
 */

/** Best-effort name hint from an evidence snippet for legacy diffs queued
 *  before `targetName` was stored. The snippet almost always starts with
 *  the character name followed by a verb in Vietnamese ("Vũ An Bang là
 *  một tráng hán..."), or "Người của X mặc..." (member of X). We grab the
 *  first noun-like phrase before "là", "mặc", or "thấy". Returns null when
 *  no confident guess can be made — caller falls back to "no resolution".
 *  This is intentionally narrow (1 helper call, no DB) so it can be used
 *  inline during apply without blocking the SSE. */
function extractNameFromEvidence(evidence: string): string | null {
  if (!evidence) return null;
  // The first sentence usually contains the name; cut at common Vietnamese
  // verbs that follow a subject noun phrase.
  const m = evidence.match(/^\s*([^,.;:()\n]+?)\s*(?:là|mặc|thấy|có|đứng|ngồi|nói|hỏi|cầm|mang|bước|vung|cảm)/i);
  if (!m) return null;
  const candidate = m[1].trim().replace(/^["'"\u201C\u201D]+|["'"\u201C\u201D]+$/g, '');
  // The helper phrases "Người của X" → strip the "Người của" prefix and
  // take what's left as the character's group affiliation (still better
  // than null and lets the user rename via the Edit dialog).
  if (/^người\s+của\s+/i.test(candidate)) {
    return candidate.replace(/^người\s+của\s+/i, '').trim();
  }
  // Reject very short or stop-word-only candidates.
  if (candidate.length < 2 || /^(và|hoặc|nhưng|rồi|thì|mà|của|trong|ngoài)$/i.test(candidate)) {
    return null;
  }
  return candidate;
}

export async function applyAcceptedBiblePatch(
  bookId: string,
  patch: BibleDiffPatch,
): Promise<{ applied: boolean; reason?: string }> {
  if (patch.kind === 'new') {
    if (!patch.newCharacter?.name.trim()) return { applied: false, reason: 'new-character-missing-name' };
    await ensureCharacter({
      bookId,
      name: patch.newCharacter.name.trim(),
      aliases: patch.newCharacter.aliases,
      gender: patch.newCharacter.gender ?? null,
      role: patch.newCharacter.role ?? 'supporting',
    });
    return { applied: true };
  }

  if (patch.kind === 'update') {
    if (!patch.updateFields || Object.keys(patch.updateFields).length === 0) {
      return { applied: false, reason: 'update-missing-target-or-fields' };
    }
    // 2026-09-02: queued update diffs frequently have characterId=null
    // because they were queued at analysis time when the LLM's
    // update_target_name didn't resolve to any existing character (e.g. a
    // new character introduced in the same chapter). When the user later
    // accepts the "Apply" (Ghi đè), we must NOT just 422 — we should
    // try to recover the target. Resolution order:
    //   1. Use the embedded characterId if it's still in this book.
    //   2. Otherwise re-resolve by targetName against the current book.
    //   3. Otherwise extract a name hint from the evidence quote
    //      (the first quoted phrase is usually the character name) so
    //      legacy diffs queued before this fix can also be applied.
    //   4. Otherwise auto-create the character (the diff effectively
    //      doubles as a new-character proposal — the user's "Ghi đè"
    //      click should be honoured).
    let characterId = patch.characterId;
    if (characterId) {
      const found = await prisma.character.findFirst({
        where: { id: characterId, bookId },
        select: { id: true },
      });
      if (!found) characterId = null;
    }
    let resolvedTargetName: string | null = (patch.targetName ?? '').trim() || null;
    if (!characterId && resolvedTargetName) {
      characterId = await findCharacterIdByName(bookId, resolvedTargetName);
    }
    if (!characterId && !resolvedTargetName) {
      const guessed = extractNameFromEvidence(patch.evidenceQuote ?? '');
      if (guessed) {
        resolvedTargetName = guessed;
        characterId = await findCharacterIdByName(bookId, guessed);
      }
    }
    if (!characterId && resolvedTargetName) {
      const created = await ensureCharacter({
        bookId,
        name: resolvedTargetName,
        role: 'supporting',
      });
      characterId = created.id;
    }
    if (!characterId) {
      return { applied: false, reason: 'update-missing-target-or-fields' };
    }
    const fields = patch.updateFields;
    const fieldSources: Partial<Record<
      'description' | 'personality' | 'speechStyle' | 'visualDescription',
      'user'
    >> = {};
    for (const field of ['description', 'personality', 'speechStyle', 'visualDescription'] as const) {
      if (fields[field] !== undefined) fieldSources[field] = 'user';
    }
    await setProfile({
      characterId,
      description: fields.description,
      personality: fields.personality,
      speechStyle: fields.speechStyle,
      visualDescription: fields.visualDescription,
      source: 'user',
      fieldSources,
      force: true,
    });
    return { applied: true };
  }

  if (patch.kind === 'relationship') {
    const rel = patch.relationship;
    if (!rel?.relationship) return { applied: false, reason: 'relationship-missing-label' };
    let fromId = rel.fromCharId ?? null;
    let toId = rel.toCharId ?? null;
    // 2026-09-02: queued relationship diffs preserve fromName/toName
    // when they were queued without resolved ids, so re-resolve here.
    if (!fromId && (rel.fromName ?? patch.fromName)) {
      const name = (rel.fromName ?? patch.fromName ?? '').trim();
      fromId = await findCharacterIdByName(bookId, name)
        ?? (await ensureCharacter({ bookId, name, role: 'supporting' })).id;
    }
    if (!toId && (rel.toName ?? patch.toName)) {
      const name = (rel.toName ?? patch.toName ?? '').trim();
      toId = await findCharacterIdByName(bookId, name)
        ?? (await ensureCharacter({ bookId, name, role: 'supporting' })).id;
    }
    if (!fromId || !toId || fromId === toId) {
      return { applied: false, reason: 'relationship-invalid-endpoints' };
    }
    const endpointCount = await prisma.character.count({
      where: { bookId, id: { in: [fromId, toId] } },
    });
    if (endpointCount !== 2) return { applied: false, reason: 'relationship-endpoint-not-in-book' };
    await addOrUpdateRelationship({
      bookId,
      fromCharId: fromId,
      toCharId: toId,
      relationship: canonicalizeRelationship(rel.relationship),
      asOfChapterIdx: rel.asOfChapterIdx ?? null,
      notes: rel.notes ?? null,
      source: 'user',
      force: true,
    });
    return { applied: true };
  }

  if (patch.kind === 'appearance') {
    let chapterIndex = patch.appearance?.chapterIndex;
    let mentions = patch.appearance?.mentions ?? 1;
    if (typeof chapterIndex !== 'number' || chapterIndex < 0) {
      // Legacy diffs queued before appearance{chapterIndex,mentions} was
      // preserved have no appearance field. Infer chapterIndex from the
      // queued context — the diff was created during a chapter refresh, but
      // we don't have that context here. Fall back to chapterIndex=0 so
      // the user can still increment the appearance ledger; the Edit
      // dialog can correct it after.
      chapterIndex = 0;
      mentions = 1;
    }
    let characterId = patch.characterId;
    let characterName: string | null = null;
    if (characterId) {
      const found = await prisma.character.findFirst({
        where: { id: characterId, bookId },
        select: { name: true },
      });
      if (found) characterName = found.name;
      else characterId = null;
    }
    if (!characterId && patch.targetName) {
      const name = patch.targetName.trim();
      const foundId = await findCharacterIdByName(bookId, name);
      if (foundId) {
        characterId = foundId;
        const c = await prisma.character.findFirst({ where: { id: foundId }, select: { name: true } });
        characterName = c?.name ?? name;
      } else {
        const created = await ensureCharacter({ bookId, name, role: 'supporting' });
        characterId = created.id;
        characterName = name;
      }
    }
    if (!characterId && !characterName) {
      // Try extracting a name from the evidence quote (legacy fallback).
      const guessed = extractNameFromEvidence(patch.evidenceQuote ?? '');
      if (guessed) {
        const foundId = await findCharacterIdByName(bookId, guessed);
        if (foundId) {
          characterId = foundId;
          const c = await prisma.character.findFirst({ where: { id: foundId }, select: { name: true } });
          characterName = c?.name ?? guessed;
        } else {
          const created = await ensureCharacter({ bookId, name: guessed, role: 'supporting' });
          characterId = created.id;
          characterName = guessed;
        }
      }
    }
    if (!characterId || !characterName) {
      return { applied: false, reason: 'appearance-missing-target' };
    }
    await recordAppearances({
      bookId,
      chapterIndex,
      names: [characterName],
    });
    return { applied: true };
  }

  return { applied: false, reason: 'unsupported-patch-kind' };
}

// ── Chapter text fetching ────────────────────────────────────────────────

async function fetchChapterInputs(
  bookId: string,
  chapterIndex: number,
  chapterFile: string | null,
  maxChars: number,
): Promise<Array<{ chapterIndex: number; chapterFile: string; text: string }>> {
  if (!Number.isInteger(chapterIndex) || chapterIndex < 0) {
    throw new Error(`fetchChapterInputs: chapterIndex must be a non-negative integer (got ${chapterIndex})`);
  }
  const book = await prisma.book.findUnique({ where: { id: bookId } });
  if (!book?.filePath) return [];
  // Lazy import — the LLM module is in /src/lib/ai, parseEpub lives under
  // /src/lib/pipeline/epub-parser.ts and is platform-Node only. Loading it
  // at module-init time would break SSR for any page that imports the AI
  // helper (none today, but future-proofing).
  const { parseEpub } = await import('@/lib/pipeline/epub-parser');
  const { readDeepFormatSidecar } = await import('@/lib/pipeline/deep-format-sidecar');

  const fs = await import('node:fs/promises');
  const { resolveBookPath } = await import('@/lib/storage');
  const bookPath = await resolveBookPath(book);
  let pathExists = false;
  try { await fs.access(bookPath); pathExists = true; } catch { pathExists = false; }
  if (!pathExists) return [];

  // ── Fast path: deep-format sidecar ─────────────────────────────
  // When the conversion ran with deepFormat=true the worker persisted a
  // JSON sidecar next to the final EPUB containing the AI-cleaned
  // chapter text. Reading from the sidecar (a) avoids re-parsing the
  // whole EPUB and (b) feeds the bible LLM the SAME text the user sees
  // in their reader — so character mentions and dialogue attribution
  // line up exactly with the prose being analyzed. Falls back to the
  // raw parseEpub() path when the sidecar is missing (old books, books
  // converted without deepFormat, or after a sidecar wipe).
  try {
    const sidecar = await readDeepFormatSidecar({ epubPath: bookPath, bookId });
    if (sidecar && sidecar.chapters.length > 0) {
      const match = sidecar.chapters.find((c) => c.index === chapterIndex);
      if (match) {
        return [{
          chapterIndex: match.index,
          chapterFile: chapterFile ?? `chapter-${match.index}`,
          text: match.text.slice(0, maxChars),
        }];
      }
      // Sidecar exists but doesn't have this chapter index — could
      // happen if the user re-ordered the EPUB after conversion.
      // Fall through to the slow path.
    }
  } catch (err) {
    // Sidecar read failures are non-fatal — we just fall back to the
    // raw EPUB parse below. Log at debug level so a corrupted sidecar
    // doesn't spam warnings, but it's visible in the job logs if the
    // operator wants to investigate.
    if (process.env.DEBUG_BIBLE_SIDECAR) {
      console.warn('[fetchChapterInputs] sidecar read failed, falling back:', err);
    }
  }

  const epub = await parseEpub(bookPath);
  const candidates: Array<{ idx: number; file: string }> = [];
  // Per-chapter only — whole-novel scans are deliberately not supported.
  if (chapterFile) {
    candidates.push({ idx: chapterIndex, file: chapterFile });
  } else {
    const file = epub.htmlFiles[chapterIndex];
    if (!file) return [];
    candidates.push({ idx: chapterIndex, file });
  }
  const out: Array<{ chapterIndex: number; chapterFile: string; text: string }> = [];
  for (const c of candidates) {
    const entry = epub.entries.get(c.file);
    if (!entry) continue;
    const html = entry.data.toString('utf-8');
    const cleaned = stripHtml(html).slice(0, maxChars);
    out.push({ chapterIndex: c.idx, chapterFile: c.file, text: cleaned });
  }
  return out;
}

/** Replace common HTML structures with whitespace so the LLM sees prose.
 *  We deliberately KEEP tag boundaries (newline) so the LLM has paragraph
 *  separation, but strip everything inside <script>, <style>, <head>, and
 *  the body of <figure>/<aside>. */
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    // Convert block-level tags to newlines so paragraphs stay separated.
    .replace(/<\/(p|div|section|h[1-6]|li|br)>/gi, '\n')
    // Strip remaining tags.
    .replace(/<[^>]+>/g, '')
    // Decode common entities.
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/** True if an error from the LLM stack is a transient gateway/upstream
 *  failure that the outer retry loop should attempt again. We DO NOT
 *  retry:
 *    - 4xx other than 408/429 (auth, billing, format errors)
 *    - JsonChatError (model returned unparseable JSON — retrying without
 *      changing anything will hit the same parse error)
 *    - generic Error whose message doesn't match a known transient shape
 *  We DO retry:
 *    - 502/503/504 (bad gateway / unavailable / gateway timeout)
 *    - 408 (request timeout)
 *    - 429 (rate limit — usually transient)
 *    - "AI returned empty response" (model dropped the connection)
 *    - "AbortError" / fetch-failed (network drop) */
function isTransientGatewayError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  if (!msg) return false;
  // JsonChatError and parse failures are model-side — retrying won't help.
  if (e && typeof e === 'object' && 'name' in e && (e as { name: string }).name === 'JsonChatError') return false;
  // Detect retryable HTTP status codes regardless of where they appear in
  // the message (rawChat formats them as `AI <status>: <body>`).
  if (/\bAI (?:502|503|504|408|429)\b/.test(msg)) return true;
  // Empty response and aborted fetches (timeout / network drop).
  if (/AI returned empty response/i.test(msg)) return true;
  if (/AbortError|aborted|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up/i.test(msg)) return true;
  // 504 page-style HTML leakage (openresty default page).
  if (/504 Gateway Time-out|<title>504/.test(msg)) return true;
  return false;
}

export { type ProfileSource };
