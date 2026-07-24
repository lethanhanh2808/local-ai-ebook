# Changelog

All notable changes to the Local-AI ebook conversion, reader, and TTS stack are
documented here.

## [Unreleased] - 2026-07-24

### Conversion pipeline

- **Source cover now survives conversion.** The builder had a complete cover branch (manifest `properties="cover-image"`, spine `itemref`, EPUB2/3 `<meta name="cover">`, generated `cover.xhtml`, media-type detection) but the conversion flow never passed `coverImagePath` through — every converted book was silently shipped without a cover even when the source had one. New `resolveSourceCover` helper inside `conversion-pipeline.ts` extracts the cover bytes from the parsed source EPUB (three strategies: `<meta name="cover">` → manifest item, `properties="cover-image"`, then `cover.*` filename scan) and writes them to a sidecar file that the builder consumes. The sidecar is unlinked after the build.
  - Pinned by a new end-to-end regression test (`conversion-cover-pass-through.test.ts`) that builds a source EPUB with a real PNG cover, runs the full pipeline, and asserts the cover bytes + manifest + cover.xhtml all survive in the output.
  - Negative case: when the source has no cover, the output also has no cover (no spurious cover branch).
  - Next step (not in this push): carry *interior* content images through the same path. Requires rewriting `<img src>` against an `EPUB/images/` collection and adding a manifest loop for non-cover images in `epub-builder.ts`. Currently the pipeline still strips all `<img>` from chapter HTML (see the comment on `stripImages`).

### Watermark cleanup unification

