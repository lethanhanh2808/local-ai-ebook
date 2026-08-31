// src/app/api/library/[id]/chapters/[chapterId]/voice-plan/route.ts
//
// GET  → return the per-sentence voice plan for a chapter. If none is stored
//        (or the stored plan is stale vs. the chapter HTML mtime), derive a
//        fresh suggestion from the attribution engine and persist it.
// PUT  → save the user-edited plan (auto-save from the Voice Assign Editor).
//
// Plan shape (JSON stored in ChapterVoicePlan.sentences):
//   [{ i, text, charId, voiceId, source }]
//
// Sentences with voiceId === null fall back to the narration (default) voice at
// playback / generation time.
import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getBook } from '@/lib/db/books';
import { listCharacters } from '@/lib/db/voices';
import { prisma } from '@/lib/db/client';
import {
  buildSuggestedVoicePlan,
  deserializePlan,
  serializePlan,
  type VoicePlanSentence,
} from '@/lib/voice-plan';
import { resolveBookPath } from '@/lib/storage';
import { parseEpub } from '@/lib/pipeline/epub-parser';
import { loadChapterRef, type ChapterRef } from '@/lib/voice-plan-loader';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(
  req: NextRequest,
  props: { params: Promise<{ id: string; chapterId: string }> },
) {
  const params = await props.params;
  const ref = await loadChapterRef(req, params.id, params.chapterId);
  if ('error' in ref) return NextResponse.json({ error: ref.error }, { status: ref.status });

  // Load existing plan (if any).
  const existing = await prisma.chapterVoicePlan.findUnique({
    where: { bookId_chapterIndex: { bookId: params.id, chapterIndex: ref.chapterIndex } },
  });

  if (existing && Number(existing.sourceMtime) === ref.mtime) {
    const plan = deserializePlan(params.id, ref.chapterIndex, existing.sentences, ref.mtime);
    return NextResponse.json({ source: 'stored', sentences: plan.sentences });
  }

  // Derive a fresh suggestion.
  const chars = await listCharacters(params.id);
  const knownNames = chars.flatMap((c) => [c.name, ...(c.aliases ?? [])]);
  const nameToCharId: Record<string, string> = {};
  for (const c of chars) {
    nameToCharId[c.name.toLowerCase()] = c.id;
    for (const a of c.aliases ?? []) nameToCharId[a.toLowerCase()] = c.id;
  }
  const characterContext = chars.map((c) => ({
    name: c.name,
    aliases: c.aliases ?? [],
    gender: c.gender ?? null,
  }));

  const plan = buildSuggestedVoicePlan({
    bookId: params.id,
    html: ref.html,
    chapterIndex: ref.chapterIndex,
    knownNames,
    nameToCharId,
    characters: characterContext,
    sourceMtime: ref.mtime,
  });

  // Persist the suggestion so subsequent GETs are O(1) and the editor opens
  // with the same baseline until the chapter HTML changes.
  await prisma.chapterVoicePlan.upsert({
    where: { bookId_chapterIndex: { bookId: params.id, chapterIndex: ref.chapterIndex } },
    create: {
      bookId: params.id,
      chapterIndex: ref.chapterIndex,
      sentences: serializePlan(plan),
      sourceMtime: ref.mtime,
    },
    update: {
      sentences: serializePlan(plan),
      sourceMtime: ref.mtime,
    },
  });

  return NextResponse.json({ source: 'suggested', sentences: plan.sentences });
}

export async function PUT(
  req: NextRequest,
  props: { params: Promise<{ id: string; chapterId: string }> },
) {
  const params = await props.params;
  const ref = await loadChapterRef(req, params.id, params.chapterId);
  if ('error' in ref) return NextResponse.json({ error: ref.error }, { status: ref.status });

  let body: { sentences?: VoicePlanSentence[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!Array.isArray(body.sentences)) {
    return NextResponse.json({ error: '`sentences` array required' }, { status: 400 });
  }

  // Validate + normalise each sentence row.
  const sentences: VoicePlanSentence[] = body.sentences.map((s, idx) => ({
    i: typeof s.i === 'number' ? s.i : idx,
    text: typeof s.text === 'string' ? s.text : '',
    charId: s.charId ?? null,
    voiceId: s.voiceId ?? null,
    source: s.source === 'manual' || s.source === 'character' || s.source === 'narration'
      ? s.source
      : 'manual',
    para: typeof s.para === 'number' ? s.para : 0,
  }));

  await prisma.chapterVoicePlan.upsert({
    where: { bookId_chapterIndex: { bookId: params.id, chapterIndex: ref.chapterIndex } },
    create: {
      bookId: params.id,
      chapterIndex: ref.chapterIndex,
      sentences: serializePlan({
        bookId: params.id,
        chapterIndex: ref.chapterIndex,
        sentences,
        sourceMtime: ref.mtime,
      }),
      sourceMtime: ref.mtime,
    },
    update: {
      sentences: serializePlan({
        bookId: params.id,
        chapterIndex: ref.chapterIndex,
        sentences,
        sourceMtime: ref.mtime,
      }),
      sourceMtime: ref.mtime,
    },
  });

  return NextResponse.json({ ok: true, count: sentences.length });
}
