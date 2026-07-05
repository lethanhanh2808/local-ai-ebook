// src/app/api/library/[id]/chapters/[chapterId]/detect-characters/route.ts
//
// POST /api/library/[id]/chapters/[chapterId]/detect-characters
//
// Per-chapter character detection — runs OMLX on a SINGLE chapter's HTML,
// then auto-applies new characters into the book's character table via the
// centralized voice selector (lib/ai/voice-selector.ts).
//
// Body: { language?: string }
// Response: {
//   detected: number,        // raw count from OMLX
//   inserted: number,        // new characters actually added to DB
//   skipped: number,         // characters that already existed (deduped)
//   characters: [...]        // the newly inserted characters + their assignments
// }
import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { getBook } from '@/lib/db/books';
import { assignVoicesToCharacters } from '@/lib/ai/voice-selector';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 180; // up to 3 min for slow OMLX detection

// ── Resolve Python interpreter + character_detector.py ──────────────
function resolveTtsServiceDir(): string | null {
  const candidates = [
    process.env.TTS_SERVICE_DIR,
    path.resolve(process.cwd(), 'app', 'tts-service'),
    path.resolve(process.cwd(), '..', 'app', 'tts-service'),
    path.resolve(process.cwd(), '..', 'tts-service'),
    '/Volumes/EXT-SSD/Users/anhl/Local-AI/app/tts-service',
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p) && fs.existsSync(path.join(p, 'character_detector.py'))) return p;
  }
  return null;
}

function resolvePython(ttsDir: string): string {
  const venvPy = path.join(ttsDir, '.venv-moss-nano', 'bin', 'python');
  if (fs.existsSync(venvPy)) return venvPy;
  return process.env.TTS_PYTHON ?? '/Library/Frameworks/Python.framework/Versions/3.11/bin/python3.11';
}

/** Run python character_detector.py on the given HTML text (single-chapter mode). */
function runDetector(htmlText: string, chapterId: string, model: string): Promise<any> {
  const ttsDir = resolveTtsServiceDir();
  if (!ttsDir) throw new Error('character_detector.py not found');
  const detector = path.join(ttsDir, 'character_detector.py');
  const py = resolvePython(ttsDir);

  const tmpDir = path.join(process.cwd(), 'data', 'tmp-chars');
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmpHtml = path.join(tmpDir, `${chapterId}-${Date.now()}.html`);
  fs.writeFileSync(tmpHtml, htmlText, 'utf-8');

  return new Promise((resolve, reject) => {
    const proc = spawn(py, [detector, tmpHtml, model], {
      env: { ...process.env, OMLX_API_KEY: process.env.OMLX_API_KEY ?? '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      try { fs.unlinkSync(tmpHtml); } catch { /* noop */ }
      if (code !== 0) {
        reject(new Error(`detector exit ${code}: ${stderr.slice(-500)}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
        return;
      } catch { /* fall through to substring extraction */ }
      const first = stdout.indexOf('{');
      const last = stdout.lastIndexOf('}');
      if (first >= 0 && last > first) {
        try { resolve(JSON.parse(stdout.slice(first, last + 1))); return; }
        catch (e) { reject(new Error(`JSON parse failed: ${String(e)}. stdout first 500: ${stdout.slice(0, 500)}`)); return; }
      }
      reject(new Error(`No JSON in detector stdout. stderr: ${stderr.slice(-200)}`));
    });
  });
}

export async function POST(req: NextRequest, { params }: { params: { id: string; chapterId: string } }) {
  const book = await getBook(params.id);
  if (!book) return NextResponse.json({ error: 'Book not found' }, { status: 404 });

  // 1. Fetch the chapter HTML
  const origin = req.nextUrl.origin;
  const chapterResp = await fetch(`${origin}/api/library/${params.id}/chapters/${encodeURIComponent(params.chapterId)}?raw=1`);
  if (!chapterResp.ok) {
    return NextResponse.json({ error: 'Failed to fetch chapter HTML' }, { status: 502 });
  }
  const { html } = await chapterResp.json() as { html: string };
  if (!html) return NextResponse.json({ error: 'Chapter has no content' }, { status: 400 });

  // 2. Resolve the user-selected model from Settings DB
  let model = '';
  try {
    const { getSettings } = await import('@/lib/db/settings');
    const s = await getSettings();
    model = s.aiModel?.trim() || process.env.OMLX_MODEL || '';
  } catch {
    model = process.env.OMLX_MODEL || '';
  }

  // 3. Run detection on this chapter
  let result: any;
  try {
    result = await runDetector(html, params.chapterId, model);
  } catch (e) {
    console.error('[chapters/detect-characters] failed:', e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }

  const detected: any[] = Array.isArray(result?.characters) ? result.characters : [];
  if (detected.length === 0) {
    return NextResponse.json({
      detected: 0,
      inserted: 0,
      skipped: 0,
      characters: [],
      summary: result?.summary ?? 'No characters detected',
    });
  }

  // 4. Use the centralized voice selector to assign voices
  // (smart gender/age/tone matching + common-pool routing for minor chars)
  const inputs = detected.map((c) => ({
    name: String(c.name ?? '').trim(),
    aliases: Array.isArray(c.aliases) ? c.aliases.filter((a: any) => typeof a === 'string') : [],
    gender: c.gender,
    age: c.age ?? null,
    tone: c.tone,
    role: c.role,  // main | supporting | minor | crowd (from detector)
  })).filter((c) => c.name);

  const assignments = await assignVoicesToCharacters(params.id, inputs);
  const inserted = assignments.filter((a) => a.isNew).length;
  const skipped = assignments.filter((a) => !a.isNew).length;

  return NextResponse.json({
    detected: detected.length,
    inserted,
    skipped,
    characters: assignments,
    summary: result?.summary,
  });
}