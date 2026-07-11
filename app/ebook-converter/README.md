# Ebook Converter

AI-powered EPUB Repair, Conversion, and Library platform — part of the Local-AI `app/` suite.

Converts EPUB, HTML, and TXT ebooks into clean, standardized EPUB3 with optional AI enhancement, then serves them through a built-in reader with library, shelves, audiobook, editor, and illustration features.

## Tech stack

- **Next.js 15** (App Router) + **TailwindCSS** + **Framer Motion** + **Radix UI** primitives
- **Prisma + SQLite** for persistent job, library, shelf, voice, character, and illustration tracking
- **BullMQ + Redis (ioredis)** for reliable async job processing and live progress polling
- **OMLX** local AI models (Qwen/DeepSeek) served on `http://127.0.0.1:8080/v1` for:
  - HTML repair and structure cleanup
  - Metadata generation (title/author when missing)
  - Vietnamese-novel deep chapter formatting
  - Character detection for audiobooks
  - AI cover art + per-chapter illustrations
- **VieNeu-TTS** Vietnamese-native neural TTS (48 kHz stereo, 10 built-in voices, instant voice cloning from 3–5 s reference audio) — **sole TTS backend as of 2026-07-05**
- **Paged SSD cache** in `omlx-home/cache`
- **Literata** font embedded in every output for consistent rendering
- **Streaming responses** with HTTP Range support for instant chapter seek
- **OPDS 1.2** Atom feed at `/api/opds` so Calibre/reader apps can browse the library

---

## Quick start

From the repository root, the recommended path is one command:

```bash
./scripts/start_full_app.sh
```

For a background launch:

```bash
./scripts/start_full_app.sh --background
```

Check the stack:

```bash
./scripts/start_full_app.sh --status
```

Manual app-only startup:

```bash
cd app/ebook-converter

# 1. Install
npm install

# 2. Configure
cp .env.example .env.local
# → set OMLX_API_KEY (and OMLX_MODEL to whatever you loaded into oMLX)
# → optionally set TTS URLs (defaults point to the tts-service stack)

# 3. Initialize DB
npm run db:push

# 4. Create data dirs (scripts/setup.sh does this automatically)
mkdir -p data/uploads data/outputs

# 5. Drop the Literata TTFs into public/assets/fonts/ (see "Fonts" below)

# 6. Start Redis, the worker, and the dev server:
redis-server
./scripts/start-worker.sh --start
npm run dev              # Next.js on http://localhost:3100
```

Or use the setup script for install, Prisma, and data directories:

```bash
bash scripts/setup.sh
```

Run validation after changes:

```bash
npm test
npm run lint
npm run typecheck
npm run test:python
npm run build
npm run test:e2e:local:smoke
npm run test:e2e:local
```

For the root one-command verification path:

```bash
cd /Volumes/EXT-SSD/Users/anhl/Local-AI
./scripts/verify_changes.sh
```

---

## Pages and user flow

| Path | What it does |
| --- | --- |
| `/` | Dashboard — recent jobs, library stats, quick links |
| `/convert` | Drag-and-drop upload + per-file conversion options (light AI, deep format, watermark cleanup) |
| `/library` | Library grid — all converted books, filter by status/format, edit metadata, multi-select actions |
| `/library/[id]` | Book details, metadata, title override, and illustration controls |
| `/library/[id]/read` | Built-in reader with TOC, themes, progress, audiobook panel, chapter illustrations, voice commands, and TTS status |
| `/library/[id]/edit` | Basic WYSIWYG EPUB chapter editor that saves edits as a new library copy |
| `/shelves` | Shelves management — group books into collections, public/private, drag-to-reorder |
| `/shelves/[id]` | Single shelf with its books |
| `/stats` | Library statistics — chapters read, time spent, formats, languages |
| `/settings` | Single-page settings — AI provider, model, image provider/style, conversion defaults, TTS health, worker concurrency, theme |

