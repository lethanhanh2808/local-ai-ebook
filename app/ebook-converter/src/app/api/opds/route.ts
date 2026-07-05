// GET /api/opds – OPDS 1.2 root catalog
// OPDS (Open Publication Distribution System) lets e-readers browse & download books
import { NextRequest, NextResponse } from 'next/server';
import { listBooks } from '@/lib/db/books';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const OPDS_CONTENT_TYPE = 'application/atom+xml; profile=opds-catalog; kind=navigation; charset=utf-8';

function xmlEscape(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function now() {
  return new Date().toISOString();
}

export async function GET(req: NextRequest) {
  const base = req.nextUrl.origin;
  const search = req.nextUrl.searchParams.get('q') ?? undefined;
  const books = await listBooks({ search, limit: 100 });

  const entries = books.map((book) => {
    const coverUrl = `${base}/api/library/${book.id}/cover`;
    const downloadUrl = `${base}/api/library/${book.id}/download`;
    const desc = xmlEscape(book.description ?? `${book.author} — ${book.language.toUpperCase()}`);
    return `
  <entry>
    <title>${xmlEscape(book.title)}</title>
    <id>urn:uuid:${book.id}</id>
    <author><name>${xmlEscape(book.author)}</name></author>
    <updated>${book.updatedAt}</updated>
    <dc:language>${xmlEscape(book.language)}</dc:language>
    ${book.publisher ? `<dc:publisher>${xmlEscape(book.publisher)}</dc:publisher>` : ''}
    <summary type="html">${desc}</summary>
    ${book.tags.map((t) => `<category term="${xmlEscape(t)}" label="${xmlEscape(t)}"/>`).join('\n    ')}
    <link rel="http://opds-spec.org/image" href="${coverUrl}" type="image/jpeg"/>
    <link rel="http://opds-spec.org/acquisition" href="${downloadUrl}" type="application/epub+zip" title="EPUB"/>
    <link rel="alternate" href="${base}/library/${book.id}/read" type="text/html" title="Read Online"/>
  </entry>`;
  }).join('');

  const feedTitle = search ? `Search: ${search}` : 'My Ebook Library';

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:dc="http://purl.org/dc/elements/1.1/"
      xmlns:opds="http://opds-spec.org/2010/catalog">
  <id>${base}/api/opds</id>
  <title>${xmlEscape(feedTitle)}</title>
  <updated>${now()}</updated>
  <author><name>Local Ebook Manager</name><uri>${base}</uri></author>
  <link rel="self" href="${base}/api/opds" type="${OPDS_CONTENT_TYPE}"/>
  <link rel="start" href="${base}/api/opds" type="${OPDS_CONTENT_TYPE}"/>
  <link rel="search" href="${base}/api/opds?q={searchTerms}" type="application/atom+xml"/>
${entries}
</feed>`;

  return new NextResponse(xml, {
    headers: { 'Content-Type': OPDS_CONTENT_TYPE },
  });
}
