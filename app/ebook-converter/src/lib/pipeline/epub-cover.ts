// src/lib/pipeline/epub-cover.ts
//
// Two operations on the cover inside an EPUB ZIP:
//
//   extractCoverFromEpub(epub, dest)  → write the existing cover bytes to disk
//   embedCoverIntoEpub(epub, cover, out) → replace (or inject) the cover in a
//                                        COPY of the EPUB. Source is preserved.
//
// Why both exist:
//   The library has cover images at `data/library/covers/<id>.<ext>`
//   but the cover that's actually SHIPPED to the user lives inside the
//   EPUB ZIP itself. If those drift apart (e.g. the user regenerates
//   the cover with /cover/generate but never re-embeds it), the
//   download endpoint would deliver an EPUB whose cover doesn't match
//   the thumbnail. embedCoverIntoEpub closes that gap — once the
//   library cover is regenerated we copy it back into the EPUB file.
//
import yauzl from 'yauzl';
import yazl from 'yazl';
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

function imageMediaType(ext: string): string {
  switch (ext.toLowerCase()) {
    case 'png':  return 'image/png';
    case 'gif':  return 'image/gif';
    case 'svg':  return 'image/svg+xml';
    case 'webp': return 'image/webp';
    case 'jpg':
    case 'jpeg':
    default:     return 'image/jpeg';
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/** Read every entry of a ZIP into a Map. Buffers are the raw,
 *  uncompressed bytes per entry. Also returns the OPF path (most ZIPs
 *  have exactly one, but some don't). */
async function readZipEntries(zipPath: string): Promise<{ entries: Map<string, Buffer>; opfPath: string | null }> {
  const openZip = promisify<string, yauzl.Options, yauzl.ZipFile>(yauzl.open);
  const zip = await openZip(zipPath, { lazyEntries: true });
  const entries = new Map<string, Buffer>();
  let opfPath: string | null = null;

  await new Promise<void>((resolve, reject) => {
    zip.readEntry();
    zip.on('entry', (entry: yauzl.Entry) => {
      if (/\/$/.test(entry.fileName)) { zip.readEntry(); return; }
      const name = entry.fileName;
      zip.openReadStream(entry, (err, stream) => {
        if (err || !stream) { zip.readEntry(); return; }
        streamToBuffer(stream).then((buf) => {
          entries.set(name, buf);
          if (name.endsWith('.opf') && opfPath === null) opfPath = name;
          zip.readEntry();
        }).catch(reject);
      });
    });
    zip.on('end', resolve);
    zip.on('error', reject);
  });

  return { entries, opfPath };
}

/** Rewrite a ZIP from the (entries, replaces) view, optionally dropping
 *  one old entry (used when an extension change requires renaming the
 *  cover file). */
function writeZipWithReplaced(
  outPath: string,
  entries: Iterable<[string, Buffer]>,
  replaces: Record<string, Buffer>,
  removeOldEntry: string | null = null,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    for (const [name, buf] of entries) {
      if (name in replaces) continue;
      if (removeOldEntry && name === removeOldEntry) continue;
      if (name === 'mimetype') {
        zip.addBuffer(buf, name, { compress: false, forceZip64Format: false });
      } else {
        zip.addBuffer(buf, name);
      }
    }
    for (const [name, buf] of Object.entries(replaces)) {
      if (name === 'mimetype') {
        zip.addBuffer(buf, name, { compress: false, forceZip64Format: false });
      } else {
        zip.addBuffer(buf, name);
      }
    }
    zip.end();
    const out = fs.createWriteStream(outPath);
    zip.outputStream.pipe(out);
    out.on('close', resolve);
    out.on('error', reject);
  });
}

// ── extractCoverFromEpub (existing behaviour — unchanged) ──────────────