---

## REST API

All routes are under `/api/`.

### Jobs

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/upload` | Multipart upload + queue (form fields: `file`, optional `aiEnhance`, `aiWatermarkClean`, `deepFormat`, `aiPrompt`, `startImmediately`) |
| `GET` | `/api/jobs` | List recent jobs (newest first) |
| `GET` | `/api/jobs/[id]` | Single job with AI stats (call counts, tokens, tok/s rates) |
| `POST` | `/api/jobs/[id]/start` | Promote `pending` → `queued` (idempotent) |
| `GET` | `/api/jobs/[id]/download` | Stream the output EPUB |
| `GET` | `/api/jobs/[id]/log` | Tail the per-job NDJSON log (Debug Console source) |
| `DELETE` | `/api/jobs/[id]` | Delete job + files |

### Library

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/library` | List books (search + pagination) |
| `GET` `/POST` `/DELETE` | `/api/library/[id]` | Read / update metadata / delete book |
| `GET` | `/api/library/[id]/download` | Serve stored EPUB |
| `GET` | `/api/library/[id]/cover` | Serve cover image |
| `POST` | `/api/library/[id]/cover/generate` | AI-generate a new cover via settings.imageProvider |
| `GET` | `/api/library/[id]/assets/[...path]` | Serve image/font inside stored EPUB |
| `GET` | `/api/library/[id]/chapters` | List chapters for the reader |
| `GET` | `/api/library/[id]/chapters/[chapterId]` | One chapter HTML |
| `GET` `/POST` | `/api/library/[id]/editor` | Load editor data / save one edited chapter as a new book copy |
| `POST` | `/api/library/[id]/enhance` | AI-enhance all chapters → outputs a new book entry with " — AI Edited" suffix |
| `GET` `/POST` `/DELETE` | `/api/library/[id]/watermarks` | Detect candidates / save phrases / clear all |
| `GET` `/POST` | `/api/library/[id]/illustrations` | List / generate illustrations for highlight chapters |
| `POST` | `/api/library/[id]/illustrations/analyze` | AI scores each chapter, returns should-illustrate plan |
| `POST` | `/api/library/[id]/illustrations/generate` | AI-generates and saves the selected images |
| `GET` `/POST` `/DELETE` | `/api/library/[id]/characters` | List / upsert / delete character → voice mapping |
| `POST` | `/api/library/[id]/characters/detect` | AI-detects characters across sample chapters |
| `GET` `/POST` `/DELETE` | `/api/library/[id]/voices` | List / upload custom voice WAV / delete |
| `PATCH` `/POST` `/DELETE` | `/api/library/[id]/voices/[voiceId]` | Edit / audition (test synthesize) / delete one voice |
| `GET` `/POST` | `/api/library/[id]/audiobook` | Status + queue actions (`generate` / `stop` / `reset` / `regenerate_one`) |
| `GET` | `/api/library/[id]/audiobook/[chapterFile]` | Stream pre-generated MP3/WAV with HTTP Range |

