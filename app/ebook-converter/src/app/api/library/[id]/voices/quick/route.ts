// src/app/api/library/[id]/voices/quick/route.ts
// POST /api/library/[id]/voices/quick — create a built-in (no-upload) voice
// for quick archetype assignment: crowd, old man/woman, child, generic…
// Picks a matching VieNeu profile from gender + age + tone and stores it as a
// built-in voice (refAudioPath = ''), so no reference audio is required.
import { NextRequest, NextResponse } from 'next/server';
import { getBook } from '@/lib/db/books';
import { createVoice } from '@/lib/db/voices';
import { setBookAudiobookStatus } from '@/lib/db/audiobook';
import { VIENEU_PROFILES, type VoiceProfile } from '@/lib/tts/vieneu-voices';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Gender = 'male' | 'female';
type Age = 'young' | 'mature' | 'old';
type Tone = 'calm' | 'cheerful' | 'cold' | 'mysterious' | 'serious';

const GENDERS: Gender[] = ['male', 'female'];
const AGES: Age[] = ['young', 'mature', 'old'];
const TONES: Tone[] = ['calm', 'cheerful', 'cold', 'mysterious', 'serious'];

// Best-effort profile picker: narrow by gender → age → tone, falling back to
// the widest match so we always return a valid built-in voice.
function pickProfile(gender?: Gender, age?: Age, tone?: Tone): VoiceProfile {
  const pool = VIENEU_PROFILES as readonly VoiceProfile[];
  const byGender = pool.filter((p) => !gender || p.gender === gender);
  const byAge = byGender.filter((p) => !age || p.age === age);
  const byTone = byAge.filter((p) => !tone || p.tone === tone);
  return byTone[0] ?? byAge[0] ?? byGender[0] ?? pool[0];
}

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const book = await getBook(params.id);
  if (!book) return NextResponse.json({ error: 'Book not found' }, { status: 404 });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const name = (body.name as string | null)?.toString().trim();
  if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 });

  const gender = GENDERS.includes(body.gender as Gender) ? (body.gender as Gender) : undefined;
  const age = AGES.includes(body.age as Age) ? (body.age as Age) : undefined;
  const tone = TONES.includes(body.tone as Tone) ? (body.tone as Tone) : undefined;

  const profile = pickProfile(gender, age, tone);

  const kind = body.kind === 'common' ? 'common' : 'character';
  const description =
    (body.description as string | null)?.toString().trim() ||
    `${profile.description} — ${age ?? profile.age} / ${tone ?? profile.tone}`;

  const voice = await createVoice({
    bookId: params.id,
    name: name.slice(0, 120),
    description: description.slice(0, 500),
    refAudioPath: '', // empty = built-in, no upload needed
    language: 'vi',
    isDefault: false,
    kind,
    builtinName: profile.name,
  });

  await setBookAudiobookStatus(params.id, 'none');

  return NextResponse.json({ voice }, { status: 201 });
}