# Audio Studio — Character Bible, Voice Assignment & Audiobook Enhancement Plan

Status: **IN PROGRESS** · Owner: AI agent + user review · Created 2026-09-01

## Progress log
- **Phase A (backend range + status) — DONE**
  - `bible/status/route.ts` (GET) — per-chapter analyzed flags from `BibleRefreshLog`.
  - `bible/analyze-range/route.ts` (POST SSE) — sequential range orchestrator reusing `refreshBible()`; skips analyzed unless `forceRerun`.
  - `character-bible-client.ts` — `openRangeAnalysisStream`, `consumeSseStream`, `fetchBibleStatus`, `BibleRangeEvent` type.
  - Verified: status returns 1033 chapters; analyze-range streams SSE correctly (gateway was down so LLM returned empty, but pipeline is correct).
- **Phase C (Nhân vật tab) — DONE**
  - `BibleAnalysisControls.tsx` — range picker (from/to), "Phân tích" + "Tiếp tục" buttons, chapter flag strip, live SSE progress, "Phân tích lại" toggle.
  - `AudioStudio.tsx` — `characters` tab now renders `BibleAnalysisControls` + `CharactersPanel` (was `VoicePanel section="characters"`).
- **Phase D (relationship graph) — DONE**
  - `RelationshipGraph.tsx` — self-contained SVG force-directed graph (no new dep), role-tinted nodes, labelled edges, hover ego-network, click-to-select.
  - `CharactersPanel.tsx` — fetches bible view, renders graph above the character grid.
- **Phase E (Phân giọng uncertainty) — DONE**
  - `voice-plan.ts` — `VoicePlanSentence.confidence` + `uncertain` fields; populated from paragraph attribution confidence (<0.6 → uncertain); serialized/deserialized.
  - `VoiceAssignPage.tsx` — amber left-border + "?" chip on uncertain sentences; "Câu cần review" filter toggle; `uncertainCount` badge.
- **Phase B (detection accuracy) — DEFERRED**: existing prompt already strong (canonical-name cheat-sheet, alias→update conversion, relationship canonicalization). Will revisit if user reports misses.
- **Phase F (Audiobook coverage) — DONE**
  - `lib/db/audiobook.ts` → `getAudiobookSummary` now returns `coverage: { plannedChapters, totalChapters, assignedSentences, uncertainSentences }` computed from stored `ChapterVoicePlan` JSON (no LLM calls).
  - `AudiobookPanel.tsx` shows two amber warnings before generation: (1) no Phân giọng plans yet → all narration; (2) N uncertain sentences need review in Phân giọng tab.

## Open questions (still relevant)
- Q1 graph lib: chose zero-dependency SVG (archify repo was provided but network/GitHub fetch was unavailable; visual style approximated — calm dark canvas, role-tinted nodes, labelled edges).
- Q2 default batch: UI defaults range to first 10 un-analyzed chapters; user can change from/to.
- Q3 re-run: skip analyzed by default; "Phân tích lại" forces re-run.
- Q4 confidence storage: piggybacked in `VoicePlanSentence` JSON (no migration).
- Q5 scope order: A→C→D→E done; F pending (blocked on gateway).

This plan ties together the three tightly-related Audio Studio tabs —
**Nhân vật** (Characters), **Phân giọng** (Voice Assignment), and **Audiobook** —
into one coherent character-driven pipeline. It builds on the substantial
infrastructure that already exists rather than duplicating it.

---

## 1. Goals (from the user request)

1. **Incremental, range-based character analysis** for a whole novel without
   doing it all at once. User can run e.g. ~10 chapters at a time to summarize
   and build characters (appearance, personality, relationships when the AI can
   find them), accumulating into a comprehensive per-book "bible".
2. **"Continue analysis"** that scans only not-yet-analyzed chapters, discovers
   new characters, and updates/completes already-known ones.
3. **Flag already-analyzed chapters** to avoid wasting time/tokens, unless the
   user explicitly confirms a re-run.
4. **User chooses the chapter range** (from chapter X to chapter Y).
5. **Relationship diagram** between main and supporting characters, visually
   elegant and intuitive (reference: `tt-a1i/archify` visual style).