### Other

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` `/POST` | `/api/settings` | Read / update single-row settings |
| `GET` | `/api/settings/models?for=text\|image` | Probe current provider for available models |
| `POST` | `/api/settings/test-ai` | Send a short test prompt and report latency + response |
| `POST` | `/api/tts/preview` | Audition any voice via the unified TTS service |
| `POST` | `/api/tts/analyze` | Run AI on a chunk of text to detect characters/lines |
| `GET` | `/api/tts/health` | Aggregate VieNeu and local readiness state (Piper/MOSS-Nano/unified router removed 2026-07-05) |
| `GET` `/POST` | `/api/shelves` | List / create shelves |
| `GET` `/PATCH` `/DELETE` | `/api/shelves/[id]` | Read / update / delete a shelf; add or remove books |
| `GET` | `/api/stats` | Library-wide stats for the dashboard |
| `GET` | `/api/opds` | OPDS 1.2 Atom feed for external e-readers |
| `POST` | `/api/validate` | Quick EPUB structure sanity check (no queue, no AI) |
| `GET` | `/api/worker/status` | BullMQ queue depth + worker health |

---

## Project structure

```
app/ebook-converter/
├── src/
│   ├── app/                                    # Next.js App Router
│   │   ├── page.tsx                            # /         Dashboard
│   │   ├── convert/page.tsx                    # /convert  Upload + options
│   │   ├── library/{page.tsx,[id]/page.tsx}    # /library  Grid + reader
│   │   ├── library/[id]/edit/page.tsx          # /library/:id/edit Basic EPUB editor
│   │   ├── shelves/{page.tsx,[id]/page.tsx}    # /shelves
│   │   ├── settings/page.tsx                   # /settings Single-page settings
│   │   ├── stats/page.tsx                      # /stats
│   │   └── api/                                # REST routes (see above)
│   ├── components/
│   │   ├── jobs/{UploadZone,JobCard,JobList}.tsx
│   │   ├── library/{EbookReader,BookCard,BookGrid,AudiobookPanel,
│   │   │              EpubEditor,
│   │   │              AudiobookPlayer,VoicePanel,CharacterDetection,
│   │   │              ReadAloudPanel,ShelvesView,StatsView,MetadataModal}.tsx
│   │   ├── nav/{AppNav,ThemeToggle}.tsx
│   │   ├── status/{ServiceHealth}.tsx
│   │   ├── layout/{PageHeader,StatCard,EmptyState}.tsx
│   │   ├── ui/{badge,button,progress}.tsx      # Radix wrappers + theme toggle
│   │   └── epub/                               # Reader-specific wrappers
│   ├── lib/
│   │   ├── ai/
│   │   │   ├── omlx-client.ts                 # OMLX REST + streaming/usage + chatWithStats()
│   │   │   ├── index.ts                        # Unified chat() / chatJSON() picker by Settings
│   │   │   ├── chapter-enhancer.ts             # Light AI HTML cleanup (parallel)
│   │   │   ├── chapter-formatter.ts            # Vietnamese-novel deep formatter (sequential per chapter)
│   │   │   ├── epub-analyzer.ts                # Prompts for repair / metadata / chapter detect
│   │   │   └── image-generator.ts              # DALL-E / MiniMax / custom image providers
│   │   ├── pipeline/
│   │   │   ├── epub-parser.ts                  # ZIP → in-memory model (yauzl)
│   │   │   ├── epub-validator.ts               # Structural scoring, warnings
│   │   │   ├── epub-repairer.ts                # Heuristic + AI repair
│   │   │   ├── epub-styler.ts                  # CSS + chapter-XHTML templates
│   │   │   ├── epub-cover.ts                   # Cover extraction
│   │   │   ├── epub-builder.ts                 # EPUB3 ZIP assembly
│   │   │   └── conversion-pipeline.ts          # Orchestrator (parse → validate → repair →
│   │   │                                       #   metadata → build chapters → deep format →
│   │   │                                       #   light enhance → watermark strip → EPUB3 build)
│   │   ├── covers/{ai-generate-cover,generate-cover}.ts
│   │   ├── db/{client,settings,jobs,books,audiobook,voices}.ts
│   │   ├── queue/index.ts                      # BullMQ queue factory
│   │   ├── storage/index.ts                    # Disk paths / upload persistence
│   │   ├── tts/client.ts                       # VieNeu HTTP client (sole TTS backend)
│   │   └── utils.ts
│   └── worker/
│       ├── index.ts                             # BullMQ consumer for ebook-conversion jobs
│       └── audiobook.ts                         # BullMQ consumer for ebook-audiobook jobs
├── prisma/schema.prisma                        # SQLite schema
├── public/assets/fonts/                        # ← Place Literata TTF files here
├── data/uploads/
├── data/outputs/
├── data/audiobooks/
├── data/job-logs/
├── data/ebook-converter.db                     # SQLite
├── Dockerfile
├── docker-compose.yml
├── scripts/setup.sh
└── tests/{epub-styler,epub-validator}.test.ts  # vitest unit tests
```

---

## Fonts

Place the Literata TTF files in `public/assets/fonts/`:

```
Literata-Regular.ttf
Literata-Italic.ttf
Literata-Bold.ttf
Literata-BoldItalic.ttf
```

Download from [Google Fonts – Literata](https://fonts.google.com/specimen/Literata). Output EPUBs embed all four files (~1 MB total), so the file size grows from ~150 KB source to ~600 KB.

---

## Conversion flow

```text
Upload ──► /api/upload ──► BullMQ ──► worker/index.ts
                                     │
                                     ├─ parseEpub()                   (yauzl ZIP reader)
                                     ├─ validateEpub()                (structural score 0-100)
                                     │   └─ if score<50: repairEpub() (AI-assisted)
                                     │       else       : repairEpubHeuristic()
                                     ├─ generateEpubMetadata()        (AI fills blanks)
                                     ├─ makeChapter() × N              (strip heading, build EPUB XHTML)
                                     ├─ if deepFormat=true:
                                     │     formatChaptersDeep()         (Vietnamese-novel formatter)
                                     │       per-chunk chunks → OMLX (streaming + token stats)
                                     ├─ if aiEnhance=true (and !deepFormat):
                                     │     enhanceChaptersParallel()   (light AI HTML cleanup)
                                     ├─ detectWatermarkPhrases()        (>60% frequency heuristic)
                                     │   if any:
                                     │     stripPhrasesFromHtml()        (3-pass: wrapper, thin, bare text)
                                     ├─ if imageMaxPerBook>0:
                                     │     analyze + generate illustrations for highlight chapters
                                     ├─ fontPaths → embedLiterata TTF files
                                     └─ buildEpub()                     (EPUB3 ZIP + nav.xhtml + toc.ncx)
                                                     ──► outputPath = data/outputs/<jobId>.epub
                                                     ──► Job.status = 'completed'
