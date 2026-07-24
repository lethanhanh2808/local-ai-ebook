// src/lib/tools/calibre-formats.ts
//
// Phase 4.3 of docs/NEXT_UP_PLAN.md — the single source of truth for which
// input formats the Calibre importer handles.
//
// Adding PDF/DOCX/AZW3/LIT/RTF later is just appending rows here — the probe
// helper, worker pre-step, and UI banners all read from this list. No code
// changes elsewhere.

export interface CalibreFormat {
  /** Lowercase extension without the leading dot. e.g. "mobi". */
  extension: string;
  /** Browser MIME types that map to this extension. Multiple entries are
   *  needed because different browsers map the same extension to different
   *  types (e.g. .pdf → application/pdf on Chrome, application/octet-stream
   *  on Safari in some flows). */
  mimeTypes: string[];
  /** Vietnamese description shown in the Settings → Importers panel and
   *  the convert page's "Định dạng hỗ trợ" card. */
  description: string;
  /** True for formats that often arrive as scanned images (only PDF in
   *  practice). Calibre does not OCR — these formats may produce empty
   *  chapters. Surfaced in the UI so users aren't surprised. */
  requiresOcr: boolean;
}

/** v1: MOBI only — the most common non-EPUB input format for Vietnamese
 *  novel readers using Kindle. */
export const CALIBRE_FORMATS: readonly CalibreFormat[] = [
  {
    extension: 'mobi',
    mimeTypes: [
      'application/x-mobipocket-ebook',
      'application/octet-stream',
    ],
    description: 'Mobipocket (Kindle)',
    requiresOcr: false,
  },
] as const;

/** Quick lookup: extension string → CalibreFormat. */
export function findCalibreFormat(ext: string): CalibreFormat | undefined {
  const lower = ext.toLowerCase();
  return CALIBRE_FORMATS.find((f) => f.extension === lower);
}
