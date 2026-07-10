# tests/test_conversation_state_client.py
#
# Phase C of D3 (BACKLOG-9) — HTTP client parity pins.
#
# Pins:
#   - snapshot_dict_to_seed: route's {snapshot} → input.seedState shape
#   - load_conversation_state: GET /conversation-state returns the
#     raw JSON body so the caller can decide between "fresh" and
#     "seed-applied".
#   - fetch_chapter_attribution: GET /attribute returns the full
#     {attribution, stats, crossChapter, snapshot} body.
#
# HTTP calls are mocked (httpx.MockTransport) so the tests stay
# offline + hermetic.  Mirrors the JS behaviour the client is meant to
# stand in for, NOT a re-implementation of the route.
#
# Run: python3 -m unittest tests.test_conversation_state_client -v

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

_TTS_ROOT = Path(__file__).resolve().parent.parent
if str(_TTS_ROOT) not in sys.path:
    sys.path.insert(0, str(_TTS_ROOT))

import httpx  # noqa: E402

import conversation_state_client as csc  # noqa: E402


# ── snapshot_dict_to_seed ────────────────────────────────────────────────


class TestSnapshotDictToSeed(unittest.TestCase):
    """Pins the route-snapshot → input.seedState field mapping."""

    def test_empty_snapshot_returns_empty_dict(self):
        self.assertEqual(csc.snapshot_dict_to_seed(None), {})
        self.assertEqual(csc.snapshot_dict_to_seed({}), {})

    def test_minimal_snapshot(self):
        seed = csc.snapshot_dict_to_seed({
            "sceneId": 3,
            "currentSpeaker": "Y Đằng Long",
            "previousSpeaker": None,
            "currentFocusCharacter": "Y Đằng Long",
            "lastActionCharacter": None,
            "activeCharacters": [
                {"name": "Y Đằng Long", "score": 0.6,
                 "lastMentionParagraph": 4, "spokenCount": 2},
            ],
            "lastMentionedCharacters": ["Y Đằng Long"],
            "dialogueHistoryLength": 2,
            "lastDialogueTurns": [
                {"paragraphIndex": 3, "speaker": "Y Đằng Long"},
            ],
        })
        self.assertEqual(seed["sceneId"], 3)
        self.assertEqual(seed["currentSpeaker"], "Y Đằng Long")
        self.assertEqual(seed["previousSpeaker"], None)
        self.assertEqual(seed["currentFocusCharacter"], "Y Đằng Long")
        self.assertEqual(seed["activeCharacters"][0]["name"], "Y Đằng Long")
        self.assertEqual(seed["dialogueHistory"][0]["speaker"], "Y Đằng Long")

    def test_missing_optional_keys_default_to_empty(self):
        # Route's snapshot omits lastSubject/lastObject/lastRecipient
        # (the JS version doesn't include them in the denormalised
        # summary).  Translation must default them to empty so the
        # Python `apply_seed` sees a clean shape.
        seed = csc.snapshot_dict_to_seed({
            "sceneId": 1,
            "currentSpeaker": None,
            "previousSpeaker": None,
            "currentFocusCharacter": None,
            "lastActionCharacter": None,
            "activeCharacters": [],
            "lastMentionedCharacters": [],
            "dialogueHistoryLength": 0,
            "lastDialogueTurns": [],
        })
        self.assertEqual(seed["sceneId"], 1)
        self.assertIsNone(seed["currentSpeaker"])
        self.assertEqual(seed["activeCharacters"], [])
        self.assertEqual(seed["lastSubject"], seed.get("lastSubject"))  # default


# ── load_conversation_state (mocked HTTP) ────────────────────────────────


def _patch_client(transport):
    """Replace `httpx.Client` with a factory that routes through the
    given MockTransport.  Uses `new=` rather than `side_effect=` to
    avoid Mock's auto-call behaviour, and saves the real `httpx.Client`
    locally so the factory does not recurse through the patched module
    attribute (httpx's Client constructor internally constructs sub-
    clients via `httpx.Client(...)`)."""
    _real_client = httpx.Client

    def _factory(*args, **kwargs):
        return _real_client(transport=transport, **kwargs)

    return patch.object(csc.httpx, "Client", new=_factory)


