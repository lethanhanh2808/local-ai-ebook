// src/app/api/library/[id]/voices/route.ts
// GET   /api/library/[id]/voices        – list voices for a book
// POST  /api/library/[id]/voices        – upload a new voice (multipart)
import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { v4 as uuid } from 'uuid';
import { getBook } from '@/lib/db/books';
import { listVoices, createVoice, deleteVoice, getDefaultVoice, getVoice } from '@/lib/db/voices';
import { setBookAudiobookStatus } from '@/lib/db/audiobook';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VOICES_DIR = path.resolve(process.cwd(), 'data/voices');
const ACCEPTED_AUDIO_EXT = new Set(['wav', 'mp3', 'm4a', 'ogg', 'flac']);
const MAX_REF_SIZE = 30 * 1024 * 1024; // 30 MB

function ensureVoicesDir() {
  fs.mkdirSync(VOICES_DIR, { recursive: true });
}

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const book = await getBook(params.id);
  if (!book) return NextResponse.json({ error: 'Book not found' }, { status: 404 });
  const voices = await listVoices(params.id);
  const defaultVoice = await getDefaultVoice(params.id);
  return NextResponse.json({ voices, defaultVoiceId: defaultVoice?.id ?? null });
}

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const book = await getBook(params.id);
  if (!book) return NextResponse.json({ error: 'Book not found' }, { status: 404 });

  ensureVoicesDir();

  try {
    const formData = await req.formData();
    const file = formData.get('file') as File | null;
    const name = (formData.get('name') as string | null)?.trim();
    const description = (formData.get('description') as string | null)?.trim() || undefined;
    const language = (formData.get('language') as string | null)?.trim() || 'vi';
    const isDefault = formData.get('isDefault') === 'true';
    const defaultSpeed = parseFloat((formData.get('defaultSpeed') as string | null) ?? '1');
    const defaultEmotion = (formData.get('defaultEmotion') as string | null)?.trim() || undefined;

    if (!file) return NextResponse.json({ error: 'file required' }, { status: 400 });
    if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 });
    if (file.size > MAX_REF_SIZE) return NextResponse.json({ error: 'file too large' }, { status: 413 });

    const ext = (file.name.split('.').pop() ?? 'wav').toLowerCase();
    if (!ACCEPTED_AUDIO_EXT.has(ext)) {
      return NextResponse.json({ error: `unsupported audio type: .${ext}` }, { status: 415 });
    }

    const bookVoicesDir = path.join(VOICES_DIR, params.id);
    fs.mkdirSync(bookVoicesDir, { recursive: true });
    const voiceId = uuid();
    const refPath = path.join(bookVoicesDir, `${voiceId}.${ext}`);
    const buf = Buffer.from(await file.arrayBuffer());
    fs.writeFileSync(refPath, buf);

    let voice;
    try {
      voice = await createVoice({
        bookId: params.id,
        name: name.slice(0, 120),
        description: description?.slice(0, 500),
        refAudioPath: refPath,
        language: language.slice(0, 16),
        isDefault,
        defaultSpeed: Number.isFinite(defaultSpeed)
          ? Math.min(2, Math.max(0.5, defaultSpeed))
          : undefined,
        defaultEmotion: defaultEmotion?.slice(0, 40),
      });
    } catch (error) {
      // The file is written before the DB transaction; roll it back if the
      // row cannot be created so failed uploads do not leak storage.
      try { fs.unlinkSync(refPath); } catch {}
      throw error;
    }

    // Mark audiobook as stale so it gets regenerated with the new voice.
    await setBookAudiobookStatus(params.id, 'none');

    return NextResponse.json({ voice }, { status: 201 });
  } catch (err) {
    console.error('[voices POST]', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const voiceId = req.nextUrl.searchParams.get('voiceId');
  if (!voiceId) return NextResponse.json({ error: 'voiceId required' }, { status: 400 });

  const existing = await getVoice(voiceId);
  if (!existing || existing.bookId !== params.id) {
    return NextResponse.json({ error: 'Voice not found' }, { status: 404 });
  }
  const voice = await deleteVoice(voiceId);
  // Best-effort: remove ref audio
  try { if (voice && fs.existsSync((voice as { refAudioPath: string }).refAudioPath)) fs.unlinkSync((voice as { refAudioPath: string }).refAudioPath); } catch {}
  await setBookAudiobookStatus(params.id, 'none');
  return NextResponse.json({ ok: true });
}