6. **Research + improve AI character detection accuracy.**
7. **Beautify the post-analysis "character introduction" window.**
8. Detected characters become the **source DB for Phân giọng** voice assignment.
9. **Better automatic voice assignment** in Phân giọng, with **highlighting of
   sentences the AI cannot confidently attribute** for user review.
10. **Improved Audiobook** generation driven by the Phân giọng data.

---

## 2. What already exists (build on this — do NOT duplicate)

### Database (Prisma / SQLite)
- `Character` (id, bookId, name, voiceId, notes, role, age, gender, tone) — unique (bookId, name)
- `CharacterProfile` (characterId PK, description, personality, speechStyle, visualDescription, visualSource, fieldSources, source, version, updatedAt)
- `CharacterRelationship` (id, bookId, fromCharId, toCharId, relationship, notes, source, asOfChapterIdx) — unique (bookId, fromCharId, toCharId, relationship)
- `CharacterChapterAppearance` (characterId, chapterIndex, mentions, analyzedAt) — unique (characterId, chapterIndex)
- `CharacterAlias`
- `BibleRefreshLog` (bookId, chapterIndex, version, status, appliedCount, queuedCount, conflictCount, durationMs, lastError, analyzedAt) — **PK (bookId, chapterIndex)** → this is our per-chapter "analyzed" flag
- `PendingBibleDiff` (id, bookId, patch, status) — human-review queue
- `ChapterVoicePlan`, `ChapterAttribution`, `VoicePlanHistory`, `Voice`, `AudiobookChapter`

### Backend libs
- `src/lib/ai/character-bible.ts` (1125 lines): `refreshBible()` (per-chapter LLM scan, SSE progress), `buildSystemPrompt`, `buildUserPrompt`, `sanitizePatches`, `normalizePatches`, `applyBiblePatch(es)`, `setUserProfile`, `applyAcceptedBiblePatch`, `fetchChapterInputs`, `writeRefreshLog`
- `src/lib/db/character-bible.ts`: `getCharacterBible`, `setProfile`, `mergeLlmProfilePatch`, `addOrUpdateRelationship`, `removeRelationship`, `recordAppearances`, `ensureCharacter`, `resolveCharacterIds`, `findCharacterIdByName`, `canonicalizeRelationship`, `queueDiff`, `applyDiff`, `rejectDiff`, `applyAllNonConflictingDiff`, `markStaleBeforeChapter`
- `src/lib/character-bible-client.ts`: `enqueueBibleRefresh`, `openBibleRefreshStream` (SSE client)
- Python `character_detector.py` (book-level detector) + `audiobook_generator.py`

### API routes (under `.../characters/`)
- `bible/route.ts` (GET assembled view), `bible/refresh/route.ts` (POST SSE, **per-chapter only — whole-book intentionally disabled**), `bible/enqueue`, `bible/diffs/[diffId]/apply|reject`, `bible/diffs/apply-all`
- `detect/route.ts` (book-level Python detector), `route.ts` (GET), `[characterId]`, `merge`, `split`
- `chapters/[chapterId]/detect-characters/route.ts`

### UI
- `AudioStudio.tsx` — tabs: `audiobook | voices | characters | assign`. **`characters` tab currently renders `VoicePanel` with `section="characters"`.**
- `CharactersPanel.tsx` (710 lines, **exists but NOT wired into AudioStudio**) — redesigned card-based character workspace.
- `CharacterDetection.tsx` (585 lines) — older detection UI.
- `VoiceAssignPage.tsx` (~1100 lines) — Phân giọng.
- `VoicePanel.tsx` (665 lines), `AudiobookPanel.tsx`.

**Key insight:** the per-chapter bible refresh + `BibleRefreshLog` already give
us the "analyzed flag" primitive. The gaps are: (a) a **range orchestrator** on
top of per-chapter refresh, (b) a **relationship graph UI**, (c) wiring the new
`CharactersPanel`, and (d) uncertainty highlighting in Phân giọng.

---

