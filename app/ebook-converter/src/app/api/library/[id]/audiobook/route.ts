// src/app/api/library/[id]/audiobook/route.ts
// GET  /api/library/[id]/audiobook               – summary of pre-generated audiobook
// POST /api/library/[id]/audiobook               – { action: 'generate'|'stop'|'reset'|'regenerate_one', chapterFile? }
import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import { getAudiobookQueue } from '@/lib/queue';
import { getBook } from '@/lib/db/books';
import { listVoices, getDefaultVoice } from '@/lib/db/voices';
import {
  listChapters, getAudiobookSummary, resetAudiobook, setBookAudiobookStatus,
} from '@/lib/db/audiobook';
import { assertWithinRoots, pathRoots, SafePathError } from '@/lib/storage/safe-path';
import { clientIp, consume, rateLimitResponse } from '@/lib/utils/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const book = await getBook(params.id);
  if (!book) return NextResponse.json({ error: 'Book not found' }, { status: 404 });
  const summary = await getAudiobookSummary(params.id);
  const chapters = await listChapters(params.id);
  const voices = await listVoices(params.id);
  const defaultVoice = await getDefaultVoice(params.id);
  return NextResponse.json({
    book: {
      id: book.id,
      title: book.title,
      language: book.language,
      ttsBackend: (book as { ttsBackend?: string }).ttsBackend ?? 'vieneu',
      audiobookStatus: (book as { audiobookStatus?: string }).audiobookStatus ?? 'none',
      audiobookGeneratedAt: (book as { audiobookGeneratedAt?: Date | null }).audiobookGeneratedAt ?? null,
      audiobookDurationMs: (book as { audiobookDurationMs?: number }).audiobookDurationMs ?? 0,
    },
    summary,
    chapters,
    voices: voices.map((v) => ({ id: v.id, name: v.name, language: v.language, isDefault: v.isDefault })),
    defaultVoiceId: defaultVoice?.id ?? null,
  });
}

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const rate = consume(`audiobook:${clientIp(req)}`, { capacity: 20, windowMs: 60_000 });
  if (!rate.allowed) return rateLimitResponse(rate);

  const book = await getBook(params.id);
  if (!book) return NextResponse.json({ error: 'Book not found' }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as {
    action?: 'generate' | 'stop' | 'reset' | 'regenerate_one';
    chapterFile?: string;
    backend?: 'piper' | 'moss-nano' | 'vieneu';
  };

  const action = body.action ?? 'generate';
  if (!new Set(['generate', 'stop', 'reset', 'regenerate_one']).has(action)) {
    return NextResponse.json({ error: 'Unknown audiobook action' }, { status: 400 });
  }

  if (action === 'reset') {
    // Delete existing audio files and chapter rows
    const existing = await resetAudiobook(params.id);
    for (const p of existing) {
      try {
        const safePath = assertWithinRoots(p, [pathRoots().audiobooks]);
        if (fs.existsSync(safePath)) fs.unlinkSync(safePath);
      } catch (error) {
        if (!(error instanceof SafePathError)) throw error;
      }
    }
    return NextResponse.json({ ok: true, reset: existing.length });
  }

  if (action === 'stop') {
    // Stop any in-progress generation:
    // 1. Set status to 'stopped' — worker checks this between chapters
    // 2. Remove all waiting/active jobs from BullMQ queue
    // Note: an in-flight chapter synthesis call cannot be cancelled
    // (the HTTP request to the TTS server is already mid-flight).
    // The current chapter will finish, then no new chapters start.
    await setBookAudiobookStatus(params.id, 'none');
    try {
      const queue = getAudiobookQueue();
      // Remove all waiting jobs for this book
      const waiting = await queue.getWaiting();
      const delayed = await queue.getDelayed();
      const toRemove = [...waiting, ...delayed].filter((j) => j.data?.bookId === params.id);
      for (const j of toRemove) {
        await j.remove().catch(() => {});
      }
      // Active BullMQ jobs own a private lock token and cannot safely be
      // moved from this API process. The worker observes the persisted
      // status after the in-flight synthesis exits, then stops before the
      // next chapter. Report those jobs as pending cancellation.
      const active = await queue.getActive();
      const activeForBook = active.filter((j) => j.data?.bookId === params.id).length;
      return NextResponse.json({
        ok: true,
        stopped: true,
        removed: toRemove.length,
        activeCancellationPending: activeForBook,
      });
    } catch (e) {
      console.error('[audiobook/stop]', e);
      return NextResponse.json({ ok: true, stopped: true, error: String(e) });
    }
  }

  // Default to VieNeu — it's Vietnamese-native (10 built-in voices, 48 kHz, voice cloning).
  // Override by sending `backend` in the request body or by setting book.ttsBackend.
  // Belt-and-suspenders: coerce any stale/unknown backend string to 'vieneu' so a
  // legacy Book row or future caller can't 400 the unified server.
  const ALLOWED_BACKENDS = new Set(['vieneu', 'piper', 'moss-nano']);
  const rawBackend = (body.backend ?? (book as { ttsBackend?: string }).ttsBackend ?? 'vieneu') as string;
  const backendChoice = (ALLOWED_BACKENDS.has(rawBackend) ? rawBackend : 'vieneu') as 'piper' | 'moss-nano' | 'vieneu';
  if (rawBackend !== backendChoice) {
    console.warn(`[audiobook] unknown backend "${rawBackend}" coerced to "vieneu" (book=${params.id})`);
  }

  if (action === 'regenerate_one') {
    if (!body.chapterFile) return NextResponse.json({ error: 'chapterFile required' }, { status: 400 });
    if (body.chapterFile.length > 1_000 || body.chapterFile.includes('\0')) {
      return NextResponse.json({ error: 'chapterFile is invalid' }, { status: 400 });
    }
    const queue = getAudiobookQueue();
    await queue.add(
      'chapter',
      { bookId: params.id, chapterFile: body.chapterFile, backend: backendChoice, force: true },
      { jobId: `audiobook:${params.id}:${encodeURIComponent(body.chapterFile)}:${Date.now()}` },
    );
    return NextResponse.json({ ok: true, queued: [body.chapterFile] });
  }

  // action === 'generate' → queue the entire book
  const queue = getAudiobookQueue();

  // Mark book as generating and pre-create AudiobookChapter rows for every chapter
  await setBookAudiobookStatus(params.id, 'generating');

  // Queue a single 'book' job that orchestrates per-chapter generation
  const job = await queue.add(
    'book',
    { bookId: params.id, backend: backendChoice },
    { jobId: `audiobook_book:${params.id}:${Date.now()}` },
  );

  return NextResponse.json({ ok: true, jobId: job.id });
}
