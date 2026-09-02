// src/app/api/library/[id]/characters/bible/route.ts
// GET    /api/library/:id/characters/bible   – assemble bible view for UI
//
// Returns: CharacterBibleView = { bookId, profiles, relationships, appearances, pendingDiffs }
// plus a few convenience fields the UI needs to render the character list:
//   - characters: { id, name, gender, role }[]  sorted by role then name
//   - pendingCount: number (banner trigger)
import { NextRequest, NextResponse } from 'next/server';
import { getBook } from '@/lib/db/books';
import { getCharacterBible } from '@/lib/db/character-bible';
import { prisma } from '@/lib/db/client';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const book = await getBook(params.id);
  if (!book) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const [bible, characters] = await Promise.all([
    getCharacterBible(params.id),
    prisma.character.findMany({
      where: { bookId: params.id },
      select: { id: true, name: true, gender: true, role: true, voiceId: true, tone: true, aliases: true },
      orderBy: [{ role: 'asc' }, { name: 'asc' }],
    }),
  ]);
  return NextResponse.json({
    bookId: params.id,
    characters,
    profiles: bible.profiles,
    relationships: bible.relationships,
    appearances: bible.appearances,
    pendingDiffs: bible.pendingDiffs,
    pendingCount: bible.pendingDiffs.length,
    lastUpdatedAt: Object.values(bible.profiles)
      .map((p) => p.updatedAt)
      .sort((a, b) => b.getTime() - a.getTime())[0] ?? null,
  });
}