export async function extractCoverFromEpub(
  epubPath: string,
  destPath: string,
): Promise<boolean> {
  const { entries, opfPath } = await readZipEntries(epubPath);
  const opfContent = opfPath ? (entries.get(opfPath)?.toString('utf8') ?? '') : '';

  // Strategy 1: OPF cover-image item
  let coverFileName: string | null = null;
  if (opfContent) {
    const metaM = opfContent.match(/<meta[^>]+name="cover"[^>]+content="([^"]+)"/i);
    if (metaM) {
      const coverId = metaM[1];
      const itemRe = new RegExp(`<item[^>]+id="${coverId}"[^>]+href="([^"]+)"`, 'i');
      const itemM = opfContent.match(itemRe);
      if (itemM) coverFileName = itemM[1];
    }
    if (!coverFileName) {
      const propM = opfContent.match(/<item[^>]+properties="cover-image"[^>]+href="([^"]+)"/i);
      if (propM) coverFileName = propM[1];
    }
  }

  // Strategy 2: look for a file named cover.* in the zip
  if (!coverFileName) {
    for (const name of entries.keys()) {
      if (/\/cover\.(jpg|jpeg|png|gif|webp)$/i.test(name) || /^cover\.(jpg|jpeg|png|gif|webp)$/i.test(name)) {
        coverFileName = name;
        break;
      }
    }
  }

  if (!coverFileName) return false;

  // Resolve relative path (OPF sibling)
  const base = opfPath ? path.dirname(opfPath) : '';
  const resolved = base ? `${base}/${coverFileName}` : coverFileName;

  const buf = entries.get(resolved) ?? entries.get(coverFileName);
  if (!buf) return false;

  const ext = path.extname(coverFileName).slice(1).toLowerCase() || 'jpg';
  const finalDest = destPath.replace(/\.[^.]+$/, `.${ext}`);

  fs.mkdirSync(path.dirname(finalDest), { recursive: true });
  fs.writeFileSync(finalDest, buf);
  return true;
}

// ── embedCoverIntoEpub (new — replaces or injects the cover) ──────────

export interface EmbedCoverResult {
  ok: boolean;
  /** True when the output EPUB was already up-to-date (no rewrite needed). */
  alreadyUpToDate: boolean;
  /** Path to the new EPUB file. */
  outputPath: string;
  /** The internal name of the cover entry inside the ZIP. */
  coverEntryName: string;
}

/** Re-package `epubPath` into `outputPath`, with the cover inside the
 *  EPUB replaced or freshly injected.
 *
 *  Cases handled:
 *   1. EPUB had no cover  → inject a new one (manifest, meta, file).
 *   2. EPUB has a cover of the SAME extension → replace bytes only.
 *   3. EPUB has a cover of a DIFFERENT extension → rename the entry
 *      to the new ext, rewrite the manifest `<item>` to point at it
 *      with the correct media-type, drop the old entry, and patch
 *      titlepage.xhtml so any `<img src="cover.jpeg">` still points
 *      at a real file.
 *
 *  Pure function w.r.t. the input EPUB: `epubPath` is read, never
 *  mutated. Caller decides whether to swap it for `outputPath`.
 */
