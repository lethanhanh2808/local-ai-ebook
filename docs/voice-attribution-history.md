# Voice Attribution — Consolidated Engineering History

> **Source files**: 9 historical reports totaling ~3,800 lines — collapsed into one chronological narrative. Read this top-to-bottom; the per-eval deep dives are archived in the original files referenced inline. Generated 2026-07-11.
>
> **Scope**: Vietnamese dialogue attribution for the ebook-converter's read-aloud and audiobook paths. Two engines must stay in sync: the TypeScript `lib/attribution.ts` (used by live read-aloud) and the Python `app/tts-service/audiobook_generator.py` (used by pre-generated audiobooks).

---

## Timeline at a glance

| # | Report | Date | Headline | Verdict |
|---|---|---|---|---|
| 0 | `How_voice_recogized.md` | 2026-07 | Original 1,423-line reverse-engineering of the 6-pass attribution engine | baseline |
| 1 | `How_voice_recogized_RE_EVALUATION.md` (eval 2) | 2026-07-05 | **Stateful conversation fusion layer added** — `attributeByConversation()` | ✅ ship |
| 2 | `How_voice_recogized_RE_EVALUATION_3.md` | 2026-07-05 | Phase-1 fixes from `PROMPT_fix_attribution.md` shipped | ✅ ship |
| 3 | `How_voice_recogized_RE_EVALUATION_4.md` | 2026-07-06 | **HARD REGRESSION** — picked `historyMultiplier = 0.30` from range, blew up ping-pong dialogue | ❌ do not ship |
| 4 | `How_voice_recogized_RE_EVALUATION_5.md` | 2026-07-06 | Recovery applied — revert `0.30 → 0.55`, dampening + missing test added | ✅ ship |
| 5 | `How_voice_recogized_RE_EVALUATION_6.md` | 2026-07-06 | Cache flushed, VnCoreNLP + prefix-matching fixes shipped | ✅ ship |
| 6 | `How_voice_recogized_RE_EVALUATION_7.md` | 2026-07-06 | `scripts/reassign-character-voices.ts` shipped — fixes gender-inverted voice rows | ✅ ship |
| 7 | `How_voice_recogized_RE_EVALUATION_8.md` | 2026-07-06 | A3 (multi-verb parser walking) + E2 (contradiction-signal dampening) + regex latent-bug fix | ✅ ship |
| — | `D9 Python pipeline parity` (ACTION_ITEMS_V3) | 2026-07-05 | Port conversation-v3 engine to Python; **13/22 fixed on chapter005** | ✅ 203/203 tests |

---

## Eval 0 — Baseline reverse-engineering (`How_voice_recogized.md`)

The starting state was a six-pass attribution engine in `app/tts-service/audiobook_generator.py::find_speaker_for_quote`:

1. Closest-name wins
2. Pronoun resolution
3. Thought-verb
4. Reactive-action
5. Em-dash
6. Default voice

Three failure modes were already known before any stateful layer landed:

- **Multi-paragraph dialogue** — every quote resolved independently with no memory of the prior speaker.
- **Two-person ping-pong dialogue** — unattributed quotes had no speech-verb/name window to fall back on.
- **Pronoun-heavy scenes** — only the latest male/female mention was tracked, ignoring grammatical role and scene presence.
- **Multiple same-gender characters** — "last female" was too coarse; subject/object roles were not consulted.
- **Live/offline divergence** — TS and Python implemented separate attribution logic, so the live read-aloud path and pre-generated audiobook path drifted over time.

---

## Eval 1 (eval-2 in report titles) — Stateful conversation fusion layer

**Decision:** add a fourth attribution layer (`attributeByConversation` in `lib/attribution.ts`) that runs *after* parser + regex (+ LLM on the analyze route) and rewrites each paragraph's attribution by combining multiple weighted evidence sources with per-chapter scene memory.

### ConversationState

```text
ConversationState
  sceneId
  activeCharacters                // 0.88× decay per paragraph
  currentSpeaker
  previousSpeaker
  dialogueHistory                 // ≤ 10 turns
  currentFocusCharacter
  lastActionCharacter
  lastSubject / lastObject / lastRecipient
  lastMentionedCharacters
  paragraphsSinceDialogue
```

