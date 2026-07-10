// src/lib/pipeline/epub-builder.ts
// Assemble a valid EPUB3 ZIP from in-memory content
import yazl from 'yazl';
import { v4 as uuid } from 'uuid';
import { STANDARD_CSS } from './epub-styler';
import fs from 'fs';
import path from 'path';

export interface ChapterEntry {
  id: string;       // e.g. "chapter001"
  title: string;
  filename: string; // e.g. "chapter001.xhtml"
  html: string;
}

export interface EpubBuildInput {
  title: string;
  author: string;
  language: string;   // 'vi' | 'en'
  description?: string;
  identifier?: string;
  coverImagePath?: string;
  chapters: ChapterEntry[];
  fontPaths?: Record<string, string>; // font basename → local fs path
  /** Override the bundled stylesheet. Defaults to STANDARD_CSS. Used by
   *  the `readerFriendly` mode to swap in READER_FRIENDLY_CSS — a minimal
   *  stylesheet that's safe for Onyx Boox / Kobo / older Kindle. */
  customCss?: string;
}

interface TocNode {
  title: string;
  href: string;
  level: number;
  children: TocNode[];
}

interface PageListEntry {
  title: string;
  href: string;
}

interface PreparedChapter extends ChapterEntry {
  manifestId: string;
  chapterId: string;
  tocNode: TocNode;
  pageList: PageListEntry[];
}

