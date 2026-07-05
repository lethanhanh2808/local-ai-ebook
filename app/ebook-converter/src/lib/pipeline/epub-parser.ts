// src/lib/pipeline/epub-parser.ts
// Parse an EPUB file (ZIP) into an in-memory representation
import yauzl from 'yauzl';
import { promisify } from 'util';
import path from 'path';

export interface EpubEntry {
  name: string;   // path inside the ZIP
  data: Buffer;
}

export interface TocEntry {
  title: string;
  src: string;    // path inside the ZIP (resolved from NCX/nav dir)
}

export interface ParsedEpub {
  entries: Map<string, EpubEntry>;   // name → entry
  opfPath: string;                   // path to the .opf file
  opfContent: string;
  htmlFiles: string[];               // relative paths of spine HTML docs (spine order)
  cssFiles: string[];
  imageFiles: string[];
  metadata: Record<string, string>;  // title, author, language…
  tocEntries: TocEntry[];            // TOC with filename links for reliable matching
}

function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

export async function parseEpub(filePath: string): Promise<ParsedEpub> {
  const openZip = promisify<string, yauzl.Options, yauzl.ZipFile>(yauzl.open);
  const zip = await openZip(filePath, { lazyEntries: true });

  const entries = new Map<string, EpubEntry>();

  await new Promise<void>((resolve, reject) => {
    zip.readEntry();
    zip.on('entry', (entry: yauzl.Entry) => {
      if (/\/$/.test(entry.fileName)) {
        // directory
        zip.readEntry();
        return;
      }
      zip.openReadStream(entry, (err, stream) => {
        if (err || !stream) { zip.readEntry(); return; }
        streamToBuffer(stream).then((buf) => {
          entries.set(entry.fileName, { name: entry.fileName, data: buf });
          zip.readEntry();
        }).catch(reject);
      });
    });
    zip.on('end', resolve);
    zip.on('error', reject);
  });

  // Find container.xml → OPF path
  const containerEntry = entries.get('META-INF/container.xml');
  let opfPath = '';
  if (containerEntry) {
    const xml = containerEntry.data.toString('utf8');
    const m = xml.match(/full-path="([^"]+\.opf)"/i);
    if (m) opfPath = m[1];
  }

  const opfEntry = opfPath ? entries.get(opfPath) : undefined;
  const opfContent = opfEntry ? opfEntry.data.toString('utf8') : '';
  const opfDir = path.dirname(opfPath);

  // Extract metadata from OPF
  const metadata: Record<string, string> = {};
  const metaFields: Array<[string, RegExp]> = [
    ['title', /<dc:title[^>]*>([^<]+)<\/dc:title>/i],
    ['author', /<dc:creator[^>]*>([^<]+)<\/dc:creator>/i],
    ['language', /<dc:language[^>]*>([^<]+)<\/dc:language>/i],
    ['publisher', /<dc:publisher[^>]*>([^<]+)<\/dc:publisher>/i],
    ['date', /<dc:date[^>]*>([^<]+)<\/dc:date>/i],
    ['description', /<dc:description[^>]*>([^<]+)<\/dc:description>/i],
    ['identifier', /<dc:identifier[^>]*>([^<]+)<\/dc:identifier>/i],
  ];
  for (const [key, re] of metaFields) {
    const m = opfContent.match(re);
    if (m) metadata[key] = m[1].trim();
  }

  // Spine → HTML files in reading order
  const spineIds: string[] = [];
  const spineRe = /<itemref\s+idref="([^"]+)"/gi;
  let sm;
  while ((sm = spineRe.exec(opfContent)) !== null) spineIds.push(sm[1]);

  const manifestItems: Record<string, string> = {};
  // Match <item ...> tags where id and href can appear in EITHER order.
  // (Calibre-produced EPUBs frequently emit href before id, e.g.
  //  <item href="Text/C0.html" id="C0" media-type="application/xhtml+xml"/>)
  const manifestItemRe = /<item\b([^>]*)\/?>/gi;
  const idAttrRe = /\bid\s*=\s*"([^"]+)"/i;
  const hrefAttrRe = /\bhref\s*=\s*"([^"]+)"/i;
  let mm: RegExpExecArray | null;
  while ((mm = manifestItemRe.exec(opfContent)) !== null) {
    const attrs = mm[1];
    const idMatch = attrs.match(idAttrRe);
    const hrefMatch = attrs.match(hrefAttrRe);
    if (idMatch && hrefMatch) {
      manifestItems[idMatch[1]] = hrefMatch[1];
    }
  }

  function resolve(href: string) {
    return opfDir && opfDir !== '.' ? `${opfDir}/${href}` : href;
  }

  const htmlFiles = spineIds
    .map((id) => manifestItems[id])
    .filter(Boolean)
    .map(resolve);

  const cssFiles = Array.from(entries.keys()).filter((n) => n.endsWith('.css'));
  const imageFiles = Array.from(entries.keys()).filter((n) =>
    /\.(jpg|jpeg|png|gif|svg|webp)$/i.test(n),
  );

  // TOC – prefer EPUB3 nav.xhtml, fall back to NCX
  const tocEntries: TocEntry[] = [];

  // Try EPUB3 nav.xhtml first (more reliable href mapping)
  const navEntry = Array.from(entries.values()).find(
    (e) => e.name.endsWith('nav.xhtml') || e.name.endsWith('nav.html'),
  );
  if (navEntry) {
    const navDir = path.dirname(navEntry.name);
    const nav = navEntry.data.toString('utf8');
    // Match <a href="...">Title</a> links inside the toc nav
    const tocSection = nav.match(/epub:type="toc"[\s\S]*?<\/nav>/i)?.[0] ?? nav;
    const aRe = /<a[^>]+href="([^"#]+)(?:#[^"]*)?"\s*>([^<]+)<\/a>/gi;
    let am;
    while ((am = aRe.exec(tocSection)) !== null) {
      const rawSrc = am[1];
      const title = am[2].trim();
      const fullSrc =
        navDir && navDir !== '.' ? `${navDir}/${rawSrc}` : rawSrc;
      tocEntries.push({ title, src: fullSrc.replace(/\\/g, '/') });
    }
  }

  // Fall back to NCX if nav.xhtml produced nothing
  if (tocEntries.length === 0) {
    const ncxEntry = Array.from(entries.values()).find((e) => e.name.endsWith('.ncx'));
    if (ncxEntry) {
      const ncxDir = path.dirname(ncxEntry.name);
      const ncx = ncxEntry.data.toString('utf8');
      // Extract only the navMap section to skip docTitle's <text>
      const navMapSection = ncx.match(/<navMap>([\s\S]*?)<\/navMap>/i)?.[1] ?? '';
      const textMatches = [...navMapSection.matchAll(/<text>([^<]+)<\/text>/gi)];
      const srcMatches = [...navMapSection.matchAll(/<content[^>]+src="([^"]+)"/gi)];
      for (let ti = 0; ti < Math.min(textMatches.length, srcMatches.length); ti++) {
        const rawSrc = srcMatches[ti][1].split('#')[0];
        const fullSrc =
          ncxDir && ncxDir !== '.' ? `${ncxDir}/${rawSrc}` : rawSrc;
        tocEntries.push({
          title: textMatches[ti][1].trim(),
          src: fullSrc.replace(/\\/g, '/'),
        });
      }
    }
  }

  return { entries, opfPath, opfContent, htmlFiles, cssFiles, imageFiles, metadata, tocEntries };
}
