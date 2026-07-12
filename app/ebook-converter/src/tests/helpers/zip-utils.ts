// src/tests/helpers/zip-utils.ts
// Tiny helper for tests that need to mutate ZIPs by hand.
import yauzl from 'yauzl';
import yazl from 'yazl';
import fs from 'fs';
import { promisify } from 'util';

function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

/** Add an entry to an existing ZIP and write the result to a new file. */
export async function addEntryToZip(
  srcEpub: string,
  entryName: string,
  content: Buffer,
): Promise<string> {
  const openZip = promisify<string, yauzl.Options, yauzl.ZipFile>(yauzl.open);
  const zip = await openZip(srcEpub, { lazyEntries: true });
  const entries = new Map<string, Buffer>();
  await new Promise<void>((resolve, reject) => {
    zip.readEntry();
    zip.on('entry', (e: yauzl.Entry) => {
      if (/\/$/.test(e.fileName)) { zip.readEntry(); return; }
      zip.openReadStream(e, (err, stream) => {
        if (err || !stream) { zip.readEntry(); return; }
        streamToBuffer(stream).then((b) => {
          entries.set(e.fileName, b);
          zip.readEntry();
        }).catch(reject);
      });
    });
    zip.on('end', resolve);
    zip.on('error', reject);
  });

  const dstEpub = srcEpub.replace(/\.epub$/, '.with-orphan.epub');
  const out = new yazl.ZipFile();
  for (const [name, buf] of entries) {
    if (name === 'mimetype') {
      out.addBuffer(buf, name, { compress: false, forceZip64Format: false });
    } else {
      out.addBuffer(buf, name);
    }
  }
  out.addBuffer(content, entryName);
  out.end();
  await new Promise<void>((resolve, reject) => {
    const fsOut = fs.createWriteStream(dstEpub);
    out.outputStream.pipe(fsOut);
    fsOut.on('close', resolve);
    fsOut.on('error', reject);
  });
  return dstEpub;
}
