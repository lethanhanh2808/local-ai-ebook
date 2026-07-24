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
