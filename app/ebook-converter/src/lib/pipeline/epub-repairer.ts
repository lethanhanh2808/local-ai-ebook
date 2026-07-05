// src/lib/pipeline/epub-repairer.ts
// Repair an EPUB's HTML and structure using AI + heuristics
import { ParsedEpub } from './epub-parser';
import { analyzeEpubContent, repairHtmlChunk, EpubIssue } from '../ai/epub-analyzer';

export interface RepairResult {
  repairedHtml: Map<string, string>; // filename → fixed html
  issues: EpubIssue[];
  language: string;
  report: {
    totalFiles: number;
    repairedFiles: number;
    issueCount: Record<string, number>;
    suggestedActions: string[];
    confidence: number;
  };
}

// Heuristic pre-pass: fixes that don't need AI
function heuristicRepair(html: string, language: string): string {
  let out = html;

  // 1. Ensure UTF-8 charset declaration
  if (!out.includes('charset=utf-8') && !out.includes('charset=UTF-8')) {
    out = out.replace(/<head([^>]*)>/, '<head$1>\n<meta charset="utf-8"/>');
  }

  // 2. Fix common Vietnamese encoding artefacts (Windows-1258 / TCVN remnants)
  // Replace common badly-encoded sequences
  out = out.replace(/Â·/g, '·').replace(/Ã©/g, 'é').replace(/Ã /g, 'à');

  // 3. Close unclosed <p>, <div> tags crudely
  const openP = (out.match(/<p[^/]*>/gi) || []).length;
  const closeP = (out.match(/<\/p>/gi) || []).length;
  if (openP > closeP) {
    out += '</p>'.repeat(openP - closeP);
  }

  // 4. Strip Microsoft Office noise
  out = out.replace(/<o:p><\/o:p>/gi, '');
  out = out.replace(/mso-[^;"]+(;|")/gi, '$1');

  // 5. Vietnamese: fix common punctuation spacing
  if (language === 'vi' || language === 'mixed') {
    // No space before ,./!? in Vietnamese
    out = out.replace(/\s+([,.:!?;])/g, '$1');
  }

  // 6. Normalize line breaks inside text
  out = out.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  return out;
}

/**
 * Fast heuristic-only repair — no AI calls.
 * Used when the EPUB has no critical structural issues.
 */
export async function repairEpubHeuristic(
  epub: ParsedEpub,
  onProgress?: (pct: number, stage: string) => void | Promise<void>,
): Promise<RepairResult> {
  const language = epub.metadata.language ?? 'vi';
  const repairedHtml = new Map<string, string>();
  const total = epub.htmlFiles.length;
  let done = 0;

  for (const file of epub.htmlFiles) {
    const entry = epub.entries.get(file);
    if (!entry) { done++; continue; }
    repairedHtml.set(file, heuristicRepair(entry.data.toString('utf8'), language));
    done++;
    // Throttle progress updates: every 50 files, or on last file
    // Await each call to avoid overwhelming SQLite with concurrent writes
    if (onProgress && (done % 50 === 0 || done === total)) {
      const pct = Math.round((done / total) * 100);
      await onProgress(pct, `Repaired ${done}/${total} files`);
    }
  }

  return {
    repairedHtml,
    issues: [],
    language,
    report: {
      totalFiles: total,
      repairedFiles: repairedHtml.size,
      issueCount: {},
      suggestedActions: [],
      confidence: 1,
    },
  };
}

/**
 * AI-assisted repair — only called when the EPUB has critical validation issues.
 */
export async function repairEpub(
  epub: ParsedEpub,
  onProgress?: (pct: number, stage: string) => void,
): Promise<RepairResult> {
  const htmlSamples: Record<string, string> = {};
  for (const file of epub.htmlFiles.slice(0, 5)) {
    const entry = epub.entries.get(file);
    if (entry) htmlSamples[file] = entry.data.toString('utf8');
  }

  onProgress?.(5, 'Analyzing EPUB structure with AI…');
  const plan = await analyzeEpubContent(htmlSamples, epub.metadata);

  const repairedHtml = new Map<string, string>();
  const criticalIssues = plan.issues.filter((i) => i.severity === 'critical');

  const total = epub.htmlFiles.length;
  let done = 0;

  for (const file of epub.htmlFiles) {
    const entry = epub.entries.get(file);
    if (!entry) { done++; continue; }

    let html = entry.data.toString('utf8');

    // Heuristic pass (fast, free)
    html = heuristicRepair(html, plan.language);

    // AI pass only when there are critical issues affecting this file
    const relevantIssues = criticalIssues.filter(
      (i) =>
        !i.affectedFiles ||
        i.affectedFiles.length === 0 ||
        i.affectedFiles.some((f) => f.includes(file) || file.includes(f)),
    );

    if (relevantIssues.length > 0) {
      try {
        html = await repairHtmlChunk(html, relevantIssues, plan.language);
      } catch {
        // keep heuristic result if AI fails
      }
    }

    repairedHtml.set(file, html);
    done++;
    const pct = 5 + Math.round((done / total) * 60);
    onProgress?.(pct, `Repaired ${done}/${total} files`);
  }

  // Issue count summary
  const issueCount: Record<string, number> = {};
  for (const issue of plan.issues) {
    issueCount[issue.type] = (issueCount[issue.type] ?? 0) + 1;
  }

  return {
    repairedHtml,
    issues: plan.issues,
    language: plan.language,
    report: {
      totalFiles: total,
      repairedFiles: repairedHtml.size,
      issueCount,
      suggestedActions: plan.suggestedActions,
      confidence: plan.confidence,
    },
  };
}