class TestLoadConversationState(unittest.TestCase):
    """Pins the GET /conversation-state wire contract."""

    def test_found_true(self):
        body = {
            "found": True,
            "bookId": "abc-123",
            "lastChapterIndex": 5,
            "parserVersion": "conversation-v3+vncorenlp-1.2",
            "snapshot": {
                "sceneId": 5,
                "currentSpeaker": "Y Đằng Ưu Nhi",
                "previousSpeaker": "Y Đằng Long",
                "currentFocusCharacter": "Y Đằng Ưu Nhi",
                "lastActionCharacter": "Y Đằng Long",
                "activeCharacters": [],
                "lastMentionedCharacters": ["Y Đằng Ưu Nhi"],
                "dialogueHistoryLength": 3,
                "lastDialogueTurns": [],
            },
            "asOf": "2026-07-05T00:00:00Z",
        }

        def _handler(request: httpx.Request) -> httpx.Response:
            self.assertEqual(
                request.url.path,
                "/api/library/abc-123/conversation-state",
            )
            return httpx.Response(200, json=body)

        with _patch_client(httpx.MockTransport(_handler)):
            resp = csc.load_conversation_state("abc-123")
        self.assertTrue(resp["found"])
        self.assertEqual(resp["lastChapterIndex"], 5)
        self.assertEqual(resp["snapshot"]["currentSpeaker"], "Y Đằng Ưu Nhi")

    def test_found_false_no_row(self):
        body = {"found": False, "bookId": "abc-123", "reason": "no-row"}

        def _handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json=body)

        with _patch_client(httpx.MockTransport(_handler)):
            resp = csc.load_conversation_state("abc-123")
        self.assertFalse(resp["found"])
        self.assertEqual(resp["reason"], "no-row")


# ── fetch_chapter_attribution (mocked HTTP) ──────────────────────────────


class TestFetchChapterAttribution(unittest.TestCase):
    """Pins the GET /attribute wire contract used by the seeded walk."""

    def test_returns_attribution_and_cross_chapter(self):
        body = {
            "parserVersion": "conversation-v3+vncorenlp-1.2",
            "fromCache": False,
            "parserReachable": True,
            "omlxReachable": False,
            "chapter": {
                "id": "chapter005",
                "title": "Chương 5",
                "paragraphCount": 139,
            },
            "attribution": {
                "10": {"speaker": "Y Đằng Long", "confidence": 0.6,
                       "source": "conversation"},
            },
            "stats": {
                "parserHits": 0, "regexHits": 4, "llmHits": 0,
                "conversationHits": 68, "sourceDrift": 0,
                "defaults": 67, "totalParagraphs": 139,
            },
            "crossChapter": {
                "seedApplied": True,
                "seedReason": "applied",
                "seedFromChapterIndex": 4,
            },
        }

        def _handler(request: httpx.Request) -> httpx.Response:
            self.assertEqual(
                request.url.path,
                "/api/library/abc-123/chapters/chapter005/attribute",
            )
            self.assertEqual(request.url.params.get("nocache"), "1")
            self.assertEqual(
                request.headers.get(csc.ATTRIBUTION_VERSION_HEADER),
                csc.ATTRIBUTION_VERSION,
            )
            return httpx.Response(200, json=body)

        transport = httpx.MockTransport(_handler)
        with _patch_client(transport):
            resp = csc.fetch_chapter_attribution("abc-123", "chapter005")
        self.assertEqual(resp["crossChapter"]["seedReason"], "applied")
        self.assertEqual(resp["attribution"]["10"]["speaker"], "Y Đằng Long")
        self.assertEqual(resp["stats"]["conversationHits"], 68)


# ── clear_conversation_state (mocked HTTP) ───────────────────────────────


class TestClearConversationState(unittest.TestCase):
    def test_delete_returns_204(self):
        def _handler(request: httpx.Request) -> httpx.Response:
            self.assertEqual(request.method, "DELETE")
            return httpx.Response(204)

        transport = httpx.MockTransport(_handler)
        with _patch_client(transport):
            # Should not raise.
            csc.clear_conversation_state("abc-123")

    def test_delete_405_swallowed(self):
        # When the route doesn't accept DELETE we silently no-op so the
        # measurement script can still run.
        def _handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(405, text="Method Not Allowed")

        transport = httpx.MockTransport(_handler)
        with _patch_client(transport):
            csc.clear_conversation_state("abc-123")  # no exception


if __name__ == "__main__":
    unittest.main(verbosity=2)