export async function buildEpub(input: EpubBuildInput, outputPath: string): Promise<void> {
  const bookId = input.identifier ?? `urn:uuid:${uuid()}`;
  const lang = input.language || 'vi';
  const preparedChapters = input.chapters.map((chapter) => prepareChapter(chapter));
  const pageList = preparedChapters.flatMap((chapter) => chapter.pageList);

  const zip = new yazl.ZipFile();
  const addText = (name: string, content: string) =>
    zip.addBuffer(Buffer.from(content, 'utf8'), name);

  // ── mimetype (uncompressed, first) ──────────────────────────────────────
  zip.addBuffer(Buffer.from('application/epub+zip'), 'mimetype', {
    compress: false,
    forceZip64Format: false,
  });

  // ── META-INF/container.xml ──────────────────────────────────────────────
  addText(
    'META-INF/container.xml',
    `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="EPUB/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`,
  );

  // ── CSS ─────────────────────────────────────────────────────────────────
  addText('EPUB/css/style.css', input.customCss ?? STANDARD_CSS);

  // ── Fonts ───────────────────────────────────────────────────────────────
  const fontManifestItems: string[] = [];
  if (input.fontPaths) {
    for (const [basename, fsPath] of Object.entries(input.fontPaths)) {
      if (fs.existsSync(fsPath)) {
        zip.addFile(fsPath, `EPUB/fonts/${basename}`);
        fontManifestItems.push(
          `    <item id="font-${basename.replace(/\W/g, '')}" href="fonts/${basename}" media-type="${fontMediaType(basename)}"/>`,
        );
      }
    }
  }

  // ── Cover ───────────────────────────────────────────────────────────────
  let coverManifest = '';
  let coverSpine = '';
  let coverMeta = '';
  if (input.coverImagePath && fs.existsSync(input.coverImagePath)) {
    const ext = (input.coverImagePath.split('.').pop() ?? 'jpg').toLowerCase();
    const mime = imageMediaType(ext);
    zip.addFile(input.coverImagePath, `EPUB/images/cover.${ext}`);
    coverManifest = `    <item id="cover-image" href="images/cover.${ext}" media-type="${mime}" properties="cover-image"/>
    <item id="cover-page" href="cover.xhtml" media-type="application/xhtml+xml"/>`;
    coverSpine = '\n    <itemref idref="cover-page"/>';
    coverMeta = '\n  <meta name="cover" content="cover-image"/>';
    addText(
      'EPUB/cover.xhtml',
      `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${escXml(lang)}" xml:lang="${escXml(lang)}">
<head><meta charset="utf-8"/><title>Cover</title>
<link rel="stylesheet" type="text/css" href="css/style.css"/></head>
<body class="cover-page" epub:type="frontmatter cover"><section epub:type="cover"><img src="images/cover.${ext}" alt="Cover"/></section></body>
</html>`,
    );
  }

  // ── Chapters ────────────────────────────────────────────────────────────
  for (const ch of preparedChapters) {
    addText(`EPUB/${ch.filename}`, ch.html);
  }

  // ── Nav (EPUB3) ─────────────────────────────────────────────────────────
  const navItems = preparedChapters
    .map((ch) => renderNavNode(ch.tocNode, 3))
    .join('\n');
  const firstChapter = preparedChapters[0];
  const landmarks = [
    ...(coverManifest ? [{ type: 'cover', href: 'cover.xhtml', title: 'Cover' }] : []),
    { type: 'toc', href: 'nav.xhtml', title: 'Table of Contents' },
    ...(firstChapter ? [{ type: 'bodymatter', href: firstChapter.tocNode.href, title: 'Begin Reading' }] : []),
  ];
  const pageListNav = pageList.length > 0
    ? `
  <nav epub:type="page-list" id="page-list" hidden="hidden">
    <h2>Pages</h2>
    <ol>
${pageList.map((entry) => `      <li><a href="${entry.href}">${escXml(entry.title)}</a></li>`).join('\n')}
    </ol>
  </nav>`
    : '';

  addText(
    'EPUB/nav.xhtml',
    `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${escXml(lang)}" xml:lang="${escXml(lang)}">
<head><meta charset="utf-8"/><title>Table of Contents</title>
<link rel="stylesheet" type="text/css" href="css/style.css"/></head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>Contents</h1>
    <ol>
${navItems}
    </ol>
  </nav>
  <nav epub:type="landmarks" id="landmarks" hidden="hidden">
    <h2>Guide</h2>
    <ol>
${landmarks.map((item) => `      <li><a epub:type="${item.type}" href="${item.href}">${escXml(item.title)}</a></li>`).join('\n')}
    </ol>
  </nav>${pageListNav}
</body>
</html>`,
  );

  // ── NCX (EPUB2 compat) ───────────────────────────────────────────────────
  let playOrder = 1;
  const ncxPoints = preparedChapters
    .map((ch) => renderNcxNode(ch.tocNode, () => playOrder++, 2))
    .join('\n');
  const ncxDepth = Math.max(1, ...preparedChapters.map((ch) => tocDepth(ch.tocNode)));

  addText(
    'EPUB/toc.ncx',
    `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="${bookId}"/>
    <meta name="dtb:depth" content="${ncxDepth}"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>${escXml(input.title)}</text></docTitle>
  <navMap>
${ncxPoints}
  </navMap>
</ncx>`,
  );

  // ── OPF (content.opf) ───────────────────────────────────────────────────
  const chapterManifest = preparedChapters
    .map(
      (ch) =>
        `    <item id="${ch.manifestId}" href="${ch.filename}" media-type="application/xhtml+xml"/>`,
    )
    .join('\n');

  const spineItems = preparedChapters
    .map((ch) => `    <itemref idref="${ch.manifestId}"/>`)
    .join('\n');

  const now = new Date().toISOString().slice(0, 10);

  addText(
    'EPUB/content.opf',
    `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="BookId" xml:lang="${escXml(lang)}" prefix="schema: http://schema.org/">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:identifier id="BookId">${escXml(bookId)}</dc:identifier>
    <dc:title>${escXml(input.title)}</dc:title>
    <dc:creator id="creator">${escXml(input.author)}</dc:creator>
    <meta refines="#creator" property="role" scheme="marc:relators">aut</meta>
    <dc:language>${escXml(lang)}</dc:language>
    <dc:date>${now}</dc:date>
    ${input.description ? `<dc:description>${escXml(input.description)}</dc:description>` : ''}
    <meta property="schema:accessibilityFeature">tableOfContents</meta>
    <meta property="schema:accessibilityFeature">readingOrder</meta>
    <meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</meta>${coverMeta}
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="css" href="css/style.css" media-type="text/css"/>
${coverManifest}
${fontManifestItems.join('\n')}
${chapterManifest}
  </manifest>
  <spine toc="ncx">${coverSpine}
${spineItems}
  </spine>
</package>`,
  );

  // ── Finalise ─────────────────────────────────────────────────────────────
  zip.end();

  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(outputPath);
    zip.outputStream.pipe(out);
    out.on('close', resolve);
    out.on('error', reject);
  });
}

function escXml(s: string) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function normalizeId(value: string) {
  let id = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (id && !/^[a-z_]/.test(id)) id = `id-${id}`;
  return id || 'item';
}

