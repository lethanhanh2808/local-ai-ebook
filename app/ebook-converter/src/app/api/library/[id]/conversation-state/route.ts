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

// ── DELETE ─────────────────────────────────────────────────────────────────
// Wipe the persisted snapshot. Used by E2E test fixtures that need a
// clean slate (`beforeEach` in 06-cross-chapter-state.spec.ts). Not
// destructive on missing rows — returns 200 either way. The `force=true`
// query param exists so callers can opt into "even if the row looks
// fresh, drop it" without ambiguity in the spec.
export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const bookId = params.id;
  const book = await prisma.book.findUnique({ where: { id: bookId } });
  if (!book) {
    return NextResponse.json({ error: 'Book not found' }, { status: 404 });
  }
  // Use a synthetic "currentChapterIndex=-1" so the loader resolves the
  // row as fresh. Then delete the row directly.
  const row = await loadConversationState(
    bookId,
    -1,
    ATTRIBUTION_VERSION,
  );
  if (row.found) {
    // loadConversationState returns the row only when it's fresh for the
    // requested chapter. For a force-delete we ignore freshness and
    // drop the row unconditionally if it exists at all.
    await prisma.bookConversationState
      .delete({ where: { bookId } })
      .catch(() => {
        // Concurrent delete (e.g. parallel test fixture) — no-op.
      });
  }
  return NextResponse.json({ ok: true, cleared: row.found });
}
