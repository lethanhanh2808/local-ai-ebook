// src/app/api/library/[id]/download/route.ts
// GET /api/library/:id/download – stream the EPUB file
//
// Cover persistence:
//   When the book has a stored `coverPath` (typically an AI-generated
//   cover written by `/cover/generate`), we re-pack the EPUB so the
//   downloaded file actually contains that cover image. The re-pack
//   is cached at `data/library/packed/<id>.epub` and only re-runs
//   when the cover file's mtime/size changes, so the cost is paid
//   once per cover regeneration — not once per download.
import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getBook } from '@/lib/db/books';
import { packedEpubPath, resolveBookPath, resolveCoverPath } from '@/lib/storage';
import { assertWithinRoots, pathRoots, SafePathError } from '@/lib/storage/safe-path';
import { embedCoverIntoEpub } from '@/lib/pipeline/epub-cover';

/** True if the on-disk packed EPUB is still in sync with the source
 *  cover (same mtime + size as last seen). Cheap no-IO check. */
function isPackFresh(packedPath: string, sourceCoverPath: string, sourceEpubPath: string): boolean {
  try {
    const pk = fs.statSync(packedPath);
    const cv = fs.statSync(sourceCoverPath);
    const sp = fs.statSync(sourceEpubPath);
    // Packed file must be newer than both the cover and the source EPUB.
    // (We don't store the metadata — comparing mtimes is enough for our
    // cover-only change pattern.)
    return pk.mtimeMs >= cv.mtimeMs && pk.mtimeMs >= sp.mtimeMs;
  } catch {
    return false;
  }
}

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const book = await getBook(params.id);
  if (!book) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  let epubPath: string;
  try {
    epubPath = assertWithinRoots(await resolveBookPath(book), [pathRoots().library]);
  } catch (error) {
    if (error instanceof SafePathError) {
      return NextResponse.json({ error: 'File not found on disk' }, { status: 404 });
    }
    throw error;
  }
  if (!fs.existsSync(epubPath)) {
    return NextResponse.json({ error: 'File not found on disk' }, { status: 404 });
  }

  // ── Decide which EPUB file to stream ─────────────────────────────────
  // If the book has a stored cover (especially the AI cover written by
  // /cover/generate), re-pack the EPUB so the cover actually ships.
  const coverPath = await resolveCoverPath(book);
  let streamPath = epubPath;
  let streamSize = fs.statSync(epubPath).size;

  if (coverPath) {
    const packed = packedEpubPath(book.id);
    if (!isPackFresh(packed, coverPath, epubPath)) {
      try {
        await embedCoverIntoEpub(epubPath, coverPath, packed);
      } catch (err) {
        // Pack failure shouldn't block the user from downloading the
        // book — fall back to the raw EPUB with the original cover.
        console.warn('[download] cover re-pack failed, streaming raw EPUB:', err);
      }
    }
    if (fs.existsSync(packed)) {
      streamPath = packed;
      streamSize = fs.statSync(packed).size;
    }
  }

  const stream = fs.createReadStream(streamPath);
  // Build a safe ASCII fallback plus RFC 5987 UTF-8 encoded name
  const rawName = `${book.title} - ${book.author}.epub`;
  const asciiName = rawName.replace(/[^\x20-\x7E]/g, '_').replace(/[/\\?%*:|"<>]/g, '-').trim();
  const encodedName = encodeURIComponent(rawName);

  return new NextResponse(stream as unknown as ReadableStream, {
    status: 200,
    headers: {
      'Content-Type': 'application/epub+zip',
      'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
      'Content-Length': String(streamSize),
      'Cache-Control': 'private, no-store',
    },
  });
}
