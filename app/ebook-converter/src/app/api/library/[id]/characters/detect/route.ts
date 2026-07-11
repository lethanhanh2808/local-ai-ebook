// src/app/api/library/[id]/characters/detect/route.ts
// POST /api/library/[id]/characters/detect
//
// Uses oMLX (local LLM) via the Python character_detector.py to extract
// characters from a book. Returns suggestions that the UI can apply.
import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { getBook } from '@/lib/db/books';
import { listCharacters, upsertCharacters, listVoices, createVoice } from '@/lib/db/voices';
import { pickBestBuiltInVoice, VIENEU_PROFILES } from '@/lib/ai/voice-selector';
import { g2pMatch } from '@/lib/vi-text-qa';
import { resolveBookPath } from '@/lib/storage';
import { BUILTIN_VIENEU_NAMES } from '@/lib/tts/vieneu-voices';

const BUILTIN_VIENEU = new Set(BUILTIN_VIENEU_NAMES);

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 180; // detection can take up to ~90s on M4

// Resolve the TTS service directory across dev/prod layouts.
// Project structure: .../Local-AI/app/ebook-converter  +  .../Local-AI/app/tts-service
// Next.js cwd is .../Local-AI/app/ebook-converter, so tts-service is at ../tts-service.
//
// The container at /app mounts only ./data + ./public/assets/fonts, so
// without extra wiring `../tts-service` and `/Volumes/...` (host path) are
// unreachable. docker-compose.yml mounts `../tts-service` at `/app/tts-service`
// for both the app and worker services; that is the canonical in-container
// location and is checked first. The host fallback still helps for dev
// (`npm run dev` on the laptop directly).
function resolveTtsServiceDir(): string | null {
  // 1. Explicit env var always wins — this is the documented knob.
  const fromEnv = process.env.TTS_SERVICE_DIR;
  if (fromEnv && fs.existsSync(fromEnv) && fs.existsSync(path.join(fromEnv, 'character_detector.py'))) {
    return fromEnv;
  }
  // 2. Try common relative layouts (covers in-container + dev paths).
  const candidates = [
    '/app/tts-service',                                       // container: ../tts-service mounted at /app/tts-service
    path.resolve(process.cwd(), 'tts-service'),               // container or dev: cwd/tts-service
    path.resolve(process.cwd(), '..', 'tts-service'),         // dev: app/ebook-converter + ../tts-service
    path.resolve(process.cwd(), 'app', 'tts-service'),        // legacy: app/ebook-converter/app/tts-service
    '/Volumes/EXT-SSD/Users/anhl/Local-AI/app/tts-service',   // host fallback (dev on laptop)
  ];
  for (const p of candidates) {
    if (fs.existsSync(p) && fs.existsSync(path.join(p, 'character_detector.py'))) {
      return p;
    }
  }
  return null;
}

const TTS_SERVICE_DIR = resolveTtsServiceDir();
const DETECTOR = TTS_SERVICE_DIR ? path.join(TTS_SERVICE_DIR, 'character_detector.py') : null;

// Pick the right Python interpreter — prefer the project's venv on host,
// fall back to system python in the container.
function resolvePython(): string {
  // 1. Host-side venv (dev / direct invocation on the laptop). The venv's
  //    `python3.11` is a symlink into /Library/Frameworks on macOS, so this
  //    only works when the script is running on the host (not inside the
  //    container) or when the volume mount preserves the full venv.
  const venvPy = TTS_SERVICE_DIR ? path.join(TTS_SERVICE_DIR, '.venv-moss-nano', 'bin', 'python') : null;
  if (venvPy && fs.existsSync(venvPy)) return venvPy;
  // 2. Explicit override (typically only used on the host).
  if (process.env.TTS_PYTHON && fs.existsSync(process.env.TTS_PYTHON)) {
    return process.env.TTS_PYTHON;
  }
  // 3. Container system Python — installed by Dockerfile with httpx.
  //    /usr/bin/python3 is the same as python3 on PATH but explicit avoids
  //    PATH surprises. Added: covers the case where the routed command
  //    `spawn` doesn't carry the standard PATH.
  if (fs.existsSync('/usr/bin/python3')) return '/usr/bin/python3';
  // 4. Last-resort fallback to whatever python is on PATH.
  return process.env.TTS_PYTHON ?? 'python3';
}

