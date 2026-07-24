// src/app/api/library/[id]/characters/[characterId]/aliases/[aliasId]/route.ts
// PATCH /api/library/[id]/characters/[characterId]/aliases/[aliasId]
//
// Phase 4.4 of docs/NEXT_UP_PLAN.md — per-alias edit endpoint. Used by
// the Aliases tab in CharacterMergeSplitPanel to:
//   - mark a low-confidence alias as wrong (confidence=0, source='user')
//   - rename an alias
//   - re-tag the source of an alias (e.g. flip 'llm' → 'user' once the
//     user confirms the alias is correct).
//
// Body: { alias?: string, confidence?: number (0..1), source?: 'user'|'llm'|'merge'|'legacy' }

import { NextRequest, NextResponse } from 'next/server';
import { getBook } from '@/lib/db/books';
import { patchCharacterAlias } from '@/lib/db/characters';
import { setBookAudiobookStatus } from '@/lib/db/audiobook';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_SOURCES = new Set(['user', 'llm', 'merge', 'legacy']);

export async function PATCH(
  req: NextRequest,
  props: { params: Promise<{ id: string; characterId: string; aliasId: string }> },
) {
  const params = await props.params;
  const book = await getBook(params.id);
  if (!book) return NextResponse.json({ error: 'Book not found' }, { status: 404 });

  const body = await req.json().catch(() => null) as {
    alias?: unknown;
    confidence?: unknown;
    source?: unknown;
  } | null;
  if (!body) return NextResponse.json({ error: 'JSON body required' }, { status: 400 });

  const patch: {
    aliasId: string;
    alias?: string;
    confidence?: number;
    source?: 'user' | 'llm' | 'merge' | 'legacy';
  } = { aliasId: params.aliasId };

  if (body.alias !== undefined) {
    if (typeof body.alias !== 'string' || !body.alias.trim()) {
      return NextResponse.json({ error: 'alias must be a non-empty string' }, { status: 400 });
    }
    patch.alias = body.alias.trim();
  }
  if (body.confidence !== undefined) {
    if (typeof body.confidence !== 'number' || !Number.isFinite(body.confidence)) {
      return NextResponse.json({ error: 'confidence must be a number' }, { status: 400 });
    }
    if (body.confidence < 0 || body.confidence > 1) {
      return NextResponse.json({ error: 'confidence must be between 0 and 1' }, { status: 400 });
    }
    patch.confidence = body.confidence;
  }
  if (body.source !== undefined) {
    if (typeof body.source !== 'string' || !VALID_SOURCES.has(body.source)) {
      return NextResponse.json({ error: "source must be one of 'user' | 'llm' | 'merge' | 'legacy'" }, { status: 400 });
    }
    patch.source = body.source as 'user' | 'llm' | 'merge' | 'legacy';
  }
  if (patch.alias === undefined && patch.confidence === undefined && patch.source === undefined) {
    return NextResponse.json({ error: 'At least one of alias, confidence, or source is required' }, { status: 400 });
  }

  const result = await patchCharacterAlias(params.characterId, params.id, patch);
  if (!result.ok) {
    switch (result.error.kind) {
      case 'survivor-not-found':
        return NextResponse.json({ error: 'Alias not found' }, { status: 404 });
      case 'cross-book':
        return NextResponse.json({ error: 'Alias does not belong to this character/book' }, { status: 404 });
    }
  }

  await setBookAudiobookStatus(params.id, 'none');
  if (!result.ok) {
    return NextResponse.json({ error: 'Unknown error' }, { status: 500 });
  }
  return NextResponse.json(result.data);
}
