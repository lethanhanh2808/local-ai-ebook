# Next-up Plan — Local-AI ebook-converter

**Created:** 2026-07-24
**Author:** Claude
**Status:** Phase 1 in progress
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

> **Status:** 🟡 In progress (1.1 done ✅, 1.2 done ✅, 1.3 pending ⬜)
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

> **Status:** ⬜ Pending (optional)
> **Effort:** ~1 hour
> **Files:** `app/ebook-converter/.eslintrc.json` (update)

`package.json` defines `"lint": "eslint . --max-warnings=0"` but `next lint` prompts interactively. The repo has a stub `.eslintrc.json` from 2026-05-24; check whether it can be enabled. Optional — if it's quick, do it; otherwise defer.

**Acceptance:** `npm run lint` exits non-interactively. Defer if it's bigger than 1 hour of work.

---

## Phase 2 — Interior image preservation

> **Status:** ⬜ Pending (depends on Phase 1.1)
> **Goal:** Carry interior content images through the conversion pipeline, not just the cover.
> **Effort:** ~3-4 days

### 2.1 Add `images` field to `EpubBuildInput`

> **Status:** ⬜ Pending
> **Files:** `app/ebook-converter/src/lib/pipeline/epub-builder.ts`

Add `images?: Array<{ id: string; href: string; data: Buffer; mediaType: string }>` to `EpubBuildInput`. In `buildEpub`:

- For each image, `zip.addBuffer(image.data, 'EPUB/images/' + image.href)`.
- Emit `<item id="…" href="images/…" media-type="…"/>` in the manifest (general `<item>` loop, not the cover branch).

**Acceptance:** `EpubBuildInput` accepts an image collection; the manifest has one `<item>` per image; each image is in the output ZIP at the expected path.

### 2.2 Stop stripping interior images + rewrite `<img src>`

> **Status:** ⬜ Pending
> **Files:** `app/ebook-converter/src/lib/pipeline/conversion-pipeline.ts`

Replace `stripImages` with `rewriteImageSources(body, imageMap)` in `makeChapter`. The new function:

- For each `<img src="…">` in the body, look up the src in the imageMap (built from `epub.imageFiles` + OPF-relative resolution).
- If found, rewrite the src to `../images/<basename>` (chapters live at `EPUB/chapterN.xhtml`; images at `EPUB/images/…`).
- If NOT found, leave the src alone (output shows broken image rather than silently dropping content).

Pass the image collection to `buildEpub` in Step 7.

**Acceptance:** `runConversionPipeline` against `fixture-illustrated-novel.epub` produces an output with all 3 interior images + the cover; the chapter HTML has rewritten `<img src>`; the OPF has 4 image items; the output opens in a reader.

### 2.3 Handle data-URI images

> **Status:** ⬜ Pending
> **Files:** Same `conversion-pipeline.ts`, new helper `decodeDataUriImages(body, imageSink)`

For each `<img src="data:image/png;base64,...">`:
- Decode the base64 → Buffer.
- Generate a deterministic filename (`inline-1.png`, `inline-2.png`).
- Add to the image collection.
- Rewrite the `src` to `../images/inline-1.png`.

**Acceptance:** The fixture's data-URI image is extracted to a file in the output; the chapter src is rewritten.

### 2.4 Tests

> **Status:** ⬜ Pending
> **Files:** `app/ebook-converter/src/tests/image-preservation.test.ts` (new)

End-to-end test that runs `runConversionPipeline` against the fixture EPUB and asserts:

- All 4 image files are in the output ZIP (1 cover + 3 interior).
- The OPF manifest has `<item>` entries for all 4 with correct `media-type`.
- Chapter HTML has rewritten `<img src="…">` pointing to `../images/…`.
- The data-URI image was extracted to a file and is no longer a `data:` URL.
- The output passes `epub-validator` (existing test).

**Acceptance:** 4-5 new test cases; all green; `npx vitest run` reports 200+/200+.

---

## Phase 3 — Backlog items

> **Status:** ⬜ Pending
> **Goal:** Polish the easy wins while Phase 2 is fresh.
> **Effort:** 1-2 days

### 3.1 `git rm --cached` for runtime artifacts (the commit side of 1.2)

> **Status:** ⬜ Pending
> **Files:** `.gitignore`, git history

The git-side commit of the Phase 1.2 cleanup:

```
git rm --cached omlx-home/stats.json
git rm --cached app/ebook-converter/dump.rdb dump.rdb
# Add to .gitignore
git commit -m "chore(gitignore): untrack runtime artifacts (stats.json, dump.rdb)"
```

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
