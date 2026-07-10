# Changelog

All notable changes to the Local-AI ebook conversion, reader, and TTS stack are
documented here.

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