function stripTags(value: string) {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractIds(html: string) {
  return new Set([...html.matchAll(/\sid\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]));
}

function uniqueId(base: string, used: Set<string>) {
  let id = normalizeId(base);
  let next = id;
  let i = 2;
  while (used.has(next)) next = `${id}-${i++}`;
  used.add(next);
  return next;
}

function ensureHeadingIds(html: string, chapterId: string) {
  const used = extractIds(html);
  let headingCount = 1;
  return html.replace(/<h([1-6])\b([^>]*)>([\s\S]*?)<\/h\1>/gi, (match, level: string, attrs: string, inner: string) => {
    if (/\sid\s*=/i.test(attrs)) return match;
    const base = level === '1' ? `${chapterId}-title` : `${chapterId}-h${level}-${headingCount++}`;
    const id = uniqueId(base, used);
    return `<h${level}${attrs} id="${id}">${inner}</h${level}>`;
  });
}

function ensurePagebreakIds(html: string, chapterId: string) {
  const used = extractIds(html);
  let pageCount = 1;
  return html.replace(
    /<(span|a|div)\b([^>]*(?:epub:type=["'][^"']*pagebreak[^"']*["']|role=["']doc-pagebreak["']|class=["'][^"']*pagebreak[^"']*["'])[^>]*)>/gi,
    (match, tag: string, attrs: string) => {
      if (/\sid\s*=/i.test(attrs)) return match;
      const id = uniqueId(`${chapterId}-page-${pageCount++}`, used);
      return `<${tag}${attrs} id="${id}">`;
    },
  );
}

function extractHeadingNodes(html: string, filename: string) {
  const nodes: TocNode[] = [];
  const headingRe = /<h([2-4])\b([^>]*)>([\s\S]*?)<\/h\1>/gi;
  let match: RegExpExecArray | null;
  let count = 0;
  while ((match = headingRe.exec(html)) !== null && count < 200) {
    const id = match[2].match(/\sid\s*=\s*["']([^"']+)["']/i)?.[1];
    const title = stripTags(match[3]);
    if (id && title) {
      nodes.push({ title, href: `${filename}#${id}`, level: Number(match[1]), children: [] });
      count++;
    }
  }
  return nodes;
}

function nestTocNodes(root: TocNode, headings: TocNode[]) {
  const stack: TocNode[] = [root];
  for (const node of headings) {
    while (stack.length > 1 && stack[stack.length - 1].level >= node.level) stack.pop();
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  }
}

function extractPageList(html: string, filename: string): PageListEntry[] {
  const pages: PageListEntry[] = [];
  const re = /<(?:span|a|div)\b([^>]*(?:epub:type=["'][^"']*pagebreak[^"']*["']|role=["']doc-pagebreak["']|class=["'][^"']*pagebreak[^"']*["'])[^>]*)>([\s\S]*?)<\/(?:span|a|div)>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null && pages.length < 500) {
    const id = match[1].match(/\sid\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!id) continue;
    const title = stripTags(match[2]) || String(pages.length + 1);
    pages.push({ title, href: `${filename}#${id}` });
  }
  return pages;
}

function prepareChapter(chapter: ChapterEntry): PreparedChapter {
  const chapterId = normalizeId(chapter.id);
  const manifestId = normalizeId(chapter.id);
  let html = ensurePagebreakIds(ensureHeadingIds(chapter.html, chapterId), chapterId);
  const topHref = `${chapter.filename}#${chapterId}`;
  const tocNode: TocNode = {
    title: chapter.title,
    href: topHref,
    level: 1,
    children: [],
  };
  nestTocNodes(tocNode, extractHeadingNodes(html, chapter.filename));
  return {
    ...chapter,
    html,
    chapterId,
    manifestId,
    tocNode,
    pageList: extractPageList(html, chapter.filename),
  };
}

function renderNavNode(node: TocNode, depth: number): string {
  const pad = '  '.repeat(depth);
  const children = node.children.length
    ? `\n${pad}  <ol>\n${node.children.map((child) => renderNavNode(child, depth + 2)).join('\n')}\n${pad}  </ol>\n${pad}`
    : '';
  return `${pad}<li><a href="${node.href}">${escXml(node.title)}</a>${children}</li>`;
}

function renderNcxNode(node: TocNode, nextPlayOrder: () => number, depth: number): string {
  const pad = '  '.repeat(depth);
  const playOrder = nextPlayOrder();
  const navId = `navpoint-${playOrder}`;
  const children = node.children.length
    ? `\n${node.children.map((child) => renderNcxNode(child, nextPlayOrder, depth + 1)).join('\n')}\n${pad}`
    : '';
  return `${pad}<navPoint id="${navId}" playOrder="${playOrder}">
${pad}  <navLabel><text>${escXml(node.title)}</text></navLabel>
${pad}  <content src="${node.href}"/>${children}
${pad}</navPoint>`;
}

function tocDepth(node: TocNode): number {
  if (node.children.length === 0) return 1;
  return 1 + Math.max(...node.children.map(tocDepth));
}

function imageMediaType(ext: string) {
  switch (ext.toLowerCase()) {
    case 'png': return 'image/png';
    case 'gif': return 'image/gif';
    case 'svg': return 'image/svg+xml';
    case 'webp': return 'image/webp';
    case 'jpg':
    case 'jpeg':
    default:
      return 'image/jpeg';
  }
}

function fontMediaType(filename: string) {
  switch (path.extname(filename).toLowerCase()) {
    case '.otf': return 'font/otf';
    case '.woff': return 'font/woff';
    case '.woff2': return 'font/woff2';
    case '.ttf':
    default:
      return 'font/ttf';
  }
}
