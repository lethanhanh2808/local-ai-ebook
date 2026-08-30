import fs from 'fs';
import path from 'path';
import type { ParsedEpub } from './epub-parser';

export async function buildMinimalEpubFromFile(
  filePath: string,
  ext: string,
): Promise<ParsedEpub> {
  const raw = fs.readFileSync(filePath, 'utf8');
  const name = path.basename(filePath, `.${ext}`);
  const html =
    ext === 'html' || ext === 'htm'
      ? raw
      : `<html><body>${raw
          .split('\n\n')
          .map((p) => `<p>${p.replace(/\n/g, ' ').trim()}</p>`)
          .join('\n')}</body></html>`;

  const dummyPath = `${name}.xhtml`;
  const entries = new Map([
    [dummyPath, { name: dummyPath, data: Buffer.from(html, 'utf8') }],
  ]);

  return {
    entries,
    opfPath: '',
    opfContent: '',
    htmlFiles: [dummyPath],
    cssFiles: [],
    imageFiles: [],
    metadata: { title: name, language: 'vi' },
    tocEntries: [{ title: name, src: dummyPath }],
  };
}

export function stripPhrasesFromHtml(html: string, phrases: string[]): string {
  if (phrases.length === 0) return html;
  let result = html;
  for (const phrase of phrases) {
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
    const wholeOnlyRe = new RegExp(
      `<(?:p|div|span|h[1-6])(?:\\s[^>]*)?>\\s*${escaped}\\s*<\\/(?:p|div|span|h[1-6])>`,
      'gi',
    );
    result = result.replace(wholeOnlyRe, '');

    const wrapperRe = new RegExp(
      `<(?:p|div|span|h[1-6])(?:\\s[^>]*)?>[^<]{0,60}${escaped}[^<]{0,60}<\\/(?:p|div|span|h[1-6])>`,
      'gi',
    );
    result = result.replace(wrapperRe, '');

    const inlineRe = new RegExp(`${escaped}`, 'gi');
    result = result.replace(inlineRe, '');
  }
  return result;
}