export async function embedCoverIntoEpub(
  epubPath: string,
  coverImagePath: string,
  outputPath: string,
): Promise<EmbedCoverResult> {
  if (!fs.existsSync(epubPath))         throw new Error(`Source EPUB not found: ${epubPath}`);
  if (!fs.existsSync(coverImagePath))   throw new Error(`Cover image not found: ${coverImagePath}`);

  const coverBuf = fs.readFileSync(coverImagePath);
  const coverExt = (path.extname(coverImagePath).slice(1) || 'jpg').toLowerCase();
  const coverMime = imageMediaType(coverExt);

  const { entries, opfPath } = await readZipEntries(epubPath);
  if (!opfPath) throw new Error('EPUB has no OPF manifest');
  const opfDir = path.posix.dirname(opfPath);
  const opfContent = entries.get(opfPath)!.toString('utf8');

  // ── 1. Locate the existing cover entry (if any) ─────────────────
  let existingCoverEntryName: string | null = null;
  let existingCoverId: string | null = null;

  const metaM = opfContent.match(/<meta[^>]+name="cover"[^>]+content="([^"]+)"/i);
  if (metaM) {
    existingCoverId = metaM[1];
    const itemRe = new RegExp(`<item[^>]+id="${existingCoverId}"[^>]+href="([^"]+)"`, 'i');
    const itemM = opfContent.match(itemRe);
    if (itemM) existingCoverEntryName = path.posix.join(opfDir, itemM[1]);
  }
  if (!existingCoverEntryName) {
    const propM = opfContent.match(/<item[^>]+properties="cover-image"[^>]+href="([^"]+)"/i);
    if (propM) existingCoverEntryName = path.posix.join(opfDir, propM[1]);
  }
  if (!existingCoverEntryName) {
    for (const name of entries.keys()) {
      if (/\/cover\.(jpg|jpeg|png|gif|webp)$/i.test(name) || /^cover\.(jpg|jpeg|png|gif|webp)$/i.test(name)) {
        existingCoverEntryName = name;
        break;
      }
    }
  }

  // ── 2. Decide the new cover entry + OPF rewrite ─────────────────
  let coverEntryName: string;
  let rewriteOpf: string;
  let removeOldEntry: string | null = null;

  if (existingCoverEntryName) {
    const existingExt = path.extname(existingCoverEntryName).slice(1).toLowerCase();
    const extChanged = existingExt !== coverExt;

    if (!extChanged) {
      // ── Case 2: same extension — replace bytes only ──
      coverEntryName = existingCoverEntryName;
      const existing = entries.get(coverEntryName);
      if (existing && existing.equals(coverBuf)) {
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.copyFileSync(epubPath, outputPath);
        return { ok: true, alreadyUpToDate: true, outputPath, coverEntryName };
      }
      rewriteOpf = opfContent;

      if (!existingCoverId) {
        // Sub-case 2a: file exists in the ZIP but no `<meta name="cover">`
        // and no `properties="cover-image"` in the manifest. This happens
        // when an EPUB has a stray `cover.<ext>` file but never registered
        // it. We must ADD a manifest item + meta so e-readers can find it.
        const coverBasename = path.posix.basename(coverEntryName);
        const newId = 'cover-image';
        const existingIds = new Set<string>();
        for (const m of opfContent.matchAll(/<item[^>]+id="([^"]+)"/gi)) existingIds.add(m[1]);
        let coverId = newId;
        let suffix = 1;
        while (existingIds.has(coverId)) coverId = `cover-image-${suffix++}`;
        existingCoverId = coverId;

        const newItem = `    <item id="${coverId}" href="${coverBasename}" media-type="${coverMime}"/>`;
        if (/<\/manifest>/.test(rewriteOpf)) {
          rewriteOpf = rewriteOpf.replace(/<\/manifest>/, `${newItem}\n  </manifest>`);
        }
        if (!/<meta[^>]+name="cover"/i.test(rewriteOpf)) {
          rewriteOpf = rewriteOpf.replace(
            /<\/metadata>/,
            `  <meta name="cover" content="${coverId}"/>\n</metadata>`,
          );
        }
      } else if (!/<meta[^>]+name="cover"/i.test(rewriteOpf)) {
        rewriteOpf = rewriteOpf.replace(
          /<\/metadata>/,
          `  <meta name="cover" content="${existingCoverId}"/>\n</metadata>`,
        );
      }
    } else {
      // ── Case 3: extension change — rename + rewrite OPF ──
      coverEntryName = path.posix.join(opfDir, `cover.${coverExt}`);
      if (entries.has(coverEntryName) && coverEntryName !== existingCoverEntryName) {
        const base = path.posix.basename(coverEntryName, path.posix.extname(coverEntryName));
        let suffix = 1;
        while (entries.has(path.posix.join(opfDir, `${base}-${suffix}.${coverExt}`))) suffix++;
        coverEntryName = path.posix.join(opfDir, `${base}-${suffix}.${coverExt}`);
      }
      const coverBasename = path.posix.basename(coverEntryName);
      rewriteOpf = opfContent;

      // Rewrite the manifest item that referenced the old cover path —
      // strip old media-type / properties, point at the new basename,
      // and add the fresh media-type + properties="cover-image".
      // For root-level covers, opfDir is "." or "" (path.posix.dirname
      // returns "." for files at root), so we match the basename
      // directly without any folder prefix.
      const isRootLevel = !opfDir || opfDir === '.' || opfDir === '/';
      const oldRelPath = isRootLevel
        ? path.posix.basename(existingCoverEntryName)
        : existingCoverEntryName.slice(opfDir.length + 1);
      const escapedOld = escapeRegex(oldRelPath);
      rewriteOpf = rewriteOpf.replace(
        new RegExp(`<item([^>]+?)href="${escapedOld}"([^>]*?)/>`, 'i'),
        (_m, pre, post) => {
          const preCleaned = pre.replace(/\s+media-type="[^"]*"/g, '').replace(/\s+properties="[^"]*"/g, '');
          const postCleaned = post.replace(/\s+media-type="[^"]*"/g, '').replace(/\s+properties="[^"]*"/g, '');
          // Normalise whitespace so we emit one space between `<item` and the
          // first attribute. `preCleaned` starts with whatever the original
          // OPF used (typically ` ` or ` id="cover"` when `id` comes before
          // `href`); we always prepend a single leading space.
          const leadingAttr = preCleaned.replace(/^\s+/, '');
          const preNorm = leadingAttr ? ` ${leadingAttr}` : '';
          return `<item${preNorm} href="${coverBasename}" media-type="${coverMime}" properties="cover-image"${postCleaned}/>`;
        },
      );

      if (existingCoverId && !/<meta[^>]+name="cover"/i.test(rewriteOpf)) {
        rewriteOpf = rewriteOpf.replace(
          /<\/metadata>/,
          `  <meta name="cover" content="${existingCoverId}"/>\n</metadata>`,
        );
      }
      removeOldEntry = existingCoverEntryName;
    }
  } else {
    // ── Case 1: no cover — inject one ──
    coverEntryName = path.posix.join(opfDir, 'images', `cover.${coverExt}`);
    // Pick a fresh manifest id that doesn't collide with existing ids.
    const existingIds = new Set<string>();
    for (const m of opfContent.matchAll(/<item[^>]+id="([^"]+)"/gi)) existingIds.add(m[1]);
    let coverId = 'cover-image';
    let suffix = 1;
    while (existingIds.has(coverId)) coverId = `cover-image-${suffix++}`;

    const newItem = `    <item id="${coverId}" href="images/cover.${coverExt}" media-type="${coverMime}" properties="cover-image"/>`;
    rewriteOpf = /<\/manifest>/.test(opfContent)
      ? opfContent.replace(/<\/manifest>/, `${newItem}\n  </manifest>`)
      : (() => { throw new Error('OPF has no <manifest> close tag — cannot inject cover item'); })();

    if (!/<meta[^>]+name="cover"/i.test(rewriteOpf)) {
      rewriteOpf = rewriteOpf.replace(
        /<\/metadata>/,
        `  <meta name="cover" content="${coverId}"/>\n</metadata>`,
      );
    }
  }

  // ── 3. Patch titlepage / cover.xhtml references for extension change ──
  // In-place same-ext replacements don't need this. Inject/rename cases
  // have rewritten the OPF to point at a new basename, so any references
  // in xhtml (e.g. Calibre titlepage.xhtml → <img src="cover.jpeg">) need
  // updating too.
  const coverBasename = path.posix.basename(coverEntryName);
  const oldCoverBasename = removeOldEntry ? path.posix.basename(removeOldEntry) : coverBasename;
  if (oldCoverBasename !== coverBasename) {
    rewriteOpf = patchTitlepageReferences(rewriteOpf, entries, coverBasename, oldCoverBasename);
  }

  // ── 4. Rewrite the new ZIP ──
  const replaces: Record<string, Buffer> = {
    [opfPath]: Buffer.from(rewriteOpf, 'utf8'),
    ...(entries.has(coverEntryName) ? { [coverEntryName]: coverBuf } : {}),
  };
  if (!entries.has(coverEntryName)) {
    replaces[coverEntryName] = coverBuf;
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  await writeZipWithReplaced(outputPath, entries, replaces, removeOldEntry);

  return { ok: true, alreadyUpToDate: false, outputPath, coverEntryName };
}

