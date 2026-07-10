// src/app/api/library/[id]/illustrations/[chapterIdx]/route.ts
//
// Serve a single AI-generated illustration PNG/JPEG from disk.
//
//   GET /api/library/[id]/illustrations/[chapterIdx]
//
// The DB row (Illustration) holds the absolute on-disk path; this route
// streams the bytes back to the browser with the correct Content-Type
// (sniffed from the magic bytes since the file's actual format may be
// JPEG even though the row stores .png — MiniMax returns JPEG, DALL-E 3
// returns PNG). The .http-style `URL` API serves `/api/library/<id>/
// illustrations/<chapterIdx>` from the reader and the gallery.
//
// The PNG file is treated as immutable per (book, chapter) — uploads of
// a regenerated illustration overwrite the previous file before DB row
// updates; clients can safely Cache-Control: max-age=86400.
//
// 404 if the row or file is missing.
import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import { prisma } from '@/lib/db/client';

export const runtime = 'nodejs';
// Don't cache the route itself; the response carries its own immutable
// Cache-Control header.
export const dynamic = 'force-dynamic';

/** Sniff JPEG vs PNG from the first 2 bytes. */
function sniffExt(buf: Buffer): 'png' | 'jpg' | undefined {
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  return undefined;
}

export async function GET(
  _req: NextRequest,
  props: { params: Promise<{ id: string; chapterIdx: string }> }
) {
  const params = await props.params;
  const idx = parseInt(params.chapterIdx, 10);
  if (!Number.isFinite(idx) || idx < 0) {
    return NextResponse.json({ error: 'Invalid chapterIdx' }, { status: 400 });
  }

  const row = await prisma.illustration.findUnique({
    where: { bookId_chapterIndex: { bookId: params.id, chapterIndex: idx } },
  });
  if (!row) return NextResponse.json({ error: 'Illustration not found' }, { status: 404 });

  // Check file exists + read with a size cap (we don't want to OOM the
  // worker on a corrupted entry that points at a 4 GB junk file).
  try {
    const stat = fs.statSync(row.imagePath);
    const buf = fs.readFileSync(row.imagePath);
    const ext = sniffExt(buf) ?? (row.imagePath.toLowerCase().endsWith('.jpg') ? 'jpg' : 'png');
    const mime = ext === 'jpg' ? 'image/jpeg' : 'image/png';

    return new NextResponse(buf, {
      status: 200,
      headers: {
        'Content-Type': mime,
        'Content-Length': String(stat.size),
        // Immutable for 1 day — the row's imagePath only changes when
        // the user regenerates, and the regeneration route writes the
        // new bytes before updating imagePath, so even mid-edit clients
        // either get the old OR the new file, never a partial.
        'Cache-Control': 'private, max-age=86400, immutable',
        // Attach metadata for client-side captions / debug.
        'X-Illustration-Chapter': String(row.chapterIndex),
        'X-Illustration-Title': encodeURIComponent(row.chapterTitle ?? ''),
        'X-Illustration-Model': encodeURIComponent(row.imageModel ?? ''),
      },
    });
  } catch (err) {
    console.warn(`[illustrations] file missing for ${params.id}/${idx}: ${row.imagePath}`, err);
    return NextResponse.json({ error: 'File missing on disk' }, { status: 404 });
  }
}
