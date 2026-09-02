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
import { pickBestBuiltInVoice } from '@/lib/ai/voice-selector';
import { g2pMatch } from '@/lib/vi-text-qa';
import { resolveBookPath } from '@/lib/storage';
import { computeAliasConfidence, type FoldMethod } from '@/lib/ai/character-alias-confidence';
import {
  getActiveTTSEngine,
  getTTSEngine,
  isBuiltinVoiceForEngine,
  voicesForEngine,
} from '@/lib/tts/provider';

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
  // 1. Explicit override (typically only used on the host).
  if (process.env.TTS_PYTHON && fs.existsSync(process.env.TTS_PYTHON)) {
    return process.env.TTS_PYTHON;
  }
  // 2. Container system Python — installed by Dockerfile with httpx.
  //    /usr/bin/python3 is the same as python3 on PATH but explicit avoids
  //    PATH surprises. Added: covers the case where the routed command
  //    `spawn` doesn't carry the standard PATH.
  if (fs.existsSync('/usr/bin/python3')) return '/usr/bin/python3';
  // 3. Last-resort fallback to whatever python is on PATH.
  return process.env.TTS_PYTHON ?? 'python3';
}

/** Suggest the best built-in voice for the active TTS engine. Delegates
 *  to the centralized picker in lib/ai/voice-selector.ts which scores
 *  the engine's catalog and returns the best match. `alreadyUsed` is a
 *  hint — we still respect it to avoid two characters in the same book
 *  getting identical voices. `engine` carries the catalog + membership
 *  check so a future second engine can be slotted in here. */
