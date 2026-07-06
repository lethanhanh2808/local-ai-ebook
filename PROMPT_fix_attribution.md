# PROMPT — Fix Vietnamese speaker attribution misattributions in `Local-AI`

> Copy-paste the whole block below into your AI (Cursor, Copilot, Claude Code, etc).
> The block ends at the line marked `=== END PROMPT ===`.

---

## Repository & context

Repo root: **/Volumes/EXT-SSD/Users/anhl/Local-AI**.
This is a local-first Vietnamese-novel-to-audiobook pipeline built on Next.js (TypeScript) + Python FastAPI TTS backends + an optional VnCoreNLP parser sidecar + an oMLX-served local LLM.

**Read these four files first** before doing anything — they are the ground truth:

1. `/Volumes/EXT-SSD/Users/anhl/Local-AI/How_voice_recogized.md` — initial reverse engineering of the entire voice pipeline (architecture, dialogue extraction, speaker attribution, character tracking, voice assignment, emotion, TTS, memory, LLM usage).
2. `/Volumes/EXT-SSD/Users/anhl/Local-AI/How_voice_recogized_RE_EVALUATION.md` — re-evaluation after the recent `attributeByConversation` stateful fusion was added.
3. `/Volumes/EXT-SSD/Users/anhl/Local-AI/ACTION_ITEMS.md` — VnCoreNLP value investigation (concluded: the parser contributes 0 attributable rows in practice because of 3 separate bugs in `lib/attribution.ts`).
4. `/Volumes/EXT-SSD/Users/anhl/Local-AI/ACTION_ITEMS_V2.md` — **THIS PROMPT'S HOME BASE.** Detailed chapter-level misattribution inventory and fix recommendations for the stateful conversation layer.

The four files together are the complete specification of what to fix.

---

## Files you will be editing