- **Single source of truth for watermark detection.** New `src/lib/pipeline/watermark-detect.ts` exposes `splitChapterIntoPhrases` + `detectFromChaptersHtml`. The conversion pipeline and the per-book Detect UI now share this engine — the manual Detect button no longer uses a worse punctuation-splitter that silently missed DTV-style `<div class="header">…</div>` watermarks.
- **Wrapper-aware strip pass.** `stripWatermarks` now drops any block-level element (`<p>`, `<div>`, `<span>`, `<h1>..<h6>`) whose plain text contains a saved phrase. The previous `<p>`-only pass left empty `<div class="header">` envelopes behind. Three-pass longest-first; legacy `p`-only and bare-text fallbacks preserved for backwards compatibility.
- **Lower detection threshold (0.6 → 0.4).** A 0.6 threshold silently missed books where the watermark footer was missing on a handful of interlude chapters (e.g. author's-note). 0.4 still leaves headroom for "real" book text while catching the standard DTV footer.
- **Removed hardcoded Chiếm Đoạt / Tiểu Ngôn / dtv-ebook whitelist.** The previous implementation only kept `<h*>Chương N</h*>` lines if they happened to contain one of those three substrings, dropping every other publisher's metadata footer. Now any `<h*>` whose text starts with `Chương N` is filtered; other recurring headings (e.g. "Giới thiệu tác giả") surface for the user to decide.
- **Retroactive cleanup endpoints.**
  - `POST /api/library/[id]/watermarks/rerun` — runs auto-detect against an existing book, persists newly-found phrases to per-book + cross-book memory, then atomically rewrites the on-disk EPUB with the merged phrase list. Useful for books uploaded before watermark cleanup was enabled.
  - `POST /api/watermarks/rerun-all` — sequential library-wide batch with `onlyMissingWatermarks` filter and per-book error reporting.
  - `WatermarksPanel` UI exposes both as a "Rerun on this book" button and a destructive "Apply cho cả thư viện" confirm flow.
- **Memory-read errors now log at error level.** `listWatermarkPhrases` previously warned and silently produced unwatermarked output when the `WatermarkMemory` table was missing. Now logs at `error` so a misconfigured DB surfaces in the worker log; pass `{ silent: true }` for batch callers that have already handled the failure.
- **32 new unit tests** covering the splitter (DTV-style `<div>` envelopes, `<h*>` filtering, dedupe, length bounds), the strip pass (wrapper-aware across all 9 phase tags, longest-first substring bleed protection, idempotency), and an integration case reconstructed from the real `Chiem Doat Vo Yeu - Tieu Ngon.epub` chapter shape.

### TTS and Vietnamese speech

- **Two stale emotion tests updated.** `detect-emotion.test.ts` previously asserted that two-or-more `…` ellipsis should map to `căng thẳng`, but the production code intentionally removed that density fallback on 2026-07-11 (VieNeu already reads `…` as a natural short pause; the trigger made every trailing-thought paragraph sound tense). Tests now assert the intentional `neutral` fallback and reference the source header comment.

### Housekeeping

- **On-disk runtime noise removed.** Six runtime artifacts (two `dump.rdb` Redis snapshots at the repo root and `app/ebook-converter/`, four `.tmp-*.mjs` scratch diagnostic scripts from the 2026-07-11 reader-polish spread work) deleted from the working tree. All were already correctly gitignored — no `git rm --cached` was needed. `git status` is now clean save for the two user-library sample EPUBs that live under `samples/` (correctly gitignored by the blanket `*.epub` rule negated only for the fixture). Phase 1.2 of `docs/NEXT_UP_PLAN.md`.

### Test fixtures

- **Deterministic illustrated fixture EPUB committed.** `samples/fixture-illustrated-novel.epub` (21 KB, 12 entries, SHA256 `5f893ddd179ccab41343ea224862450a7e12bf0d95150cf2f98b006a21469fdc`) ships in the repo so the Phase 2 interior-image-preservation tests have a stable target. Built by `scripts/build-fixture-epub.mjs` (one-off, uses `sharp` + `yazl`); structure is 1 cover (600×900), 2 figures (300×200) plus a base64 data-URI variant, and 4 chapters covering the control / inline / block-level / short cases. A `.sha256` sidecar lets future asserts pin against accidental modifications. Parent `.gitignore` updated with a scoped `!app/ebook-converter/samples/**/*.epub` negation so the blanket `*.epub` rule (which exists to exclude user-library books from version control) doesn't sweep the fixture away.

### Conversion pipeline — interior images (Phase 2.1)

- **Builder now accepts an `images[]` field on `EpubBuildInput`.** New `EpubImage` interface (`{ id, href, data, mediaType }`) lets the conversion pipeline carry non-cover content images (figures, illustrations) through to the output EPUB. For each entry the builder writes the bytes under `EPUB/images/<sanitized-href>` and emits one `<item id="…" href="images/…" media-type="…"/>` per image in the manifest, ordered after the cover branch (when present) and before the chapters. Id collisions get a `-N` suffix; href collisions get the same treatment. `cover.<ext>` is reserved for the cover branch and a caller-supplied collision is skipped (never silently overwritten). Hrefs are sanitized — directory prefixes stripped, `..`/`.foo`/empty rejected, illegal chars replaced with `_` — so a dirty input cannot write outside `EPUB/images/`.
  - **5 new unit tests** (`epub-builder-images.test.ts`) cover the happy path with byte fidelity, manifest ordering vs chapters, cover-href collision rejection, sanitization rules, and id/href dedupe. Total test count: **200/200** (was 195/195).
  - Next step (Phase 2.2): the conversion pipeline stops calling `stripImages` and starts rewriting `<img src>` against an image map built from the source EPUB's image entries + OPF-relative resolution. Then passes the collection to the new `images[]` field.

### Conversion pipeline — interior images (Phase 2.2-2.4)

- **Interior content images now survive conversion.** The Phase 2.1 builder field is wired into `runConversionPipeline`. Every real EPUB conversion scans each chapter body for `<img src>` and rewrites resolvable srcs against the source's image entries (OPF-relative resolution, `..`/`./` normalisation, case-insensitive fallback) to the unified `../images/<basename>` form that `buildEpub` emits. Unresolved srcs are left in place so the reader shows a broken-image marker rather than silently dropping content. The cover entry is filtered from the interior-images collection so the cover branch and interior branch don't double-emit. Legacy `stripImages` is retained as a fallback for the `buildMinimalEpubFromFile()` non-EPUB path only.
- **Data-URI inline images get materialised.** Any `<img src="data:image/<ext>;base64,<payload>">` in a chapter body is decoded to a `Buffer`, named `inline-N.<ext>` (deterministic — collision-free across chapters), and added to the same `images[]` collection. The src is rewritten to `../images/inline-N.<ext>` so the reader resolves it the same way as file-backed figures. Bad payloads (decode fails, empty buffer) are left untouched so they don't break the build.
- **Cover pages no longer sneak in as Chapter 1.** Source EPUBs whose cover is a standalone XHTML (`cover.xhtml`/`title.xhtml` with `class="cover-page"`/`epub:type="cover"`/`epub:type="frontmatter"` on `<body>`) used to slip through the existing 20-char "skip cover-only chapters" filter because the embedded `<img>` + `<section>` padding pushed the text length over the threshold. The result was a phantom "Chapter 1" with a broken cover-path reference at the front of every converted book. New `looksLikeCoverPage` heuristic matches the body-attribute signature and filters these pages out before chapter construction in both the AI-detect and spine-order branches. The cover branch in `buildEpub` is unchanged.
- **End-to-end regression test.** New `image-preservation.test.ts` runs the full pipeline against the committed fixture (`samples/fixture-illustrated-novel.epub`) and pins: all 4 image files (`cover.png`, `figure-1.png`, `figure-2.png`, `inline-1.png`) end up in the output ZIP; the OPF manifest has one row per image with the right `media-type`; chapter HTML uses `../images/<basename>` and never `../Images/` (source casing) or `data:` URLs; the cover row retains `properties="cover-image"` while interior rows do not. Total: **201/201** tests pass (was 200/200 after Phase 2.1).

### Attribution — per-genre threshold (Phase 3.2)

- **The 0.42 floor is now per-genre.** A new `MIN_SCORE_BY_GENRE` map in `@/lib/attribution` replaces the legacy single-floor gate inside `attributeByConversation`. Cultivation / kiếm hiệp / huyền huyễn now clear 0.48 (heavy internal monologue); cổ trang / lịch sử 0.46 (honorifics-driven narration); ngôn tình / thiếu niên 0.38 (short continuity turns); kinh dị 0.36 (narrator-heavy); đô thị / game-system / sci-fi 0.40. Unknown / blank / null genres fall back to the legacy 0.42 default so existing books (and existing caches) keep their current attribution rates.
- **`ConversationAttributionInput` gains an optional `genre?: string | null` field**, with the legacy `attributeConversationChapter` wrapper forwarding it transparently so the measure / backfill scripts pick up the same behaviour without code changes. `resolveBookGenre(book)` wraps the existing `detectGenre` cover keyword matcher (cheap regex pass, no LLM, no schema migration, no new column on `Book`) and returns `null` for unrecognised titles. Both attribution routes thread the book's `title + titleVi + description` through this helper so the per-genre floor is auto-derived from metadata.
- **`getMinScoreForGenre(genre)`** is the public lookup helper. It lowercases the key, resolves common accent-stripped synonyms (`co_trang → cổ_trang`, `ngôn_tình → ngon_tinh`, `tu_tiên → tu_tieu_thuyet`, `đô_thị → do_thi`, `lịch_sử → lich_su`) onto their canonical entry, and returns the 0.42 legacy default for anything else.
- **End-to-end route plumbing.** Both `/api/library/[id]/chapters/[chapterId]/attribute` (GET, cheap) and `/api/library/[id]/chapters/[chapterId]/attribute/analyze` (SSE, full) pass the resolved genre through three call sites (local baseline + final fuse + the leftover spot that had been missed earlier). The analyze route surfaces the detected genre in the `init` SSE log so the user can see which floor was applied.
- **Tests + docs.** New `attribution-genre-threshold.test.ts` (8 cases) pins the default fallback, strict and permissive floors, accent-stripping synonyms, `attributeByConversation` propagation, weak-evidence drop under strict cultivation, and `resolveBookGenre` over five book shapes. Total: **209/209** tests pass (was 201/201 after Phase 2.4); `tsc --noEmit` clean. Phase 3.2 of `docs/NEXT_UP_PLAN.md`.

### Attribution — actor alternation bump parity (Phase 3.3)

- **The 0.36 → 0.48 alternation bump is now mirrored on the JS engine.** `roles.actor` in `attributeByConversation` previously used a flat `0.36` timeline weight regardless of scene shape. The Python port already had the bump (constants `ACTOR_BASE_WEIGHT = 0.36` / `ACTOR_ALT_WEIGHT = 0.48`, conditional `actor_weight = ACTOR_ALT_WEIGHT if alternation_strength > 0 else ACTOR_BASE_WEIGHT`). The JS-side implementation now derives `alternationActive = !!(lastTurn && previousTurn && lastTurn !== previousTurn)` from `state.dialogueHistory` and uses `alternationActive ? 0.48 : 0.36`. The bump fires only when the previous two turns were spoken by different characters — exactly the same condition the Python port uses. The evidence `detail` row surfaces `"alternating turn — bumped"` vs the legacy `"last named actor before/around the quote"` so downstream consumers can tell which branch fired.
- **JS regression test** (`attribution.test.ts`, new case) proves both branches: when alternation is detected, the timeline evidence row carries the bumped 0.48 weight + bumped detail; when alternation is NOT detected, the actor weight stays at 0.36 and the resolved paragraph falls back to the previous speaker (Lan) because 0.36 cannot out-score the scene-memory continuation branch (0.38). Total: **210/210 JS** tests pass.
- **Python regression test** (`test_actor_alternation_bump.py`, 4 cases) pins: constants `0.36 / 0.48`, the bump fires on alternating seed history, no bump on same-speaker history, no bump on history length < 2. Tests seed `ConversationStateSnapshot.dialogueHistory` directly so they don't depend on a multi-paragraph walk.
- **Phase 3.3 of `docs/NEXT_UP_PLAN.md` complete** — Phase 3 backlog (3.1 gitignore, 3.2 per-genre floor, 3.3 alternation parity) all done.

### E2E deterministic fixture (Phase 4.1)

- **A deterministic minimal-novel EPUB now seeds the E2E library.** The Playwright suite previously depended on whatever book the user happened to upload. `app/ebook-converter/scripts/build-minimal-epub-fixture.mjs` is a pure-yazl builder (no sharp, no PNGs) that emits a 2.98 KB EPUB with one Vietnamese chapter, no cover, no images, frozen `MODIFIED_DATE = '2026-07-24T00:00:00Z'`, frozen `IDENTIFIER = 'urn:uuid:e2e-minimal-novel-2026-07-24'`. The output (`app/ebook-converter/e2e/fixtures/minimal-novel.epub`) is committed alongside a SHA256 sidecar so the seed setup can verify integrity before upload.
- **Playwright `globalSetup` runs once per invocation.** `app/ebook-converter/e2e/seed-fixture.global-setup.ts` (1) verifies the SHA against the sidecar, (2) fast-path reuses any existing library row matching `Tiểu Thuyết Tối Giản (E2E)` + `Bộ Kiểm Thử`, (3) multipart-uploads via `/api/upload` with `aiEnhance=false / aiWatermarkClean=false / deepFormat=false / readerFriendly=true`, (4) polls `/api/jobs` for `completed` (90 s timeout), (5) polls `/api/library` for the matching row (30 s timeout), (6) writes `e2e/.seed-book.json` and sets `process.env.E2E_BOOK_ID` for child specs. Total cold seed: ~3-5 s on a warm worker.
- **Helpers.ts precedence.** `resolveDefaultBookId()` returns `E2E_BOOK_ID` env → `.seed-book.json` → legacy `ffa65ac0…` fallback. Smoke specs that call `resolveTestBook(page)` automatically pick up the seeded fixture book. Legacy deeper-voice specs (which intentionally wipe rows for `E2E_BOOK_ID`) keep their old behaviour but now also target the seeded book by default — `E2E_BOOK_ID=<other-id>` overrides cleanly.
- **CI opt-out.** `E2E_SKIP_SEED=1 E2E_BOOK_ID=<pre-baked-id>` skips the globalSetup entirely (`playwright.config.ts` checks the env before wiring it). Pre-baked-library CI runs are unaffected.
- **Fixture drift protection.** New `app/ebook-converter/src/tests/minimal-fixture-epub.test.ts` pins the SHA, on-disk size, parsed metadata (title/author/language), exact `htmlFiles` / `imageFiles` shape, and that the chapter HTML carries `id="ch001"` plus the expected title. Runs as part of the regular vitest suite (211/211 total).
- **Gitignore scoping.** Blanket `*.epub` ignores are negated for `app/ebook-converter/e2e/fixtures/**/*.epub` so the fixture stays tracked; `app/ebook-converter/e2e/.seed-book.json` is gitignored as a per-run artifact.
- **README updated.** `app/ebook-converter/e2e/README.md` documents the fixture + seed flow, the helper precedence, and the CI opt-out path.
- **Phase 4.1 of `docs/NEXT_UP_PLAN.md` complete.** Test totals: **211/211 JS** tests pass (was 210/210 after Phase 3.3; +1 from the new minimal-fixture vitest test); `tsc --noEmit` clean. Python tests untouched in this phase.

## [Unreleased] - 2026-07-11

### Reader and playback experience

- **Spread mode shows exactly 2 columns.** The iframe clip width now equals the spread width (centered horizontally via `min(820px, calc(100vw - 2*padInline))` + `max(padInline, calc(50vw - 410px))`) so only one page track is visible at a time — even on viewports wider than the spread. The previous clip was wider than the spread, which exposed 1.6 page tracks and read as "four columns" to the eye. Playwright verification at `app/ebook-converter/verify-spread.mjs` confirms `column-count: 2` on the spread element after the fix.
- **Embedded EPUB `<style>` blocks are stripped before serving.** Long-standing reader polish bug: third-party EPUBs ship `<style>` blocks with `!important` declarations on `column-count` that survived the iframe wrapper's CSS layer and broke the 2-column layout. `stripEmbeddedStyles` is now applied in `chapters/[chapterId]/route.ts` before any other processing, so the reader's column math is the only column math.
- **Higher-specificity column override.** A `#epub-clip .epub-spread p` selector (and matching `section/div/article/blockquote/li/dd/dt`) forces `columns: 1 !important; column-count: 1 !important` even when an attacker (or an overzealous EPUB) declares its own column rules in body class scope. Heading and HR elements get `column-span: all` so they break across both columns.
- **Standardized paragraph indent.** `DEFAULT_SETTINGS.indent` is now `0` (was `1.5`). Old persisted `indent: 1.5` values are auto-migrated to `0` on next read so existing users get the new default without manual clearing. Paragraphs render with `margin: 0.65em 0` and zero first-line indent, so chapter text reads as flush-left paragraphs separated by blank space (not first-line indent on every paragraph). The slider remains in the reader settings panel for users who prefer the older look.
- **Reader padding consistency.** The body padding now matches the user's Reading Settings slider (`padTop` / `padBottom` / `padInline`) instead of being hard-coded to `4px` horizontal. The horizontal padding default is now `56px` so the text column is centered on tablet widths and reads cleanly without forced left-edge bleed.
- **Playwright verification harness.** `app/ebook-converter/verify-spread.mjs` boots headless Chromium, loads `/api/library/[id]/chapters/[chapterId]` directly with the user's settings, and reports the spread's computed `column-count`, `column-width`, bounding rect, scroll dimensions, and the first five paragraphs' `text-indent` / `margin` / `column-count`. Use it any time you change the spread CSS to confirm the layout math still holds.
- Migrated all dynamic pages and route handlers to Next.js 15 asynchronous params.

## [Unreleased] - 2026-07-10

### TTS and Vietnamese speech

- Preserved XHTML paragraph boundaries and decoded entities before speech
  segmentation so pauses and attribution match the visible chapter structure.
- Recognized one-character Vietnamese replies such as “Ừ” as valid dialogue.
- Kept thoughts, letters, quoted titles, and inner monologue on the narrator
  voice; character voices are now reserved for spoken dialogue.
- Restored the conversation-attribution engine toggle, Vietnamese proper-name
  recognition, pronoun/context carry, and the supported emotion-marker allowlist.
- Added natural story-reading cadence (`doc_truyen`), bounded speed control, and
  safer text/speed limits for live preview and synthesis endpoints.
- Prevented partial or missing synthesis output from being marked ready and made
  failed generators retry through BullMQ.
- Invalidated cached chapter audio when the source EPUB changes, not only when a
  voice assignment changes.
- Added cancellable, bounded, timed Python generator processes and bounded their
  captured output to prevent stuck workers and memory growth.

### Character detection and Character Bible

- Replaced fragile OPF regular-expression parsing with namespace-safe XML
  parsing and sampled chapters across the full book spine.
- Removed unsafe chapter-derived temporary paths by supporting detector input on
  stdin; added subprocess timeout, cancellation, and output-size limits.
- Stopped expensive character detection from running on every reader navigation;
  it now starts when the user explicitly begins TTS while cached attribution
  remains available during navigation.
- Fixed manual Character Bible refresh so review-only mode no longer mutates
  profiles or relationships before approval.
- Fixed individual and Apply All review actions so new characters, appearances,
  relationships, and profile updates are actually applied exactly once.
- Preserved user-locked fields, distinguished omitted values from explicit nulls,
  and prevented automatic refreshes from erasing manual edits.
- Made default-voice changes atomic, restored first-voice fallback, tolerated
  malformed legacy aliases, and blocked cross-book voice assignments.
- Added cascade relations for Bible diffs, refresh logs, conversation state, and
  character relationships so book/character deletion does not leave orphans.

### Reader and playback experience

- Added reliable reader loading and error states, synchronized fullscreen state,
  improved mobile controls, and made hidden panels non-focusable.
- Improved keyboard shortcuts so they do not fire while typing or interacting
  with controls, and added accessible labels and value text to playback sliders.
- Kept chapter attribution lightweight on navigation and deferred costly model
  work until playback intent is clear.
- Corrected audiobook stop semantics: queued work is removed immediately and an
  active generator receives a cooperative cancellation signal without using an
  invalid BullMQ lock token.
- Streamed EPUB/audio downloads instead of buffering whole files in memory and
  returned standards-compliant range errors for invalid audio seeks.

### Library, editor, settings, and workflows

- Made library filters URL-addressable, debounced, abortable, and compatible with
  dashboard links; improved empty, loading, error, mobile, and overflow states.
- Fixed metadata clearing by sending explicit nulls, added backend field
  whitelisting/validation, and handled failed mutations before updating the UI.
- Added validated shelf create/edit/membership operations and idempotent removal.
- Resolved host-versus-container EPUB and cover paths consistently across the
  reader, editor, detector, cover, illustration, watermark, and download flows.
- Added atomic in-place editor writes, safer Save As cover copying, responsive
  editor actions, and clearer save labels.
- Activated persisted system/light/dark appearance settings and hash-addressable
  settings tabs; validated provider, model, concurrency, language, image, and
  theme values server-side.
- Corrected the startup TTS health target to the configured endpoint (VieNeu
  `:5020` by default), preventing healthy VieNeu processes from being restarted
  because the optional `:5010` router was absent.

### UI, accessibility, and responsive design

- Added a skip link, consistent global focus visibility, reduced-motion support,
  forced-color support, and improved progress semantics.
- Reworked shared dialogs with focus trapping, focus restoration, Escape handling,
  scroll locking, accessible titles/descriptions, and safer nested behavior.
- Improved upload switches, forms, card actions, job controls, navigation, reader
  toolbars, metadata forms, and editor layouts across mobile and desktop widths.
- Eliminated React hook dependency warnings, unescaped JSX content errors, stale
  closures, and ref-related console warnings.

### Security, reliability, and performance

- Upgraded to Next.js 15.5.20, UUID 11.1.1, Vitest 4.1, patched PostCSS/esbuild,
  and removed unused vulnerable `xmldom`, `xpath`, and obsolete type packages.
- Added storage-root allowlisting with symlink resolution to file reads, streams,
  copies, and deletions; corrupted DB paths can no longer escape app-owned data.
- Added EPUB asset traversal, decompression-size, MIME sniffing, and content
  security guards.
- Replaced permissive book PATCH spreading with explicit field validation and
  added bounds/rate limits to uploads, TTS, audiobook, and model-facing inputs.
- Hardened worker start/stop authorization: configured tokens are revalidated and
  zero-config mode requires an exact loopback same-origin request.
- Applied worker concurrency changes live, removed stale liveness keys during
  shutdown, added graceful-shutdown timeouts, tracked active subprocesses, and
  recovered stale conversion rows after crashes.
- Reused the Character Bible queue connection rather than creating one Redis
  connection per request.
- Added query indexes for common job, library, and shelf filters and made Settings
  singleton initialization atomic.

### Tests and engineering workflow

- Added regression tests for storage traversal/symlinks, worker authorization,
  subprocess tracking, Character Bible review/apply behavior, dialogue/narration
  preprocessing, detector parsing, and VieNeu pacing.
- Migrated all dynamic pages and route handlers to Next.js 15 asynchronous params.
- Added a non-interactive ESLint configuration and made warnings fail the lint
  gate.
- Added lightweight Python test dependencies and GitHub Actions jobs for frontend,
  production build/audit, and Python TTS orchestration tests.
- Expanded the local verification command to run lint, TypeScript, Vitest, all
  Python tests, a production build, and Playwright smoke tests.
- Updated Playwright contracts to match the current tabbed settings, editor,
  audiobook, voice, and model-selection workflows.

### Operational changes

- Existing databases migrate in place without resetting Character Bible data;
  legacy timestamp columns are retained and `PendingBibleDiff.updatedAt` now has
  a migration-safe default.
- Next.js now requires Node.js 18.18 or newer. The repository and CI use Node 20+
  compatible tooling.
- Worker control from non-loopback browser origins now requires
  `INTERNAL_API_TOKEN`; this intentionally tightens the former permissive behavior.
