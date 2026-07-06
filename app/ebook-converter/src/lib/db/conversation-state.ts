// src/lib/db/conversation-state.ts
//
// Per-book cross-chapter ConversationState persistence (D1).
//
// Why this exists:
//   attributeByConversation() starts every chapter with a fresh
//   ConversationState — so if ch.4 ends with Ưu Nhi speaking and ch.5
//   opens with a bare "Cô ấy……", the pronoun-cue layer cannot use the
//   last speaker from ch.4 as context. This table persists the final
//   state of the most recently attributed chapter so the next chapter
//   can seed its loop with it.
//
// Cache invalidation:
//   We persist the lastChapterIndex alongside the payload so callers
//   can detect "I am being asked to attribute a chapter that's BEHIND
//   the persisted one" (e.g. user re-reads ch.3 after ch.5 was
//   attributed). In that case we treat the seed as stale and skip it
//   rather than letting ch.5's state bleed backward into ch.3.
//
//   We also persist parserVersion so a rule change invalidates the
//   snapshot — the seed is purely structural data, but stale rules
//   can make it misleading.

import { prisma } from './client';
import type { ConversationStateSnapshot } from './chapter-attribution';

export interface ConversationStateSeed {
  state: ConversationStateSnapshot;
  lastChapterIndex: number;
  parserVersion: string;
}

export type LoadResult =
  | {
      found: false;
      reason:
        | 'no-row'
        | 'stale-chapter'
        | 'version-mismatch'
        | 'corrupt-payload'
        | 'empty-payload';
    }
  | {
      found: true;
      seed: ConversationStateSeed;
    };

/** Load the cross-chapter ConversationState seed for a given book.
 *
 *  Returns a `found: false` result with a discriminating `reason` when:
 *    • `no-row`             — no BookConversationState row exists for this book.
 *    • `version-mismatch`   — the row's `parserVersion` differs from the
 *                             caller's expected version (rule change since
 *                             the row was persisted — old seed is unsafe).
 *    • `stale-chapter`      — the row's `lastChapterIndex` is AHEAD of the
 *                             chapter we're about to attribute. Without
 *                             this guard we'd leak future-chapter state
 *                             backward (e.g. user re-reads ch.3 after
 *                             ch.5 was attributed).
 *    • `corrupt-payload`    — the row exists but JSON.parse failed.
 *    • `empty-payload`      — the row exists, parses, but yields an
 *                             object with no signal (e.g. empty
 *                             dialogueHistory, no currentSpeaker). A
 *                             usable-but-empty seed is the same as no
 *                             seed for the caller's purposes.
 *
 *  Returns `found: true` with a `seed` only when the snapshot has real
 *  signal AND the chapter index is consistent. */
export async function loadConversationState(
  bookId: string,
  currentChapterIndex: number,
  parserVersion: string,
): Promise<LoadResult> {
  const row = await prisma.bookConversationState.findUnique({ where: { bookId } });
  if (!row) return { found: false, reason: 'no-row' };
  if (row.parserVersion !== parserVersion) {
    return { found: false, reason: 'version-mismatch' };
  }
  if (row.lastChapterIndex > currentChapterIndex) {
    // Stored state is from a chapter we haven't reached yet — would
    // leak future-chapter context backward. Treat as stale.
    console.debug('[conversation-state] stale seed –', { bookId, lastChapterIndex: row.lastChapterIndex, currentChapterIndex });
    return { found: false, reason: 'stale-chapter' };
  }
  let snapshot: ConversationStateSnapshot;
  try {
    snapshot = JSON.parse(row.payload) as ConversationStateSnapshot;
  } catch (e) {
    // Surface the parse error in the server log so it's discoverable.
    // Without this branch we'd silently downgrade a corrupt row to
    // `no-row`, masking a data-integrity issue.
    console.error('[conversation-state] JSON.parse failed for', bookId, e);
    return { found: false, reason: 'corrupt-payload' };
  }
  // Ensure the parsed payload is an object-shaped snapshot. JSON.parse on
  // an empty string would have thrown; a non-object payload (string,
  // number, or array) is unexpected and likely indicates corrupted data.
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) {
    console.error('[conversation-state] unexpected payload type for', bookId, typeof snapshot);
    return { found: false, reason: 'corrupt-payload' };
  }

  // Detect a structurally-empty snapshot: an object with no signal.
  if (
    (snapshot.dialogueHistory?.length ?? 0) === 0
    && !snapshot.currentSpeaker
    && !snapshot.previousSpeaker
    && (snapshot.lastMentionedCharacters?.length ?? 0) === 0
    && (snapshot.activeCharacters?.length ?? 0) === 0
  ) {
    return { found: false, reason: 'empty-payload' };
  }
  return {
    found: true,
    seed: {
      state: snapshot,
      lastChapterIndex: row.lastChapterIndex,
      parserVersion: row.parserVersion,
    },
  };
}

/** Persist the final ConversationState of the most recently attributed
 *  chapter for this book. Overwrites any prior row.
 *
 *  Note: this is called AFTER ChapterAttribution is cached, so the
 *  persisted snapshot always matches the cached attribution's
 *  per-paragraph state field. */
export async function saveConversationState(
  bookId: string,
  chapterIndex: number,
  state: ConversationStateSnapshot,
  parserVersion: string,
): Promise<void> {
  await prisma.bookConversationState.upsert({
    where: { bookId },
    create: {
      bookId,
      lastChapterIndex: chapterIndex,
      payload: JSON.stringify(state),
      parserVersion,
    },
    update: {
      lastChapterIndex: chapterIndex,
      payload: JSON.stringify(state),
      parserVersion,
    },
  });
}

/** Wipe the seed for a book — used by tests and by the migration
 *  script when an attribution version is bumped. */
export async function clearConversationState(bookId: string): Promise<void> {
  await prisma.bookConversationState.deleteMany({ where: { bookId } });
}
