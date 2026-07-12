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
// In-container: docker-compose mounts ../tts-service at /app/tts-service
// (see app/ebook-converter/docker-compose.yml). Dev (laptop): one of the
// ../tts-service variants resolves. Host fallback kept for explicit dirs.
function resolveTtsServiceDir(): string | null {
  const candidates = [
    process.env.TTS_SERVICE_DIR,
    '/app/tts-service',                                       // container: ../tts-service mounted at /app/tts-service
    path.resolve(process.cwd(), 'tts-service'),               // cwd/tts-service (legacy container or dev)
    path.resolve(process.cwd(), 'app', 'tts-service'),        // legacy: app/ebook-converter/app/tts-service
    path.resolve(process.cwd(), '..', 'app', 'tts-service'),  // legacy: ../app/tts-service
    path.resolve(process.cwd(), '..', 'tts-service'),         // dev: app/ebook-converter + ../tts-service
    '/Volumes/EXT-SSD/Users/anhl/Local-AI/app/tts-service',   // host fallback
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p) && fs.existsSync(path.join(p, 'character_detector.py'))) return p;
  }
  return null;
}

function resolvePython(_ttsDir: string): string {
  // 2026-07-12: .venv-moss-nano was removed along with the MOSS-TTS-Nano
  // backend. The detector only needs httpx (a system package in the
  // container), so we go straight to explicit override → system python.
  // 1. Explicit override (typically only used on the host).
  if (process.env.TTS_PYTHON && fs.existsSync(process.env.TTS_PYTHON)) {
    return process.env.TTS_PYTHON;
  }
  // 2. Container-installed system Python (see Dockerfile). `/usr/bin/python3`
  //    is installed with httpx via `pip install --break-system-packages`
  //    during the image build.
  if (fs.existsSync('/usr/bin/python3')) return '/usr/bin/python3';
  // 3. Last-resort: PATH lookup.
  return process.env.TTS_PYTHON ?? 'python3';
}

const DETECTOR_TIMEOUT_MS = 170_000;
const MAX_STDOUT_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 256 * 1024;
const MAX_CHAPTER_HTML_BYTES = 5 * 1024 * 1024;

/** Run character_detector.py with chapter HTML on stdin. No temp file is
 * created, so navigation cancellation and dev-server restarts cannot orphan
 * data/tmp-chars artifacts. */
function runDetector(htmlText: string, chapterId: string, model: string, signal?: AbortSignal): Promise<any> {
  const ttsDir = resolveTtsServiceDir();
  if (!ttsDir) throw new Error('character_detector.py not found');
  const detector = path.join(ttsDir, 'character_detector.py');
  const py = resolvePython(ttsDir);

  if (Buffer.byteLength(htmlText) > MAX_CHAPTER_HTML_BYTES) {
    throw new Error('Chapter HTML exceeds 5 MiB detection limit');
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(py, [detector, '-', model], {
      env: {
        ...process.env,
        OMLX_API_KEY: process.env.OMLX_API_KEY ?? '',
        CHARACTER_DETECTOR_CHAPTER_ID: chapterId.slice(0, 200),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const onAbort = () => fail(new Error('Character detection cancelled'));
    const timer = setTimeout(
      () => fail(new Error(`Character detector timed out after ${DETECTOR_TIMEOUT_MS / 1000}s`)),
      DETECTOR_TIMEOUT_MS,
    );
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      try { proc.kill('SIGTERM'); } catch {}
      reject(error);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    proc.stdout.on('data', (d) => {
      stdout += d.toString();
      if (Buffer.byteLength(stdout) > MAX_STDOUT_BYTES) fail(new Error('Detector stdout exceeded 2 MiB'));
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
      if (Buffer.byteLength(stderr) > MAX_STDERR_BYTES) fail(new Error('Detector stderr exceeded 256 KiB'));
    });
    proc.on('error', fail);
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
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
    proc.stdin.on('error', (error) => fail(error));
    proc.stdin.end(htmlText, 'utf8');
  });
}

export async function POST(
  req: NextRequest,
  props: { params: Promise<{ id: string; chapterId: string }> }
) {
  const params = await props.params;
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

  // 2. Resolve the user-selected model from Settings DB. Validate against
  //    the live oMLX model list (5 min cache) so a stale aiModel value
  //    — e.g. an old Claude session id like "MiniMax-M3" that leaked into
  //    the DB via the /settings form — doesn't reach oMLX and trigger
  //    "Model 'X' not found", which forces the detector into its
  //    regex-fallback branch (orphan-aiModel pattern documented in the
  //    character-detection-source-tagging memory).
  let model = '';
  let modelResolution: 'empty' | 'default' | 'env-fallback' | 'validated' | 'unknown-replaced' = 'empty';
  try {
    const { getSettings } = await import('@/lib/db/settings');
    const s = await getSettings();
    const { resolveOmlxModel } = await import('@/lib/ai/omlx-models');
    const resolved = await resolveOmlxModel(s.aiModel);
    model = resolved.model;
    modelResolution = resolved.reason;
    if (resolved.reason === 'unknown-replaced') {
      console.warn(
        `[chapters/detect-characters] settings.aiModel="${resolved.requested}" is not a known oMLX model; ` +
        `falling back to OMLX default. User should fix /settings.`,
      );
    }
  } catch {
    model = process.env.OMLX_MODEL || '';
    modelResolution = model ? 'env-fallback' : 'empty';
  }

  // 3. Run detection on this chapter
  let result: any;
  try {
    result = await runDetector(html, params.chapterId, model, req.signal);
  } catch (e) {
    console.error('[chapters/detect-characters] failed:', e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }

  const detected: any[] = Array.isArray(result?.characters) ? result.characters : [];
  // BUGFIX 2026-07-12: surface model resolution issues in the response so
  // the UI can warn the user their settings.aiModel is stale.
  const modelWarning = modelResolution === 'unknown-replaced'
    ? 'Model trong /settings không hợp lệ (đã đổi tên hoặc đã xoá). Đang dùng model mặc định của oMLX — vui lòng cập nhật /settings.'
    : undefined;
  if (detected.length === 0) {
    return NextResponse.json({
      detected: 0,
      inserted: 0,
      skipped: 0,
      characters: [],
      summary: result?.summary ?? 'No characters detected',
      model_used: model || '(omlx default)',
      model_resolution: modelResolution,
      ...(modelWarning ? { warning: modelWarning } : {}),
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
    // BUGFIX 2026-07-12: surface model info on the success path too,
    // so a stale /settings aiModel surfaces a warning even when detection
    // produced characters. Otherwise the user only sees the warning when
    // detection is empty — which is exactly the case where they'd think
    // "nothing detected, my model must be fine." Include both fields
    // unconditionally so the UI can flag it either way.
    model_used: model || '(omlx default)',
    model_resolution: modelResolution,
    ...(modelWarning ? { warning: modelWarning } : {}),
  });
}