```

Each step writes a live entry to `data/job-logs/<jobId>.jsonl`, polled every 2 seconds by the **Debug Console** button on the JobCard.

The final EPUB build keeps the root `mimetype` entry uncompressed, writes `META-INF/container.xml`, creates OPF manifest/spine metadata, builds an EPUB3 `nav.xhtml` with `toc` and `landmarks`, creates a nested `toc.ncx` for older devices, and assigns stable IDs to chapter sections/headings.

AI conversion is intentionally bounded. Enhancement and deep format receive only chapter body fragments; the EPUB builder owns wrappers, canonical chapter `<h1>`, navigation, metadata, and CSS. Model output is checked for fragment-only HTML, unsafe tags, unexpected `<h1>`, and large visible-text loss/expansion before it can replace source content.

## EPUB editor

The editor at `/library/[id]/edit` is intentionally small. It loads the book's spine chapters, lets users edit one chapter in a WYSIWYG surface, and saves a new edited library copy instead of overwriting the original. The save API replaces the edited chapter in a copied EPUB archive and updates nav/NCX chapter labels when the edited title changes.

---

## AI providers

Selected in **Settings → AI Provider**. The conversion pipeline reads `Settings.aiProvider` and `Settings.aiModel` on every job, so changing the provider doesn't require a restart.

| Provider | Base URL | Needs API key | Default model |
| --- | --- | --- | --- |
| **OMLX (local)** | `http://127.0.0.1:8080/v1` | yes (local server) | Whatever's loaded in oMLX |
| **MiniMax Cloud** | `https://api.minimax.io/v1` | yes | `MiniMax-Text-01` |
| **OpenAI** | `https://api.openai.com/v1` | yes | `gpt-4o-mini` |
| **Custom (OpenAI-compatible)** | user-supplied | yes | user-supplied |

