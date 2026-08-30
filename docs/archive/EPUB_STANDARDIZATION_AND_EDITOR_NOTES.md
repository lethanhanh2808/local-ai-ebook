# EPUB Standardization And Editor Notes

Date: 2026-07-04

## Reference Repositories

Downloaded under `reference/`:

- `reference/standardebooks-manual`
- `reference/standardebooks-tools`
- `reference/w3c-epub-specs`
- `reference/Sigil-Ebook-Sigil`

## What We Used

### W3C EPUB Specs

Relevant lessons for the converter:

- Keep `mimetype` as the first ZIP entry and store it uncompressed.
- Keep `META-INF/container.xml` pointing to the package document.
- EPUB3 requires a package document, manifest, spine, and navigation document.
- The nav document should include `epub:type="toc"` and should be listed in OPF with `properties="nav"`.
- `toc.ncx` is not required by EPUB3, but it improves compatibility with older readers.
- XHTML content should declare the XHTML namespace and language.
- Reflowable ebooks should avoid fragile layout CSS.

Implemented:

- Richer EPUB3 `nav.xhtml` with `toc`, `landmarks`, and optional `page-list`.
- Nested TOC generation from chapter h2-h4 headings.
- Mirrored nested `toc.ncx` generation for older devices.
- More complete package metadata and accessibility feature metadata.
- Stricter validator checks for package, nav, XHTML language/namespace, duplicate IDs, and heading anchors.

### Standard Ebooks Manual

Relevant lessons for the converter:

- Body content should be grouped into semantic sectioning elements.
- Headings that represent structural divisions should appear in the table of contents.
- Headings should have stable anchors when they are navigation targets.
- EPUB CSS should be conservative and reflowable.
- Navigation and structural semantics matter more than decorative styling.

Implemented:

- Generated chapters now use stable section IDs and title IDs.
- Chapter bodies declare `epub:type="bodymatter"`.
- Chapter sections declare `epub:type="chapter"` and `role="doc-chapter"`.
- Standard CSS was simplified toward reader compatibility and reflowable layout.
- Nested section headings are added to the generated TOC when present.

### Standard Ebooks Tools

Useful code concepts:

- Their build tooling keeps `mimetype` uncompressed.
- Their tooling can convert HTML nav into NCX for compatibility.
- Their commands separate build, lint, manifest, spine, and TOC concerns.

Implemented in our TypeScript pipeline:

- The builder now treats nav and NCX generation as first-class output steps.
- The validator now catches more EPUB structural problems before handoff.

Future useful idea:

- Add optional external `epubcheck` integration for stricter validation when Java and epubcheck are installed.

### Sigil

Useful product concept:

- A full EPUB editor needs file tree, book browser, code view, preview, validation, and save/repackage logic.

Implemented a deliberately smaller version:

- `/library/[id]/edit` opens a basic WYSIWYG chapter editor.
- The editor lists chapters, loads one chapter at a time, supports common formatting actions, and saves as a new edited copy.
- The save API preserves the original archive, replaces the edited chapter, updates nav/NCX labels when the title changes, and adds the edited copy to the library.

Not implemented:

- Full file tree editing.
- CSS/image/font editing.
- Code view with syntax validation.
- Multi-chapter batch save.
- EPUBCheck integration.

## Files Changed

EPUB output:

- `app/ebook-converter/src/lib/pipeline/epub-builder.ts`
- `app/ebook-converter/src/lib/pipeline/epub-styler.ts`
- `app/ebook-converter/src/lib/pipeline/epub-validator.ts`
- `app/ebook-converter/src/lib/pipeline/conversion-pipeline.ts`
- `app/ebook-converter/src/app/api/library/[id]/enhance/route.ts`

Editor:

- `app/ebook-converter/src/app/library/[id]/edit/page.tsx`
- `app/ebook-converter/src/components/library/EpubEditor.tsx`
- `app/ebook-converter/src/app/api/library/[id]/editor/route.ts`
- `app/ebook-converter/src/components/library/BookCard.tsx`

Tests:

- `app/ebook-converter/src/tests/epub-builder.test.ts`
- `app/ebook-converter/src/tests/epub-validator.test.ts`
- `app/ebook-converter/e2e/00-smoke.spec.ts`

## Next Recommendations

1. Preserve images during conversion instead of stripping `<img>` tags.
2. Add optional `epubcheck` validation and show results in the job report.
3. Add a deterministic fixture EPUB for conversion, TOC, and editor tests.
4. Add editor code view/source cleanup for advanced fixes.
5. Add chapter split/merge tools for messy imported files.
6. Add a TOC review screen before final build for books with poor source navigation.
