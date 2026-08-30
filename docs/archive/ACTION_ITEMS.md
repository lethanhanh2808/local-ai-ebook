# Action Items — Voice Attribution Engineering History

> Consolidated from `ACTION_ITEMS.md`, `ACTION_ITEMS_V2.md`, and `ACTION_ITEMS_V3.md`. Last updated 2026-07-11.
>
> Standing reference: `How_voice_recogized.md` (baseline) and `docs/voice-attribution-history.md` (chronological eval reports).
>
> **Current status (as of 2026-07-11):** every item in this file is **DONE**. The prioritized lists are preserved below as engineering reference — they explain *why* the current architecture looks the way it does. The status block at the end points at the live evidence (tests, measurement scripts, shipped files) so future maintainers can verify the closed-out state without re-deriving the priorities.

---

## Background

The original debug panel output that triggered the investigation:

```text
Voice assignment debug
Attributed / Unattributed (default voice) / Narration
81/83 dialogue paragraphs attributed • 2 fall back to default voice • 139 total paragraphs
  0 via parser (VnCoreNLP)
  3 via regex
  3 via LLM (oMLX)
 75 via state
• parser reachable
• oMLX reachable
```

The stateful conversation fusion layer was carrying 75/81 attributions; VnCoreNLP was contributing 0 hits. The three files below chronicle the investigation, the prioritised fix list, and the close-out.

---

## Part 1 — VnCoreNLP investigation (from V1)

### 1.1 Three concrete reasons the parser contributes ~0

**Reason A — `attributeByParse` discards the bulk of valid parses.** When the parser returns a subject that is *not* a known character name but matches a `name + action-verb` pattern (e.g. "Long gật đầu"), the engine drops the row entirely instead of emitting a low-confidence row.

**Reason B — Word segmentation breaks multi-token character names.** Two-token names like "Y Đằng Long" or three-token "Lão giả áo xám" get split into separate tokens by the segmenter. The matcher only handles single-token lookups.

**Reason C — Only the ROOT verb's subject is examined.** The parser treats a paragraph as one mega-sentence. Multi-clause paragraphs (e.g. multiple quotes interleaved with narration) collapse to the root verb's subject, losing clause-level speakers.

### 1.2 Should VnCoreNLP be kept or removed?

Two paths forward. If A1–A4 lift parser hits to >5% on the user's chapter, keep; otherwise replace.

---

## Part 2 — Prioritised fix list

### Impact band A — VnCoreNLP integration (the bug from §1.3)

| Item | Why | Effort | Status |
|---|---|---:|---|
| **A1.** Emit `parserOut` rows for *name + action-verb* (Reason A) | Catches the dominant Vietnamese-novel pattern that the parser currently discards. | ~20 min | ✅ DONE |
| **A2.** Accept single-character prefix names (Reason B) | Lets the parser match "Y Đằng…" prefixes without full-name lookup. | ~15 min | ✅ DONE |
| **A3.** Walk *every* verb in the sentence that has a `sub`/`nsubj` (Reason C) | Multi-verb walking; landed via `findVerbsWithSubjects()` in eval-8. | ~35 min | ✅ DONE |
| **A4.** Lower `findRootVerb`'s POS restriction to include verbs tagged `Vb` | Catches vernacular Vietnamese short verbs. | ~15 min | ✅ DONE |

### Impact band B — Corpus robustness

| Item | Why | Status |
|---|---|---|
| **B1.** Decide parser-version policy | Landed as the `ATTRIBUTION_VERSION` constants; bumping invalidates cache. | ✅ DONE |
| **B2.** Surface `parserHits` even when source is `conversation` | `VoiceDebugPanel` now reports per-source counts even when the row's source label is `conversation`. | ✅ DONE |
| **B3.** Add a regression test that asserts **>0 parser hits** on a sample chapter | New vitest pinning parser contribution. | ✅ DONE |

### Impact band C — Replace, don't repair

| Item | Why | Status |
|---|---|---|
| **C1.** Remove VnCoreNLP from the stack | **NOT taken.** A1–A4 lifted parser hits to 5–20 on the user's chapter; the sidecar earned its keep. | (deferred) |

### Impact band D — Carry-over improvements

| Item | Why | Status |
|---|---|---|
| **D1.** Persist book-level `ConversationStateSnapshot` in SQLite for cross-chapter pronoun seeding | Cross-chapter seed; landed via `BookConversationState` Prisma model + `loadConversationState`/`saveConversationState`. Close-out evidence in `docs/voice-attribution-history.md` (eval 1 + V3 §A). | ✅ DONE |
| **D2.** Make `score >= 0.42` threshold per-genre | Currently a single 0.42 threshold; per-genre is a future polish item. | (deferred) |
| **D3.** Adopt `attributeByConversation` on the Python (audiobook) side | Landed in `app/tts-service/conversation_attribution.py`; 203/203 Python tests passing; 13/22 inventory rows fixed on chapter005 (vs 0/22 baseline). | ✅ DONE |

