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
import { listCharacters, upsertCharacters, listVoices } from '@/lib/db/voices';
import { pickBestBuiltInVoice, VIENEU_PROFILES } from '@/lib/ai/voice-selector';
import { g2pMatch } from '@/lib/vi-text-qa';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 180; // detection can take up to ~90s on M4

// Resolve the TTS service directory across dev/prod layouts.
// Project structure: .../Local-AI/app/ebook-converter  +  .../Local-AI/app/tts-service
// Next.js cwd is .../Local-AI/app/ebook-converter, so tts-service is at ../tts-service.
function resolveTtsServiceDir(): string | null {
  // 1. Explicit env var always wins — this is the documented knob.
  const fromEnv = process.env.TTS_SERVICE_DIR;
  if (fromEnv && fs.existsSync(fromEnv) && fs.existsSync(path.join(fromEnv, 'character_detector.py'))) {
    return fromEnv;
  }
  // 2. Try common relative layouts.
  const candidates = [
    path.resolve(process.cwd(), '..', 'tts-service'),         // dev: app/ebook-converter + ../tts-service
    path.resolve(process.cwd(), 'app', 'tts-service'),        // legacy: app/ebook-converter/app/tts-service
    path.resolve(process.cwd(), 'tts-service'),              // if next is run from app/
    '/Volumes/EXT-SSD/Users/anhl/Local-AI/app/tts-service',   // fallback to known location
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

// Pick the right Python interpreter — prefer the project's venv (has httpx + deps).
function resolvePython(): string {
  const venvPy = TTS_SERVICE_DIR ? path.join(TTS_SERVICE_DIR, '.venv-moss-nano', 'bin', 'python') : null;
  if (venvPy && fs.existsSync(venvPy)) return venvPy;
  return process.env.TTS_PYTHON ?? '/Library/Frameworks/Python.framework/Versions/3.11/bin/python3.11';
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
async function runDetector(epubPath: string): Promise<any> {
  return new Promise(async (resolve, reject) => {
    const omlxKey = process.env.OMLX_API_KEY ?? '';
    const py = resolvePython();
    if (!DETECTOR) {
      reject(new Error(
        `character_detector.py not found. Searched in:\n` +
        `  ${process.cwd()}/../tts-service\n` +
        `  ${process.cwd()}/app/tts-service\n` +
        `  ${process.cwd()}/tts-service\n` +
        `  /Volumes/EXT-SSD/Users/anhl/Local-AI/app/tts-service\n` +
        `Adjust TTS_SERVICE_DIR env var to point at the tts-service root.`
      ));
      return;
    }
    if (!fs.existsSync(DETECTOR)) {
      reject(new Error(`Detector not found at ${DETECTOR}`));
      return;
    }
    // Read the user's selected model from the Settings DB (same source
    // chapter-enhancer / chapter-formatter / epub-analyzer use), so the
    // character detection respects whatever the user picked in /settings.
    // Falls back to OMLX_MODEL env var only if the DB row is empty.
    let omlxModel: string;
    try {
      const { getSettings } = await import('@/lib/db/settings');
      const settings = await getSettings();
      omlxModel = settings.aiModel?.trim() || process.env.OMLX_MODEL || '';
    } catch {
      omlxModel = process.env.OMLX_MODEL || '';
    }
    // Pass model as a CLI arg (after the epub path) so the Python script
    // gets an explicit value — env-var-only passing was unreliable.
    const proc = spawn(py, [DETECTOR, epubPath, omlxModel], {
      env: { ...process.env, OMLX_API_KEY: omlxKey, OMLX_MODEL: omlxModel },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
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

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const book = await getBook(params.id);
  if (!book) return NextResponse.json({ error: 'Book not found' }, { status: 404 });
  if (!fs.existsSync(book.filePath)) {
    return NextResponse.json({ error: 'Book file missing on disk' }, { status: 404 });
  }

  let result: any;
  try {
    result = await runDetector(book.filePath);
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

  return NextResponse.json({
    language: result.language ?? 'vi',
    summary: result.summary ?? '',
    narrator_gender_hint: result.narrator_gender_hint ?? 'unknown',
    total_dialogue_lines: Number(result.total_dialogue_lines ?? 0),
    characters: suggestions,
    available_voices: VIENEU_VOICES,
  });
}