const VIENEU_VOICES = VIENEU_PROFILES.map((p) => ({
  id: p.name,
  gender: p.gender,
  tone: p.tone,
  desc: p.description,
}));

/** Suggest the best built-in VieNeu voice for a character based on the
 *  full attribute set (gender + age + tone). Delegates to the centralized
 *  picker in lib/ai/voice-selector.ts which scores all 10 voices and
 *  returns the best match. `alreadyUsed` is a hint — we still respect it
 *  to avoid two characters in the same book getting identical voices. */
function suggestVoice(gender: string, tone: string, alreadyUsed: Set<string>, age?: string | null, name?: string): string {
  // Build candidates list, prefer unused voices to give visual diversity
  // (the scoring itself doesn't care about used-set, only diversity does).
  const profile = pickBestBuiltInVoice({ name: name ?? '_', gender, age, tone });
  // If the top-scored voice is already in heavy use, try the runner-up.
  if (alreadyUsed.has(profile.name)) {
    // Re-score without the used voices by faking different gender until we
    // find one not in the used set. Cheap fallback — picker is pure.
    for (const p of VIENEU_PROFILES) {
      if (!alreadyUsed.has(p.name) && p.gender === profile.gender) {
        return p.name;
      }
    }
  }
  return profile.name;
}

/** Run the python character_detector.py and return parsed JSON. */
const DETECTOR_TIMEOUT_MS = 170_000;
const MAX_DETECTOR_STDOUT = 2 * 1024 * 1024;
const MAX_DETECTOR_STDERR = 256 * 1024;

