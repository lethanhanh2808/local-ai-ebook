#!/usr/bin/env python3
"""conversation_state_client.py

Thin HTTP client for the Next.js `BookConversationState` endpoints.
Backs the Python-side `ATTRIBUTION_ENGINE=conversation_v3` path so the
port can read/write cross-chapter seed through the production route
instead of needing a Prisma Python shim.

Routes:
- GET  /api/library/{bookId}/conversation-state
  → returns `{ found, snapshot }` for the current persisted state.
  Read-only; the DB write side is intentionally NOT exposed here.
  Use the /attribute route below for the read+compute+persist cycle.

- GET  /api/library/{bookId}/chapters/{chapterId}/attribute
  → returns `{ attribution, stats, crossChapter, snapshot }`.  This is
  the production endpoint the JS app uses; it loads seed internally,
  runs the full attribution pipeline, and persists the new snapshot
  back when not fromCache.  Using this from Python gives us exact
  parity with the production behaviour.

The Python client intentionally does NOT mimic the JS-side
`saveConversationState` write path.  Phase C of D3 mandates "HTTP
roundtrip to Next.js route for DB access" — i.e. writes must go
through the route, not through a Python-side prisma shim.
"""

from __future__ import annotations

import os
from typing import Optional

import httpx


# ── Configuration ────────────────────────────────────────────────────────

DEFAULT_BASE_URL = "http://localhost:3000"
ATTRIBUTION_VERSION_HEADER = "x-attribution-version"
# Bumped 2026-07-12 after retiring the VnCoreNLP sidecar; matches
# ATTRIBUTION_VERSION in conversation_attribution.py.
ATTRIBUTION_VERSION = "conversation-v3"


def _base_url() -> str:
    return os.environ.get("EBOOK_CONVERTER_URL") or DEFAULT_BASE_URL


# ── GET /api/library/{bookId}/conversation-state ─────────────────────────


def load_conversation_state(book_id: str) -> dict:
    """Read the latest persisted BookConversationState for a book.

    Returns the raw response body.  Schema:
      { found: false, bookId, reason }   when no row exists
      { found: true,  bookId, lastChapterIndex, parserVersion, snapshot }
                                         when a row exists
    """
    url = f"{_base_url()}/api/library/{book_id}/conversation-state"
    with httpx.Client(timeout=30.0) as client:
        resp = client.get(url)
    resp.raise_for_status()
    return resp.json()


def snapshot_dict_to_seed(snapshot: dict) -> dict:
    """Translate the route's `snapshot` field into the JSON wire format
    that `ConversationAttributionInput.seedState` accepts.

    The Python `ConversationStateSnapshot` dataclass has the same keys
    as the JS `ConversationStateSnapshot` interface; this function is
    only here to make the field-name mapping explicit.
    """
    if not snapshot:
        return {}
    return {
        "sceneId": snapshot.get("sceneId", 0),
        "currentSpeaker": snapshot.get("currentSpeaker"),
        "previousSpeaker": snapshot.get("previousSpeaker"),
        "currentFocusCharacter": snapshot.get("currentFocusCharacter"),
        "lastActionCharacter": snapshot.get("lastActionCharacter"),
        "lastSubject": snapshot.get("lastSubject"),
        "lastObject": snapshot.get("lastObject"),
        "lastRecipient": snapshot.get("lastRecipient"),
        "activeCharacters": snapshot.get("activeCharacters", []),
        "lastMentionedCharacters": snapshot.get("lastMentionedCharacters", []),
        "dialogueHistory": snapshot.get("lastDialogueTurns") or [],
    }


# ── GET /api/library/{bookId}/chapters/{chapterId}/attribute ─────────────


def fetch_chapter_attribution(
    book_id: str,
    chapter_id: str,
    *,
    bypass_cache: bool = True,
) -> dict:
    """Hit the production /attribute route for one chapter.

    The route:
    1. Loads the chapter HTML.
    2. Loads the seed (if a persisted row exists).
    3. Runs the full attribution pipeline.
    4. Persists the new snapshot back to the DB.
    5. Returns { attribution, stats, crossChapter, snapshot }.

    This is the path the Python script uses for --seed mode: by
    delegating to the route, we exercise the exact same DB read+write
    cycle the JS app uses, instead of reimplementing it in Python.
    """
    url = (
        f"{_base_url()}/api/library/{book_id}"
        f"/chapters/{chapter_id}/attribute"
    )
    params = {}
    if bypass_cache:
        params["nocache"] = "1"
    headers = {ATTRIBUTION_VERSION_HEADER: ATTRIBUTION_VERSION}
    with httpx.Client(timeout=120.0) as client:
        resp = client.get(url, params=params, headers=headers)
    resp.raise_for_status()
    return resp.json()


# ── Convenience: clear (test/dev only) ────────────────────────────────────


def clear_conversation_state(book_id: str) -> None:
    """Wipe the persisted BookConversationState for a book.

    Convenience wrapper used by the measurement script's --seed mode
    so each run is reproducible.  Calls the JS-side route via DELETE if
    one exists; otherwise falls back to a no-op.
    """
    url = f"{_base_url()}/api/library/{book_id}/conversation-state"
    with httpx.Client(timeout=30.0) as client:
        # Many setups wire DELETE on this route to drop the row.
        # If the route doesn't accept DELETE, we swallow the 405.
        resp = client.delete(url)
    if resp.status_code not in (200, 204, 405):
        resp.raise_for_status()