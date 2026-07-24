# Next-up Plan — Local-AI ebook-converter

**Created:** 2026-07-24
**Author:** Claude
**Status:** Phase 1 done ✅, Phase 2 next
**Source of truth:** this document is the canonical plan; `TodoWrite` tracks the active task.

## Current state (as of 2026-07-24)

Last 3 commits on `main`:

```
c32c2521 fix(cover): pass source cover through conversion pipeline
1b063797 feat(watermark): retro rerun endpoints + 'apply to library' batch UI
cf3a9a85 refactor(watermark): shared tag-aware detector + wrapper-aware strip
```

**Quality bar:** 195/195 tests passing, `tsc --noEmit` clean, working tree clean.

The two big remaining functional gaps:

1. **Interior content images are still stripped** during conversion (the cover pass-through we just shipped only handled the first image).
2. **Several roadmap items are on the shelf** (Playwright fixtures, one-click restart, Calibre import, etc.).

This plan addresses them in dependency order. **Do them in the order listed.**

---

## Phase 1 — Foundation

> **Status:** ✅ Done (2026-07-24)
>
> **Goal:** Unblock the rest of the work by adding a deterministic test fixture and cleaning up housekeeping.

### 1.1 Add a deterministic illustrated fixture EPUB

> **Status:** ✅ Done (2026-07-24)
> **Effort:** ~4 hours
> **Files:** `app/ebook-converter/scripts/build-fixture-epub.mjs` (new), `app/ebook-converter/samples/fixture-illustrated-novel.epub` (new, committed), `app/ebook-converter/samples/fixture-illustrated-novel.epub.sha256` (new)

