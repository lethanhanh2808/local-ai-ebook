// POST /api/library/[id]/watermarks/apply
//
// Rewrite the EPUB file on disk with the book's saved watermark phrases
// stripped from every chapter. Returns per-phrase hit counts so the UI
// can render "Đã xoá 47 lần × 3 cụm từ" with a per-phrase breakdown.
//
// Atomic-rewrite pattern matches the editor's `save` mode at
// /api/library/[id]/editor/route.ts:198–224 (.tmp + fs.renameSync +
// EXDEV fallback).
//
// Hit counting is done against the ORIGINAL html (longest-first
// attribution falls out for free — see watermark-strip.ts for details).
import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import yazl from 'yazl';
import { getBook, getBookWatermarks, updateBook } from '@/lib/db/books';
import { resolveBookPath } from '@/lib/storage';
import { parseEpub } from '@/lib/pipeline/epub-parser';
import { stripWatermarks, countPhraseHits } from '@/lib/pipeline/watermark-strip';
import { touchWatermarks } from '@/lib/db/watermark-memory';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface PhraseHit { phrase: string; hits: number }
interface ApplyResult {
  ok: true;
  phrases: PhraseHit[];              // input order, longest-first
  totalHits: number;
  chaptersStripped: number;
  chaptersUnchanged: number;
  bytesChanged: number;
  durationMs: number;
  oldSize: number;
  newSize: number;
}

async function buildStrippedEpub(
  sourcePath: string,
  outputPath: string,
  watermarks: string[],
): Promise<{ chaptersStripped: number; chaptersUnchanged: number; bytesChanged: number }> {
  const epub = await parseEpub(sourcePath);
  const zip = new yazl.ZipFile();

  // EPUB spec: mimetype MUST be first, uncompressed.
  const mimetype = epub.entries.get('mimetype')?.data
    ?? Buffer.from('application/epub+zip');
  zip.addBuffer(mimetype, 'mimetype', { compress: false });

  const htmlSet = new Set(epub.htmlFiles);
  let chaptersStripped = 0;
  let chaptersUnchanged = 0;
  let bytesChanged = 0;

  for (const [name, entry] of epub.entries) {
    if (name === 'mimetype') continue;            // already added above
    if (htmlSet.has(name)) {
      const original = entry.data.toString('utf8');
      const stripped = stripWatermarks(original, watermarks);
      if (stripped !== original) {
        chaptersStripped++;
        bytesChanged += Buffer.byteLength(original, 'utf8') - Buffer.byteLength(stripped, 'utf8');
        zip.addBuffer(Buffer.from(stripped, 'utf8'), name);
      } else {
        chaptersUnchanged++;
        zip.addBuffer(entry.data, name);          // verbatim copy
      }
    } else {
      zip.addBuffer(entry.data, name);            // CSS, images, OPF, NCX, nav.xhtml
    }
  }

  zip.end();
  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(outputPath);
    out.on('close', () => resolve());
    out.on('error', reject);
    zip.outputStream.pipe(out);
  });

  return { chaptersStripped, chaptersUnchanged, bytesChanged };
}

export async function POST(
  _req: NextRequest,
  props: { params: Promise<{ id: string }> },
) {
  const params = await props.params;
  const t0 = Date.now();
  try {
    const book = await getBook(params.id);
    if (!book) return NextResponse.json({ error: 'Book not found' }, { status: 404 });

    const watermarks = await getBookWatermarks(params.id);
    if (watermarks.length === 0) {
      return NextResponse.json(
        { error: 'No watermarks saved for this book. Run Detect first.' },
        { status: 400 },
      );
    }

    const bookPath = await resolveBookPath(book);
    if (!fs.existsSync(bookPath)) {
      return NextResponse.json({ error: 'EPUB file not found on disk' }, { status: 404 });
    }

    const oldSize = fs.statSync(bookPath).size;
    const tmpPath = `${bookPath}.tmp`;

    // ── Per-phrase hit counting (against ORIGINAL html, so longest-first
    // attribution falls out for free — "DTV-EBOOK" inside the long phrase
    // is counted as a hit of the long phrase only, never as a separate
    // hit of the short one).
    const epub = await parseEpub(bookPath);
    const phrases: PhraseHit[] = watermarks
      .map((w) => w.trim())
      .filter(Boolean)
      .map((phrase) => ({ phrase, hits: 0 }));
    for (const name of epub.htmlFiles) {
      const entry = epub.entries.get(name);
      if (!entry) continue;
      const hits = countPhraseHits(entry.data.toString('utf8'), watermarks);
      for (const h of hits) {
        const target = phrases.find((p) => p.phrase === h.phrase);
        if (target) target.hits += h.hits;
      }
    }
    // Preserve longest-first ordering for the response (matches strip order).
    phrases.sort((a, b) => b.phrase.length - a.phrase.length);

    // ── Atomic rewrite
    const { chaptersStripped, chaptersUnchanged, bytesChanged } =
      await buildStrippedEpub(bookPath, tmpPath, watermarks);

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
    try { await updateBook(book.id, { fileSize: newSize }); } catch { /* best effort */ }

    // Best-effort memory touch (fire-and-forget, never blocks the response)
    void touchWatermarks(watermarks).catch(() => { /* ignore */ });

    const result: ApplyResult = {
      ok: true,
      phrases,
      totalHits: phrases.reduce((a, p) => a + p.hits, 0),
      chaptersStripped,
      chaptersUnchanged,
      bytesChanged,
      durationMs: Date.now() - t0,
      oldSize,
      newSize,
    };
    return NextResponse.json(result);
  } catch (err) {
    console.error('[watermarks/apply]', err);
    return NextResponse.json(
      { error: 'Apply failed: ' + (err instanceof Error ? err.message : String(err)) },
      { status: 500 },
    );
  }
}