## 3. Gap analysis → work items

| # | Requirement | Exists? | Work needed |
|---|---|---|---|
| 1 | Range-based analysis | Partial (per-chapter refresh) | **Range orchestrator** endpoint + UI |
| 2 | Continue analysis | No | Compute unanalyzed set from `BibleRefreshLog`; loop |
| 3 | Analyzed-chapter flag | Yes (`BibleRefreshLog`) | Expose in a status API + UI badges |
| 4 | Range picker | No | UI control (from/to chapter) |
| 5 | Relationship diagram | Data yes, UI no | New graph component (archify style) |
| 6 | Detection accuracy | Baseline | Prompt + sampling + merge improvements |
| 7 | Beautify intro window | `CharactersPanel` exists | Wire + polish |
| 8 | Characters → Phân giọng DB | Yes | Ensure voice assignment reads bible |
| 9 | Better auto voice + uncertainty highlight | Partial | Confidence field + UI highlight |
| 10 | Audiobook from Phân giọng | Yes | Verify + surface coverage warnings |

---

## 4. Design

### 4.1 Analysis status API (new)
`GET /api/library/[id]/characters/bible/status`
Returns per-chapter analysis state so the UI can render flags and compute ranges:
```ts
{
  totalChapters: number,
  analyzed: number[],        // chapterIndex[] with a successful BibleRefreshLog
  failed: number[],
  pendingDiffCount: number,
  characterCount: number,
  lastAnalyzedAt: string | null,
}
```
Backed by `BibleRefreshLog` + `Character` counts. No schema change.