**Result:**
- Fixture: 12 entries, 21 KB, SHA256 `5f893ddd179ccab41343ea224862450a7e12bf0d95150cf2f98b006a21469fdc`
- `parseEpub` reads it correctly: 5 HTML files (cover + 4 chapters), 3 images, 4 TOC entries, all metadata populated
- Chapters 1 and 4 have no `<img>` (control cases); chapter 2 has both an inline `figure-1.png` AND a base64 data-URI image; chapter 3 has a block-level figure
- `npx vitest run` reports **195/195** passing (no test depends on the fixture yet — that's Phase 2)
- `npx tsc --noEmit` clean

A tiny, hand-built EPUB committed to the repo. Gives the next round of tests a stable target.

**Spec:**
- 1 cover image (`OEBPS/Images/cover.png`, 600×900, sharp-generated with constant color)
- 3 inline content images:
  - 1 `<img>` inside a `<p>` (figure inline)
  - 1 `<img>` between two `<p>`s (block-level figure)
  - 1 data-URI image (`data:image/png;base64,...`) to exercise the base64 → file path
- 4 chapters (varied lengths)
- Deterministic bytes (no timestamp, no machine-specific paths)
- ~50 KB total
- A `.sha256` sidecar so the test suite can assert no accidental modifications

**Build helper:** `scripts/build-fixture-epub.mjs` (one-off; uses `sharp` + `yazl` directly to produce a valid EPUB structure).

**Acceptance:**
- `unzip -l samples/fixture-illustrated-novel.epub` shows the expected entries
- File is checked in and ~50 KB
- SHA256 sidecar matches the on-disk file
- `npx vitest run` is still 195/195 (no test depends on it yet — that's Phase 2)

### 1.2 Clean up runtime artifacts in the repo

> **Status:** ✅ Done (2026-07-24)
> **Effort:** ~30 min
> **Files:** `.gitignore` (no change needed — already covers all of these), `omlx-home/stats.json` (already untracked + file removed), `dump.rdb` × 2 (already untracked; files removed from disk), `app/ebook-converter/.tmp-*.mjs` × 4 (deleted from disk)

**Result:**
- `omlx-home/stats.json` had already been untracked and the file deleted in the cover-pass-through commit session (2026-07-24, before this plan).
- `dump.rdb` × 2 (`/` + `app/ebook-converter/`) — already correctly covered by `dump.rdb` rule on line 33 of parent `.gitignore`; not tracked. Files deleted from disk (73 KB each — Redis snapshot leftover).
- `app/ebook-converter/.tmp-borders.mjs`, `.tmp-spread-diag.mjs`, `.tmp-spread-test.mjs`, `.tmp-spread-verify.mjs` — 4 spread-mode diagnostic scratch scripts from the 2026-07-11 reader polish work. Deleted from disk (17 KB total).
- After cleanup: `git status --porcelain` returns only the two user-library sample EPUBs (`bat-dau-100-trieu-nam-tu-vi.epub`, `trong-sinh-ai-con-lam-minh-tinh.epub`) which are correctly gitignored.

No commit needed — all artifacts were already correctly untracked; only on-disk files needed removal.

### 1.3 ESLint config

> **Status:** ✅ Done (was already in place; verified 2026-07-24)
> **Effort:** ~0 (no work needed)
> **Files:** `app/ebook-converter/.eslintrc.json` (already extended from `next/core-web-vitals`)

`package.json` defines `"lint": "eslint . --max-warnings=0"` and `.eslintrc.json` extends `next/core-web-vitals`. `npx eslint --print-config` confirms 52 resolved rules (Next.js core-web-vitals defaults including `@next/next/no-html-link-for-pages`, `google-font-display`, etc.). The lint gate was already wired up in the 2026-07-10 round and is documented in `CHANGELOG.md` ("Added a non-interactive ESLint configuration and made warnings fail the lint gate").

**Verification:** `npm run lint` runs fully non-interactively today and is part of `npm run verify`.

---

## Phase 2 — Interior image preservation

> **Status:** ✅ Done (2026-07-24)
> **Goal:** Carry interior content images through the conversion pipeline, not just the cover.
> **Effort:** ~3-4 days

### 2.1 Add `images` field to `EpubBuildInput`

> **Status:** ✅ Done (2026-07-24)
> **Files:** `app/ebook-converter/src/lib/pipeline/epub-builder.ts` (new field + emission loop + `sanitizeImageHref` helper), `app/ebook-converter/src/tests/epub-builder-images.test.ts` (new — 5 cases)

**Result:**
- `EpubBuildInput.images?: EpubImage[]` with `{ id, href, data, mediaType }`.
- `buildEpub` emits each image under `EPUB/images/<sanitized-href>` and adds one `<item id=… href="images/…" media-type="…"/>` per image in the manifest, after the cover row but before the chapter rows. De-dupes ids and hrefs against reserved names (`nav`, `ncx`, `css`, `cover-image`, `cover-page`, etc.) — collisions get a `-N` suffix instead of being silently dropped. Image hrefs are sanitized (`subdir/x.png` → `x.png`, `..`/`.hidden.png`/`""` dropped, illegal chars replaced with `_`).
- 5 new unit tests cover: happy path + byte fidelity, manifest ordering vs chapters, cover-href collision skips the rogue row, sanitization rules, and id/href dedupe. All green; **200/200** total tests now pass (was 195/195).
- Next step: Phase 2.2 wires the conversion pipeline into this field and starts rewriting `<img src>` against the image map instead of stripping it.

### 2.2 Stop stripping interior images + rewrite `<img src>`

> **Status:** ✅ Done (2026-07-24)
> **Files:** `app/ebook-converter/src/lib/pipeline/conversion-pipeline.ts` (`buildImageResolver`, `rewriteImageSources`, `collectInteriorImages`, threaded through `makeChapter`, image collection passed to `buildEpub`)

**Result:** Every `<img src>` in a real EPUB chapter body is now resolved against the source's image entries (OPF-relative, with `..`/`./` normalisation + case-insensitive fallback). Resolved srcs are rewritten to the unified `../images/<basename>` form (the layout `buildEpub` owns). Unresolved srcs are left untouched — the reader will show a broken-image marker rather than silently dropping content. Cover entry is filtered from the interior-images collection so the cover branch and the interior branch don't double-emit. `stripImages` is retained as a legacy fallback for the `buildMinimalEpubFromFile()` non-EPUB path.

### 2.3 Handle data-URI images

> **Status:** ✅ Done (2026-07-24)
> **Files:** same `conversion-pipeline.ts` (`extractDataUriImages`, `normalizeImageExt`)

**Result:** Any `<img src="data:image/<ext>;base64,<payload>">` in a chapter body is decoded to a `Buffer`, named `inline-N.<ext>` (deterministic — collision-free across chapters), and added to the `EpubImage[]` collection (id prefix `img-inline-`). The src is rewritten to `../images/inline-N.<ext>` so the reader resolves it the same way it resolves file-backed figures. Bad payloads (decode fails, empty buffer) are left untouched so they don't break the build.

### 2.4 Tests

> **Status:** ✅ Done (2026-07-24)
> **Files:** `app/ebook-converter/src/tests/image-preservation.test.ts` (new — 1 end-to-end test covering all 4 images)

**Result:** End-to-end test runs `runConversionPipeline` against `samples/fixture-illustrated-novel.epub` and pins:
- All 4 image files (`cover.png`, `figure-1.png`, `figure-2.png`, `inline-1.png`) present in the output ZIP at `EPUB/images/…`
- OPF manifest has one `<item>` per image with the right `media-type`
- Cover row retains `properties="cover-image"`; interior rows do not
- Chapter HTML has rewritten `<img src="../images/<basename>">`; no `../Images/` (source casing) or `data:` URIs remain
- Total: **201/201** tests pass (was 200/200 after Phase 2.1).

### Bonus fix: cover pages no longer sneak in as Chapter 1

> **Status:** ✅ Done (2026-07-24)
> **Files:** `app/ebook-converter/src/lib/pipeline/conversion-pipeline.ts` (new `looksLikeCoverPage` helper; used to filter `epub.htmlFiles` before chapter construction in both branches)

**Result:** Source EPUBs whose cover is rendered as its own XHTML page (`cover.xhtml`/`title.xhtml` with `<body class="cover-page">`/`epub:type="cover"`/`epub:type="frontmatter">`) used to slip through the "skip cover-only chapters" filter because the embedded `<img>` + `<section>` whitespace pads the body text past the 20-char floor. The result was an extra "Chapter 1" with a broken `src="../Images/…"` reference (since the cover branch already consumed the cover bytes) sitting at the start of every converted book. The Phase 2.4 test surfaced this; the fix is a body-attribute heuristic in `looksLikeCoverPage` that filters these pages out before chapter construction. The cover branch in `buildEpub` is unchanged — it still owns the cover image + spine row.

---

## Phase 3 — Backlog items

> **Status:** ✅ Done (3.1 ✅, 3.2 ✅, 3.3 ✅)
> **Goal:** Polish the easy wins while Phase 2 is fresh.
> **Effort:** 1-2 days

### 3.1 `git rm --cached` for runtime artifacts (the commit side of 1.2)

> **Status:** ✅ Done (2026-07-24)
> **Files:** git index

**Result:** `omlx-home/stats.json` removed from the index (file kept on disk per plan). The directory is already excluded by parent `.gitignore` line `omlx-home/`, so the file falls out of git's view automatically. The other gitignored dirs that were also missing files (`dump.rdb` at repo root + `app/ebook-converter/dump.rdb`) were already correctly untracked before this session and the on-disk files were removed in Phase 1.2 — nothing to do.

Three sibling files (`omlx-home/bin/omlx`, `model_settings.json`, `settings.json`) remain tracked because they predate the `omlx-home/` gitignore entry and the plan only requested `stats.json`. Leaving them as-is keeps the diff focused.

### 3.2 D2 per-genre `score >= 0.42` threshold

> **Status:** ✅ Done (2026-07-24)
> **Files:** `app/ebook-converter/src/lib/attribution.ts` (`MIN_SCORE_BY_GENRE` map + `getMinScoreForGenre` + `resolveBookGenre`), `app/ebook-converter/src/app/api/library/[id]/chapters/[chapterId]/attribute/route.ts`, `app/ebook-converter/src/app/api/library/[id]/chapters/[chapterId]/attribute/analyze/route.ts` (3 call sites), `app/ebook-converter/src/tests/attribution-genre-threshold.test.ts` (new — 8 cases)

**Result:** The hardcoded 0.42 floor inside `attributeByConversation` is now a per-genre threshold drawn from a `MIN_SCORE_BY_GENRE` map:

| Genre | Floor | Why |
| --- | --- | --- |
| `tu_tieu_thuyet`, `kiếm_hiệp`, `huyền_huyễn` | 0.48 | Heavy internal monologue + named-character narration → stricter floor so weak hits don't surface as wrong speakers. |
| `cổ_trang`, `lich_su` | 0.46 | Elaborate honorifics + role nouns the regex layer can't disambiguate → strict. |
| `do_thi`, `khoa_hoc_vien_tuong`, `game_system` | 0.40 | Modern urban / sci-fi / system novels are usually close-third dialogue; moderate. |
| `ngon_tinh`, `thieu_nien` | 0.38 | Short low-confidence continuity turns; relax so "Em yêu anh." doesn't drop to default voice. |
| `kinh_di` | 0.36 | Narrator-heavy; relax so possession / monologue works. |
| (unknown / null / empty / non-Vietnamese-novel) | **0.42 (legacy default)** | Safe fallback preserves existing attribution rates for books the detector can't classify. |

Implementation:
- `MIN_SCORE_BY_GENRE` exported from `attribution.ts` (private), with `getMinScoreForGenre(...)` exposing the lookup. Returns the legacy 0.42 for null/blank/unknown keys and resolves common synonyms (`co_trang → cổ_trang`, `ngôn_tình → ngon_tinh`, `tu_tiên → tu_tieu_thuyet`, `đô_thị → do_thi`, `lịch_sử → lich_su`).
- `ConversationAttributionInput` gains an optional `genre?: string | null` field. The legacy `attributeConversationChapter` wrapper forwards it transparently so the measure/backfill scripts pick up the same behaviour without code changes.
- Cheap helper `resolveBookGenre(book)` wraps `detectGenre` (the existing cover-detector keyword matcher — no LLM, no schema change, no migration) and returns `null` for the "unknown" case. Routes thread the result of this helper into every `attributeByConversation` call.
- `attributeByConversation` reads `genre` once at the top of the function, looks up the floor, and uses it in place of `0.42` for the final "bestBucket.score >= minScore" gate. Unknown / null genre → old behaviour.
- Both routes (`attribute/route.ts` GET + `attribute/analyze/route.ts` SSE) thread the book's `title` + `titleVi` + `description` through `resolveBookGenre` once per request. The analyze route surfaces the detected genre in the SSE `init` log so the user sees which floor was applied.

Tests:
- 8 new cases in `attribution-genre-threshold.test.ts` cover: the legacy 0.42 default fallback, strict floors for cultivation / cổ trang / lịch sử, the relaxed romance floor, the accent-stripping synonym resolver, an end-to-end `attributeByConversation` propagation check, weak-evidence drop under strict cultivation, and `resolveBookGenre` over five book shapes (cultivation / tu-vi / romance / unrecognised / empty).
- Total: **209/209** tests pass (was 201/201); `tsc --noEmit` clean. No regression on the existing 7 attribution tests.

### 3.3 D9 Python-side actor alternation bump parity

> **Status:** ✅ Done (2026-07-24)
> **Files:** `app/ebook-converter/src/lib/attribution.ts` (bump ported), `app/ebook-converter/src/tests/attribution.test.ts` (1 new JS test), `app/tts-service/tests/test_actor_alternation_bump.py` (new — 4 Python cases)

The Python port already had the bump (constants `ACTOR_BASE_WEIGHT = 0.36` / `ACTOR_ALT_WEIGHT = 0.48`, conditional `actor_weight = ACTOR_ALT_WEIGHT if alternation_strength > 0 else ACTOR_BASE_WEIGHT`). The JS engine's flat `0.36` actor weight had regressed away from the spec listed in `ACTION_ITEMS.md` §E3. This commit:

1. **Ports the bump JS-side.** The `roles.actor` block in `attributeByConversation` now reads `alternationActive = !!(lastTurn && previousTurn && lastTurn !== previousTurn)` and applies `0.48` inside detected alternation, `0.36` outside. The evidence `detail` row surfaces `"alternating turn — bumped"` vs the legacy `"last named actor before/around the quote"` so the regression test (and downstream consumers) can tell which branch fired.

2. **Adds a JS-side regression test** in `attribution.test.ts` that pins both branches: when alternation is detected the timeline evidence row carries the bumped 0.48 weight + bumped detail; when alternation is NOT detected the resolved paragraph falls back to the previous speaker (Lan) because the 0.36 base weight can't out-score the scene-memory continuation branch (0.38).

3. **Adds a Python-side regression test** (`test_actor_alternation_bump.py`, 4 cases) that pins: constants `0.36 / 0.48`, the bump fires on alternating seed history, no bump on same-speaker history, no bump on history length < 2. Tests seed `ConversationStateSnapshot.dialogueHistory` directly so they don't depend on a multi-paragraph walk to reach the bump-detection branch.

Test totals (Phase 3.3): **210/210 JS** tests pass (was 209/209 after Phase 3.2; +1 from the new alternation test; `tsc --noEmit` clean). Python: 187 baseline tests + 4 new = 191 total collected; 4 pre-existing env errors (missing `fastapi` import, missing `_TIER3B_AVAILABLE` attribute on `audiobook_generator`, missing `vncorenlp_attribution` module) are unrelated to this change — same errors verified via `git stash` round-trip. The new Python tests all pass locally; CI (with full `requirements-test.txt` deps installed) is expected to reach the 203+ bar noted in `ACTION_ITEMS.md`.

Acceptance: bump mechanic cross-validated on both engines; behaviour outside alternation unchanged on both sides.

---

## Phase 4 — Roadmap items

> **Status:** ⬜ Pending (pick one per session)
> **Goal:** Bigger features from `PROJECT_REVIEW_AND_RECOMMENDATIONS.md`.

These are independent of each other and of Phases 1-3. Pick one when there's bandwidth.

### 4.1 Deterministic Playwright fixture EPUB for E2E

> **Status:** ✅ Done (2026-07-24)
> **Files:** `app/ebook-converter/scripts/build-minimal-epub-fixture.mjs` (new — deterministic builder), `app/ebook-converter/e2e/fixtures/minimal-novel.epub` (new — 2.98 KB, 5 entries, SHA256 `1f3164d7…`), `app/ebook-converter/e2e/fixtures/minimal-novel.epub.sha256` (new — sidecar), `app/ebook-converter/src/tests/minimal-fixture-epub.test.ts` (new — 1 case pinning SHA + parse shape), `app/ebook-converter/e2e/seed-fixture.global-setup.ts` (new — Playwright globalSetup seed), `app/ebook-converter/e2e/helpers.ts` (env > seed-file > legacy fallback), `app/ebook-converter/playwright.config.ts` (wires globalSetup; `E2E_SKIP_SEED=1` opt-out), `app/ebook-converter/e2e/README.md` (documents fixture + seed flow), `.gitignore` (scoped negations for `e2e/fixtures/**/*.epub` + per-run `.seed-book.json` ignore)

A SECOND fixture — much simpler (1 chapter, no images, no cover, minimal metadata) — for Playwright E2E. The existing `samples/` books are too big and stateful for `npm run test:e2e:local:smoke`.

**Why:** The E2E suite (8 specs) previously depended on whatever's in the user's library. A fixture makes the suite deterministic and lets it run in CI without an uploaded book.

**Implementation:**
- **Builder (`scripts/build-minimal-epub-fixture.mjs`)** is a 224-line pure-yazl / Node-crypto script. No sharp, no PNGs, no data-URI images. Constants: `IDENTIFIER = 'urn:uuid:e2e-minimal-novel-2026-07-24'`, frozen `MODIFIED_DATE = '2026-07-24T00:00:00Z'`, 1 chapter (`ch001.xhtml`), ~10 short Vietnamese paragraphs. Writes a SHA256 sidecar next to the EPUB so the seed setup can verify integrity at startup.
- **Fixture** is exactly 2.98 KB, 5 entries (mimetype, META-INF/container.xml, OEBPS/content.opf, OEBPS/nav.xhtml, OEBPS/Text/ch001.xhtml). No cover, no images, no inline data-URIs.
- **Vitest pin (`src/tests/minimal-fixture-epub.test.ts`)** asserts: SHA matches sidecar, on-disk size < 20 KB, `parseEpub` returns metadata (title/author/language), `htmlFiles` is exactly `['OEBPS/Text/ch001.xhtml']`, `imageFiles` is `[]`, chapter has ≥ 5 paragraphs, HTML contains `id="ch001"` and the chapter title. Catches fixture drift before the E2E suite runs.
- **Playwright `globalSetup` (`e2e/seed-fixture.global-setup.ts`)** runs ONCE per `playwright` invocation. Steps: (1) verify SHA against sidecar, (2) fast-path reuse any existing library row matching `Tiểu Thuyết Tối Giản (E2E)` + `Bộ Kiểm Thử`, (3) multipart upload via `/api/upload` with `aiEnhance=false / aiWatermarkClean=false / deepFormat=false / readerFriendly=true`, (4) poll `/api/jobs` for `completed` (90 s timeout), (5) poll `/api/library` for the matching row (30 s timeout), (6) write `e2e/.seed-book.json` and set `process.env.E2E_BOOK_ID` for child specs.
- **`helpers.ts` precedence** is `E2E_BOOK_ID` env → `.seed-book.json` → legacy `ffa65ac0-…` fallback. Smoke specs that call `resolveTestBook(page)` automatically pick up the seeded fixture book.
- **CI opt-out** is `E2E_SKIP_SEED=1 E2E_BOOK_ID=<pre-baked-id>`. `playwright.config.ts` checks `E2E_SKIP_SEED` before wiring the globalSetup; existing pre-baked-library runs are unaffected.

**Acceptance:** New minimal fixture; new deterministic seed flow; smoke tests run against the fixture book by default; CI can opt out via `E2E_SKIP_SEED=1`.

Test totals: **211/211 JS tests pass** (was 210/210 after Phase 3.3; +1 from the new minimal-fixture vitest test); `tsc --noEmit` clean. Python tests untouched in this phase.

### 4.2 One-click local service restart in Settings

> **Status:** ⬜ Pending
> **Effort:** ½ day
> **Files:** `app/ebook-converter/src/app/api/services/restart/route.ts` (new), `app/ebook-converter/src/components/status/ServiceHealth.tsx` (update)

The `ServiceHealth` component already shows "is this up?"; this adds "and here's a button to restart it". New local-only POST API route that calls the per-service stop/start script. Guard with `process.env.NODE_ENV === 'development'`.

**Acceptance:** "Restart" button on the Settings health panel; safe to use during a session without orphaning the worker.

### 4.3 Calibre-based optional import pipeline

> **Status:** ✅ Done (Phase 4.3, 2026-07-24) — v1 scoped to **MOBI only**
> **Effort:** 1 day (was estimated 1 week; MOBI-only scope was 1 day)
> **Files:** see file list below

Wrap Calibre's `ebook-convert` so users can upload MOBI (Kindle) files. The worker auto-converts MOBI → staged EPUB before the regular pipeline runs. When Calibre is missing, the upload UI surfaces a Vietnamese "install Calibre" hint that links to Settings → Importers, and MOBI uploads are 415'd with a friendly message pointing at the same panel.

**Why v1 = MOBI only:** Scoping to MOBI (the most common non-EPUB input for Vietnamese-novel readers) eliminated the PDF OCR question entirely and kept the surface area small. The pre-step machinery is format-agnostic — adding PDF/DOCX/AZW3 later is just appending rows to `CALIBRE_FORMATS` + surfacing them in the UI. No architectural changes.

**Acceptance:** A real `.mobi` upload runs through `preprocess-resolve → preprocess-convert → preprocess-done` NDJSON stages and produces an EPUB that validates at the same level as a direct EPUB upload. On a Calibre-less machine, the UploadZone shows an amber banner + Settings → Importers shows a 3-row status panel (path/version/formats) with a manual "Re-check" button. 12 new tests, 252/252 total.

**Implementation details:**

- **Probe helper** — `src/lib/tools/calibre.ts` exports `probeCalibre(force)` + `convertWithCalibre(input, output, opts)`. Resolution chain: `CALIBRE_EBOOK_CONVERT` env override → 4 absolute-path candidates (`/opt/homebrew`, `/usr/local`, `/usr/bin`, `/opt/calibre`) → bare `ebook-convert` on `PATH`. Per-process in-memory cache (60s TTL). Mirrors `resolvePython()` at `src/app/api/library/[id]/characters/detect/route.ts:61-73` (no `which`, only `fs.existsSync`). `convertWithCalibre()` mirrors `convertToMp3` graceful-degradation pattern at `src/worker/audiobook.ts:217-275`.
- **Format table** — `src/lib/tools/calibre-formats.ts` single-source-of-truth array. v1 has one row (MOBI). Future formats are append-only.
- **API route** — `src/app/api/tools/calibre/route.ts` returns `{ ok, path, version, error, checkedAt, formats, bannerText, installUrl }`. 503 when missing. `?force=1` bypasses cache.
- **Worker pre-step** — `src/worker/index.ts` runs `preprocess-resolve → preprocess-convert → preprocess-done` between line 129 (`paths` log) and the pipeline call. Tick percentages 3 → 5 → 6/7 (heartbeat) → 8 (hand-off). `probeCalibre(true)` forces fresh probe in worker process. Errors throw `bullmq.UnrecoverableError` — no BullMQ retries on non-recoverable Calibre failures (avoids 2–6 min wasted attempts). Worker `lockDuration` bumped `5min → 8min` to accommodate the extra step.
- **Upload route** — `src/app/api/upload/route.ts` extends `ALLOWED_EXTENSIONS` with Calibre formats when probe succeeds, 415s MOBI uploads with a Vietnamese hint when probe fails. Queue payload gets `requiresPreprocessing: calibre.has(ext)`.
- **Queue** — `ConversionJobData.requiresPreprocessing?: boolean` (Phase 4.3).
- **UI** —
  - `<CalibrePanel>` (`src/components/status/CalibrePanel.tsx`) — 3-row status (path/version/formats), "Re-check" button, "Cách hoạt động" footer card.
  - `<UploadZone>` (`src/components/jobs/UploadZone.tsx`) — `acceptedTypes` derived from probe; amber banner + Settings link when missing; "MOBI" appended to supported-formats line when present.
  - `<ConvertPage>` (`src/app/convert/page.tsx`) — `supportedFormats` `useMemo` merges base 3 + Calibre-discovered formats for the "Định dạng hỗ trợ" card.
  - `<SettingsPage>` — 7th tab "Importers" (`<Download>` icon) at line 429-431 + matching `<TabsContent>` rendering `<CalibrePanel />` at line 1036-1039. Hash-sync allow-list extended.
- **Tests** — `src/tests/calibre-probe.test.ts` (8 cases: env override + 4 candidate paths + missing-all + cache hit + convert happy path + convert missing) + `src/tests/calibre-worker-integration.test.ts` (4 cases: MOBI fires pre-step + EPUB skips + defensive guard + missing-Calibre throws UnrecoverableError). Drops a real POSIX shim into a tempdir to drive probe + conversion organically. 12 new tests; 252/252 total.


### 4.4 Character merge/split UI with confidence review

> **Status:** ✅ Done (Phase 4.4, 2026-07-24)
> **Effort:** 1-2 days
> **Files:** see file list below

The Character Bible now has per-alias confidence. The UI exposes all three operations (merge / split / alias edit) behind a single panel with three tabs, driven by a new `CharacterAlias` Prisma side table that replaces the legacy `Character.aliases` JSON column.

**Implementation details:**

- **Schema migration** — `prisma/migrations/20260724000000_add_character_alias_confidence/migration.sql` creates the `CharacterAlias` side table, backfills from the legacy JSON column via `json_each()`, then drops the JSON column in the same migration. UUIDs are synthesised in SQL via `lower(hex(randomblob(...)))` since SQLite has no native UUID type.
- **Confidence helper** — `src/lib/ai/character-alias-confidence.ts` computes per-alias scores. Bases: `exact/normalized → 0.95`, `substring → 0.85`, `levenshtein → 0.75`, `llm → 0.6`. Modifiers: sample-lines bonus capped at +0.20, crowding decay ×0.85 per alias beyond the third. Self-alias short-circuits to 1.0 (bypasses bonus + decay). Output is clamped to [0, 1] and rounded to 2dp. Threshold constants `LOW_CONFIDENCE_THRESHOLD=0.6`, `HIGH_CONFIDENCE_THRESHOLD=0.8` drive the badge tiers via `classifyAliasScore()`.
- **DB helpers** — `src/lib/db/characters.ts` exports `mergeCharacters()` (alias reassignment with confidence-based dedup + caller overrides, appearance summing, relationship rewiring, profile absorption on conflict) and `splitCharacter()` (name-collision check, alias move with `source='user'`). Both return a discriminated `CharacterMutationResult<T>` for clean HTTP error mapping.
- **Write-through** — `src/lib/db/voices.ts` `upsertCharacters` and `src/app/api/library/[id]/characters/detect/route.ts` now persist `CharacterAlias` rows (with confidence + source + detectedInChapter) instead of JSON-stringifying into the deleted column. The read path (`listCharacters`) aggregates aliases into both `aliases: string[]` (for legacy consumers) and `aliasDetails: {id, alias, confidence, source, detectedInChapter}[]` (for the new UI).
- **API routes** —
  - `POST /api/library/[id]/characters/merge` — `{survivorId, absorbedId, aliasResolutions?}`
  - `POST /api/library/[id]/characters/split` — `{characterId, aliasesToMove[], newName, newRole?, newVoiceName?}`
  - `PATCH /api/library/[id]/characters/[characterId]/aliases/[aliasId]` — `{confidence?, source?, alias?}` (used by the "Đánh dấu sai" button)
  All three invalidate the audiobook cache via `setBookAudiobookStatus(..., 'none')` after a successful write.
- **UI panel** — `src/components/library/CharacterMergeSplitPanel.tsx` mounted on `/library/[id]/page.tsx` below `<WatermarksPanel />`. Card header carries the "needs review" badge summing `pendingCount + lowConfidenceCount`. Three tabs (`<Tabs>` primitive):
  - **Gộp (Merge)** — two `<CharacterSelect>` dropdowns, side-by-side `<CharacterSummary>`, per-shared-alias radio ("Giữ ở {survivor}" / "Giữ ở {absorbed}") defaulting to higher-confidence, `<Dialog>` confirm.
  - **Tách (Split)** — `<CharacterSelect>` for source, per-alias checkboxes with `<ConfidenceBadge>` (green/amber/red by tier), `newName` input, role `<Select>`, `<Dialog>` confirm.
  - **Aliases (review)** — collapsible `<details>` per character; per-alias confidence badge + "Đánh dấu sai" button → PATCH to `confidence=0, source='user'`.
  All three tabs share a `refetchAll()` that re-pulls the character list + bible endpoint so badges update after each write.
- **Tests** — 3 new vitest files. `character-alias-confidence.test.ts` (15 cases) covers each fold method, sample-lines bonus cap, crowding decay, self-alias short-circuit, clamping, rounding, tier classification. `character-merge-api.test.ts` (14 cases) covers merge happy path + every error branch (self-merge, survivor/absorbed not-found, profile-conflict, shared-alias default vs override) plus split (happy path, empty-aliases, name-collision, source-not-found) plus `patchCharacterAlias` (mark wrong, clamp confidence, alias-not-found). Total: **240/240 JS tests pass** (`npx tsc --noEmit` clean).

**File list (new):**

- `app/ebook-converter/prisma/migrations/20260724000000_add_character_alias_confidence/migration.sql`
- `app/ebook-converter/src/lib/ai/character-alias-confidence.ts`
- `app/ebook-converter/src/lib/db/characters.ts`
- `app/ebook-converter/src/app/api/library/[id]/characters/merge/route.ts`
- `app/ebook-converter/src/app/api/library/[id]/characters/split/route.ts`
- `app/ebook-converter/src/app/api/library/[id]/characters/[characterId]/aliases/[aliasId]/route.ts`
- `app/ebook-converter/src/components/library/CharacterMergeSplitPanel.tsx`
- `app/ebook-converter/src/tests/character-alias-confidence.test.ts`
- `app/ebook-converter/src/tests/character-merge-api.test.ts`

**File list (modified):**

- `app/ebook-converter/prisma/schema.prisma` — add `CharacterAlias` + back-relation; drop `Character.aliases` JSON
- `app/ebook-converter/src/app/api/library/[id]/characters/route.ts` — enriched wire shape (`aliasDetails`)
- `app/ebook-converter/src/app/api/library/[id]/characters/detect/route.ts` — write-through with computed confidence
- `app/ebook-converter/src/lib/db/voices.ts` — `upsertCharacters` syncs `CharacterAlias` rows
- `app/ebook-converter/src/lib/db/character-bible.ts` — `ensureCharacter` / `mergeAliasLists` / `resolveCharacterIds` use the side table
- `app/ebook-converter/src/app/library/[id]/page.tsx` — mount `<CharacterMergeSplitPanel />`

**Acceptance:** ✅ Two new API routes (`/merge`, `/split`) + a third (`/aliases/[aliasId]`) for per-alias edits; new UI panel; **240/240 JS tests pass** (vs. the 195/195 baseline in the original plan).

### 4.5 M4B audiobook export

> **Status:** ⬜ Pending
> **Effort:** 1-2 days
> **Files:** `app/ebook-converter/src/app/api/library/[id]/audiobook/m4b/route.ts` (new), `app/ebook-converter/src/components/library/AudiobookPlayer.tsx` (update)

Replace the "stream MP3" audiobook output with a single `.m4b` file that has chapter markers and embedded cover art. Requires `ffmpeg` (already in the project per `audiobook_generator.py`).

**Why:** Most podcast/audiobook apps prefer M4B (single file, chapter-aware, cover art). Users currently get a folder of MP3s.

**Acceptance:** "Export as M4B" button on the audiobook player; the resulting `.m4b` opens in Apple Books / Voice / etc. with chapter markers visible.

---

## Sequencing

If you have 1 week: **Phase 1 → Phase 2 → Phase 3**.

If you have 2 weeks: **Phase 1-3 + one of Phase 4.1-4.5** (pick 4.1 first to unblock E2E, then 4.4 for character work).

If you only have 1 day: **Phase 1 only**.

---

## What I will NOT do

- Refactor the watermark split-detection branch (already done in this session).
- Touch the EPUB3 / nav / NCX output structure (already solid).
- Replace VieNeu with anything (only Vietnamese TTS path; no fallback).
- Bulk-rewrite existing test files. Add to the suite, don't churn it.

---

## Status legend

- ⬜ Pending
- 🟡 In progress
- ✅ Done
- ⛔ Blocked (with reason)