function suggestVoice(
  engine: ReturnType<typeof getTTSEngine>,
  gender: string,
  tone: string,
  alreadyUsed: Set<string>,
  age?: string | null,
  name?: string,
): string {
  const catalog = engine.builtins();
  const profile = pickBestBuiltInVoice(
    { name: name ?? '_', gender, age, tone },
    catalog,
  );
  // If the top-scored voice is already in heavy use, try a runner-up with
  // the same gender so the suggestion still feels coherent. Cheap — picker
  // is pure.
  if (alreadyUsed.has(profile.name)) {
    for (const p of catalog) {
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

type DetectorOutcome = {
  result: any;
  modelUsed: string;
  modelResolution: 'empty' | 'default' | 'env-fallback' | 'validated' | 'unknown-replaced';
};

async function runDetector(epubPath: string, signal?: AbortSignal, sessionOverride?: Partial<import('@prisma/client').Settings> | null): Promise<DetectorOutcome> {
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

  // Resolve the AI provider configured in Settings so character detection uses
  // the SAME backend as every other AI feature (chat/enhance/format). The
  // Python detector reads OMLX_BASE_URL / OMLX_API_KEY / OMLX_MODEL from its
  // environment, so we forward the effective provider's endpoint here instead
  // of hardcoding the local OMLX (127.0.0.1:8080) that may not be running.
  //
  // The DATABASE is the single source of truth (Settings + UserSettings).
  // The browser `ai-settings-session` cookie is passed in as a fallback
  // gap-fill only (never shadowing a DB value) — see `mergeEffectiveSettings`
  // in `@/lib/db/settings`. Previously the detection route ignored the cookie
  // entirely, so a Custom AI key saved to the cookie (scope=session) was
  // invisible server-side and the detector hit the gateway with no auth →
  // 401 → empty body → regex-fallback. Threading the cookie in here closes
  // that gap.
  let omlxModel: string;
  let modelReason: 'empty' | 'default' | 'env-fallback' | 'validated' | 'unknown-replaced' = 'empty';
  let envOverrides: Record<string, string> = {};
  try {
    const { getEffectiveSettings } = await import('@/lib/db/settings');
    const { detectorEnvOverrides } = await import('@/lib/ai');
    const settings = await getEffectiveSettings(undefined, sessionOverride);
    envOverrides = await detectorEnvOverrides(sessionOverride);

    if (settings.aiProvider === 'omlx-local') {
      // BUGFIX 2026-07-11 + 2026-07-12: validate the settings.aiModel value
      // against the live oMLX model list before passing it down. Previously
      // the code only filtered the literal "default" — but any stale value
      // (e.g. an old Claude session id like "MiniMax-M3" that leaked into
      // the DB via the /settings form, or a model renamed/removed upstream)
      // reached oMLX and produced "Model 'X' not found", which forced the
      // Python detector into its regex-fallback branch (orphan-aiModel
      // pattern in the character-detection-source-tagging memory).
      //
      // resolveOmlxModel() fetches the live model list (5 min TTL) and
      // replaces unknown values with the empty default + flags a reason
      // we can surface in the response so the user knows their settings
      // need updating.
      const { resolveOmlxModel } = await import('@/lib/ai/omlx-models');
      const resolved = await resolveOmlxModel(settings.aiModel);
      omlxModel = resolved.model;
      modelReason = resolved.reason;
      if (resolved.reason === 'unknown-replaced') {
        console.warn(
          `[characters/detect] settings.aiModel="${resolved.requested}" is not a known oMLX model; ` +
          `falling back to OMLX default. User should fix /settings.`,
        );
      }
    } else {
      // Cloud providers: the user picked the model in /settings — trust it
      // directly. (resolveOmlxModel's /models probe is oMLX-specific and
      // would wrongly blank a valid cloud model.)
      omlxModel = settings.aiModel?.trim() || '';
      modelReason = omlxModel ? 'validated' : 'empty';
    }
  } catch (e) {
    // detectorEnvOverrides throws when a cloud provider has no base URL set —
    // surface that clearly instead of a confusing connection-refused 500.
    if (e instanceof Error && /requires a base URL/.test(e.message)) {
      throw e;
    }
    omlxModel = process.env.OMLX_MODEL || '';
    modelReason = omlxModel ? 'env-fallback' : 'empty';
  }

  return new Promise((resolve, reject) => {
    // Read the user's selected model from the Settings DB (same source
    // chapter-enhancer / chapter-formatter / epub-analyzer use), so the
    // character detection respects whatever the user picked in /settings.
    // Falls back to OMLX_MODEL env var only if the DB row is empty.
    // Pass model as a CLI arg (after the epub path) so the Python script
    // gets an explicit value — env-var-only passing was unreliable.
    // envOverrides forwards the configured provider's OMLX_BASE_URL /
    // OMLX_API_KEY so the detector hits the right backend (not the dead
    // local OMLX).
    const proc = spawn(py, [DETECTOR, epubPath, omlxModel], {
      env: { ...process.env, ...envOverrides, OMLX_MODEL: omlxModel },
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
        resolve({ result: JSON.parse(stdout), modelUsed: omlxModel, modelResolution: modelReason });
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

  // Thread the browser's `ai-settings-session` cookie through as a fallback
  // override so a Custom AI key saved to the cookie (scope=session) reaches
  // the detector. The DB is still authoritative — the cookie only fills
  // null/undefined slots (see mergeEffectiveSettings).
  const { readSessionOverrides } = await import('@/lib/db/settings');
  const sessionOverride = readSessionOverrides(req.headers.get('cookie'));

  let result: any;
  let modelUsed = '';
  let modelResolution: 'empty' | 'default' | 'env-fallback' | 'validated' | 'unknown-replaced' = 'empty';
  try {
    const outcome = await runDetector(bookPath, req.signal, sessionOverride);
    result = outcome.result;
    modelUsed = outcome.modelUsed;
    modelResolution = outcome.modelResolution;
  } catch (e) {
    console.error('[characters/detect] failed:', e);
    // A cloud provider selected in Settings but missing its base URL is a
    // user-config error, not a server fault — return 400 with a clear hint.
    if (e instanceof Error && /requires a base URL/.test(e.message)) {
      return NextResponse.json(
        { error: e.message, hint: 'Set the AI provider base URL in /settings.' },
        { status: 400 },
      );
    }
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

  // Resolve the active TTS engine once. Voice suggestions and the
  // available_voices list both follow the active backend.
  const engine = await getActiveTTSEngine();
  const isBuiltin = (n: string) => isBuiltinVoiceForEngine(engine, n);
  const availableVoices = voicesForEngine(engine);

  // Build suggestions: per detected character, suggest a voice + check for duplicates
  const characters = Array.isArray(result.characters) ? result.characters : [];
  const suggestions = characters.map((c: any) => {
    const name = String(c.name ?? '').trim();
    const suggestedVoice = suggestVoice(
      engine,
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
  let warning = source !== 'omlx'
    ? 'LLM không trả về danh sách nhân vật hợp lệ — kiểm tra aiModel trong /settings hoặc thử lại.'
    : undefined;
  // BUGFIX 2026-07-12: also surface when settings.aiModel was stale /
  // invalid and we silently fell back to the OMLX default. Without this
  // the user keeps the broken value in /settings and the warning goes
  // away (because the LLM now responds), so they never realise they
  // need to update it.
  if (!warning && modelResolution === 'unknown-replaced') {
    warning = 'Model trong /settings không hợp lệ (đã đổi tên hoặc đã xoá). Đang dùng model mặc định của oMLX — vui lòng cập nhật /settings.';
  }

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
        aliasDetails?: Array<{
          alias: string;
          confidence: number;
          source: 'llm';
          detectedInChapter: number | null;
        }>;
      }> = [];
      for (const s of suggestions) {
        if (s.already_in_db) continue;  // skip dupes
        let voiceId: string | null = null;
        if (s.suggested_voice && isBuiltin(s.suggested_voice)) {
          let v = voiceByName.get(s.suggested_voice);
          if (!v) {
            v = await createVoice({
              bookId: params.id,
              name: s.suggested_voice,
              description: `Built-in ${engine.label} voice: ${s.suggested_voice}`,
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
        // Phase 4.4 — compute per-alias confidence scores from the detector
        // signals. The Python detector doesn't expose the fold method per
        // alias, so we infer it from the alias shape: identical to the
        // primary name → 'normalized' (high), contained in primary → 'llm'
        // (low). This is a heuristic; future work could surface the actual
        // fold method via the detector.
        const primaryName = s.name.trim();
        const rawAliases: string[] = (s.aliases ?? []).slice(0, 30);
        const aliasDetails = rawAliases.map((alias: string) => {
          const trimmed = alias.trim();
          const foldMethod: FoldMethod = trimmed.toLowerCase() === primaryName.toLowerCase()
            ? 'normalized'
            : 'llm';
          const confidence = computeAliasConfidence(primaryName, trimmed, {
            aliasCount: rawAliases.length,
            foldMethod,
            sampleLinesCount: Array.isArray(s.sample_lines) ? s.sample_lines.length : 0,
          });
          return {
            alias: trimmed,
            confidence,
            source: 'llm' as const,
            detectedInChapter: null,
          };
        });
        toUpsert.push({
          name: s.name.slice(0, 120),
          aliases: rawAliases,
          voiceId,
          role: s.role ?? 'supporting',
          age: s.age ?? null,
          gender: s.gender ?? null,
          tone: s.tone ?? null,
          aliasDetails,
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
    available_voices: availableVoices,
    source,
    // BUGFIX 2026-07-12: echo which model we actually used + the resolution
    // reason, so the /settings UI can flag stale model values without the
    // user having to dig through server logs.
    model_used: modelUsed || '(omlx default)',
    model_resolution: modelResolution,
    warning,
    ...(autoApply ? { inserted } : {}),
  });
}