async function runDetector(epubPath: string, signal?: AbortSignal): Promise<any> {
  const omlxKey = process.env.OMLX_API_KEY ?? '';
  const py = resolvePython();
  if (!DETECTOR) {
    throw new Error(
      `character_detector.py not found. Searched in:\n` +
      `  ${process.cwd()}/../tts-service\n` +
      `  ${process.cwd()}/app/tts-service\n` +
      `  ${process.cwd()}/tts-service\n` +
      `  /Volumes/EXT-SSD/Users/anhl/Local-AI/app/tts-service\n` +
      `Adjust TTS_SERVICE_DIR env var to point at the tts-service root.`
    );
  }
  if (!fs.existsSync(DETECTOR)) throw new Error(`Detector not found at ${DETECTOR}`);

  let omlxModel: string;
  try {
    const { getSettings } = await import('@/lib/db/settings');
    const settings = await getSettings();
    // BUGFIX 2026-07-11: schema default for aiModel is the literal string
    // "default" (see prisma/schema.prisma). OMLX treats that as a real
    // model id and rejects it ("Model 'default' not found"), which forces
    // the Python detector into its regex-fallback branch — exactly the
    // orphan-aiModel pattern documented in the character-detection-source-
    // tagging memory. Treat both empty AND the literal "default" as "no
    // user-chosen model" so the Python script falls through to its own
    // empty-string path (= OMLX uses its server-side default model).
    const raw = settings.aiModel?.trim() ?? '';
    omlxModel = (raw && raw.toLowerCase() !== 'default')
      ? raw
      : (process.env.OMLX_MODEL || '');
  } catch {
    omlxModel = process.env.OMLX_MODEL || '';
  }

  return new Promise((resolve, reject) => {
    // Read the user's selected model from the Settings DB (same source
    // chapter-enhancer / chapter-formatter / epub-analyzer use), so the
    // character detection respects whatever the user picked in /settings.
    // Falls back to OMLX_MODEL env var only if the DB row is empty.
    // Pass model as a CLI arg (after the epub path) so the Python script
    // gets an explicit value — env-var-only passing was unreliable.
    const proc = spawn(py, [DETECTOR, epubPath, omlxModel], {
      env: { ...process.env, OMLX_API_KEY: omlxKey, OMLX_MODEL: omlxModel },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    let settled = false;
    const finishError = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      try { proc.kill('SIGTERM'); } catch {}
      reject(error);
    };
    const onAbort = () => finishError(new Error('Character detection cancelled'));
    const timer = setTimeout(
      () => finishError(new Error(`Character detector timed out after ${DETECTOR_TIMEOUT_MS / 1000}s`)),
      DETECTOR_TIMEOUT_MS,
    );
    signal?.addEventListener('abort', onAbort, { once: true });
    proc.stdout.on('data', (d) => {
      stdout += d.toString();
      if (Buffer.byteLength(stdout) > MAX_DETECTOR_STDOUT) {
        finishError(new Error('Character detector output exceeded 2 MiB'));
      }
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
      if (Buffer.byteLength(stderr) > MAX_DETECTOR_STDERR) {
        finishError(new Error('Character detector error output exceeded 256 KiB'));
      }
    });
    proc.on('error', (error) => finishError(error));
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (code !== 0) {
        reject(new Error(`detector exit ${code}: ${stderr.slice(-500)}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(new Error(`detector JSON parse failed: ${e}. Stdout first 500: ${stdout.slice(0, 500)}`));
      }
    });
  });
}

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const book = await getBook(params.id);
  if (!book) return NextResponse.json({ error: 'Book not found' }, { status: 404 });
  const bookPath = await resolveBookPath(book);
  if (!fs.existsSync(bookPath)) {
    return NextResponse.json({ error: 'Book file missing on disk' }, { status: 404 });
  }

  // BUGFIX 2026-07-11: Full Analyzer calls us with { autoApply: true } to
  // skip the UI's character-review step. We run detection then persist the
  // suggestions straight into the Character table using the same voice-name
  // resolution as the manual apply path. The response carries the inserted
  // count so the caller knows whether the auto-roster step produced anything
  // useful before it tries speaker attribution.
  const body = await req.json().catch(() => ({})) as { autoApply?: boolean };
  const autoApply = body.autoApply === true;

  let result: any;
  try {
    result = await runDetector(bookPath, req.signal);
  } catch (e) {
    console.error('[characters/detect] failed:', e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }

  // Read existing characters/voices for "already used" tracking
  const [existingChars, voices] = await Promise.all([
    listCharacters(params.id),
    listVoices(params.id),
  ]);
  const existingNames = new Set(existingChars.map((c) => c.name));
  // Also fold aliases into the existing-name set so a previously-saved alias
  // (e.g., "Tuan Ngoc") blocks a fresh "Tuấn Ngọc" suggestion from being
  // re-imported as a brand-new character.
  const existingAliases = new Set<string>();
  for (const c of existingChars) {
    for (const a of c.aliases ?? []) existingAliases.add(a);
  }
  // Helper: did this name already exist under any spelling?
  const isAlreadyInDb = (name: string) => {
    if (existingNames.has(name) || existingAliases.has(name)) return true;
    for (const en of existingNames) if (g2pMatch(en, name)) return true;
    for (const ea of existingAliases) if (g2pMatch(ea, name)) return true;
    return false;
  };
  const usedVoices = new Set<string>();
  for (const c of existingChars) {
    if (c.voiceId) {
      const v = voices.find((vv) => vv.id === c.voiceId);
      if (v) usedVoices.add(v.name);
    } else if (c.voice) {
      usedVoices.add(c.voice.name);
    }
  }

  // Build suggestions: per detected character, suggest a voice + check for duplicates
  const characters = Array.isArray(result.characters) ? result.characters : [];
  const suggestions = characters.map((c: any) => {
    const name = String(c.name ?? '').trim();
    const suggestedVoice = suggestVoice(
      c.gender ?? 'unknown',
      c.tone ?? 'unknown',
      usedVoices,
      c.age ?? null,
      name,
    );
    usedVoices.add(suggestedVoice);
    return {
      name,
      aliases: Array.isArray(c.aliases) ? c.aliases : [],
      gender: c.gender ?? 'unknown',
      age: c.age ?? null,
      tone: c.tone ?? 'unknown',
      role: c.role ?? 'supporting',
      lines_estimate: Number(c.lines_estimate ?? 0),
      sample_lines: Array.isArray(c.sample_lines) ? c.sample_lines : [],
      suggested_voice: suggestedVoice,
      already_in_db: isAlreadyInDb(name),
    };
  }).filter((s: any) => s.name);

  // BUGFIX 2026-07-11: surface the detection source so the UI can warn
  // when the regex fallback fired (caused by an invalid aiModel in
  // /settings, or any other LLM JSON-parse failure).
  const source = (result.source ?? 'omlx') as 'omlx' | 'regex-fallback' | 'failed';
  const warning = source !== 'omlx'
    ? 'LLM không trả về danh sách nhân vật hợp lệ — kiểm tra aiModel trong /settings hoặc thử lại.'
    : undefined;

  // ── BUGFIX 2026-07-11: auto-apply path ─────────────────────────────────
  // Full Analyzer calls us with { autoApply: true } when the user clicks
  // "Full LLM" against a book with an empty roster. Without persistence,
  // autoExtractRoster in analyze/route.ts would have nothing to load and
  // speaker attribution would still bail with "0 names". Mirror the manual
  // apply path: resolve suggested_voice names → voiceId, skip rows already
  // in the roster, then upsert. Returns `inserted` so the caller knows the
  // auto-roster step was worth running.
  let inserted = 0;
  if (autoApply && suggestions.length > 0) {
    try {
      const voiceByName = new Map(voices.map((v) => [v.name, v]));
      const toUpsert: Array<{
        name: string;
        aliases: string[];
        voiceId?: string | null;
        role: string;
        age?: string | null;
        gender?: string | null;
        tone?: string | null;
      }> = [];
      for (const s of suggestions) {
        if (s.already_in_db) continue;  // skip dupes
        let voiceId: string | null = null;
        if (s.suggested_voice && BUILTIN_VIENEU.has(s.suggested_voice)) {
          let v = voiceByName.get(s.suggested_voice);
          if (!v) {
            v = await createVoice({
              bookId: params.id,
              name: s.suggested_voice,
              description: `Built-in VieNeu voice: ${s.suggested_voice}`,
              refAudioPath: '',
              language: 'vi',
              isDefault: false,
              kind: 'character',
              builtinName: s.suggested_voice,
              defaultEmotion: s.tone && s.tone !== 'unknown' ? s.tone : undefined,
            });
            voiceByName.set(s.suggested_voice, v);
          }
          voiceId = v.id;
        }
        toUpsert.push({
          name: s.name.slice(0, 120),
          aliases: (s.aliases ?? []).slice(0, 30),
          voiceId,
          role: s.role ?? 'supporting',
          age: s.age ?? null,
          gender: s.gender ?? null,
          tone: s.tone ?? null,
        });
      }
      if (toUpsert.length > 0) {
        const created = await upsertCharacters(params.id, toUpsert);
        inserted = created.length;
        console.log(`[characters/detect] autoApply: persisted ${inserted} characters for book ${params.id}`);
      }
    } catch (e) {
      console.error('[characters/detect] autoApply failed:', e);
      // Don't fail the whole response — the caller can still see suggestions
      // and try again manually. Just log.
    }
  }

  return NextResponse.json({
    language: result.language ?? 'vi',
    summary: result.summary ?? '',
    narrator_gender_hint: result.narrator_gender_hint ?? 'unknown',
    total_dialogue_lines: Number(result.total_dialogue_lines ?? 0),
    characters: suggestions,
    available_voices: VIENEU_VOICES,
    source,
    warning,
    ...(autoApply ? { inserted } : {}),
  });
}