Scene boundaries are detected from chapter start, long narration blocks, long gaps since dialogue, and transition phrases (`hôm sau`, `lúc này`, `trong khi đó`, `một lát sau`, `ở một nơi khác`, `trong phòng`, `trên đường`).

### Weighted evidence (initial ladder)

| Evidence | Weight | Purpose |
|---|---:|---|
| VnCoreNLP named subject + speech verb | 0.72 | Strong grammatical speaker signal |
| VnCoreNLP lower-confidence pronoun/non-speech subject | 0.50 | Useful but not absolute |
| Regex speech-verb/name pattern | 0.45-0.58 | Existing strict local attribution |
| LLM fallback | 0.50-0.68 | Optional high-level ambiguity resolver |
| Active scene presence | ≤ 0.16 | Bias toward currently-present characters |
| Current paragraph mention | 0.08 | Weak local context |
| Pronoun resolved from scene roles | 0.38-0.48 | Replaces "last male/female only" |
| Immediate event actor | 0.36 | Timeline action before/around quote |
| Carried last actor | 0.12 | Weak continuity |
| Two-person dialogue alternation | 0.45-0.50 | Ping-pong without speech verbs |
| Previous-speaker continuation | 0.38 | Multi-paragraph continued speech |
| Current scene focus | 0.10 | Weak narrative focus support |

Minimum acceptance threshold: **0.42**. If an explicit source dominates (gap ≥ 0.18), the row keeps its source (`parser` / `regex` / `llm`); otherwise the row's source becomes `conversation`.

### Cache invalidation

`parserVersion` parameter added to `getCachedAttribution` so the schema version itself invalidates stale cache rows:

- `ATTRIBUTION_VERSION = 'conversation-v1+vncorenlp-1.2'`
- `ATTRIBUTION_VERSION_LLM = 'conversation-v1+vncorenlp-1.2+llm'`

### Slicing alignment

`sliceParagraphs()` now honors HTML block elements (`<p|h1-6|li|blockquote>`) before falling back to newlines/sentences — this aligns TS-side slicing with `EbookReader.tsx::getChapterParagraphs()`. **This was the fix for the long-standing paragraph-index mismatch between `/attribute` and `EbookReader.detectSpeaker()`.**

### File Δ

| File | Before | After | Δ |
|---|---:|---:|---:|
| `app/ebook-converter/src/lib/attribution.ts` | 694 L | **1,315 L** | +621 |
| `app/ebook-converter/src/lib/db/chapter-attribution.ts` | 138 L | 167 L | +29 |
| `app/ebook-converter/src/app/api/library/[id]/chapters/[chapterId]/attribute/route.ts` | 149 L | 164 L | +15 |
| `app/ebook-converter/src/components/library/EbookReader.tsx` | 2,518 L | 2,522 L | +4 |
| `app/ebook-converter/src/components/library/VoiceDebugPanel.tsx` | 457 L | 457 L | + evidence[] render + state.activeCharacters row |
| `src/tests/attribution.test.ts` | — | **new**, 86 L | 4 vitest cases |
| `e2e/05-attribution.spec.ts` | — | **new**, 53 L | 1 Playwright smoke |

`app/tts-service/*` (audiobook_generator.py, vncorenlp_attribution.py, character_detector.py, unified_server.py, vieneu_server.py, server.py) — **untouched** at this stage, and already demonstrably behind TS.

### Verdict

✅ **Ship.** The single biggest lift in the conversation-attribution work. Bumps `parserVersion`, which forces a re-attribute on the next reader open.

---

## Eval 3 — Phase-1 fixes (`PROMPT_fix_attribution.md`)

Shipped the deterministic guards from the prompt-review audit:

- New constants & helper functions in `lib/attribution.ts` (+72 lines)
- `chapter-attribution.ts` snapshot types (+5 lines)
- `VoiceDebugPanel.tsx` (+31 lines, 4 hunks) — surfaces new debug info
- `src/tests/attribution.test.ts` (+63 lines, 4 tests)
- New `scripts/measure-attribution.ts` measurement harness
- `e2e/05-attribution.spec.ts` (+1 line)

