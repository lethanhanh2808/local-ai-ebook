export function extractTitleFromBody(body: string): string | null {
  const m = body.match(/^\s*<h[1-6](?:\s[^>]*)?>([\s\S]*?)<\/h[1-6]>/i);
  if (!m) return null;
  return m[1].replace(/<[^>]+>/g, '').trim() || null;
}

export function looksLikeCoverPage(html: string): boolean {
  if (!html) return false;
  const bodyMatch = html.match(/<body\b([^>]*)>/i);
  if (!bodyMatch) return false;
  const attrs = bodyMatch[1];
  if (/\bclass\s*=\s*["'][^"']*\bcover-page\b/i.test(attrs)) return true;
  if (/\bepub:type\s*=\s*["'][^"']*\bcover\b/i.test(attrs)) return true;
  if (/\bepub:type\s*=\s*["'][^"']*\bfrontmatter\b/i.test(attrs)) return true;
  return false;
}

export function stripLeadingHeadings(body: string, title?: string): string {
  let result = body.trim();
  const headRe = /^<h[1-6](?:\s[^>]*)?>([\s\S]*?)<\/h[1-6]>\s*/i;
  while (headRe.test(result)) {
    result = result.replace(headRe, '').trim();
  }
  if (title) {
    const esc = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const dupPRe = new RegExp(`^<p(?:\\s[^>]*)?>\\s*${esc}\\s*<\\/p>\\s*`, 'i');
    if (dupPRe.test(result)) {
      result = result.replace(dupPRe, '').trim();
    }
  }
  return result;
}

export function extractBody(html: string): string {
  const m = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  return m ? m[1].trim() : html;
}

export function prepareChapterBodies(
  chapters: ReadonlyArray<{ id: string; title: string; html: string }>,
): Array<{ id: string; bodyHtml: string }> {
  return chapters.map((ch) => ({
    id: ch.id,
    bodyHtml: extractChapterBodyFragment(ch.html, ch.title),
  }));
}

import { extractChapterBodyFragment } from './epub-styler';
