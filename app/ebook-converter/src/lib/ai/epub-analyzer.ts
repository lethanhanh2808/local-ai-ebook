// src/lib/ai/epub-analyzer.ts
// Uses OMLX to analyze an EPUB's HTML/structure and return a repair plan
import { chat, chatJSON } from './';  // unified AI client (routes by settings.aiProvider)

export interface EpubIssue {
  type:
    | 'broken_html'
    | 'missing_nav'
    | 'encoding'
    | 'missing_toc'
    | 'chapter_structure'
    | 'heading_hierarchy'
    | 'punctuation'
    | 'spacing'
    | 'metadata'
    | 'css_invalid'
    | 'other';
  severity: 'critical' | 'warning' | 'info';
  description: string;
  affectedFiles?: string[];
}

export interface RepairPlan {
  issues: EpubIssue[];
  suggestedActions: string[];
  confidence: number; // 0-1
  language: string;   // detected primary language
}

export async function analyzeEpubContent(
  htmlSamples: Record<string, string>, // filename → html snippet
  metadata: Record<string, string>,
): Promise<RepairPlan> {
  const sampleText = Object.entries(htmlSamples)
    .slice(0, 3) // keep prompt manageable
    .map(([f, h]) => `=== ${f} ===\n${h.slice(0, 1500)}`)
    .join('\n\n');

  return chatJSON<RepairPlan>({
    messages: [
      {
        role: 'system',
        content: `You are an expert EPUB3 document repair specialist. You understand EPUB2/EPUB3 standards, Vietnamese Unicode encoding, e-ink reader compatibility, and semantic HTML5.

Identify only issues supported by the provided samples and metadata. Do not invent files or problems that are not evidenced. Return only valid JSON matching the requested schema; no markdown, no prose, no code fences. /no_think`,
      },
      {
        role: 'user',
        content: `Analyze this EPUB content and return a JSON RepairPlan.

Metadata:
${JSON.stringify(metadata, null, 2)}

HTML Samples:
${sampleText}

Return JSON with shape:
{
  "issues": [{ "type": "...", "severity": "critical|warning|info", "description": "...", "affectedFiles": ["..."] }],
  "suggestedActions": ["..."],
  "confidence": 0.9,
  "language": "vi|en|mixed"
}`,
      },
    ],
  });
}

export async function repairHtmlChunk(
  html: string,
  issues: EpubIssue[],
  language: string,
): Promise<string> {
  const issueList = issues.map((i) => `- [${i.severity}] ${i.type}: ${i.description}`).join('\n');

  // Read model from settings so the user's selected model is used (not the
  // OMLX_MODEL env var fallback)
  const { getEffectiveSettings } = await import('@/lib/db/settings');
  const settings = await getEffectiveSettings();

  return chat({
    model: settings.aiModel,
    temperature: 0.1,
    messages: [
      {
        role: 'system',
        content: `You are a conservative EPUB HTML repair tool.
Language: ${language}.

Output only the corrected HTML fragment/document. No explanation, no markdown, no code fences.

Non-negotiable rules:
- Preserve all meaningful text, order, links, images, ids, classes, href/src/alt attributes, and headings that exist in the input.
- Do NOT translate, summarize, rewrite, paraphrase, censor, modernize, or add content.
- Fix only structural or encoding problems: malformed tags, unclosed elements, invalid nesting, obvious mojibake, repeated empty paragraphs, and unsafe script/style content.
- Normalize Vietnamese Unicode to NFC when possible.
- Use <p> paragraphs for naked prose only when the source clearly contains prose.
- Do not remove text unless it is clearly a broken script/style artifact or impossible-to-render markup.`,
      },
      {
        role: 'user',
        content: `KNOWN_ISSUES:\n${issueList}\n\nSOURCE_HTML:\n${html}`,
      },
    ],
  });
}

export async function detectChapters(
  tocItems: Array<{ title: string; src: string }>,
  htmlFiles: string[],
): Promise<{ chapters: Array<{ title: string; file: string; order: number }> }> {
  // Limit to 200 files to keep the prompt manageable
  const limitedFiles = htmlFiles.slice(0, 200);
  const tocTitles = tocItems.slice(0, 100).map((t) => `${t.title} → ${t.src}`);
  // 2026-09-01: honor Settings.aiMaxTokens (via chatJSON fallback) instead
  // of hardcoding 8192. Chapter detection for large EPUBs (200 files, broken
  // TOCs) can produce 500+ chapter entries — JSON output balloons fast.
  // chat() clamps internally to 16384 as a safety net so a user-set
  // "Generous" preset (e.g. for reasoning models) still works.
  return chatJSON({
    messages: [
      {
        role: 'system',
        content: `You are an ebook chapter detection assistant.

Return only valid JSON. Use only filenames that appear exactly in the provided HTML files list. Do not invent, rename, normalize, or guess file paths. If TOC entries exist and their files are present, trust the TOC order. If TOC is missing or incomplete, use the provided HTML file order. /no_think`,
      },
      {
        role: 'user',
        content: `TOC entries (title → file): ${JSON.stringify(tocTitles)}
HTML files: ${JSON.stringify(limitedFiles)}

Return JSON only: { "chapters": [{ "title": "...", "file": "...", "order": 1 }] }
/no_think`,
      },
    ],
  });
}

export async function generateEpubMetadata(
  rawTitle: string,
  rawAuthor: string,
  sampleText: string,
): Promise<{ title: string; author: string; language: string; description: string; subject: string }> {
  return chatJSON({
    messages: [
      {
        role: 'system',
        content:
          'You are a conservative ebook metadata specialist. Return only valid JSON. Clean existing metadata, but do not invent title, author, subject, or description unless supported by the raw fields or sample text. Use "Unknown" for missing title/author when evidence is insufficient.',
      },
      {
        role: 'user',
        content: `Raw title: "${rawTitle}"
Raw author: "${rawAuthor}"
Sample text: ${sampleText.slice(0, 500)}

Return JSON only: { "title": "...", "author": "...", "language": "vi|en|mixed", "description": "...", "subject": "..." }`,
      },
    ],
  });
}
