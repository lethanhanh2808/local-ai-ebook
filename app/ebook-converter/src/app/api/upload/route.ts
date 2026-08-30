// src/app/api/upload/route.ts
// POST /api/upload – accept file, create DB record, enqueue job
import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuid } from 'uuid';
import fs from 'fs';
import path from 'path';
import { createJob } from '@/lib/db/jobs';
import { getQueue } from '@/lib/queue';
import { ensureDirs, uploadPath, UPLOAD_DIR, jobLogPath } from '@/lib/storage';
import { clientIp, consume, rateLimitResponse } from '@/lib/utils/rate-limit';
import { probeCalibre } from '@/lib/tools/calibre';
import { CALIBRE_FORMATS, findCalibreFormat } from '@/lib/tools/calibre-formats';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BASE_ALLOWED_EXTENSIONS = new Set(['epub', 'html', 'htm', 'txt']);

/** Resolve which extensions are accepted for this request. When Calibre is
 *  available, the Calibre-supported extensions (currently MOBI) are added.
 *  When Calibre is missing, the Calibre-only extensions still surface in
 *  the 415 message so the user can click through to Settings → Importers
 *  to install it. Phase 4.3 of docs/NEXT_UP_PLAN.md. */
async function resolveAllowedExtensions(): Promise<{
  base: Set<string>;
  calibre: Set<string>;
  available: boolean;
}> {
  const base = new Set(BASE_ALLOWED_EXTENSIONS);
  const calibre = new Set<string>();
  // Force a fresh probe so cold-cache uploads after install don't see the
  // 60s lag.
  const probe = await probeCalibre(true);
  if (probe.ok) for (const f of CALIBRE_FORMATS) calibre.add(f.extension);
  return { base, calibre, available: probe.ok };
}
const configuredMaxMb = Number(process.env.MAX_FILE_SIZE_MB ?? 100);
const MAX_FILE_SIZE_MB = Number.isFinite(configuredMaxMb) && configuredMaxMb > 0
  ? Math.min(configuredMaxMb, 1024)
  : 100;
const MAX_BYTES = Math.floor(MAX_FILE_SIZE_MB * 1024 * 1024);

/**
 * Converts a filename with Unicode/diacritics to a safe ASCII filename.
 * "Việt Nam Ebook.epub" → "Viet Nam Ebook.epub"
 */
function toSafeFilename(name: string): string {
  // Explicit replacements not covered by NFD decomposition
  const explicit: Record<string, string> = {
    đ: 'd', Đ: 'D',
    ø: 'o', Ø: 'O',
    ł: 'l', Ł: 'L',
    ß: 'ss',
    æ: 'ae', Æ: 'AE',
    œ: 'oe', Œ: 'OE',
  };
  let s = name.replace(/[đĐøØłŁßæÆœŒ]/g, (c) => explicit[c] ?? c);
  // NFD decompose → strip all combining diacritic marks
  s = s.normalize('NFD').replace(/\p{Diacritic}/gu, '');
  // Collapse whitespace to hyphens, then strip any remaining non-safe chars
  s = s.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9.\-_]/g, '').replace(/-{2,}/g, '-');
  return s || 'upload';
}