### Measurement result on the user's chapter005

| Metric | Eval 2 | Eval 3 |
|---|---:|---:|
| Test outcomes | — | 10/10 vitest passing, type-check clean |
| `unresolved-actor` rows | — | **1** (new metric, useful) |
| Inventory (22 rows) fixed | 0 | 0 (no delta from this round alone) |

### Why the inventory didn't move

The headline `0 → 0 fixed` is **not a regression** — the seed is firing on every subsequent chapter. The 19 wrong rows are dominated by *mid-chapter ping-pong bleed* (rows #65, #67, #69, #75, #82, #101, #103), not chapter-boundary bleed. Phase-1 fixes targeted cross-chapter carry-over; ping-pong bleed within a chapter is E-band territory.

### Net direction

Row #29 flipped from `'Y Đằng Long'` (wrong) to `(none)` — i.e. the chapter-boundary signal taught the engine *not to commit* to the wrong speaker, even though it didn't pick the right one. **The direction is correct: Phase-1 reduces false positives at chapter starts.** Once E1 (alternationStrength) lands, this row should flip to `'Y Đằng Ưu Nhi'`.

### Verdict

✅ **Ship.** Hygiene is in place; the next measurement trigger is "re-run after V2 E1 lands."

---

## Eval 4 — **HARD REGRESSION** (`historyMultiplier = 0.30`)

> **Lesson:** when an audit gives a *range*, walk the range. Don't jump to the most-aggressive value.

The eval-3 §7.2 recommendation said:

> "Try `historyMultiplier` values `0.55`, `0.40`, `0.30`, `0.20` against the same chapter. Whichever first yields `Inventory fixed + Inventory partial ≥ 14 of 22` is the new constant."

The user picked **`0.30`** (the lower end) and skipped the empirical sweep. The result: the conversation-fusion engine is now broken for any chapter that contains dialogue between two known characters — which is the dominant case for Vietnamese web-novels.

### Numerical proof

| Metric | Eval 3 | Eval 4 (this commit) | Δ |
|---|---:|---:|---:|
| `parserHits` | 3-15 | similar | minor |
| Inventory fixed | 0/22 | regressed | **major regression** |
| Voice distribution | correct | 4 rows misattributed by gender | separate bug |

### Root cause

`historyMultiplier = 0.30` collapsed the alternation-evidence weight, so when two speakers with similar dialogic weight alternate (rows #56-#84, #85-#89, #104-#116), the engine flipped each paragraph to the *previous* speaker instead of the *correct* speaker.

### Why didn't any test catch it?

**The 10 new tests all pass, but they don't cover the chapter's failure mode.** The §6.5 test (12-line ping-pong regression test) is the only one that would have caught this, and it was not added.

### Recovery plan (eval-5)

1. Revert `historyMultiplier = 0.30 → 0.55`.
2. Add the §6.5 ping-pong test (gating any future change to the scoring math).
3. UI data fix: VoicePanel voice assignments (4 rows), Character table aliases (rename or add `"Y Đằng Ưu Nhi"` etc.).
4. Click `Wand2` on each affected chapter to invalidate cache.

### Verdict

❌ **Do not ship the eval-4 build.** Recoverable via eval-5.

---

## Eval 5 — Recovery applied

Four surgical edits to `lib/attribution.ts`:

1. `historyMultiplier` reverted `0.30 → 0.55`.
2. Scene-weight dampening when contradicting signal (E2).
3. History-continuation dampening when contradicting signal (E2 — extended).
4. New vitest pinning the focus-character + lexical-signal conflict.

### Test outcomes

37/37 tests passing (was 36). Type-check clean.

### Predicted impact on the user's chapter

- `parserHits`: 3-15 → 5-20 (after E2 + the bonus regex fix).
- Inventory rows recovered from history-bleed: **+5-10** (E2 dampening reduces false-positive carry-over when a contradicting parser/actor signal is present).

### Verdict

✅ **Ship.**

---

## Eval 6 — Cache flushed + remaining fixes

Bumped `parserVersion` to `v3+vncorenlp-1.2` (forces re-attribute on next GET). Applied the cheap, low-risk fixes flagged in `ACTION_ITEMS.md` band A (VnCoreNLP) and `ACTION_ITEMS_V2.md` band F (prefix matching) on top of the eval-5 recovery.

### Layer deltas

| Layer | Eval 5 | Eval 6 |
|---|---|---|
| `parserVersion` | `v2+vncorenlp-1.2` | **`v3+vncorenlp-1.2`** |
| VnCoreNLP weight tuning | partial | finalized |
| Prefix matching (`Y…` aliases) | not in code | landed |
| New vitest cases pinning prefix + scene-reset edges | — | +2 |

### What the user still had to do (data side)

- Open VoicePanel, fix 4 voice mappings.
- (Optional) Add `Y…` aliases to existing character rows.
- Reset chapter cache (done automatically by the `v3` version bump).

### Verdict

✅ **Ship.**

---

## Eval 7 — `scripts/reassign-character-voices.ts` shipped

The user had a number of gender-inverted voice assignments that had to be fixed by hand. This script makes it scriptable.

### Deliverables

| File | Status |
|---|---|
| `app/ebook-converter/scripts/reassign-character-voices.ts` (~165 lines) | ✅ ready |
| `app/ebook-converter/src/tests/reassign-character-voices.test.ts` (~70 lines) | ✅ 7/7 passing |

### Behaviour

- Args: `--book <uuid>`, `--from <characterName>`, `--to <characterName>`, `--apply`, `--dry-run`.
- Default mode is dry-run (prints planned swaps).
- `--apply` writes the swaps through the live `/api/library/[id]/characters` route so cache invalidation is identical to UI flow.
- After successful apply, run `Wand2` on each affected chapter to invalidate attribution cache, then regenerate audiobook.

### Verdict

✅ **Ship.**

---

## Eval 8 — A3 + E2 + bonus regex fix

Three bugs closed in one round.

### A3 — multi-verb parser walking (`findVerbsWithSubjects`)

```ts
// before: emit exactly one row per sentence based on the root verb
// after:  walk every (verb, subject) pair, pick the highest-confidence row
const pairs = findVerbsWithSubjects(sent);
let bestConf = 0;
let bestRecord = null;
for (const { verb, subject } of pairs) { /* ... */ }
if (bestRecord) out[paragraphIdx] = { speaker, confidence, source: 'parser' };
```

Necessary because the parser treats paragraphs containing multiple quotes as one mega-sentence. Walking every V/Vb that has a `sub`/`nsubj` head and is NOT a child of another V/Vb captures clause-level speakers in those paragraphs.

### E2 — contradiction-signal dampening

Scene-weight and history-continuation weights are now halved when parser / regex / llm / actor / pronoun all point away from `state.currentSpeaker` or `state.currentFocusCharacter`. This prevents the *previous* engine behaviour where stateful carry-over over-voted a contradicting fresh signal.

### Bonus — latent `actionRe` regex bug

```ts
// before
const actionRe = new RegExp(`^.{0,80}(?:${TEXT_SPEECH_VERBS}|${TEXT_ACTION_VERBS})`, 'iu');
//   ^.{0,80}(?:VERB) —  anchor at position 0, then greedy 0-80 chars,
//   then VERB must match IMMEDIATELY. With tail = " quay phắt đầu, ..."
//   the verb `quay` is at position 1; backtrack to no match.

// after (the real intended check)
const actionRe = new RegExp(`(?:${TEXT_SPEECH_VERBS}|${TEXT_ACTION_VERBS})`, 'iu');
//   Any-verb-position within the tail.
```

This was a **latent bug** that existed in the codebase since eval-2. It was masked because the typical conversation-fusion paths used the regex-layer (which finds NAME+VERB), not the timeline layer. But the moment we needed the timeline layer to detect a contradicting signal (E2), the bug surfaced.

### New test

A 28-line vitest pinning the focus-character + lexical-signal conflict — without this, the regression that eval-4 walked into would happen again.

### Predicted impact

| Metric | Eval 7 expected | Eval 8 expected |
|---|---:|---:|
| `parserHits` | 3-15 | **5-20** (A3 + regex fix) |
| Inventory rows recovered from history-bleed | — | **+5-10** (E2) |

### Verdict

✅ **Ship.** 37/37 tests passing.

---

## D9 — Python pipeline parity (from `ACTION_ITEMS_V3.md`)

The single largest remaining asymmetry between the live-read-aloud path (Next.js) and the pre-generated audiobook path (Python).

### Acceptance gate results (chapter005, no parser, no seed)

- 13 / 22 fixed (59% of inventory rows correct)
- 0 / 22 partial
- 9 / 22 wrong
- Baseline from `How_voice_recogized_RE_EVALUATION_3.md`: 0 / 22 fixed → **+13 net improvement**
- Dialogue paragraph attribution: chapter003 49/108 (45%), chapter004 199/238 (84%), chapter005 68/139 (49%)

### Delivered phases

| Phase | Asset | Tests |
|---|---|---:|
| A | `conversation_attribution.py` state machine + snapshot + apply_seed | 71 |
| B.1 | `attribute_chapter` main loop + helpers | 28 |
| B.2+B.3 | `build_context` + `scan_mentions` + `find_potential_new_characters` + `collect_novel_names` | 43 |
| B.4 | `resolve_narrative_pronoun_cue` + `best_active_by_gender` + `resolve_pronoun_from_state` | 16 |
| B.5 | `attribute_chapter` end-to-end + helpers | 29 |
| B.6+E | `scripts/measure_attribution.py` ports `measure-attribution.ts` | — |
| C | `conversation_state_client.py` HTTP client for `/api/library/[id]/conversation-state` | 8 |
| D | `ATTRIBUTION_ENGINE=conversation_v3\|legacy` env toggle | 8 |

**Total: 203 / 203 Python tests passing.**

`_is_known_surface_name` IndexError bug fixed during B.6 verification (Python `or` short-circuit vs JS `.every` short-circuit).

### Remaining gaps (per `ACTION_ITEMS_V3.md` §D)

1. **D1 cross-chapter seed** — Python doesn't read or write `BookConversationState`. Single biggest remaining asymmetry.
2. **E2 contradiction-signal dampening** — Python `_fuse_speaker` always gives `current_speaker` 0.38 and `current_focus` 0.10 — these will over-vote the fresh signal.
3. **`ALTERNATION_HISTORY_MULTIPLIER = 0.55`** — JS dampens history-based evidence when the last two dialogue turns alternate. Python doesn't.

---

## Standing engineering rules (carry forward)

1. **Don't jump to the most-aggressive value when given a range.** Walk the range, stop at the first value that achieves the acceptance criterion.
2. **The §6.5 ping-pong test is gating.** Any future change to `attributeByConversation` scoring math must keep this test passing with `resolved ≥ 8`. The eval-4 regression slipped through because no test covered the chapter's failure mode.
3. **`parserVersion` bump = force re-attribute.** Bumping the version constant is the one-shot way to invalidate stale cache rows after a logic change.
4. **Python and TS engines must stay in sync.** Any change to `attributeByConversation` in TS must be mirrored in `audiobook_generator.py::_fuse_speaker`. The eval-1 → D9 work is the first time both engines implement the same algorithmic design and evidence weights.
5. **`historyMultiplier = 0.55` is the safe default.** Don't drop below 0.40 without an empirical sweep and the §6.5 test passing.

---

## Pointers

- Original detailed reports: `../How_voice_recogized.md`, `../How_voice_recogized_RE_EVALUATION.md`, `../How_voice_recogized_RE_EVALUATION_3.md` through `_8.md`.
- Acceptance criteria + measurement harness: `../ACTION_ITEMS_V3.md` §D (consolidated into `ACTION_ITEMS.md`).
- Prompt-review + deterministic guards: `../PROMPT_fix_attribution.md`.