// src/app/api/library/[id]/conversation-state/route.ts
//
// GET /api/library/[id]/conversation-state
//
// Read-only debug endpoint that returns the per-book
// `BookConversationState` row + a small denormalised summary so the
// "what state does my next chapter start with?" question has an answer
// without going through the (more expensive) `/attribute` endpoint.
//
// Why this exists:
//   The attribute route reports `crossChapter.seedReason` and
//   `seedFromChapterIndex` only when an attribution call is actively
//   being made. This endpoint reports the row's current state at any
//   time — useful for the debug panel of an unstarted chapter, and for
//   CI / scripting (the backfill CLI greps it).
//
// Response shape:
//
//   200 OK, found: true
//   {
//     found: true,
//     bookId,
//     lastChapterIndex,
//     parserVersion,
//     snapshot: {
//       sceneId,
//       currentSpeaker,
//       previousSpeaker,
//       currentFocusCharacter,
//       lastActionCharacter,
//       lastMentionedCharacters,
//       activeCharacters,
//       dialogueHistoryLength,
//     },
//     asOf: ISO timestamp when the row was last persisted
//   }
//
//   200 OK, found: false
//   { found: false, bookId }
//
//   404 Not Found
//   when the book id doesn't exist in the library.
//
// Stale-chapter handling: this endpoint never returns the row behind a
// "stale-chapter" guard — it's not asking "what seed should I use for
// chapter N", it's reporting "what's in the DB right now". The caller
// (debug panel, CLI, monitor) can decide what to do with it.
//
// No POST/PUT/DELETE on this route — writes happen through the
// attribution pipeline via `saveConversationState` after a fresh compute.
// A CLI backfill bypasses this by writing directly via Prisma
// (`scripts/backfill-conversation-state.ts`).

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
import {
  loadConversationState,
} from '@/lib/db/conversation-state';
import { ATTRIBUTION_VERSION } from '@/lib/attribution';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const bookId = params.id;
  // First make sure the book exists — returning 404 here is more useful
  // than letting loadConversationState silently report `no-row` for a
  // typo'd UUID.
  const book = await prisma.book.findUnique({ where: { id: bookId } });
  if (!book) {
    return NextResponse.json({ error: 'Book not found' }, { status: 404 });
  }

  // We pass a huge currentChapterIndex so that the loader never returns
  // `stale-chapter` for this read endpoint — see conversation-state.ts:
  // loadConversationState fires `stale-chapter` when the stored
  // `lastChapterIndex` is AHEAD of the requested chapter. By asking
  // about chapter +∞ we guarantee we always see the row.
  const FAR_FUTURE_INDEX = Number.MAX_SAFE_INTEGER;
  const row = await loadConversationState(
    bookId,
    FAR_FUTURE_INDEX,
    ATTRIBUTION_VERSION,
  );

  if (!row.found) {
    return NextResponse.json(
      { found: false, bookId, reason: row.reason },
      { status: 200 },
    );
  }

  const snap = row.seed.state;
  return NextResponse.json({
    found: true,
    bookId,
    lastChapterIndex: row.seed.lastChapterIndex,
    parserVersion: row.seed.parserVersion,
    snapshot: {
      sceneId: snap.sceneId,
      currentSpeaker: snap.currentSpeaker,
      previousSpeaker: snap.previousSpeaker,
      currentFocusCharacter: snap.currentFocusCharacter,
      lastActionCharacter: snap.lastActionCharacter,
      lastMentionedCharacters: snap.lastMentionedCharacters,
      activeCharacters: snap.activeCharacters,
      dialogueHistoryLength: snap.dialogueHistory.length,
      lastDialogueTurns: snap.dialogueHistory.slice(-5),
    },
  });
}
