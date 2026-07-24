// POST /api/library/[id]/watermarks/rerun
//
// Force a watermark-detection + strip pass against the on-disk EPUB for a
// single book, independent of the conversion pipeline's `aiWatermarkClean`
// flag (which only runs at upload time). This is the "retroactive" cleanup
// path users hit when:
//   • they uploaded books before turning watermark cleanup on, or
//   • they just manually added / detected phrases for an existing book
//     and want the on-disk file to reflect those phrases (so the
//     audiobook exporter, the next-device download, and other consumers
//     all see the cleaned chapters).
//
// Body schema (all optional):
//   {
//     "phrases"?: string[],            // override with a custom phrase list
//                                    // (otherwise pulls per-book + memory)
//     "autoDetect"?: boolean,        // run the auto-detector; default true
//     "persistToMemory"?: boolean    // push newly-detected phrases into
//                                    // the cross-book WatermarkMemory
//   }
//
// Response mirrors /watermarks/apply: per-phrase hit counts, file-size
// delta, duration. If no phrases end up saved, returns 400 (no work to do).

import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import yazl from 'yazl';
import { getBook, getBookWatermarks, updateBookWatermarks } from '@/lib/db/books';
import { resolveBookPath } from '@/lib/storage';
import { parseEpub } from '@/lib/pipeline/epub-parser';
import { stripWatermarks, countPhraseHits } from '@/lib/pipeline/watermark-strip';
import { detectFromChaptersHtml } from '@/lib/pipeline/watermark-detect';
import {
  listWatermarkPhrases,
  rememberWatermarks,
  touchWatermarks,
} from '@/lib/db/watermark-memory';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface PhraseHit { phrase: string; hits: number }
interface RerunResult {
  ok: true;
  bookId: string;
  phrases: PhraseHit[];
  totalHits: number;
  chaptersStripped: number;
  chaptersUnchanged: number;
  bytesChanged: number;
  durationMs: number;
  oldSize: number;
  newSize: number;
  detectionSummary: {
    memory: number;
    autoDetected: number;
    manuallyProvided: number;
  };
}