**The model selection actually matters.** The pipeline reads `settings.aiModel` and passes it explicitly to every OMLX/OpenAI call, so the Settings page's "Model" dropdown (populated from `/api/settings/models?for=text`) controls every conversion. Don't rely on environment variables.

### Streaming + token accounting

`omlx-client.ts::chatWithStats()` uses `stream: true` + `stream_options.include_usage: true`. OMLX responds with a final `usage` chunk that includes:

- `prompt_tokens`, `completion_tokens`, `total_tokens`
- `prompt_tokens_per_second` (prompt-eval rate)
- `generation_tokens_per_second` (output generation rate)
- `time_to_first_token`, `prompt_eval_duration`, `generation_duration`

These flow all the way to the **JobCard** so users see live `5 calls · gen 30 tok/s · prompt 800 tok/s`. When streaming isn't accepted (rare), the helper falls back to a non-streaming request and parses the regular `usage` block.

If you prefer non-streaming behavior or are hitting "usage" parsing bugs, set `OMLX_API_KEY=...` and make sure your oMLX server supports the `stream_options.include_usage` OpenAI extension.

### Image generation

Settings → Image generation lets you assign one of:

| Provider | Style presets | Default model |
| --- | --- | --- |
| **None** | – | – |
| **OpenAI** | ink / sketch / watercolor / manga / none | `dall-e-3` |
| **MiniMax** | ink / sketch / watercolor / manga / none | `image-01` |
| **Custom** | ink / sketch / watercolor / manga / none | user-supplied |

`imageMaxPerBook` (default `6`) limits how many highlight chapters get illustrated.

---

## Reader read-aloud controls

The reader supports live read-aloud through `/api/tts` with VieNeu built-in voices, cloned voices, character-based voice switching (six-pass attribution: closest-name + speech-verb → pronoun resolution → name-as-subject → thought-verb → reactive-action → em-dash → default), heuristic emotion markers, paragraph prefetching, and browser-native voice commands.

The microphone button in the reader header uses the Web Speech API when the browser supports it. Recognized commands include play/resume, pause, stop, next/previous paragraph, next/previous chapter, page navigation, faster, slower, normal speed, and bookmark.

The reader header also shows compact local TTS health so users can see whether read-aloud and audiobook dependencies are ready before starting narration.

## Audiobook playback

Pre-generated audiobook chapters stream with HTTP Range support and play through `AudiobookPlayer`. The player keeps per-book listening progress and timestamp bookmarks in browser local storage, supports a restart action, and includes 15/30/45 minute sleep timers.

---

## TTS providers

Selected in **Settings → TTS Provider** and used by the audiobook pipeline.

Settings also includes a local service health panel backed by `/api/tts/health` and `/api/worker/status`.

| Provider | Vietnamese | Voice cloning | Speed | Quality | Status |
| --- | --- | --- | --- | --- | --- |
| **VieNeu v3 Turbo** | ✅ native | ✅ (instant from 3–5 s) | 0.5–3 s / segment | 48 kHz stereo | **default, sole backend** |
| ~~Piper~~ | ✅ fixed voices | ❌ | 0.5 s / segment | 22 kHz mono | **removed 2026-07-05** |
| ~~MOSS-TTS-Nano~~ | ❌ | ✅ instant | 4–5 s / segment | 48 kHz | **removed 2026-07-05** |

The audiobook pipeline talks directly to VieNeu at `http://127.0.0.1:5020/synthesize` (overridable via `VIENEU_BASE_URL`). The historical `UNIFIED_TTS_URL` env var is preserved as a back-compat alias for `VIENEU_BASE_URL`; setting it to `:5010` will fail the health check because no router runs on that port anymore. The `Settings.ttsProvider` value is always `vieneu`; setting `piper` or `moss-nano` returns 400.

For audiobook details, character detection, voice cloning, dialogue attribution, and pre-generation architecture, see [`AI_AUDIOBOOK_README.md`](./AI_AUDIOBOOK_README.md).