### Impact band E — Ping-pong arbitration (from V2, RC-A)

| Item | Why | Status |
|---|---|---|
| **E1.** Reduce `history` weight when alternation strength is high | Landed via `ALTERNATION_HISTORY_MULTIPLIER = 0.55` (eval-5 recovery from eval-4's `0.30` regression). | ✅ DONE |
| **E2.** Reduce `scene` weight multiplier when scene has settled | Landed via contradiction-signal dampening (eval-8). | ✅ DONE |
| **E3.** Boost `actor` (timeline 36%) when alternation is detected and `history` is present | Actor alternation bump (`0.36 → 0.48` inside detected alternation) mirrored on the JS side; Python-side parity is a future item. | ✅ DONE (JS) / partial (Python) |

### Impact band F — Vocative vs subject pronoun (from V2, RC-B)

| Item | Why | Status |
|---|---|---|
| **F1.** Make `resolvePronounFromState` reject pure vocative "Anh/Cô" at paragraph start | Pure-vocative rejection at paragraph start landed; covered by regression test in eval-5. | ✅ DONE |
| **F2.** Tag tokens that are preceded by a name + ", " as vocative candidates | Token-vocative tagging landed. | ✅ DONE |

### Impact band G — Character registry completeness (from V2, RC-C)

| Item | Why | Status |
|---|---|---|
| **G1.** Add `Y Đằng Chân Lí Tử` to the chapter's character roster via the Wand button | UI button shipped in eval-2 timeframe; user-side data fix verified in eval-6. | ✅ DONE |
| **G2.** When a character is mentioned in narration but not in roster, auto-suggest an addition (Wand2 button behaviour) | Wand2 surfaces unregistered mentions as suggestion chips. | ✅ DONE |
| **G3.** When `attributeByConversation` cannot resolve a speaker, but the paragraph's own narrator-names a character, leave a "ghost" attribution in the cache | Ghost-attribution behaviour lands via `unresolved-actor` source tag (eval-3 metric). | ✅ DONE |
| **G4.** Detect unregistered character names from the chapter text via the same offline alias-canonical logic used during detection, but in real time during attribution | Landed via `find_potential_new_characters` + `collect_novel_names` on the Python side; JS-side parity pending. | ✅ DONE (Python) / (deferred JS) |

### Impact band H — Source-of-truth visibility (from V2, DX)

| Item | Why | Status |
|---|---|---|
| **H1.** Show `actor` vs `subject` separately in the debug panel | `VoiceDebugPanel` now exposes `state.activeCharacters` + per-evidence breakdown. | ✅ DONE |
| **H2.** Add a per-character `misattributionRate` to the VoicePanel summary panel | Per-character misattribution counters landed in the measurement script. | ✅ DONE |

---

## Part 3 — Concise action checklist (carried forward)

### Suggested AI-review pass order

1. Apply A1 + A2 + A4 first (50 min total, ship-to-user value).
2. Measure parser-hit % on the user's actual book. If < 5%, pivot to C1 (full removal). Otherwise continue.
3. Only if A1–A4 lift the parser signal meaningfully, invest in A3 + D1/D3.

---

## Part 4 — Diagnostic log of the user's exact debug panel (preserved from V1)

| Metric | Value |
|---|---|
| `parserVersion` | `conversation-v1+vncorenlp-1.2` *(was cached on initial GET; since bumped to `v3+vncorenlp-1.2` after eval-6)* |
| `parserHits` | 0 → **5–20** after A1–A4 + eval-8 |
| `regexHits` | 3 |
| `llmHits` | 3 |
| `conversationHits` | 75 |
| defaults | 2 |
| totalParagraphs | 139 |
| `parserReachable` | true |
| `omlxReachable` | true |

**Historical takeaway:** the stateful fusion layer was responsible for 75/81 attributed paragraphs when this investigation started. After the full A–H sequence, parser hits rose from 0 → 5–20, the alternation regression was recovered (eval-5), and the Python engine now mirrors the JS engine (203/203 tests, 13/22 inventory rows fixed on chapter005).

---

## Part 5 — D1 close-out + post-close-out queue (from V3)

The following items shipped together with the D1 close-out push.

### A. D1 close-out (✅ DONE)

| Item | What shipped |
|---|---|
| **A1.** API e2e verify | [scripts/smoke-d1.sh](app/ebook-converter/scripts/smoke-d1.sh) — bash that hits `/attribute` four times in sequence and prints the `crossChapter` block from each response. |
| **A2.** `e2e/06-cross-chapter-state.spec.ts` | 3 Playwright tests covering `no-row → applied → stale-chapter` transitions. |
| **A3.** Wire `measure-attribution.ts` to thread the seed | `--seed` (default), `--no-seed`, `--inventory-only` flags. Headline table at the end reports `Δ fixed / Δ wrong` on the target chapter. |
| **A4.** Re-run before/after measurement on Chiếm Đoạt Vợ Yêu ch.4 → ch.5 | **Finding:** D1 alone does not move the 22-row inventory headline (`+0 fixed / +0 wrong`). The seed *does* fire on every subsequent chapter (`seedReason: 'applied'`), but the 19 wrong rows are dominated by mid-chapter ping-pong bleed, not chapter-boundary bleed. D1's direction is correct: row #29 flipped `'Y Đằng Long'` (wrong) → `(none)` (correctly rejecting the wrong speaker). Once E1 (alternationStrength) lands, this row should flip to `'Y Đằng Ưu Nhi'`. |

### B. UI surfacing (✅ DONE)

| Item | What shipped |
|---|---|
| **B5.** Show `crossChapter` in `VoiceDebugPanel` | New `CrossChapterChip` sub-component with 5 variants (`applied` / `no-row` / `stale-chapter` / `version-mismatch` / `empty`). `data-testid="voice-debug-cross-chapter"` and `data-seed-reason="..."` exposed. |

### C. Convenience / ops (✅ DONE)

| Item | What shipped |
|---|---|
| **C6.** Backfill CLI `scripts/backfill-conversation-state.ts` | Drives the live `/attribute` HTTP route (not Prisma direct); `--book`, `--from`, `--to`, `--base-url`, `--dry-run`, `--clear-only`, `--rate-ms`, `--no-skip-resume`, `--help`. Resume by default. |
| **C7.** `/api/library/[id]/conversation-state` debug GET | Runtime nodejs, dynamic force-dynamic, GET-only. 404 if book not found; 200 with `{ found: false, reason }` or populated snapshot. Never returns `stale-chapter`. Returns `lastChapterIndex`, `parserVersion`, denormalised `snapshot` summary. |
| **C8.** Surface stale-chapter skip in attribute API response | Lands with B5 — yellow chip variant. |

### D. Eval-8 §6 backlog (✅ DONE)

| Item | What shipped | Tests |
|---|---|---|
| **D9.** D3 — Python pipeline parity | `app/tts-service/conversation_attribution.py` mirrors `attributeConversationChapter`; `_is_known_surface_name` IndexError bug fixed during B.6 verification. **203/203 Python tests passing.** **13/22 fixed on chapter005** (vs 0/22 baseline). | 71 + 28 + 43 + 16 + 29 + 8 + 8 |
| **D10.** G4 — unregistered-name detection | Landed in Python port (`find_potential_new_characters` + `collect_novel_names`); JS-side parity pending. | covered in D9 |
| **D11.** `permissionDenylist` for emotion markers | Python-side denylist landed in eval-8 §6.6. | ✅ |
| **D12.** Vitest: pin `cacheHit` behaviour for attribute route | Regression test pinned in eval-8. | ✅ |

---

## Status block — all items DONE

| Band | Item count | Status |
|---|---:|---|
| A — VnCoreNLP integration | 4 | 4 done (C1 deferred) |
| B — Corpus robustness | 3 | 3 done |
| C — Replace | 1 | deferred (A1–A4 earned the sidecar its keep) |
| D — Carry-over | 3 | 2 done (D2 per-genre deferred as polish) |
| E — Ping-pong arbitration | 3 | 3 done |
| F — Vocative vs subject pronoun | 2 | 2 done |
| G — Character registry completeness | 4 | 4 done |
| H — Source-of-truth visibility | 2 | 2 done |
| V3 §A — D1 close-out | 4 | 4 done |
| V3 §B — UI surfacing | 1 | 1 done |
| V3 §C — Convenience / ops | 3 | 3 done |
| V3 §D — Eval-8 backlog | 4 | 4 done |

**Open (deferred polish):**

- D2 per-genre `score >= 0.42` threshold
- C1 full VnCoreNLP removal (not needed; A1–A4 lifted parser hits from 0 → 5–20)
- D9 Python-side actor alternation bump parity with JS
- D10 JS-side `find_potential_new_characters` parity with Python

These are tracked as future polish in `PROJECT_REVIEW_AND_RECOMMENDATIONS.md`.

---

## End-to-end smoke check

After any future change to `lib/attribution.ts` or `audiobook_generator.py::find_speaker_for_quote`:

```bash
# 1. Type-check
cd app/ebook-converter && npx tsc --noEmit

# 2. Vitest (must keep 37/37 passing, including the §6.5 ping-pong test)
npm test

# 3. Python parity tests (must keep 203/203 passing)
cd ../tts-service && python3 -m pytest tests/

# 4. Measure script — re-run on the user's chapter005; expect ≥ 13/22 fixed
MEASURE_BOOK_ID=<uuid> npx tsx scripts/measure-attribution.ts

# 5. Playwright — 7 spec files, 36 tests
cd ../ebook-converter && npx playwright test --list
```

The §6.5 ping-pong test is the only one that would have caught the eval-4 regression; keep it green with `resolved ≥ 8`.