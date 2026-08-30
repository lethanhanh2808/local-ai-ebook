import type { EpubImage } from './epub-builder';

export function normalizeImageExt(raw: string): string {
  const e = raw.toLowerCase();
  switch (e) {
    case 'png':
    case 'gif':
    case 'svg':
    case 'svg+xml':
    case 'webp':
    case 'jpg':
    case 'jpeg':
      return e === 'jpeg' ? 'jpg' : e === 'svg+xml' ? 'svg' : e;
    default:
      return '';
  }
}

export function extractDataUriImages(body: string, sink: EpubImage[]): string {
  return body.replace(
    /<img\b([^>]*?)\ssrc=(['"])data:image\/([A-Za-z0-9+.-]+)(?:;base64)?,([^'"]+)\2([^>]*?)\/?>/gi,
    (match, pre, quote, rawExt, payload, post) => {
      const ext = normalizeImageExt(rawExt);
      if (!ext) return match;
      let buf: Buffer;
      try {
        buf = Buffer.from(payload, 'base64');
      } catch {
        return match;
      }
      if (buf.length === 0) return match;

      const used = new Set(sink.map((i) => i.href));
      let n = 1;
      while (used.has(`inline-${n}.${ext}`)) n++;
      const basename = `inline-${n}.${ext}`;
      const mediaType = `image/${ext === 'jpg' ? 'jpeg' : ext}`;
      sink.push({ id: `img-inline-${sink.length + 1}`, href: basename, data: buf, mediaType });

      const newSrc = `../images/${basename}`;
      const isSelfClosing = match.endsWith('/>');
      return `<img${pre} src=${quote}${newSrc}${quote}${post}${isSelfClosing ? ' /' : ''}>`;
    },
  );
}

export function stripImages(body: string): string {
  return body.replace(/<img\b[^>]*\/?\>/gi, '').trim();
}

export function rewriteImageSources(body: string, resolve: (src: string) => string | null): string {
  return body.replace(/<img\b([^>]*?)\/?>/gi, (match, attrs) => {
    const m = attrs.match(/\ssrc=(?:"([^"]+)"|'([^']+)'|(\S+))/i);
    if (!m) return match;
    const src = m[1] ?? m[2] ?? m[3] ?? '';
    const resolved = resolve(src);
    if (!resolved) return match;

    let quote: '"' | "'" | '' = '';
    if (m[1] !== undefined) quote = '"';
    else if (m[2] !== undefined) quote = "'";

    const newAttrs = attrs.replace(/\ssrc=(?:"[^"]+"|'[^']+'|\S+)/i, '') + ` src=${quote}../images/${resolved}${quote}`;
    const isSelfClosing = match.endsWith('/>');
    return `<img${newAttrs}${isSelfClosing ? ' /' : ''}>`;
  });
}
