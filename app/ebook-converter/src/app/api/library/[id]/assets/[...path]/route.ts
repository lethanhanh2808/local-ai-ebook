// GET /api/library/[id]/assets/[...path]
// Serves images and other assets embedded inside a stored EPUB ZIP.
// The reader iframes rewrite relative asset paths to this endpoint.
import { NextRequest, NextResponse } from 'next/server';
import { getBook } from '@/lib/db/books';
import fs from 'fs';
import yauzl from 'yauzl';
import { promisify } from 'util';

const MIME_MAP: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  ttf: 'font/ttf', otf: 'font/otf',
  woff: 'font/woff', woff2: 'font/woff2', css: 'text/css',
};

function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string; path: string[] } },
) {
  const book = await getBook(params.id);
  if (!book?.filePath || !fs.existsSync(book.filePath)) {
    return new NextResponse(null, { status: 404 });
  }

  const assetPath = params.path.join('/'); // e.g. "images/cover.jpg"
  const ext = assetPath.split('.').pop()?.toLowerCase() ?? '';
  const mime = MIME_MAP[ext] ?? 'application/octet-stream';

  const openZip = promisify<string, yauzl.Options, yauzl.ZipFile>(yauzl.open);

  try {
    const zip = await openZip(book.filePath, { lazyEntries: true });

    const buf = await new Promise<Buffer | null>((resolve, reject) => {
      zip.readEntry();
      zip.on('entry', (entry: yauzl.Entry) => {
        const fn = entry.fileName;
        // Match the asset: exact, EPUB-prefixed, or suffix match
        const isMatch =
          fn === assetPath ||
          fn === `EPUB/${assetPath}` ||
          fn.endsWith(`/${assetPath}`) ||
          fn.endsWith(assetPath);
        if (isMatch && !/\/$/.test(fn)) {
          zip.openReadStream(entry, (err, stream) => {
            if (err || !stream) { zip.close(); resolve(null); return; }
            streamToBuffer(stream)
              .then((b) => { zip.close(); resolve(b); })
              .catch(reject);
          });
        } else {
          zip.readEntry();
        }
      });
      zip.on('end', () => resolve(null));
      zip.on('error', reject);
    });

    if (!buf) return new NextResponse(null, { status: 404 });

    return new NextResponse(new Uint8Array(buf), {
      headers: {
        'Content-Type': mime,
        'Cache-Control': 'public, max-age=86400',
      },
    });
  } catch {
    return new NextResponse(null, { status: 500 });
  }
}