/** Walk every .xhtml/.html entry and rewrite references to the OLD
 *  cover file (by basename) to point at the NEW basename. Standard
 *  Calibre pattern: `titlepage.xhtml` references `<img src="cover.jpeg">`.
 *  Some EPUBs use a relative path like `../Images/cover.jpeg` — the
 *  function preserves the leading path and only swaps the file. */
function patchTitlepageReferences(
  opfContent: string,
  entries: Map<string, Buffer>,
  newCoverBase: string,
  oldCoverBase: string,
): string {
  let patched = opfContent;

  // 1. Update OPF-side guide <reference type="cover" href="…"/>.
  patched = patched.replace(
    new RegExp(
      `(<reference[^>]+type="cover"[^>]+href="(?:[^"]*\\/)?)${escapeRegex(oldCoverBase)}("[^>]*\\/>)`,
      'i',
    ),
    (_m, prefix, suffix) => `${prefix}${newCoverBase}${suffix}`,
  );

  // 2. Walk .xhtml/.html entries — replace any `oldCoverBase` reference
  //    with `newCoverBase`. Leading folder paths are preserved when
  //    present (e.g. "../Images/cover.jpeg"), but bare references
  //    (just "cover.jpeg") are also rewritten — that's the common
  //    Calibre titlepage pattern.
  for (const [name, buf] of entries) {
    if (!/\.(xhtml|html)$/i.test(name)) continue;
    const text = buf.toString('utf8');
    if (!text.includes(oldCoverBase)) continue;
    // Match either "attr=path/cover.<ext>" or "attr=cover.<ext>"
    const newText = text.replace(
      new RegExp(
        `((?:src|xlink:href|href)\\s*=\\s*")((?:[^"]*\\/)?)${escapeRegex(oldCoverBase)}(")`,
        'gi',
      ),
      (_m, attr, prefix, suffix) => `${attr}${prefix}${newCoverBase}${suffix}`,
    );
    if (newText !== text) entries.set(name, Buffer.from(newText, 'utf8'));
  }
  return patched;
}
