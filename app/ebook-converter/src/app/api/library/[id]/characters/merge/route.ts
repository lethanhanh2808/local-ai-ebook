// src/app/api/library/[id]/characters/merge/route.ts
// POST /api/library/[id]/characters/merge
//
// Phase 4.4 of docs/NEXT_UP_PLAN.md — merges two characters into one.
// Body: { survivorId, absorbedId, aliasResolutions?: [{alias, keepOn}] }
//
// Behavior: aliases get folded (highest-confidence wins per shared alias;
// caller can override ties via aliasResolutions); chapter appearances get
// summed; CharacterRelationship edges get rewired; CharacterProfile gets
// absorbed if survivor has none; absorbed row gets deleted.
//
// All the actual logic lives in `mergeCharacters()` in
// src/lib/db/characters.ts — this route only validates input and
// translates the result to HTTP.

import { NextRequest, NextResponse } from 'next/server';
import { getBook } from '@/lib/db/books';
import { mergeCharacters } from '@/lib/db/characters';
import { setBookAudiobookStatus } from '@/lib/db/audiobook';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const book = await getBook(params.id);
  if (!book) return NextResponse.json({ error: 'Book not found' }, { status: 404 });

  const body = await req.json().catch(() => null) as {
    survivorId?: unknown;
    absorbedId?: unknown;
    aliasResolutions?: unknown;
  } | null;
  if (!body) {
    return NextResponse.json({ error: 'JSON body required' }, { status: 400 });
  }
  if (typeof body.survivorId !== 'string' || !body.survivorId) {
    return NextResponse.json({ error: 'survivorId (string) is required' }, { status: 400 });
  }
  if (typeof body.absorbedId !== 'string' || !body.absorbedId) {
    return NextResponse.json({ error: 'absorbedId (string) is required' }, { status: 400 });
  }
  let aliasResolutions: Array<{ alias: string; keepOn: 'survivor' | 'absorbed' }> | undefined;
  if (body.aliasResolutions !== undefined) {
    if (!Array.isArray(body.aliasResolutions)) {
      return NextResponse.json({ error: 'aliasResolutions must be an array' }, { status: 400 });
    }
    aliasResolutions = [];
    for (const r of body.aliasResolutions) {
      if (!r || typeof r !== 'object') {
        return NextResponse.json({ error: 'Each aliasResolution must be an object' }, { status: 400 });
      }
      const obj = r as { alias?: unknown; keepOn?: unknown };
      if (typeof obj.alias !== 'string' || !obj.alias) {
        return NextResponse.json({ error: 'aliasResolution.alias must be a non-empty string' }, { status: 400 });
      }
      if (obj.keepOn !== 'survivor' && obj.keepOn !== 'absorbed') {
        return NextResponse.json({ error: "aliasResolution.keepOn must be 'survivor' or 'absorbed'" }, { status: 400 });
      }
      aliasResolutions.push({ alias: obj.alias, keepOn: obj.keepOn });
    }
  }

  const result = await mergeCharacters(params.id, {
    survivorId: body.survivorId,
    absorbedId: body.absorbedId,
    aliasResolutions,
  });

  if (!result.ok) {
    switch (result.error.kind) {
      case 'self-merge':
        return NextResponse.json({ error: 'survivorId and absorbedId must differ' }, { status: 400 });
      case 'survivor-not-found':
      case 'absorbed-not-found':
        return NextResponse.json({ error: result.error.kind === 'survivor-not-found' ? 'Survivor character not found' : 'Absorbed character not found' }, { status: 404 });
      case 'cross-book':
        return NextResponse.json({ error: 'Both characters must belong to this book' }, { status: 404 });
      case 'profile-conflict':
        return NextResponse.json(
          {
            error: `Survivor's ${result.error.field} is user-locked and differs from absorbed. Resolve via /profile first.`,
            field: result.error.field,
          },
          { status: 409 },
        );
    }
  }

  // Invalidate audiobook cache so the merged character picks up the
  // combined voice mapping on the next generation.
  await setBookAudiobookStatus(params.id, 'none');
  return NextResponse.json(result.ok ? result.data : null);
}
