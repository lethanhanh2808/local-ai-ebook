# Cleanup and Optimization Plan

## Objective

Normalize the project into a maintainable, high-confidence local AI ebook platform without losing the product history and engineering lessons already captured in the repo.

This plan is based on the current state of the workspace: the project is functional, heavily instrumented, and already has strong validation gates, but it is also carrying historical docs, debug artifacts, and oversized modules that make it harder to maintain and reason about.

---

## Phase 0 — GitHub repo creation and baseline safety

### Goal

Create a fresh GitHub repository, push the current local repo as the baseline, and ensure the codebase can be worked on without hidden local state.

### Actions

1. Authenticate the GitHub CLI.
2. Create a new GitHub repository with a clean name, e.g. `local-ai-ebook` or similar.
3. Add the remote.
4. Commit the baseline state.
5. Push `main`.
6. Verify the repo is visible on GitHub and the branch is in sync.

### Acceptance criteria

- The repository exists remotely.
- The current workspace is pushed to GitHub.
- The main branch contains the project baseline.

---

## Phase 1 — Repository hygiene and doc normalization

### Goal

Reduce confusion by separating active docs from historical engineering notes.

### Problems to fix

- Root-level docs mix current product docs with historical incident notes.
- Some files are still named around debugging or feature-specific investigations.
- The repo still carries a lot of “incident mode” context that is useful but should not dominate the top-level view.

### Actions

1. Create a canonical folder structure for docs:
   - `docs/active/`
   - `docs/history/`
   - `docs/reports/`
   - `docs/architecture/`
2. Move or archive historical notes such as:
   - `ACTION_ITEMS.md`
   - `How_voice_recogized.md`
   - `PROMPT_fix_attribution.md`
   - `AI_CONVERSION_PROMPT_REVIEW.md`
   - `EPUB_STANDARDIZATION_AND_EDITOR_NOTES.md`
3. Keep only the current operational documents at the repo root:
   - `README.md`
   - `CHANGELOG.md`
   - one canonical project overview
4. Add a short `docs/README.md` that explains the purpose of each folder.
5. Review the top-level `reference/` folder and either restore intentionally tracked content or remove it intentionally and document the reason.

### Acceptance criteria

- Root directory is clean and focused.
- Historical notes live in archive/history folders.
- New contributors can tell what is current vs legacy.

---

## Phase 2 — Remove local-only state and runtime artifacts from repo intent

### Goal

Keep the repo clean and reproducible on any machine.

### Actions

1. Review `.gitignore` for completeness and clarity.
2. Confirm generated artifacts stay out of git, especially:
   - local data directories
   - runtime caches
   - generated EPUB fixtures that are intentionally tracked only when needed
   - `.seed-book.json` and other local test state
3. Make the distinction explicit between:
   - tracked fixtures for deterministic tests
   - untracked local runtime outputs
4. Ensure no stale or half-removed vendor/reference folders remain in the working tree.

### Acceptance criteria

- Fresh checkout stays clean after running the app.
- No accidental local runtime data enters source control.
- Test fixtures are intentionally tracked and documented.

---

## Phase 3 — Split oversized product modules

### Goal

Reduce maintenance risk by shrinking modules with too many responsibilities.

### Priority targets

1. `app/ebook-converter/src/components/library/EbookReader.tsx`
2. `app/ebook-converter/src/components/library/VoiceDebugPanel.tsx`
3. `app/ebook-converter/src/lib/pipeline/conversion-pipeline.ts`
4. `app/ebook-converter/src/lib/attribution.ts`

### Refactor approach

#### 3.1 Reader split

Break `EbookReader` into smaller modules:
- reader shell and layout
- chapter rendering
- TOC/navigation
- TTS playback controls
- debug modal state
- attribution debug panels

#### 3.2 Pipeline split

Separate the conversion pipeline into stages:
- parse
- validate
- repair
- metadata
- image collection
- EPUB emission

#### 3.3 Attribution module split

Move logic into clearer components:
- score aggregation
- conversation history scoring
- actor alternation adjustment
- evidence formatting
- debug output generation

### Acceptance criteria

- Files are under a manageable size and scope.
- A contributor can understand the module’s responsibilities without reading the entire file.
- Debug behavior is clearly separate from user-facing flow control.

---

## Phase 4 — Improve test hygiene and determinism

### Goal

Make the test suite fast, reproducible, and easier to trust.

### Actions

1. Separate tests into categories:
   - fast unit tests
   - integration tests
   - deterministic fixtures
   - AI/LLM variance tests
   - full E2E smoke tests
2. Document which tests are expected to be slow or environment-sensitive.
3. Keep the smoke path minimal and deterministic.
4. Avoid broad `skip` usage unless the reason is documented in the test itself.
5. Ensure fixture-based tests remain byte-stable and version-controlled.

### Acceptance criteria

- Developers can run a meaningful smoke path quickly.
- High-signal unit tests fail for real logic issues.
- AI-sensitive tests are clearly isolated from deterministic checks.

---

## Phase 5 — Remove debug debt from production code

### Goal

Limit production files from acting as a debugging notebook.

### Actions

1. Identify comment-heavy sections that are implementation history, not active guidance.
2. Reduce inline incident notes in product code.
3. Move important historical notes into docs instead of the code body.
4. Keep only concise comments necessary for onboarding or edge-case handling.

### Acceptance criteria

- Production code reads like current product logic, not a project diary.
- Debugging notes are available in docs and test cases instead of scattered in runtime modules.

---

## Phase 6 — Operational hardening and maintainability

### Goal

Improve the maintainability of the local-first product without over-engineering.

### Actions

1. Review middleware and API security patterns.
2. Review background worker lifecycle and crash recovery.
3. Review DB migration strategy and avoid unsafe direct schema writes.
4. Review any worker or API call patterns that assume a single-user, single-machine environment.
5. Standardize logging and error reporting.

### Acceptance criteria

- The system is easier to reason about under load.
- Operational failures are easier to diagnose.
- Local-first assumptions are explicit and documented.

---

## Phase 7 — Architecture and product clarity

### Goal

Make the product model clear enough that future features can be added without expanding the same modules further.

### Questions to answer

1. What are the true product boundaries: conversion, library, reader, audiobook generation, and TTS?
2. Which components are user-facing product code, and which are internal infrastructure?
3. What is the long-term architecture for AI logic, processing workers, and local storage?
4. Which features are “core” and which are “experimental” or “patchwork”?

### Acceptance criteria

- There is a clear architecture document.
- New contributors know which folder to edit for each feature.
- The code structure matches product responsibilities.

---

## Suggested order of execution

### Sprint 1: repo hygiene
- Phase 0: GitHub repo creation + baseline push
- Phase 1: doc normalization
- Phase 2: local runtime artifact cleanup

### Sprint 2: maintainability
- Phase 3: split oversized modules
- Phase 4: test hygiene and fixtures

### Sprint 3: product maturity
- Phase 5: debug debt cleanup
- Phase 6: operational hardening
- Phase 7: architecture clarity

---

## Recommended first PRs

1. Repo normalization / docs organization
2. `.gitignore` and runtime artifact cleanup
3. Reader module split
4. Pipeline module split
5. Test stabilization and deterministic fixtures

This sequence reduces risk while making the code easier to work in.

---

## Final recommendation

Do not start with a large rewrite.

Start with:
- repo normalization,
- doc cleanup,
- module splitting,
- and deterministic test stabilization.

That will create a clean foundation for the more expensive optimization work later.