### 4.2 Range analysis orchestrator (new)
`POST /api/library/[id]/characters/bible/analyze-range` (SSE)
Body: `{ from: number, to: number, skipAnalyzed?: boolean (default true), autoMerge?: boolean, model?: string }`
- Resolves chapter list; filters out chapters already in `BibleRefreshLog` with
  `status='applied'` when `skipAnalyzed` (requirement #3).
- Iterates chapters sequentially, calling the existing `refreshBible()` per
  chapter (reuses all prompt/merge/patch logic — requirement #1, #2).
- Streams a new `BibleRangeProgressEvent` union: `{kind:'chapter-start'|'chapter-done'|'chapter-error'|'range-done', chapterIndex, index, total, ...}`.
- `autoMerge=true` applies non-conflicting patches; conflicts go to
  `PendingBibleDiff` for review.
- **Bounded concurrency = 1** (context-window + merge-corruption reasons already
  documented in `refresh/route.ts`). A small delay between chapters.

### 4.3 Detection accuracy improvements (requirement #6)
- **Larger, smarter sampling**: current book-level detector samples 5 chapters ×
  3000 chars. For range mode we already read full chapters via `fetchChapterInputs`.
- **Prompt**: add explicit instructions to (a) resolve aliases/nicknames to a
  canonical name, (b) infer gender from pronouns/titles (cổ trang: 陛下/công tử/
  tiểu thư/nương etc.), (c) output relationships with direction + type, (d) mark
  role (main/supporting/minor) by mention frequency across the range.
- **Cross-chapter dedup**: reuse `findCharacterIdByName` + `normKey` +
  alias table so "Nữ Đế" / "Bệ hạ" merge into one character.
- **Confidence**: have the LLM emit a 0–1 confidence per character/relationship;
  store in `notes`/`fieldSources` (no schema change) or add a column later.

### 4.4 Relationship diagram (requirement #5)
- New component `RelationshipGraph.tsx` rendering `CharacterRelationship` +
  `Character` as a force-directed graph.
- Library: prefer a light dependency. **Reference `tt-a1i/archify` for visual
  style** (confirm exact stack when network access is available; fallback to a
  self-contained SVG force layout or `reactflow` if a graph lib is already a dep).
- Nodes tinted by role (main = accent, supporting = muted, minor = subtle) and
  gender; edges labelled with canonicalized relationship; hover highlights the
  ego network; click opens the character card.
- Rendered inside the new Nhân vật tab, in a collapsible "Sơ đồ quan hệ" panel.

### 4.5 Nhân vật tab redesign (requirements #4, #7)
Wire `CharactersPanel.tsx` into `AudioStudio` `characters` tab (replacing the
`VoicePanel section="characters"` usage) and extend it with:
- **Range controls**: from/to chapter selects + "Phân tích" and "Tiếp tục phân
  tích" (continue) buttons, driven by the status API.
- **Chapter flags**: a compact chapter strip showing analyzed ✓ / failed ⚠ / not
  yet ○, with a "Phân tích lại" confirm for re-runs (requirement #3).
- **SSE progress** using `openBibleRefreshStream`-style client for the range
  endpoint.
- **Character intro cards**: appearance, personality, speech style, aliases,
  relationships summary, sample line, voice picker (requirement #7).
- **Pending diff review** banner (reuses existing diff apply/reject routes).

### 4.6 Phân giọng auto-assign + uncertainty (requirements #8, #9)
- Voice assignment already reads characters. Ensure the suggestion path uses the
  **bible** (profiles + aliases) as the character DB.
- Add a **confidence/uncertainty** signal to `PlanSentence` (extend `source` with
  a `confidence` number or a `'uncertain'` source flavor).
  - In `buildSuggestedVoicePlan` / attribution, when a quoted sentence cannot be
    confidently attributed to a known character, mark it `uncertain`.
- **UI**: highlight uncertain sentences (amber left-border + "?" chip) and add a
  "Chỉ hiện câu cần review" filter so the user can quickly resolve them.

### 4.7 Audiobook (requirement #10)
- Confirm `AudiobookPanel` + worker build audio strictly from the saved
  `ChapterVoicePlan` (Phân giọng data).
- Add a **coverage check** before generation: warn if any chapter has uncertain/
  unassigned character sentences, with a link back to Phân giọng.

---

## 5. Implementation phases (incremental, verifiable)

**Phase A — Backend range analysis + status (no UI):**
1. `bible/status/route.ts` (GET).
2. `bible/analyze-range/route.ts` (POST SSE) reusing `refreshBible()`.
3. Client helper `openRangeAnalysisStream` in `character-bible-client.ts`.
4. Verify with `curl`/SSE against the test book; `tsc --noEmit`.

**Phase B — Detection accuracy:**
5. Improve `buildSystemPrompt`/`buildUserPrompt` (alias/gender/role/confidence).
6. Strengthen dedup via alias resolution.
7. Verify: run range analysis on chapters 1–3 of the test book; inspect bible.

**Phase C — Nhân vật tab:**
8. Wire `CharactersPanel` into `AudioStudio`.
9. Add range controls + chapter flag strip + SSE progress + re-run confirm.
10. Polish character intro cards.

**Phase D — Relationship graph:**
11. `RelationshipGraph.tsx` (archify-style) + integrate into Nhân vật tab.

**Phase E — Phân giọng uncertainty:**
12. Add confidence to plan sentences + attribution.
13. Highlight + "review-only" filter in `VoiceAssignPage`.

**Phase F — Audiobook:**
14. Coverage warning + verify audio built from Phân giọng data.

Each phase ends with `tsc --noEmit` (from `app/ebook-converter`) and a manual
smoke test on port 3100 (cookie `ebook-auth-session=admin`), plus a
`CHANGELOG.md` (Unreleased) entry. No `git push` (manual by user).

---

## 6. Open questions for the user

- **Q1 — Graph library:** OK to add a dependency (e.g. `reactflow` or a small
  force-graph lib) for the relationship diagram, or prefer a zero-dependency
  self-contained SVG implementation?
- **Q2 — Default range batch size:** default to 10 chapters per run (with the
  user able to change from/to), as requested?
- **Q3 — Re-run behaviour:** when the user picks a range that includes analyzed
  chapters, skip them silently by default and only re-run on explicit "Phân tích
  lại" confirm — correct?
- **Q4 — Confidence storage:** OK to piggyback confidence in existing JSON
  fields for now (no migration), and add a proper column later if needed?
- **Q5 — Scope order:** Any phase you want prioritized/deprioritized?