export async function POST(req: NextRequest) {
  const limit = consume(`upload:${clientIp(req)}`, { capacity: 10, windowMs: 10 * 60_000 });
  if (!limit.allowed) return rateLimitResponse(limit);

  try {
    ensureDirs();

    const formData = await req.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    if (file.size > MAX_BYTES) {
      return NextResponse.json(
        { error: `File exceeds maximum size of ${MAX_FILE_SIZE_MB} MB` },
        { status: 413 },
      );
    }

    const originalName = toSafeFilename(path.basename(file.name));
    const ext = originalName.split('.').pop()?.toLowerCase() ?? '';
    const { base, calibre, available } = await resolveAllowedExtensions();
    if (!base.has(ext)) {
      if (!calibre.has(ext)) {
        return NextResponse.json({ error: `Unsupported file type: .${ext}` }, { status: 415 });
      }
      // Format is in CALIBRE_FORMATS — needs the preprocessor.
      const fmt = findCalibreFormat(ext);
      if (!available) {
        return NextResponse.json(
          {
            error: `Calibre is required for .${ext} but is not installed. Open Settings → Importers for the install link (${fmt?.description ?? ext}).`,
          },
          { status: 415 },
        );
      }
      // Calibre available — fall through to the existing path. The
      // requiresPreprocessing flag below routes the worker through the
      // MOBI → EPUB pre-step.
    }

    const jobId = uuid();
    const savePath = uploadPath(jobId, originalName);
    // Per-job log path (consumed by Debug Console). Pre-create the empty
    // .jsonl so the Debug Console button is enabled immediately and shows
    // a "queued" entry the moment upload completes — no longer waits for
    // the worker to start the job.
    const logPath = jobLogPath(jobId);
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.writeFileSync(
        logPath,
        JSON.stringify({
          ts: Date.now(),
          level: 'info',
          stage: 'upload',
          message: `Uploaded ${originalName} (${(file.size / 1024).toFixed(1)} KB) — waiting for worker`,
        }) + '\n',
      );
    } catch (err) {
      console.warn('[api/upload] Failed to seed job log:', err);
    }

    // Stream to disk
    const buf = Buffer.from(await file.arrayBuffer());
    fs.writeFileSync(savePath, buf);

    // DB record (start as 'pending' if user wants manual control, 'queued' otherwise)
    const startImmediately = formData.get('startImmediately') !== 'false'; // default true
    await createJob({
      id: jobId,
      filename: originalName,
      originalExt: ext,
      inputPath: savePath,
      status: startImmediately ? 'queued' : 'pending',
      logPath,
    });

    // Enqueue only if startImmediately is true
    if (startImmediately) {
      const queue = getQueue();

      // Read AI flags. If the form doesn't include them, fall back to the
      // defaults from the Settings row (defaultAiEnhance, defaultAiWatermarkClean,
      // defaultDeepFormat). This ensures changes in /settings take effect
      // immediately, even for users who haven't refreshed the upload zone.
      const { getEffectiveSettings } = await import('@/lib/db/settings');
      const settings = await getEffectiveSettings();
      const formEnhance = formData.get('aiEnhance');
      const formWatermark = formData.get('aiWatermarkClean');
      const formDeep = formData.get('deepFormat');
      const formReaderFriendly = formData.get('readerFriendly');
      const aiEnhance = formEnhance !== null ? formEnhance === 'true' : settings.defaultAiEnhance;
      const aiWatermarkClean = formWatermark !== null ? formWatermark === 'true' : settings.defaultAiWatermarkClean;
      const deepFormat = formDeep !== null ? formDeep === 'true' : settings.defaultDeepFormat;
      // Reader-friendly defaults to true: most web-novel source EPUBs ship
      // with CSS that crashes Neoreader after the first 1–2 pages. We use
      // `?? true` instead of `settings.defaultReaderFriendly` so that an
      // older Settings row (where the column was added via ALTER TABLE
      // without backfilling the existing singleton) still produces the
      // intended safe default. Users who want the original heavy styling
      // can turn it off in /settings.
      const readerFriendly = formReaderFriendly !== null ? formReaderFriendly === 'true' : (settings.defaultReaderFriendly ?? true);
      const rawAiPrompt = (formData.get('aiPrompt') as string | null)?.trim() || undefined;
      const aiPrompt = rawAiPrompt?.slice(0, 8_000);

      // Persist the user's actual choices back to settings (so next upload uses
      // them as default) — but only if the form explicitly sent them.
      const { updateSettings } = await import('@/lib/db/settings');
      const persist: Record<string, unknown> = {};
      if (formEnhance !== null) persist.defaultAiEnhance = aiEnhance;
      if (formWatermark !== null) persist.defaultAiWatermarkClean = aiWatermarkClean;
      if (formDeep !== null) persist.defaultDeepFormat = deepFormat;
      if (formReaderFriendly !== null) persist.defaultReaderFriendly = readerFriendly;
      if (Object.keys(persist).length > 0) {
        await updateSettings(persist).catch(() => { /* best-effort */ });
      }

      await queue.add(
        'convert',
        {
          jobId, inputPath: savePath, originalExt: ext, filename: originalName,
          aiEnhance, aiWatermarkClean, deepFormat, readerFriendly, aiPrompt,
          // Phase 4.3 — true when the input is in CALIBRE_FORMATS (MOBI).
          // The worker pre-step runs ebook-convert → staged .epub, then
          // hands off to the regular pipeline.
          requiresPreprocessing: calibre.has(ext),
        },
        { jobId },
      );
    }

    return NextResponse.json({
      jobId,
      filename: originalName,
      status: startImmediately ? 'queued' : 'pending',
    }, { status: 201 });
  } catch (err) {
    console.error('[api/upload]', err);
    return NextResponse.json({ error: 'Upload failed' }, { status: 500 });
  }
}