export async function POST(
  req: NextRequest,
  props: { params: Promise<{ id: string }> },
) {
  const params = await props.params;
  const t0 = Date.now();
  try {
    const book = await getBook(params.id);
    if (!book) return NextResponse.json({ error: 'Book not found' }, { status: 404 });

    const body = (await req.json().catch(() => ({}))) as {
      phrases?: string[];
      autoDetect?: boolean;
      persistToMemory?: boolean;
    };

    const bookPath = await resolveBookPath(book);
    if (!fs.existsSync(bookPath)) {
      return NextResponse.json({ error: 'EPUB file not found on disk' }, { status: 404 });
    }

    // Build the working phrase list. Order matters:
    //   1. Explicit `phrases` from the caller (optional, e.g. for tests)
    //   2. Per-book saved watermarks
    //   3. WatermarkMemory catalog (always; cheap and idempotent)
    //   4. Fresh auto-detection (only when caller didn't provide a custom
    //      list and didn't opt out)
    const memoryPhrases = await listWatermarkPhrases();
    const memorySet = new Set(memoryPhrases);

    let detectedPhrases: string[] = [];
    const autoDetect = body.autoDetect !== false;

    if (Array.isArray(body.phrases)) {
      // Caller-supplied list — skip auto-detection but still merge memory.
      // De-dupe + drop anything already in memory (no double-strip cost).
      const explicit = body.phrases
        .map((p) => p.trim())
        .filter((p) => p.length > 0 && p.length <= 200);
      detectedPhrases = explicit.filter((p) => !memorySet.has(p));
    } else {
      const savedPhrases = await getBookWatermarks(params.id);
      const savedSet = new Set(savedPhrases);

      // Run auto-detection on the live file's chapters.
      const epub = await parseEpub(bookPath);
      const chapters = epub.htmlFiles
        .map((file) => epub.entries.get(file)?.data.toString('utf8') ?? '')
        .filter(Boolean)
        .map((html) => ({ html }));
      if (autoDetect && chapters.length >= 2) {
        detectedPhrases = detectFromChaptersHtml(chapters, { threshold: 0.4 })
          // Keep only newly-detected phrases that aren't already saved
          // OR in memory; otherwise we'd duplicate-strip on every run.
          .filter((p) => !savedSet.has(p) && !memorySet.has(p));
      }
    }

    const manualSet = new Set(detectedPhrases);
    const allPhrases = [...new Set([...memoryPhrases, ...detectedPhrases])].filter(Boolean);
    if (allPhrases.length === 0) {
      return NextResponse.json(
        { error: 'No watermark phrases available — run Detect first or pass phrases=[…]' },
        { status: 400 },
      );
    }

    // Persist newly-detected phrases into the per-book slot so the UI
    // reflects what's now being stripped.
    const savedPhrases = await getBookWatermarks(params.id);
    const merged = [...new Set([...savedPhrases, ...detectedPhrases])];
    if (merged.length > savedPhrases.length) {
      try {
        await updateBookWatermarks(book.id, merged);
      } catch (err) {
        console.warn('[watermarks/rerun] failed to persist per-book phrases:', err);
      }
    }

    // Optionally push newly-detected phrases into the cross-book
    // WatermarkMemory catalog so future uploads skip the scan.
    if (body.persistToMemory !== false && detectedPhrases.length > 0) {
      try {
        await rememberWatermarks(detectedPhrases, 'auto');
      } catch (err) {
        console.warn('[watermarks/rerun] memory persist failed:', err);
      }
    }
    try {
      await touchWatermarks(memoryPhrases);
    } catch { /* best-effort */ }

    // ── Atomic rewrite the EPUB with the merged phrase list ──────────────
    const oldSize = fs.statSync(bookPath).size;
    const tmpPath = `${bookPath}.tmp`;

    // Per-phrase hit counting against the ORIGINAL html so longest-first
    // attribution falls out for free.
    const epub = await parseEpub(bookPath);
    const phrases: PhraseHit[] = allPhrases
      .map((w) => w.trim())
      .filter(Boolean)
      .map((phrase) => ({ phrase, hits: 0 }));
    for (const name of epub.htmlFiles) {
      const entry = epub.entries.get(name);
      if (!entry) continue;
      const hits = countPhraseHits(entry.data.toString('utf8'), allPhrases);
      for (const h of hits) {
        const target = phrases.find((p) => p.phrase === h.phrase);
        if (target) target.hits += h.hits;
      }
    }
    phrases.sort((a, b) => b.phrase.length - a.phrase.length);

    // Build the stripped EPUB
    const htmlSet = new Set(epub.htmlFiles);
    const zip = new yazl.ZipFile();
    const mimetype = epub.entries.get('mimetype')?.data
      ?? Buffer.from('application/epub+zip');
    zip.addBuffer(mimetype, 'mimetype', { compress: false });

    let chaptersStripped = 0;
    let chaptersUnchanged = 0;
    let bytesChanged = 0;

    for (const [name, entry] of epub.entries) {
      if (name === 'mimetype') continue;
      if (htmlSet.has(name)) {
        const original = entry.data.toString('utf8');
        const stripped = stripWatermarks(original, allPhrases);
        if (stripped !== original) {
          chaptersStripped++;
          bytesChanged += Buffer.byteLength(original, 'utf8') - Buffer.byteLength(stripped, 'utf8');
          zip.addBuffer(Buffer.from(stripped, 'utf8'), name);
        } else {
          chaptersUnchanged++;
          zip.addBuffer(entry.data, name);
        }
      } else {
        zip.addBuffer(entry.data, name);
      }
    }

    zip.end();
    await new Promise<void>((resolve, reject) => {
      const out = fs.createWriteStream(tmpPath);
      out.on('close', () => resolve());
      out.on('error', reject);
      zip.outputStream.pipe(out);
    });

    try {
      fs.renameSync(tmpPath, bookPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
        fs.copyFileSync(tmpPath, bookPath);
        fs.unlinkSync(tmpPath);
      } else {
        try { fs.unlinkSync(tmpPath); } catch { /* best effort */ }
        throw err;
      }
    }

    const newSize = fs.statSync(bookPath).size;
    const { updateBook } = await import('@/lib/db/books');
    try { await updateBook(book.id, { fileSize: newSize }); } catch { /* best effort */ }

    const result: RerunResult = {
      ok: true,
      bookId: book.id,
      phrases,
      totalHits: phrases.reduce((a, p) => a + p.hits, 0),
      chaptersStripped,
      chaptersUnchanged,
      bytesChanged,
      durationMs: Date.now() - t0,
      oldSize,
      newSize,
      detectionSummary: {
        memory: memoryPhrases.length,
        autoDetected: detectedPhrases.length,
        manuallyProvided: manualSet.size,
      },
    };
    return NextResponse.json(result);
  } catch (err) {
    console.error('[watermarks/rerun]', err);
    return NextResponse.json(
      { error: 'Rerun failed: ' + (err instanceof Error ? err.message : String(err)) },
      { status: 500 },
    );
  }
}