Primary:
- `app/ebook-converter/src/lib/attribution.ts` — main attribution engine (the only large file you'll touch)
- `app/ebook-converter/src/lib/db/chapter-attribution.ts` — cache row schema + type enums
- `app/ebook-converter/src/components/library/VoiceDebugPanel.tsx` — debug UI
- `app/ebook-converter/src/tests/attribution.test.ts` — vitest tests (add new tests here)
- `app/ebook-converter/e2e/05-attribution.spec.ts` — playwright smoke test

Secondary (read-only unless you find a bug):
- `app/ebook-converter/src/components/library/EbookReader.tsx`
- `app/ebook-converter/src/components/library/VoicePanel.tsx`
- `app/ebook-converter/src/app/api/library/[id]/chapters/[chapterId]/attribute/route.ts`
- `app/ebook-converter/src/app/api/library/[id]/chapters/[chapterId]/attribute/analyze/route.ts`
- `app/ebook-converter/prisma/schema.prisma`

DO NOT TOUCH (out of scope for this task, will break unrelated systems):
- `app/tts-service/audiobook_generator.py` and any `vncorenlp_attribution.py` — Python side has its own engine
- `app/tts-service/server.py`, `unified_server.py`, `vieneu_server.py` — TTS pipeline
- `app/ebook-converter/src/lib/ai/voice-selector.ts` — voice assignment
- Any file in `app/tts-service/VieNeu-TTS/` or `app/tts-service/MOSS-TTS-Nano/` — vendored models

---

## Three root causes of the misattribution

You must fix all three. They come from a single observed chapter (Chương 3 of a Vietnamese web-novel) where 18–22 of 81 attributed paragraphs (≈22–27 %) are wrong.

### Root cause A — `history` evidence weight bleeds onto wrong turn in ping-pong dialogue

In `app/ebook-converter/src/lib/attribution.ts`, the scoring in `attributeByConversation()` is:

```ts
// Current scoring (paraphrased, around lines 1167–1200)
if (implicitTurn && state.currentSpeaker) {
  ...
  if (activeNames.length === 2 && otherActive.length === 1) {
    addScore(scores, other, previousPrevious === other ? 0.5 : 0.45, { source: 'history', ... });
    addScore(scores, state.currentSpeaker, 0.08, { source: 'history', ... });
  } else {
    addScore(scores, state.currentSpeaker, 0.38, { source: 'history', ... });
  }
}
```

When two characters alternate (e.g. Long↔Ưu Nhi or Nhâm↔Ưu Nhi ping-pong), `state.currentSpeaker` is the previous speaker, so every other turn lands on the wrong speaker with weight 0.38 (or 0.45). The lexical evidence from `timeline`, `pronoun`, `presence` is in the 0.10–0.16 range and gets drowned.

**Concrete fix — phase 1, mandatory.** Add an `alternationStrength` calculation and a `historyMultiplier` somewhere before the `if (implicitTurn && state.currentSpeaker)` branch (around line 1167), and multiply every `history` weight by it:

```ts
// inside attributeByConversation, just before the implicitTurn branch
const alternationStrength =
  state.dialogueHistory.length >= 2 &&
  state.dialogueHistory.at(-2)?.speaker !== state.dialogueHistory.at(-1)?.speaker
    ? 1.0 : 0.0;
const historyMultiplier = alternationStrength > 0 ? 0.55 : 1.0;
```

Then in the `if (implicitTurn && state.currentSpeaker)` branch, multiply every numeric weight in `addScore(... { source: 'history', ... })` by `historyMultiplier`.

### Root cause B — vocative `"Anh"` / `"Cô"` mis-read as a subject pronoun

`resolvePronounFromState()` (around line 973–1011) uses regex pattern:

```ts
const pronounRe = new RegExp(
  `(?:^|(?<=[,。.!?:；。、…—\\-–"'“”]))\\s*`
  + `(${FEMALE_PRONOUN_TEXT}|${MALE_PRONOUN_TEXT})`
  + `(?:\\s+[^,。.!?"'“”「」『』]{0,70})?`
  + `(?:${TEXT_SPEECH_VERBS}|${TEXT_ACTION_VERBS})`,
  'iu',
);
```

It doesn't distinguish "Anh" as a **vocative** ("hey you", addressing someone, used at quote-start by Ưu Nhi addressing Nhâm Thiếu Hoài) from "Anh" as a **subject** (used in narration "Anh đánh nhẹ cô"). This makes ping-pong dialogue like `"Anh......"` and `"Anh, anh bày ra cái bộ dáng quái dị này..."` get attributed to the addressed male character (Nhâm / Long) instead of the speaker (Ưu Nhi).

**Concrete fix — phase 1, mandatory.** In `resolvePronounFromState()` after `pronounRe.exec(text)` succeeds, check whether the pronoun is a vocative:

```ts
const m = pronounRe.exec(text);
if (!m) return null;

// Vocative guard: if the pronoun is at the start of a quote-like fragment
// (no verbs before it within 30 chars), it's a vocative, not a subject.
const pronounStart = m.index + m[0].indexOf(m[1] ?? '');
const preceding = text.slice(Math.max(0, pronounStart - 30), pronounStart);
const hasPrecedingVerb = new RegExp(
  `(?:${TEXT_SPEECH_VERBS}|${TEXT_ACTION_VERBS})`,
  'i',
).test(preceding);
if (!hasPrecedingVerb) {
  const trailing = text.slice(pronounStart, pronounStart + 80);
  // If the line ends in punctuation/ellipsis OR contains no verb within 70 chars,
  // it's a vocative ("Anh...", "Cô ơi...") — don't resolve.
  if (/[,….\-—:!?]+\s*$/.test(trailing)) return null;
}
```

### Root cause C — `Y Đằng Chân Lí Tử` not in `Character` table → fuzzy fallback mis-attribution

She appears 4+ times in this chapter but is not in the `Character` row table. The fusion layer has to fall back to the closest prefix-match: "Y Đằng Chân Lí Tử" → "Y Đằng Ưu Nhi" / "Y Đằng Long" → misattributions #126, #135, #138.

**Concrete fix — phase 1+2, mandatory.** Add a new `AttributionSource` enum value `'unresolved-actor'` for "we know someone is speaking but they aren't in the roster." When `attributeByConversation` cannot resolve any speaker but `roles.actor` is set (i.e. we detected a name doing an action), emit a ghost row instead of skipping or fuzzy-matching.

In `app/ebook-converter/src/lib/db/chapter-attribution.ts`:

```ts
export type AttributionSource =
  | 'parser'
  | 'regex'
  | 'llm'
  | 'conversation'
  | 'unresolved-actor'   // NEW
  | 'default';
```

In `app/ebook-converter/src/lib/attribution.ts`, in `attributeByConversation()` at the bottom (where you currently emit `out[paragraph.index] = { speaker: null, confidence: 0.2, source: 'parser' }` for unresolved parser), add a sibling fallback that fires when `!speaker_name && roles.actor`:

```ts
// Existing branch keeps as-is. Add just below it:
else if (roles.actor) {
  // Heuristic: we detected a named actor that isn't in the canonical roster.
  // Tag for UI review instead of fuzzy-matching to a wrong name.
  out[paragraph.index] = {
    speaker: null,
    confidence: 0.0,
    source: 'unresolved-actor',
    reason: `Detected "${roles.actor}" as named actor but not in character roster`,
    evidence: [{
      source: 'timeline',
      speaker: roles.actor,
      weight: 0.36,
      detail: `unresolved actor "${roles.actor}" — likely a character missing from the roster`,
    }],
    sceneId: state.sceneId,
    state: snapshotState(state),
  };
}
```

In `app/ebook-converter/src/components/library/VoiceDebugPanel.tsx` add the new source to `SOURCE_BADGE` map with a teal/amber colour (something distinct from `parser`, `regex`, `llm`, `conversation`).

---

## Phase 1 — minimum viable fix (≈ 80 minutes, addresses ~14 of the 22 misattributions)

Do these **in order**, with a `npx tsc --noEmit` + `npm test` after every step:

### Step 1.1 — RC-A: alternation-aware history multiplier (~15 min)

1. Open `app/ebook-converter/src/lib/attribution.ts`.
2. Locate the `if (implicitTurn && state.currentSpeaker) { ... }` block inside `attributeByConversation()` (around line 1169).
3. Implement RC-A as shown above (alternationStrength + historyMultiplier).
4. Make sure the multiplier is **applied only** to the `addScore(... { source: 'history', ... })` calls — not to `presence`, `pronoun`, `timeline`, or `scene`.
5. Update `lib/attribution.ts:1311` (the `conversationHits` counter) is unaffected.

### Step 1.2 — RC-B: vocative guard in `resolvePronounFromState` (~15 min)

1. In the same file, locate `resolvePronounFromState()` (around line 973).
2. Implement the vocative guard as shown above.
3. Keep the existing `FEMALE_PRONOUN_TEXT` / `MALE_PRONOUN_TEXT` / `TEXT_SPEECH_VERBS` / `TEXT_ACTION_VERBS` constants available (they are already defined at file scope).

### Step 1.3 — RC-C: emit `unresolved-actor` rows (~30 min)

1. Update `chapter-attribution.ts`: add `'unresolved-actor'` to the `AttributionSource` union.
2. Update `attribution.ts`'s `attributeByConversation()` to emit ghost rows as described above.
3. Add `'unresolved-actor'` to `VoiceDebugPanel.tsx`'s `SOURCE_BADGE` map.
4. If `sourceForBucket()` enumerates explicit sources (it does — `parser | regex | llm`), it should ignore `'unresolved-actor'` and keep emitting as-is; verify the existing function does not regress.

### Step 1.4 — UI one-time fix (~ 2 min, user does this, not you)

Tell the user: "Re-run AI Character Detection on this chapter (VoicePanel → Wand2) to register `Y Đằng Chân Lí Tử` and any other missing characters." You cannot do this in code — it's a one-time UI action to seed the DB. Document it in the commit message.

### Step 1.5 — `H1` debug visibility (~30 min)

In `VoiceDebugPanel.tsx`, in the render block that shows `evidence[]`, add a sub-row that surfaces the **top-3 evidence items with the snippet context** (5 chars before/after each character mention), so the user can verify in one click whether the timeline/pronoun signal lined up.

---

## Phase 2 — measure on real corpus (~ 1 hour, MANDATORY)

After Phase 1 ships, write a small script that runs `attributeByConversation` on the same chapter text the misattribution table in `ACTION_ITEMS_V2.md` lists, and reports:

- per-source hit count (parser, regex, llm, conversation, unresolved-actor)
- count of paragraphs where `state.currentSpeaker ≠ paragraph.evidence[0]` in the 11 ping-pong cases
- count of paragraphs where `roles.actor ≠ state.currentSpeaker` (signal disagreement metric)

Save it as `scripts/measure-attribution.ts` (use tsx to run it; it should not need Next.js context).

Acceptance criterion:

> For the 22 paragraphs listed in `ACTION_ITEMS_V2.md` §1.1–§1.3, ≥ 14 must now resolve to the correct speaker.

If fewer than 14 are fixed, return the diff and a summary; do NOT auto-retry without understanding why.

---

## Phase 3 — secondary fixes (~ 1–2 hours, OPTIONAL)

Only start Phase 3 after Phase 2 acceptance:

- **E2** — Reduce `scene` weight when contradicting lexical signal is present. (10 min)
- **G4** — Real-time detect unregistered character names from the chapter text via `g2pMatch` against known aliases and propose additions. (2-3 days)
- **H2** — Per-character `misattributionRate` in VoicePanel summary. (½ day)

Ask first before doing these.

---

## Forbidden actions (will cause regressions if you do them)

1. ❌ **Do not remove VnCoreNLP.** Keep the parser container. Only ship the parser-contributes-0-rows fixes from `ACTION_ITEMS.md` (the 3-line `attributeByParse` patch — see that file's band A) if you have the time at the end of Phase 2; otherwise leave it.
2. ❌ **Do not modify `lib/attribution.ts` outside the `attributeByConversation` and `resolvePronounFromState` functions**, unless you find a bug elsewhere. Specifically:
   - do not refactor the regex engine in `attributeByRegex`
   - do not touch `attributeByParse` (the parser walker)
   - do not touch `attributeByLLM`
   - do not touch `mergeAttribution`
3. ❌ **Do not change the score weights** for `presence`, `pronoun`, `timeline`, `scene` away from their current values (0.04–0.16 range). Only the `history` weight gets multiplied.
4. ❌ **Do not change `parserVersion` string** in `lib/attribution.ts:47-48` until explicitly asked. Bumping it invalidates every chapter's cached attribution.
5. ❌ **Do not touch `app/tts-service/`, Prisma schema, or any voice-selection code.**
6. ❌ **Do not modify `EbookReader.tsx` if you can avoid it.** All fixes can land in `attribution.ts` and `VoiceDebugPanel.tsx`.
7. ❌ **Do not add new dependencies to package.json.** Use existing utilities.

---

## Tests to add

In `app/ebook-converter/src/tests/attribution.test.ts`, add four new `it(...)` blocks:

1. `it('reduces history weight when alternation is detected', ...)`: build a 4-paragraph ping-pong with a known roster, run `attributeByConversation`, assert every other paragraph resolves to the correct speaker.
2. `it('does not resolve "Anh/Cô" as a subject at paragraph start with no preceding verb', ...)`: a paragraph with `"Anh..."` only and no verb in the prior 30 chars — `resolvePronounFromState` should return null.
3. `it('emits an unresolved-actor row when the speaker is detected but not in the roster', ...)`: a paragraph mentioning `Y Đằng Chân Lí Tử` not in the chars list — should produce a row with `source: 'unresolved-actor'`.
4. `it('preserves the conversationHits count when history weight is multiplied', ...)`: regression test — make sure the per-source counters in `computeStats()` still work.

Run `npm test` after writing. Verify all 4 existing tests + 4 new tests pass.

---

## What to report back when you're done

Reply with:

1. **`git diff --stat`** for the touched files (the diff itself is fine inline, no need to commit).
2. A **before/after table** for the 22-row misattribution inventory from `ACTION_ITEMS_V2.md`. Use this format:

```text
| # | Quote | Was attributed to | Should be | After fix: attributed to | Fixed? |
|---|-------|-------------------|-----------|--------------------------|--------|
| #10 | "Sai!" | Ưu Nhi | Long | ? | ? |
| ... |
```

3. **`npm test` output** (last 30 lines) — confirm all tests pass.
4. **`npx tsc --noEmit` output** — confirm type-clean.
5. **`scripts/measure-attribution.ts` output** if you wrote it in Phase 2.
6. A **short paragraph (≤ 200 words)** describing:
   - which root causes (RC-A/B/C) you managed to fix
   - which misattribution rows remain uncorrected (if any) and why
   - any **new bugs** you discovered along the way (be specific — file + line)
   - one specific **next-step suggestion** for Phase 3 work

If you find yourself blocked (e.g. a refactor takes much longer than expected), STOP and report. Do not silently add scope.

## End-of-task guard

After all of the above:

1. Run `git diff --check` (whitespace).
2. Run `npx tsc --noEmit` and `npm test`.
3. Do **not** commit. The user reviews the diff.

=== END PROMPT ===
