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

> **Status:** ⬜ Pending
> **Goal:** Polish the easy wins while Phase 2 is fresh.
> **Effort:** 1-2 days

### 3.1 `git rm --cached` for runtime artifacts (the commit side of 1.2)

> **Status:** ✅ Done (2026-07-24)
> **Files:** git index

**Result:** `omlx-home/stats.json` removed from the index (file kept on disk per plan). The directory is already excluded by parent `.gitignore` line `omlx-home/`, so the file falls out of git's view automatically. The other gitignored dirs that were also missing files (`dump.rdb` at repo root + `app/ebook-converter/dump.rdb`) were already correctly untracked before this session and the on-disk files were removed in Phase 1.2 — nothing to do.

Three sibling files (`omlx-home/bin/omlx`, `model_settings.json`, `settings.json`) remain tracked because they predate the `omlx-home/` gitignore entry and the plan only requested `stats.json`. Leaving them as-is keeps the diff focused.

### 3.2 D2 per-genre `score >= 0.42` threshold

> **Status:** ⬜ Pending
> **Files:** `app/ebook-converter/src/lib/attribution.ts`

The current code uses a single threshold for all genres. `ACTION_ITEMS.md` §D2 notes that modern vs cổ trang Vietnamese novels need different floors. Add a `genre → minScore` map. Plumb the book's genre into the attribution call (fall back to the global default if unknown). Add a regression test.

**Acceptance:** New test case; attribution rates don't regress on the existing `chapter005` measurement (≥13/22 fixed).

### 3.3 D9 Python-side actor alternation bump parity

> **Status:** ⬜ Pending
> **Files:** `app/tts-service/conversation_attribution.py`

Mirror the JS engine's `actor alternation bump (0.36 → 0.48 inside detected alternation)` from `ACTION_ITEMS.md` §E3 in the Python port. Implement the same bump with the same conditions.

**Acceptance:** 203+ Python tests still pass; measure script on `chapter005` shows the actor-alternation rows improving or staying the same.

---

## Phase 4 — Roadmap items

> **Status:** ⬜ Pending (pick one per session)
> **Goal:** Bigger features from `PROJECT_REVIEW_AND_RECOMMENDATIONS.md`.

These are independent of each other and of Phases 1-3. Pick one when there's bandwidth.

### 4.1 Deterministic Playwright fixture EPUB for E2E

> **Status:** ⬜ Pending
> **Effort:** ½ day
> **Files:** `app/ebook-converter/e2e/fixtures/minimal-novel.epub` (new), `app/ebook-converter/e2e/_seed.spec.ts` (new)

A SECOND fixture — much simpler (1 chapter, no images, no cover, minimal metadata) — for Playwright E2E. The existing `samples/` books are too big and stateful for `npm run test:e2e:local:smoke`.

**Why:** The E2E suite (8 specs) currently depends on whatever's in the user's library. A fixture makes the suite deterministic and lets it run in CI.

**Acceptance:** New minimal fixture; new seed spec; existing smoke tests re-pointed at the fixture.

### 4.2 One-click local service restart in Settings

> **Status:** ⬜ Pending
> **Effort:** ½ day
> **Files:** `app/ebook-converter/src/app/api/services/restart/route.ts` (new), `app/ebook-converter/src/components/status/ServiceHealth.tsx` (update)

The `ServiceHealth` component already shows "is this up?"; this adds "and here's a button to restart it". New local-only POST API route that calls the per-service stop/start script. Guard with `process.env.NODE_ENV === 'development'`.

**Acceptance:** "Restart" button on the Settings health panel; safe to use during a session without orphaning the worker.

### 4.3 Calibre-based optional import pipeline

> **Status:** ⬜ Pending (gated)
> **Effort:** 1 week
> **Files:** `app/ebook-converter/src/lib/import/calibre.ts` (new), `app/ebook-converter/src/app/api/import/calibre/route.ts` (new), upload UI updates

Wrap Calibre's `ebook-convert` for PDF/DOCX/MOBI/AZW3 → EPUB. New route; new Settings → Importers section that probes `which ebook-convert` and reports availability. Update the upload UI to show "Calibre" as a fallback option for the currently-disabled formats (gated on Calibre being installed).

**Why gated:** Requires Calibre to be installed; we don't want to break the "no Calibre" experience. The feature should be discoverable but not advertised in the default upload UI.

**Acceptance:** A PDF and a DOCX convert to a valid EPUB via the new path; the `samples/` PDF cases (none today) get a real pipeline.

### 4.4 Character merge/split UI with confidence review

> **Status:** ⬜ Pending
> **Effort:** 1-2 days
> **Files:** `app/ebook-converter/src/components/library/CharacterMergePanel.tsx` (new), 2 new API routes

The Character Bible already tracks per-character confidence. Add a UI:

- A "needs review" badge for low-confidence aliases.
- A merge flow: select two characters, see the unified preview, confirm.
- A split flow: select a character, see its aliases, mark which are wrong.
- Persist via existing `BookCharacterBible` Prisma model.

**Acceptance:** Two new API routes (`/api/library/[id]/characters/merge`, `/api/library/[id]/characters/split`); new UI panel; existing 195/195 JS tests still pass.

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
