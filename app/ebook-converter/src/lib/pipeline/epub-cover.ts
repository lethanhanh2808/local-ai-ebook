// src/lib/pipeline/epub-cover.ts
// Extract a cover image from an EPUB ZIP to a local file path.
// Returns true if a cover was found and written, false otherwise.
import yauzl from 'yauzl';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';

function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

export async function extractCoverFromEpub(
  epubPath: string,
  destPath: string,
): Promise<boolean> {
  const openZip = promisify<string, yauzl.Options, yauzl.ZipFile>(yauzl.open);
  const zip = await openZip(epubPath, { lazyEntries: true });

  // Collect all entries as a flat map for two-pass lookup
  const allEntries = new Map<string, Buffer>();
  let opfContent = '';

  await new Promise<void>((resolve, reject) => {
    zip.readEntry();
    zip.on('entry', (entry: yauzl.Entry) => {
      if (/\/$/.test(entry.fileName)) { zip.readEntry(); return; }
      zip.openReadStream(entry, (err, stream) => {
        if (err || !stream) { zip.readEntry(); return; }
        streamToBuffer(stream).then((buf) => {
          allEntries.set(entry.fileName, buf);
          if (entry.fileName.endsWith('.opf')) opfContent = buf.toString('utf8');
          zip.readEntry();
        }).catch(reject);
      });
    });
    zip.on('end', resolve);
    zip.on('error', reject);
  });

  // Strategy 1: OPF cover-image item
  let coverFileName: string | null = null;
  if (opfContent) {
    // Look for <meta name="cover" content="cover-img-id"/>
    const metaM = opfContent.match(/<meta[^>]+name="cover"[^>]+content="([^"]+)"/i);
    if (metaM) {
      const coverId = metaM[1];
      // Find the href for that id in the manifest
      const itemRe = new RegExp(`<item[^>]+id="${coverId}"[^>]+href="([^"]+)"`, 'i');
      const itemM = opfContent.match(itemRe);
      if (itemM) coverFileName = itemM[1];
    }
    // Also check for an item with properties="cover-image" (EPUB3)
    if (!coverFileName) {
      const prop = opfContent.match(/<item[^>]+properties="cover-image"[^>]+href="([^"]+)"/i);
      if (prop) coverFileName = prop[1];
    }
  }

  // Strategy 2: look for a file named cover.* in the zip
  if (!coverFileName) {
    for (const name of allEntries.keys()) {
      if (/\/cover\.(jpg|jpeg|png|gif|webp)$/i.test(name) || /^cover\.(jpg|jpeg|png|gif|webp)$/i.test(name)) {
        coverFileName = name;
        break;
      }
    }
  }

  if (!coverFileName) return false;

  // Resolve relative path (OPF sibling)
  const opfEntry = Array.from(allEntries.keys()).find((k) => k.endsWith('.opf'));
  const base = opfEntry ? path.dirname(opfEntry) : '';
  const resolved = base ? `${base}/${coverFileName}` : coverFileName;

  const buf = allEntries.get(resolved) ?? allEntries.get(coverFileName);
  if (!buf) return false;

  const ext = path.extname(coverFileName).slice(1).toLowerCase() || 'jpg';
  const finalDest = destPath.replace(/\.[^.]+$/, `.${ext}`);

  fs.mkdirSync(path.dirname(finalDest), { recursive: true });
  fs.writeFileSync(finalDest, buf);
  return true;
}
