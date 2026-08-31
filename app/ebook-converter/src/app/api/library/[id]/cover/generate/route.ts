// POST /api/library/[id]/cover/generate
// 1. Try to extract existing cover from EPUB
// 2. Otherwise, generate a beautiful AI-powered cover (background + elegant typography)
// 3. Falls back to SVG-only generation if AI is disabled
// 4. Persist the new cover into the EPUB so subsequent downloads ship it
//
// Optional body fields:
//   • `genre`      — explicit genre override. Free-text ("tu tiểu thuyết") or
//                    enum ("tu_tieu_thuyet", "ngon_tinh", "lich_su", "do_thi",
//                    "game_system", "kinh_di", "khoa_hoc_vien_tuong",
//                    "thieu_nien"). Without this, we infer from the title.
//   • `seed`       — explicit seed (otherwise derived from title|author).
//   • `tags`       — array of strings that override inferred genre cues.
//
// The response includes `genre` + `genreConfidence` so the UI can show
// the user "what theme we picked" and offer a dropdown to override.
import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { getBook, updateBook } from '@/lib/db/books';
import { embedCoverIntoEpub, extractCoverFromEpub } from '@/lib/pipeline/epub-cover';
import { coverPath, packedEpubPath, resolveBookPath } from '@/lib/storage';
import { generateAIBookCover } from '@/lib/covers/ai-generate-cover';
import { detectGenre } from '@/lib/covers/genre-detector';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const book = await getBook(params.id);
  if (!book) return NextResponse.json({ error: 'Book not found' }, { status: 404 });

  // Parse optional body fields. We accept JSON or fall back to no body.
  // `genre` is the explicit theme hint; `seed` lets users reroll.
  // `force` skips EPUB cover extraction and always generates a fresh
  // AI cover (used by the "Generate cover" button so the user gets a new
  // AI illustration even when the EPUB already ships a cover).
  let body: { genre?: string | null; seed?: number; force?: boolean } = {};
  try {
    const raw = await req.text();
    body = raw ? JSON.parse(raw) : {};
  } catch { /* ignore — empty/invalid body just means defaults */ }

  const forceAi = Boolean(body.force);

  const destBase = coverPath(book.id);
  const bookPath = await resolveBookPath(book);

  // ── Genre detection (visible to caller) ─────────────────────────
  // We tag the book with the auto-detected Vietnamese-novel genre so
  // the UI can let the user override ("this looks like tu tiểu thuyết,
  // but should it be ngôn tình?"). The actual generator call already
  // passes the hint through when the body supplies one; the response
  // echoes what we ACTUALLY used.
  const detection = detectGenre({
    title: book.titleVi ?? book.title,
    titleVi: book.titleVi,
    description: book.description,
    hint: body.genre ?? null,
  });

  // 1. Try to extract existing cover from the EPUB
  //    Skip this entirely when `force` is requested — the user explicitly
  //    wants a fresh AI-generated cover, not the publisher's embedded one.
  if (!forceAi && fs.existsSync(bookPath)) {
    try {
      const extracted = await extractCoverFromEpub(bookPath, destBase);
      if (extracted) {
        const exts = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
        for (const ext of exts) {
          const p = destBase.replace(/\.[^.]+$/, `.${ext}`);
          if (fs.existsSync(p)) { await updateBook(book.id, { coverPath: p }); break; }
        }
        // Invalidate any cached pack from a previous cover so the next
        // download re-embeds the freshly-extracted cover.
        await safeUnlink(packedEpubPath(book.id));
        return NextResponse.json({
          ok: true,
          type: 'extracted',
          // Echo the genre for parity with the AI path.
          genre: detection.genre,
          genreVi: detection.spec.vi,
          genreEn: detection.spec.en,
          genreConfidence: Number(detection.confidence.toFixed(3)),
          genreHits: detection.matchedKeywords,
          // Extracted covers come pre-baked with the publisher's own
          // layout, so we don't pick a placement here. Surface null
          // so the UI knows there's no choice to offer.
          placement: null,
          placementScore: null,
        });
      }
    } catch { /* fall through to generation */ }
  }

  // 2. Generate cover — AI background (if enabled) + elegant title typography.
  //     The title on the bìa is the user's Vietnamese version when set,
  //     otherwise the book's stored title (which is already Vietnamese for
  //     native-VN imports). This guarantees the printed text is always
  //     Vietnamese — even if the imported `title` is in another language
  //     (e.g. Chinese for translated novels).
  try {
    const result = await generateAIBookCover({
      title: book.titleVi ?? book.title,
      author: book.author,
      language: book.language,
      series: book.series,
      seriesIndex: book.seriesIndex ?? undefined,
      description: book.description,
      genre: detection.genre,
      seed: typeof body.seed === 'number' ? body.seed : undefined,
    });

    const pngPath = destBase.replace(/\.[^.]+$/, '.png');
    fs.mkdirSync(path.dirname(pngPath), { recursive: true });
    fs.writeFileSync(pngPath, result.buffer);
    await updateBook(book.id, { coverPath: pngPath });

    // 3. Persist the cover into the EPUB on disk so it survives the
    //    download round-trip. The download endpoint reads `coverPath`
    //    from the DB, but the EPUB ZIP itself is what actually goes
    //    out the door — without this step, regenerating the cover
    //    would only update the library thumbnail, not the file the
    //    user downloads.
    let embedded = false;
    if (fs.existsSync(bookPath)) {
      try {
        const packed = packedEpubPath(book.id);
        const result = await embedCoverIntoEpub(bookPath, pngPath, packed);
        embedded = result.ok;
      } catch (err) {
        // Non-fatal: the cover is saved + the thumbnail will refresh.
        // The user can still re-trigger via a Regenerate click and the
        // download endpoint will catch up on the next attempt.
        console.warn('[cover/generate] EPUB re-pack failed:', err);
      }
    }

    return NextResponse.json({
      ok: true,
      type: result.source === 'ai' ? 'ai' : 'generated',
      source: result.source,
      design: { style: result.design.style, accent: result.design.accent, background: result.design.background },
      durationMs: result.durationMs,
      embedded,
      // Echo the genre we used + how confident the detector is, plus the
      // signal keywords we matched. The UI can show this as a chip
      // ("Đã nhận diện: Tu tiên / Kiếm hiệp") so the user knows what the
      // model thinks the book is, and can override if it's wrong.
      genre: detection.genre,
      genreVi: detection.spec.vi,
      genreEn: detection.spec.en,
      genreConfidence: Number(detection.confidence.toFixed(3)),
      genreHits: detection.matchedKeywords,
      // Final placement the picker chose for the title overlay, after
      // re-scoring the AI image. Echoed so a future UI dropdown can
      // offer "bottom / top / left / right" overrides. `placementScore`
      // is the 0..1 confidence; the UI can show it as a small hint
      // ("AI picked bottom — confidence 0.78").
      placement: result.placement ?? null,
      placementScore: result.placementScore ?? null,
    });
  } catch (err) {
    console.error('[cover/generate]', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

async function safeUnlink(p: string): Promise<void> {
  try { await fs.promises.unlink(p); } catch { /* best-effort cache invalidation */ }
}
