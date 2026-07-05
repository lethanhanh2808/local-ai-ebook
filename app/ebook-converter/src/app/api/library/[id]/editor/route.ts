// GET/POST /api/library/[id]/editor
// Minimal EPUB editor API. Saves edits as a new library copy by default.
import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import yazl from 'yazl';
import { v4 as uuid } from 'uuid';
import { getBook, createBook } from '@/lib/db/books';
import { parseEpub } from '@/lib/pipeline/epub-parser';
import { coverPath, ensureDirs, libraryPath } from '@/lib/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function extractBody(html: string) {
  return html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1]?.trim() ?? html;
}

function extractTitle(html: string, fallback: string) {
  const body = extractBody(html);
  const heading = body.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i)?.[1];
  return heading?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || fallback;
}

function chapterIdForFile(file: string) {
  return path.basename(file, path.extname(file));
}

function restoreEditorAssets(html: string, bookId: string) {
  const apiPrefix = `/api/library/${bookId}/assets/`;
  return html
    .replace(
      /<img\b([^>]*?)\sdata-epub-src=(["'])(.*?)\2([^>]*)>/gi,
      (_match, before: string, quote: string, src: string, after: string) => {
        const cleaned = `${before} ${after}`.replace(/\ssrc=(["']).*?\1/gi, '').replace(/\s{2,}/g, ' ');
        return `<img${cleaned} src=${quote}${src}${quote}>`;
      },
    )
    .replace(new RegExp(apiPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '');
}

function makeEditorHtml(html: string, bookId: string) {
  return html.replace(
    /(<img\b[^>]*?)\ssrc=(["'])(.*?)\2([^>]*?>)/gi,
    (_match, before: string, quote: string, src: string, after: string) => {
      if (src.startsWith('data:') || src.startsWith('http://') || src.startsWith('https://') || src.startsWith('/api/')) {
        return `${before} src=${quote}${src}${quote}${after}`;
      }
      const resolved = src.replace(/^(\.\.\/)+/, '').replace(/^\//, '');
      return `${before} data-epub-src=${quote}${src}${quote} src=${quote}/api/library/${bookId}/assets/${resolved}${quote}${after}`;
    },
  );
}

function replaceBody(originalHtml: string, bodyHtml: string, title: string, language: string) {
  const cleanedTitle = escXml(title);
  let html = originalHtml;
  if (/<title>[\s\S]*?<\/title>/i.test(html)) {
    html = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${cleanedTitle}</title>`);
  }
  if (/<body\b[^>]*>[\s\S]*<\/body>/i.test(html)) {
    return html.replace(/(<body\b[^>]*>)[\s\S]*(<\/body>)/i, `$1\n${bodyHtml}\n$2`);
  }
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${escXml(language)}" xml:lang="${escXml(language)}">
<head><meta charset="utf-8"/><title>${cleanedTitle}</title></head>
<body>
${bodyHtml}
</body>
</html>`;
}

function updateTocLabel(content: Buffer, entryName: string, targetFile: string, title: string) {
  const targetBase = path.basename(targetFile).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const label = escXml(title);
  let text = content.toString('utf8');

  if (/nav\.x?html$/i.test(entryName)) {
    const linkRe = new RegExp(`(<a\\b[^>]+href=["'][^"']*${targetBase}(?:#[^"']*)?["'][^>]*>)([\\s\\S]*?)(<\\/a>)`, 'i');
    text = text.replace(linkRe, `$1${label}$3`);
    return Buffer.from(text, 'utf8');
  }

  if (/\.ncx$/i.test(entryName)) {
    const ncxRe = new RegExp(`(<navPoint\\b[\\s\\S]*?<navLabel>\\s*<text>)([\\s\\S]*?)(<\\/text>\\s*<\\/navLabel>\\s*<content\\b[^>]+src=["'][^"']*${targetBase})`, 'i');
    text = text.replace(ncxRe, `$1${label}$3`);
    return Buffer.from(text, 'utf8');
  }

  return content;
}

async function writeEditedCopy(options: {
  sourcePath: string;
  outputPath: string;
  targetFile: string;
  editedHtml: string;
  title: string;
}) {
  const epub = await parseEpub(options.sourcePath);
  const zip = new yazl.ZipFile();
  const mimetype = epub.entries.get('mimetype')?.data ?? Buffer.from('application/epub+zip');
  zip.addBuffer(mimetype, 'mimetype', { compress: false, forceZip64Format: false });

  for (const [name, entry] of epub.entries) {
    if (name === 'mimetype') continue;
    let data = name === options.targetFile ? Buffer.from(options.editedHtml, 'utf8') : entry.data;
    if (name !== options.targetFile) {
      data = updateTocLabel(data, name, options.targetFile, options.title);
    }
    zip.addBuffer(data, name);
  }

  zip.end();
  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(options.outputPath);
    zip.outputStream.pipe(out);
    out.on('close', resolve);
    out.on('error', reject);
  });
}

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const book = await getBook(params.id);
  if (!book) return NextResponse.json({ error: 'Book not found' }, { status: 404 });
  if (!fs.existsSync(book.filePath)) return NextResponse.json({ error: 'Book file not found' }, { status: 404 });

  const epub = await parseEpub(book.filePath);
  const tocByBase = new Map(epub.tocEntries.map((entry) => [path.basename(entry.src), entry.title]));
  const tocByFull = new Map(epub.tocEntries.map((entry) => [entry.src, entry.title]));
  const chapters = epub.htmlFiles.map((file, index) => {
    const raw = epub.entries.get(file)?.data.toString('utf8') ?? '';
    return {
      id: chapterIdForFile(file),
      file,
      order: index + 1,
      title: tocByFull.get(file) ?? tocByBase.get(path.basename(file)) ?? extractTitle(raw, `Chapter ${index + 1}`),
    };
  });

  const chapterId = req.nextUrl.searchParams.get('chapterId');
  if (!chapterId) return NextResponse.json({ book, chapters });

  const file = epub.htmlFiles.find((candidate) => chapterIdForFile(candidate) === chapterId || path.basename(candidate) === chapterId);
  if (!file) return NextResponse.json({ error: 'Chapter not found' }, { status: 404 });
  const raw = epub.entries.get(file)?.data.toString('utf8') ?? '';
  return NextResponse.json({
    book,
    chapters,
    chapter: {
      id: chapterIdForFile(file),
      file,
      title: tocByFull.get(file) ?? tocByBase.get(path.basename(file)) ?? extractTitle(raw, chapterId),
      html: makeEditorHtml(extractBody(raw), params.id),
    },
  });
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const book = await getBook(params.id);
  if (!book) return NextResponse.json({ error: 'Book not found' }, { status: 404 });
  if (!fs.existsSync(book.filePath)) return NextResponse.json({ error: 'Book file not found' }, { status: 404 });

  const body = await req.json().catch(() => ({})) as {
    chapterId?: string;
    title?: string;
    html?: string;
  };
  if (!body.chapterId || typeof body.html !== 'string') {
    return NextResponse.json({ error: 'chapterId and html are required' }, { status: 400 });
  }

  const epub = await parseEpub(book.filePath);
  const targetFile = epub.htmlFiles.find((candidate) => chapterIdForFile(candidate) === body.chapterId || path.basename(candidate) === body.chapterId);
  if (!targetFile) return NextResponse.json({ error: 'Chapter not found' }, { status: 404 });

  const originalHtml = epub.entries.get(targetFile)?.data.toString('utf8') ?? '';
  const title = body.title?.trim() || extractTitle(body.html, body.chapterId);
  const editedBody = restoreEditorAssets(body.html, params.id);
  const editedHtml = replaceBody(originalHtml, editedBody, title, book.language);

  ensureDirs();
  const newBookId = uuid();
  const outputFile = libraryPath(newBookId);
  await writeEditedCopy({
    sourcePath: book.filePath,
    outputPath: outputFile,
    targetFile,
    editedHtml,
    title,
  });

  let copiedCover: string | undefined;
  if (book.coverPath && fs.existsSync(book.coverPath)) {
    const ext = path.extname(book.coverPath) || '.jpg';
    copiedCover = coverPath(newBookId, ext.replace(/^\./, ''));
    fs.copyFileSync(book.coverPath, copiedCover);
  }

  const editedSuffix = ' - Edited';
  const newTitle = book.title.endsWith(editedSuffix) ? book.title : `${book.title}${editedSuffix}`;
  const originalName = book.originalFilename.replace(/(\.[^.]+)$/, `${editedSuffix}$1`);
  const stat = fs.statSync(outputFile);
  const newBook = await createBook({
    id: newBookId,
    title: newTitle,
    author: book.author,
    language: book.language,
    description: book.description ?? undefined,
    publisher: book.publisher ?? undefined,
    publishDate: book.publishDate ?? undefined,
    identifier: book.identifier ?? undefined,
    series: book.series ?? undefined,
    seriesIndex: book.seriesIndex ?? undefined,
    rating: book.rating ?? undefined,
    coverPath: copiedCover,
    filePath: outputFile,
    fileSize: stat.size,
    originalFilename: originalName,
    tags: book.tags,
    notes: book.notes ?? undefined,
  });

  return NextResponse.json({ book: newBook }, { status: 201 });
}

function escXml(s: string) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
