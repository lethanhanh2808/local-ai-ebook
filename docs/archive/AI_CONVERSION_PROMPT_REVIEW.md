# AI Conversion Prompt Review

Date: 2026-07-04

This note records the current AI prompt strategy for ebook conversion and the follow-up ideas to continue improving EPUB output quality.

## Review Summary

The previous AI conversion prompts were useful, but too permissive for production-quality EPUB conversion. The main risks were content drift, accidental summarization, duplicate chapter headings, invented metadata, unsafe watermark removal, and AI output being accepted even when it returned a full HTML document or invalid fragment.

The safest strategy is now:

- AI cleans chapter body fragments only.
- Deterministic code owns EPUB structure, titles, navigation, OPF metadata, and CSS.
- Every AI output is validated before it is used.
- Unsafe AI output falls back to original content with a warning.

## Implemented Prompt Enhancements

### Chapter Light Enhancement

File: `app/ebook-converter/src/lib/ai/chapter-enhancer.ts`

Changes:

- Rewrote the default system prompt as a conservative EPUB body-fragment cleanup prompt.
- Added hard rules against translation, summarization, rewriting, censorship, modernization, and invented story content.
- Required output to be body-fragment HTML only, with no `<html>`, `<head>`, `<body>`, markdown, code fences, or explanations.
- Clarified that the app injects the canonical chapter `<h1>`.
- Limited watermark removal to clearly non-book promotional/source-site text.
- Made custom prompts optional style requests that cannot override invariant rules.
- Added output cleanup and safety checks for empty output, full-document output, scripts, unexpected `<h1>`, severe visible-text shrinkage, and severe expansion.
- Added per-chapter fallback for batch enhancement so one failed AI call does not reject the whole batch.

### Deep Chapter Formatting

File: `app/ebook-converter/src/lib/ai/chapter-formatter.ts`

Changes:

- Removed the contradictory instruction that said both "do not include `<h1>`" and "start with `<h1>`".
- Reframed the formatter as a conservative EPUB body-fragment formatter.
- Added stronger Vietnamese formatting rules while preserving original wording.
- Allowed only XHTML-compatible body tags and preserved safe links/images.
- Made retry hints match the real contract: no full document, no `<h1>`, no markdown, no invented content.
- Added validation for markdown fences, unsafe full-document tags, unexpected `<h1>`, missing block content, and unbalanced paragraphs.
- Added visible-text preservation checks to reject likely summarization, truncation, or hallucinated expansion.
- Changed long-chapter behavior so invalid AI chunks fall back to the original chunk instead of being stitched into output.

### EPUB Repair And Analysis

File: `app/ebook-converter/src/lib/ai/epub-analyzer.ts`

Changes:

- Tightened repair-plan prompts to return only JSON and identify only evidenced problems.
- Tightened HTML repair prompts to preserve all meaningful content and avoid rewriting.
- Required chapter detection to use exact filenames from the parsed EPUB list.
- Made metadata generation conservative and evidence-based, with `Unknown` for missing title/author when evidence is insufficient.

### Watermark Confirmation

File: `app/ebook-converter/src/app/api/library/[id]/watermarks/route.ts`

Changes:

- Reworded the AI watermark classifier for high precision.
- Explicitly stated that false positives are worse than false negatives.
- Protected recurring story text, chapter titles, subtitles, poems, epigraphs, letters, dialogue, and character catchphrases.

### Deterministic EPUB Guards

Files:

- `app/ebook-converter/src/lib/pipeline/epub-styler.ts`
- `app/ebook-converter/src/lib/pipeline/conversion-pipeline.ts`
- `app/ebook-converter/src/app/api/library/[id]/enhance/route.ts`

Changes:

- Added `extractChapterBodyFragment()` to strip generated/imported wrappers and leading chapter headings before AI receives content.
- Updated conversion and existing-book enhancement paths to send only editable body content to AI.
- Kept `buildChapterHtml()` as the single owner of canonical chapter title injection.
- Added unit coverage for wrapper stripping and duplicate heading prevention.

## Prompt Contract

Every AI conversion prompt should preserve these rules:

- Return only the requested schema or HTML fragment.
- Never translate, summarize, rewrite, paraphrase, censor, modernize, or add story content.
- Preserve names, dialogue wording, paragraph order, links, images, and meaningful text.
- Fix obvious encoding/HTML structure issues only when the intended correction is clear.
- Remove only clear promotional/source-site watermarks.
- Do not create chapter `<h1>` in chapter body output.
- Do not invent filenames, metadata, image paths, IDs, classes, CSS, or chapter titles.
- Fail safe by returning original content when model output is unsafe.

## Recommended Next Improvements

1. Add a deterministic fixture set for AI conversion evaluation.

   Include short EPUB/HTML/TXT samples with Vietnamese dialogue, scene breaks, mojibake, duplicate headings, repeated story catchphrases, real watermarks, images, and nested headings.

2. Add snapshot-style output checks.

   For each fixture, verify generated EPUB structure, nav/NCX entries, chapter headings, visible text preservation ratio, image references, and absence of source-site watermark phrases.

3. Add an optional "strict preservation" mode.

   This mode should disable paragraph merging and only allow HTML repair, encoding fixes, and clear watermark removal.

4. Add prompt versioning to job metadata.

   Store a prompt/profile version with conversion jobs so output regressions can be traced to a specific prompt revision.

5. Add a visual EPUB QA page.

   Show before/after chapter text, heading map, TOC entries, visible-text ratio, detected removals, and AI warnings before saving final output.

6. Add EPUBCheck integration.

   Run it after build when available and surface errors in the job report.

7. Add model comparison tests.

   Run the same fixture through local oMLX models and compare structural validity, preservation ratio, and watermark precision.

## Verification Checklist For Future Prompt Changes

Run at minimum:

```bash
cd app/ebook-converter && npx tsc --noEmit
cd app/ebook-converter && npm test
```

For output-impacting changes, also run:

```bash
./scripts/verify_changes.sh
```

Then manually inspect at least one generated EPUB:

- TOC entries open the correct chapters.
- Each chapter has exactly one visible chapter title.
- Vietnamese diacritics are preserved.
- Dialogue and paragraph flow are improved but not rewritten.
- Watermarks are removed only when clearly promotional.
- Reader opens the converted book without layout or navigation issues.

## Verification Performed In This Pass

```bash
cd app/ebook-converter && npm test -- --run src/tests/epub-styler.test.ts
cd app/ebook-converter && npm test
cd app/ebook-converter && npx tsc --noEmit
./scripts/verify_changes.sh
```

Additional temporary conversion smoke:

- Input: `app/ebook-converter/data/uploads/ed3a4508-9133-4cbb-b45b-cb42e2ba343c-tiny.epub`
- Result: parsed generated EPUB successfully.
- Output contained 1 chapter, `EPUB/nav.xhtml`, and `EPUB/toc.ncx`.
