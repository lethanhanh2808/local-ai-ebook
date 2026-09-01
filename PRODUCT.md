# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**Primary:** the Mac owner and a small circle of family/friends who share one
running instance. They convert ebooks (EPUB, HTML, TXT) from their own
collections — often Vietnamese-language content — into a local library, read
them in-app, and (when they want) generate per-chapter audiobooks with
distinct character voices. Auth separates people for library rights, not for
multi-tenant administration.

**Situation:** the conversion pipeline runs locally on a Mac (M-series); the
runtime can live on a separate `linux/amd64` VM the same owner runs. TTS runs
on the Mac host (GPU required), reached by the app via
`host.docker.internal:5020`. The "deployment" is build-once-on-Mac /
pull-on-VM.

## Product Purpose

End-to-end local ownership of an ebook and its audiobook: ingest, repair,
read, narrate. The product exists so a small group can keep their reading
library entirely on hardware they control, generate natural-sounding
audiobooks for that library, and assign distinct character voices per
chapter — without uploading anything to a cloud service.

Success means: a person can drop a messy source file into the app and end
up with a clean chaptered library entry, and (optionally) a multi-voice
audiobook that sounds like a Vietnamese reader would narrate it.

## Positioning

Three claims that stack, and that cloud-first competitors cannot
truthfully copy together:

1. **End-to-end local.** Every step — conversion, AI enhancement, voice
   attribution, TTS — runs on the owner's hardware. No book, voice sample,
   or generated audio leaves the network.
2. **Per-chapter character voice attribution.** Each chapter records a
   `ChapterVoicePlan` mapping detected characters to distinct voices, so a
   multi-character audiobook sounds like a dramatisation rather than a
   single TTS voice reading everything.
3. **Vietnamese-native TTS.** VieNeu and F5-TTS-Vietnamese produce
   audiobooks that read as Vietnamese, not as English-trained TTS forced
   through Vietnamese text. Reference clips + transcript hand-correction
   are first-class inputs.

The position is the intersection. No single feature is the story; the
combination is.

## Operating Context

- **Hardware split.** Mac (arm64, GPU) is the build host and TTS host. The
  VM (`172.16.125.51`, `mgmt-admin`, `linux/amd64`) is a runtime snapshot.
  The Mac publishes `linux/amd64` images to a local registry; the VM pulls
  them. The VM is not a git repo.
- **TTS runs on the host, not in a container.** The
  `docker-compose.{yml,build.yml,pull.yml}` stack reaches TTS at
  `host.docker.internal:5020`. There is no `tts-vieneu` container; do not
  reintroduce one.
- **Voice identity is a reference clip, not a name.** F5-TTS has no
  built-in voices — every voice *is* a 24 kHz mono WAV referenced by slug
  or explicit path. Voice cloning is a first-class flow, not a future
  feature.
- **Conversions are messy.** Source files commonly have watermarks,
  scan artefacts, mixed encodings, broken chapters. The pipeline expects
  this and normalises before metadata extraction.
- **Reading and listening are different surfaces.** The in-app reader and
  the audiobook generator consume the same chapter artefacts but produce
  different deliverables; per-chapter voice plans persist independently
  of which surface used them last.

## Capabilities and Constraints

- **Formats:** EPUB, HTML, TXT in; same formats out plus chaptered audio
  (via TTS pipeline).
- **TTS engines:** VieNeu (`vieneu-v3-turbo`) is the production backend;
  F5-TTS (Vietnamese) is being evaluated as a second backend selectable at
  runtime via `settings.ttsProvider`. Reference clips are 24 kHz mono,
  ~8 s, with hand-corrected transcripts.
- **AI:** oMLX runs local models for enhancement, watermark cleanup, and
  image handling. Provider abstraction in `src/lib/ai/index.ts`
  (`omlx-local | minimax-cloud | openai | custom`) — switching provider
  is a settings change, not a code change.
- **Storage:** SQLite (`prisma/`) for books, chapters, characters, voice
  plans, settings. Filesystem under `data/` for voice references and
  generated audio.
- **Background work:** BullMQ + Redis. Audiobook generation runs in the
  worker, not in the request path. `Book.audiobookStatus.configHash`
  includes the active TTS backend so a backend switch triggers regen.
- **Voice sample licensing:** F5-TTS-Vietnamese reference weights are
  CC-BY-NC-SA-4.0 (non-commercial). The audiobook app records this in the
  TTS server header. Building a commercial product on these weights is
  not currently permitted.
- **Auth:** multi-user local auth has been added recently and may still
  be settling — settings, characters, and admin routes were touched in
  the in-flight refactor. Coordinate auth commits before further changes
  to those routes.

## Brand Commitments

None binding. There is no public product name beyond "Local AI Ebook
Platform" (repo-level only), no marketing voice, no logo, and no external
identity to defend. Directory names are the only identity; design is free
to pick a coherent visual world without preserving anything beyond
repository structure.

## Evidence on Hand

- **Corpus in use:** real Vietnamese-source ebooks already converted and
  read in the library (the audio generator has been exercised on them).
  No public testimonials, customers, or case studies.
- **Reference voice clips:** two Vietnamese voices (`hong-dao`, female;
  `ngoc-ngan`, male), each ~8 s at 24 kHz mono, with hand-corrected
  transcripts. These *are* the F5 voice catalog and the comparison
  artefacts for A/B testing backends.
- **Open delivery:** `./scripts/start_full_app.sh` starts the full local
  stack (Mac) and `./scripts/deploy-vm.sh code` runs the VM-side pull.
  Deployment is documented in `docs/dev-workflow.md` and governed by the
  Mac→VM publish/pull flow.
- **Operational notes:** `docs/dev-workflow.md` "Gotchas #7" records the
  arm64/amd64 mismatch that produced an `exec format error` on the VM;
  `docker-compose.build.yml` pins `platform: linux/amd64` for that
  reason. Do not remove the pin.

Future work must not fabricate testimonials, customers, benchmarks,
pricing, or licensing claims about this product.

## Product Principles

1. **Local ownership is the floor.** A feature that requires sending book
   content or voice samples to a third party is not a feature of this
   product.
2. **The reader/listener experience leads.** A conversion that produces
   an audiobook no one will listen to is a failed conversion; narration
   fidelity and character distinction are first-class, not polish.
3. **Voice is reference data, not a name.** Treat every voice as a clip
   plus a transcript; never as a fixed label. New voices are new clips.
4. **The deployment model is build-once.** The Mac builds, the VM pulls.
   Anything that conflates the two (building on the VM, running source
   from the VM) breaks the model and burns a day.
5. **One source of truth per decision.** PRODUCT.md owns product truth;
   DESIGN.md owns the visual world; `prisma/schema.prisma` owns the data
   shape. Do not write the same fact in two places.

## Accessibility & Inclusion

No product-specific accessibility standard was established. The web stack
delivers default browser semantics (semantic HTML, keyboard focus on
interactive controls). If a future round establishes a target standard
(WCAG 2.2 AA, keyboard-only reader, screen-reader-tested audiobook
controls), record it here.