---

## Settings reference (single-row `Settings` table)

| Field | Default | Description |
| --- | --- | --- |
| `aiProvider` | `omlx-local` | One of `omlx-local`, `minimax-cloud`, `openai`, `custom` |
| `aiApiKey` | (none) | API key for the chosen text provider |
| `aiBaseUrl` | (per-provider default) | Override endpoint for OpenAI-compatible providers |
| `aiModel` | `default` | Model identifier (used for every AI call) |
| `aiMaxTokens` | `8192` | Cap on completion tokens per AI call |
| `aiTemperature` | `0.2` | Lower = more deterministic |
| `ttsProvider` | `vieneu` | Default TTS backend for audiobooks |
| `defaultAiEnhance` | `true` | Light AI HTML cleanup (per-chapter, parallel) |
| `defaultAiWatermarkClean` | `true` | Strip phrases/divs appearing in ≥60% of chapters |
| `defaultDeepFormat` | `false` | Slow Vietnamese-novel formatter |
| `defaultLanguage` | `vi` | Output EPUB language |
| `imageProvider` | `none` | none / openai / minimax / custom |
| `imageApiKey` | (none) | API key for image provider |
| `imageModel` | `dall-e-3` | Image model identifier |
| `imageStyle` | `ink` | Art style hint injected into prompt |
| `imageMaxPerBook` | `6` | Max chapters to auto-illustrate per book |
| `theme` | `system` | UI theme — `system` / `light` / `dark` |
| `workerConcurrency` | `2` | Max simultaneous conversion jobs (restart worker to apply) |
| `workerChapterConcurrency` | `1` | Within a job, max chapters to deep-format in parallel (BullMQ doesn't support live changes for this — restart required) |

---

## Environment variables

`.env.local` is the central place for connection details. Values not found here fall back to `.env.example` defaults.

| Variable | Default | Description |
| --- | --- | --- |
| `OMLX_BASE_URL` | `http://127.0.0.1:8080/v1` | OMLX OpenAI-compatible base URL |
| `OMLX_API_KEY` | `your-omlx-api-key-here` | API key for OMLX server |
| `OMLX_MODEL` | `default` | Loaded model name in OMLX |
| `REDIS_HOST` | `127.0.0.1` | Redis host for BullMQ |
| `REDIS_PORT` | `6379` | Redis port |
| `REDIS_PASSWORD` | (empty) | Optional Redis auth |
| `DATABASE_URL` | `file:./data/ebook-converter.db` | SQLite path (relative to project root) |
| `UPLOAD_DIR` | `./data/uploads` | Where uploaded files are stored |
| `OUTPUT_DIR` | `./data/outputs` | Where converted EPUBs go |
| `MAX_FILE_SIZE_MB` | `100` | Upload limit (MB) |
| `NEXT_PUBLIC_APP_URL` | `http://localhost:3100` | Used for OPDS self-links |

For the audiobook pipeline, see `.env.local` notes in [`AI_AUDIOBOOK_README.md` § Configuration & env vars](./AI_AUDIOBOOK_README.md#13-configuration--env-vars).

---

## Database schema (Prisma)

| Model | Purpose |
| --- | --- |
| `Job` | One row per uploaded file; tracks status, progress, AI model/tokens, log path, output path |
| `Book` | A library book (created by Add-to-Library after job success) |
| `Voice` | Per-book voice definitions (narrator + custom clones) |
| `Character` | Per-book character → voice mapping |
| `AudiobookChapter` | One row per chapter per book for pre-generated audio |
| `Shelf` | User-defined reading collections |
| `ShelfBook` | Pivot (book + position on shelf) |
| `Settings` | Singleton row — AI provider, model, image provider, defaults, theme, worker concurrency |
| `Illustration` | One row per AI-generated chapter image |

---

## Watermark stripping

The pipeline runs a deterministic watermark pass after AI enhancement / deep format:

1. **`detectWatermarkPhrases(chapters)`** — splits each chapter's HTML on `</p>`, `</h*>`, `</div>`, `<br/>`, etc. Each block becomes a "phrase", and any phrase that appears in >60% of chapters is flagged (catches `<div class="header">Chiếm Đoạt Vợ Yêu</div>`, `<div class="author">Tiểu Ngôn</div>`, `<div class="author">www.dtv-ebook.com</div>` from Calibre-produced EPUBs).
2. **`stripPhrasesFromHtml(html, phrases)`** runs three passes:
   1. Remove whole elements whose text equals a phrase
   2. Remove thin wrappers (≤60 chars of extra text)
   3. Strip bare occurrences inside paragraphs

The watermark manager at `/library/[id]/watermarks` lets you detect, save, and clear phrases per book (overriding/adding to the auto-detected set).

---

## Debug Console & live AI stats

Every job writes events to `data/job-logs/<jobId>.jsonl`. The **Console** button on each JobCard opens a modal that:

- Polls `/api/jobs/[id]/log?from=N` every 2 seconds
- Auto-scrolls to the latest entry
- Color-codes stages (blue = ai-call, green = chapter-done, red = error)

Per-AI-call stats also flow into the JobCard:

- `aiCallCount`, `aiTotalTokens`, `aiTotalDurationMs`
- `aiGenerationTokensPerSecond` (emerald), `aiPromptTokensPerSecond` (amber) — server-reported
- Computed fallback `(tokens*1000/duration)` when server rates aren't available

Both fields update **per-chapter** (the worker's `onChapterDone` callback writes the running total to the DB), so the dashboard shows progress while the job is still running.

---

## Worker performance

`Settings.workerConcurrency` (default `2`) controls how many conversion jobs run in parallel. `Settings.workerChapterConcurrency` (default `1`) controls how many chapters within a deep-format job run in parallel.

BullMQ requires concurrency to be set at worker construction, so changes only apply after restarting the worker. Use `./scripts/start-worker.sh --restart` from `app/ebook-converter`. The Settings page surfaces this with a "(restart worker to apply)" hint.

---

## Docker

A multi-stage [`Dockerfile`](./Dockerfile) builds the Next.js standalone app + bundles the BullMQ worker via esbuild. The image runs as a non-root `nextjs` user.

[`docker-compose.yml`](./docker-compose.yml) brings up three services and is designed to **coexist with the host stack** (host dev server on `:3100`, host Redis on `:6379`):

- `redis` — Redis 7 Alpine, side-channel port `16379`, healthcheck via `redis-cli ping`
- `app` — Production Next.js standalone, side-channel port `13100`, healthcheck via `/api/tts/health`
- `worker` — `node worker.js` (the bundled BullMQ worker)

It maps to side-channel ports so the host dev server (`./scripts/start_full_app.sh --background`) stays usable on `:3100` and `:6379` for in-process editing while the container stack runs real end-to-end tests in parallel.

### Reaching host-local oMLX and TTS from inside the container

The container rewrites `VIENEU_BASE_URL` (and its back-compat alias `UNIFIED_TTS_URL`) and `OMLX_BASE_URL` to `http://host.docker.internal:…` (with `extra_hosts: ['host.docker.internal:host-gateway']`) so the app inside Docker can talk to the host's:

| Host service | URL inside container |
| --- | --- |
| oMLX (`:8080`) | `http://host.docker.internal:8080/v1` |
| VieNeu (`:5020`) | `http://host.docker.internal:5020` |

This works on Docker Desktop for Mac/Windows out of the box. On Linux without Docker Desktop you would either switch to `network_mode: host` or set the URLs to the host's LAN IP.

### Build and run

```bash
cd app/ebook-converter
cp .env.example .env.local        # if you don't already have one
# edit .env.local (OMLX_API_KEY, etc.)

docker compose up -d --build      # build + start in background
docker compose logs -f app worker # tail logs
docker compose ps                 # check health
```

Open the containerized app at:

```text
http://localhost:13100
```

The host dev server stays available at:

```text
http://localhost:3100
```

Both write to the **same** `./data/` directory on the host, including the SQLite database — uploads and audiobooks created in one are immediately visible to the other. The container's Redis is a separate data volume (`redis-data`).

### Tearing down

```bash
docker compose down               # stop + remove containers (keeps redis-data volume)
docker compose down -v            # also wipe redis-data
```

### What ships into the image

`.dockerignore` excludes `node_modules`, `.next/cache`, `data/`, sibling workspace dirs (`models/`, `omlx-home/`, `opencode-home/`, `opencode-runtime/`, `backups/`, `exmple-books/`), tests, secrets (`.env*`), and OS noise. Only source code and the rebuilt artifacts (`prisma/`, `.next/standalone`, `.next/static`, `dist/worker.js`) end up in the image.

`prisma/schema.prisma` pins `binaryTargets = ["native", "linux-musl-openssl-3.0.x"]` so `npx prisma generate` produces a working engine for both local macOS dev and the Alpine runner image.

### Troubleshooting

- **Container can't reach oMLX (`/api/tts/health` 5xx, "ECONNREFUSED 127.0.0.1:8080")** — make sure `OMLX_BASE_URL` and `VIENEU_BASE_URL` in `.env.local` are not pinning them to literal `127.0.0.1`; the compose `environment:` overrides take precedence, but if you delete those lines, the container will fall back to host-internal localhost and fail. Also confirm Docker Desktop is running and the host services are up: `curl http://127.0.0.1:8080/health && curl http://127.0.0.1:5020/health`.
- **Build fails on `npx prisma generate`** — confirm the schema pinned `binaryTargets` includes `linux-musl-openssl-3.0.x` (or delete the pin for local-only dev).
- **`Permission denied` on `./data` mount** — the image runs as UID 1001 (`nextjs`); `chown -R 1001:1001 app/ebook-converter/data` once on the host before `up`.

---

## Testing

```bash
npm test              # vitest run (one-shot)
npm run test:watch    # watch mode
npm run test:e2e:local:smoke
npm run test:e2e:local
```

Unit tests cover the EPUB builder, styler, and validator. Playwright smoke E2E covers service health, upload-format UI, library/reader entry, read-aloud controls, audiobook controls, voice-management UI, Settings health, and the basic EPUB editor.

---

## Supported input formats

| Format | Parser | Notes |
| --- | --- | --- |
| `.epub` | Built-in (yauzl) | Primary supported format |
| `.html` / `.htm` | Direct pass-through | Wrapped in a minimal EPUB shell |
| `.txt` | Built-in text→HTML | Paragraphs split on blank lines |

PDF, DOCX, MOBI, AZW3 were originally listed but are **not implemented**. The upload API now rejects them before queueing a job, because the conversion pipeline only handles EPUB, HTML, and TXT. Add a real Calibre/importer path before enabling those extensions.

---

## Common operations

### Inspect a stuck job

```bash
ls data/job-logs/
cat data/job-logs/<jobId>.jsonl | head -20
```

Or use the worker log:

```bash
tail -f data/worker-runtime/worker.log
```

### Force-clear Redis queue

```bash
redis-cli -n 0 keys 'bull:ebook-conversion:*' | xargs redis-cli del
redis-cli -n 0 del bull:ebook-conversion:id bull:ebook-conversion:meta
```

### Reset a single job to "pending"

```sql
UPDATE Job SET status = 'pending', progress = 0, stage = 'upload' WHERE id = '<jobId>';
```

Then click **Bắt đầu** in the UI — the worker re-queues it.

### Re-render watermarks after editing

Each Book has a `watermarks: string[]` field. Edit via the watermarks API; the next chapter serve strips those phrases automatically.
