# tests/test_actor_alternation_bump.py
#
# Phase 3.3 of docs/NEXT_UP_PLAN.md — D9 actor alternation bump parity
# between the JS engine and the Python port. The bump raises the
# `roles.actor` timeline weight from the base `ACTOR_BASE_WEIGHT = 0.36`
# to `ACTOR_ALT_WEIGHT = 0.48` whenever the previous two turns in
# `state.dialogueHistory` were spoken by different characters (i.e.
# the conversation is in detected ping-pong alternation).
#
# This file pins the Python-side bump so a future refactor that
# accidentally drops it (or flips the alternation-strength condition)
# surfaces here. The JS engine has the matching test in
# `app/ebook-converter/src/tests/attribution.test.ts`.
#
# Run: python3 -m unittest tests.test_actor_alternation_bump -v

from __future__ import annotations

import sys
import unittest
from pathlib import Path

_TTS_ROOT = Path(__file__).resolve().parent.parent
if str(_TTS_ROOT) not in sys.path:
    sys.path.insert(0, str(_TTS_ROOT))

from conversation_attribution import (  # noqa: E402
    ACTOR_ALT_WEIGHT,
    ACTOR_BASE_WEIGHT,
    ConversationAttributionInput,
    ConversationStateSnapshot,
    attribute_chapter,
)


def _paragraphs(items: list[tuple[int, str]]) -> list[dict]:
    """Build paragraph dicts with {index, start, end, text}."""
    out: list[dict] = []
    cursor = 0
    for idx, text in items:
        out.append({
            "index": idx,
            "start": cursor,
            "end": cursor + len(text),
            "text": text,
        })
        cursor += len(text) + 1
    return out


def _seed_with_history(history: list[tuple[int, str]]) -> ConversationStateSnapshot:
    """Seed state with a pre-populated dialogue history so the test
    does not have to walk through N resolved turns to reach the
    alternation-detection branch."""
    snap = ConversationStateSnapshot(
        sceneId=0,
        activeCharacters=[],
        currentSpeaker=history[-1][1] if history else None,
        previousSpeaker=history[-2][1] if len(history) >= 2 else None,
        currentFocusCharacter=None,
        lastActionCharacter=None,
        lastMentionedCharacters=[],
        dialogueHistory=[
            {"paragraphIndex": pidx, "speaker": speaker}
            for pidx, speaker in history
        ],
    )
    return snap


ROSTER_CHIEM_DOAT = [
    {"name": "Y Đằng Long", "aliases": ["Đằng Long"], "gender": "male"},
    {"name": "Y Đằng Ưu Nhi", "aliases": ["Ưu Nhi"], "gender": "female"},
    {"name": "Nhâm Thiếu Hoài", "aliases": ["Thiếu Hoài"], "gender": "male"},
]


class TestActorAlternationBump(unittest.TestCase):
    """Pin D9 — the Python port must mirror the JS bump."""

    def test_constants_match_js_side(self):
        # The JS side documents 0.36 → 0.48 as the bump targets;
        # Python constants must match for parity.
        self.assertAlmostEqual(ACTOR_BASE_WEIGHT, 0.36, places=3)
        self.assertAlmostEqual(ACTOR_ALT_WEIGHT, 0.48, places=3)
        self.assertGreater(ACTOR_ALT_WEIGHT, ACTOR_BASE_WEIGHT)

    def test_bump_fires_when_history_alternates(self):
        """Seeded history alternates Long → Ưu Nhi, so the next
        paragraph's `roles.actor` bucket should carry the bumped
        0.48 weight (not 0.36). We seed the state directly to skip
        walking through the preceding turns."""
        snap = _seed_with_history([
            (0, "Y Đằng Long"),
            (1, "Y Đằng Ưu Nhi"),
        ])
        # The paragraph whose actor branch we want to inspect:
        # only the timeline branch can fire (no regex/pronoun/LLM
        # evidence, no quoted name → no continuation branch).
        paragraphs = _paragraphs([
            (2, "Y Đằng Long quay đầu nhìn cô. \"Đi thôi.\""),
        ])
        result = attribute_chapter(ConversationAttributionInput(
            paragraphs=paragraphs,
            characters=ROSTER_CHIEM_DOAT,
            seedState=snap,
        ))

        # Should resolve — actor weight 0.48 clears the 0.42 floor.
        self.assertIn(2, result.attribution)
        bucket = result.attribution[2]
        self.assertEqual(bucket["speaker"], "Y Đằng Long")

        # Find a timeline evidence row whose weight is in the bumped
        # range [0.46, 0.50] and detail carries the "alternating
        # turn — bumped" marker.
        evidence = bucket.get("evidence", [])
        bumped = [
            e for e in evidence
            if e["source"] == "timeline"
            and 0.46 <= e["weight"] <= 0.50
        ]
        self.assertTrue(
            bumped,
            f"expected at least one bumped timeline row in {evidence!r}",
        )
        self.assertTrue(
            any("alternating turn" in e["detail"] for e in bumped),
            f"bumped timeline rows missing 'alternating turn' marker: {bumped!r}",
        )

    def test_no_bump_when_history_is_single_speaker(self):
        """Seeded history is the same speaker twice → no alternation →
        the actor branch must stay at the 0.36 base weight. We pin
        this by asserting the "alternating turn" marker does NOT
        appear in any timeline evidence row of the resolved bucket."""
        snap = _seed_with_history([
            (0, "Y Đằng Long"),
            (1, "Y Đằng Long"),
        ])
        paragraphs = _paragraphs([
            (2, "Y Đằng Long quay đầu nhìn Ưu Nhi. \"Đi thôi.\""),
        ])
        result = attribute_chapter(ConversationAttributionInput(
            paragraphs=paragraphs,
            characters=ROSTER_CHIEM_DOAT,
            seedState=snap,
        ))
        # May or may not resolve (depends on score), but if it does,
        # no timeline row should carry the "alternating turn" marker.
        if 2 in result.attribution:
            evidence = result.attribution[2].get("evidence", [])
            timeline_rows = [e for e in evidence if e["source"] == "timeline"]
            self.assertTrue(
                not any("alternating turn" in e["detail"] for e in timeline_rows),
                f"no-bump rows should not carry 'alternating turn' marker: "
                f"{timeline_rows!r}",
            )

    def test_no_bump_when_history_too_short(self):
        """Seeded history length < 2 → no alternation possible →
        same constraint: no timeline row may carry the bump
        marker."""
        snap = _seed_with_history([
            (0, "Y Đằng Long"),
        ])
        paragraphs = _paragraphs([
            (2, "Y Đằng Long quay đầu nhìn Ưu Nhi. \"Đi thôi.\""),
        ])
        result = attribute_chapter(ConversationAttributionInput(
            paragraphs=paragraphs,
            characters=ROSTER_CHIEM_DOAT,
            seedState=snap,
        ))
        if 2 in result.attribution:
            evidence = result.attribution[2].get("evidence", [])
            for row in evidence:
                if row["source"] == "timeline":
                    self.assertNotIn(
                        "alternating turn",
                        row["detail"],
                        f"marker must not appear with history len < 2: {row!r}",
                    )


if __name__ == "__main__":
    unittest.main(verbosity=2)
