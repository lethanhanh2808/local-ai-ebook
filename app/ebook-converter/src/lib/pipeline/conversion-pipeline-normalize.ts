import { buildChapterHtml } from './epub-styler';
import type { EpubImage } from './epub-builder';
import { extractBody, extractTitleFromBody, stripLeadingHeadings } from './conversion-pipeline-content';
import { extractDataUriImages, rewriteImageSources, stripImages } from './conversion-pipeline-image-ops';

export interface NormalizedChapterInput {
  index: number;
  tocTitle: string;
  rawHtml: string;
  lang: string;
  imageResolver?: (src: string) => string | null;
  dataUriSink?: EpubImage[];
}

export function normalizeChapterHtml(input: NormalizedChapterInput) {
  const { index, tocTitle, rawHtml, lang, imageResolver, dataUriSink } = input;
  const rawBody = extractBody(rawHtml);
  const bodyTitle = extractTitleFromBody(rawBody);
  const title = bodyTitle || tocTitle;
  let body = stripLeadingHeadings(rawBody, title);

  if (dataUriSink) {
    body = extractDataUriImages(body, dataUriSink);
  }

  if (imageResolver) {
    body = rewriteImageSources(body, imageResolver);
  } else {
    body = stripImages(body);
  }

  const n = String(index + 1).padStart(3, '0');
  return {
    id: `chapter${n}`,
    title,
    filename: `chapter${n}.xhtml`,
    html: buildChapterHtml({ id: `chapter${n}`, title, body, lang }),
  };
}
