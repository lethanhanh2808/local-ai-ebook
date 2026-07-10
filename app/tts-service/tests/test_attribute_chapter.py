# tests/test_attribute_chapter.py
#
# Phase B.5 of D3 (BACKLOG-9) — main attribution loop parity pins.
#
# Pins:
#   - detect_timeline_roles: subject/object/actor/recipient from mentions
#   - detect_unresolved_actor: novel name + verb outside roster
#   - merge_attribution: parser > regex > llm > parser (unresolved)
#   - compute_stats: hit counts + source-drift counter
#   - normalize_speaker_name: alias map + g2p fallback
#   - add_score: bucket accumulator + explicit weight tracking
#   - update_state_after_paragraph: state mutations per paragraph
#   - attribute_chapter: full end-to-end on synthetic paragraph streams
#
# Run: python3 -m unittest tests.test_attribute_chapter -v

from __future__ import annotations

import sys
import unittest
from pathlib import Path

_TTS_ROOT = Path(__file__).resolve().parent.parent
if str(_TTS_ROOT) not in sys.path:
    sys.path.insert(0, str(_TTS_ROOT))

from conversation_attribution import (  # noqa: E402
    ActiveCharacter,
    AttributionEvidence,
    ConversationAttributionInput,
    ConversationState,
    ScoreBucket,
    add_score,
    attribute_chapter,
    build_context,
    compute_stats,
    create_conversation_state,
    detect_timeline_roles,
    detect_unresolved_actor,
    empty_state_snapshot,
    merge_attribution,
    normalize_speaker_name,
    scan_mentions,
    snapshot_state,
    source_for_bucket,
    update_state_after_paragraph,
)


ROSTER_CHIEM_DOAT = [
    {"name": "Y Đằng Long", "aliases": ["Đằng Long"], "gender": "male"},
    {"name": "Y Đằng Ưu Nhi", "aliases": ["Ưu Nhi"], "gender": "female"},
    {"name": "Nhâm Thiếu Hoài", "aliases": ["Thiếu Hoài"], "gender": "male"},
]


def _paragraphs(items: list[tuple[int, str]]) -> list[dict]:
    """Helper: build paragraph dicts with {index, start, end, text}."""
    out = []
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


# ── detect_timeline_roles ──────────────────────────────────────────────────


class TestDetectTimelineRoles(unittest.TestCase):
    """Pins the subject/object/actor/recipient extraction."""

    def test_no_mentions(self):
        ctx = build_context(ROSTER_CHIEM_DOAT)
        roles = detect_timeline_roles(
            "Some plain narration without names.",
            [],
        )
        self.assertIsNone(roles.subject)
        self.assertIsNone(roles.object)
        self.assertIsNone(roles.actor)
        self.assertIsNone(roles.recipient)

    def test_subject_with_verb(self):
        ctx = build_context(ROSTER_CHIEM_DOAT)
        mentions = scan_mentions("Y Đằng Long quay đầu nhìn cô.", ctx)
        roles = detect_timeline_roles("Y Đằng Long quay đầu nhìn cô.", mentions)
        # "Y Đằng Long" is subject (not object — no marker before it).
        # "quay" is a verb → actor = "Y Đằng Long".
        self.assertEqual(roles.subject, "Y Đằng Long")
        self.assertEqual(roles.actor, "Y Đằng Long")
        self.assertIsNone(roles.object)

    def test_object_marker(self):
        ctx = build_context(ROSTER_CHIEM_DOAT)
        text = "Cô ấy quay đầu nhìn Y Đằng Long rồi đi."
        mentions = scan_mentions(text, ctx)
        roles = detect_timeline_roles(text, mentions)
        # "Y Đằng Long" has "nhìn" before it → object.
        self.assertEqual(roles.object, "Y Đằng Long")
        self.assertIsNone(roles.actor)  # no subject with verb tail

    def test_recipient_marker(self):
        ctx = build_context(ROSTER_CHIEM_DOAT)
        text = "Y Đằng Long nói với Ưu Nhi."
        mentions = scan_mentions(text, ctx)
        roles = detect_timeline_roles(text, mentions)
        # "Ưu Nhi" preceded by "với" → recipient.
        self.assertEqual(roles.recipient, "Y Đằng Ưu Nhi")


# ── detect_unresolved_actor ───────────────────────────────────────────────


class TestDetectUnresolvedActor(unittest.TestCase):
    """Pins the 'missing character' detection."""

    def test_no_unresolved(self):
        ctx = build_context(ROSTER_CHIEM_DOAT)
        text = "Y Đằng Long nói gì đó."
        self.assertIsNone(detect_unresolved_actor(text, ctx))

    def test_unresolved_actor_detected(self):
        ctx = build_context(ROSTER_CHIEM_DOAT)
        # "Dũng Chi Trợ" not in roster.
        text = "Dũng Chi Trợ đứng dậy."
        self.assertEqual(detect_unresolved_actor(text, ctx), "Dũng Chi Trợ")

    def test_inside_quotes_skipped(self):
        ctx = build_context(ROSTER_CHIEM_DOAT)
        # Novel name INSIDE the quotes — should NOT surface (the parser
        # only flags narrative actors).
        text = '"Dũng Chi Trợ đứng dậy."'
        self.assertIsNone(detect_unresolved_actor(text, ctx))


# ── normalize_speaker_name ────────────────────────────────────────────────


class TestNormalizeSpeakerName(unittest.TestCase):
    """Pins alias + g2p resolution."""

    def test_none_returns_none(self):
        ctx = build_context(ROSTER_CHIEM_DOAT)
        self.assertIsNone(normalize_speaker_name(None, ctx))
        self.assertIsNone(normalize_speaker_name("", ctx))

    def test_exact_alias_canonicalises(self):
        ctx = build_context(ROSTER_CHIEM_DOAT)
        self.assertEqual(
            normalize_speaker_name("Đằng Long", ctx),
            "Y Đằng Long",
        )

    def test_diacritic_fallback(self):
        ctx = build_context(ROSTER_CHIEM_DOAT)
        # "Tuấn Ngọc" not in roster, but let's add it
        ctx2 = build_context([
            {"name": "Tuấn Ngọc", "aliases": [], "gender": None},
        ])
        self.assertEqual(
            normalize_speaker_name("Tuan Ngoc", ctx2),
            "Tuấn Ngọc",
        )


# ── add_score ─────────────────────────────────────────────────────────────


class TestAddScore(unittest.TestCase):
    """Pins bucket accumulation + explicit-weight tracking."""

    def test_first_evidence_creates_bucket(self):
        scores: dict[str, ScoreBucket] = {}
        add_score(scores, "Y Đằng Long", 0.5, AttributionEvidence(
            source="parser", weight=0.5, detail="test",
        ))
        self.assertIn("Y Đằng Long", scores)
        self.assertAlmostEqual(scores["Y Đằng Long"].score, 0.5)
        self.assertEqual(len(scores["Y Đằng Long"].evidence), 1)

    def test_explicit_sources_track_separately(self):
        scores: dict[str, ScoreBucket] = {}
        add_score(scores, "X", 0.5, AttributionEvidence(
            source="parser", weight=0.5, detail="",
        ))
        add_score(scores, "X", 0.3, AttributionEvidence(
            source="presence", weight=0.3, detail="",
        ))
        bucket = scores["X"]
        self.assertAlmostEqual(bucket.score, 0.8)
        # explicit_weight only counts parser/regex/llm.
        self.assertAlmostEqual(bucket.explicit_weight, 0.5)
        self.assertEqual(bucket.dominant_explicit_source, "parser")


# ── source_for_bucket ─────────────────────────────────────────────────────


class TestSourceForBucket(unittest.TestCase):
    def test_dominant_explicit_close_to_total(self):
        # score - explicit_weight < 0.18 → use dominant explicit source.
        b = ScoreBucket(
            score=0.5, evidence=[], explicit_weight=0.5,
            dominant_explicit_source="parser", dominant_explicit_weight=0.5,
        )
        self.assertEqual(source_for_bucket(b), "parser")

    def test_dominant_explicit_far_from_total(self):
        # score - explicit_weight >= 0.18 → 'conversation'.
        b = ScoreBucket(
            score=0.8, evidence=[], explicit_weight=0.5,
            dominant_explicit_source="parser", dominant_explicit_weight=0.5,
        )
        self.assertEqual(source_for_bucket(b), "conversation")

    def test_no_dominant_explicit_returns_conversation(self):
        b = ScoreBucket(score=0.5, evidence=[], explicit_weight=0.0)
        self.assertEqual(source_for_bucket(b), "conversation")


# ── merge_attribution ─────────────────────────────────────────────────────


class TestMergeAttribution(unittest.TestCase):
    def test_parser_high_conf_wins(self):
        parser = {0: {"speaker": "Y Đằng Long", "confidence": 0.9, "source": "parser"}}
        regex = {0: {"speaker": "Y Đằng Ưu Nhi", "confidence": 0.6, "source": "regex"}}
        merged = merge_attribution(parser, regex)
        self.assertEqual(merged[0]["speaker"], "Y Đằng Long")

    def test_parser_low_conf_falls_through(self):
        parser = {0: {"speaker": "Y Đằng Long", "confidence": 0.5, "source": "parser"}}
        regex = {0: {"speaker": "Y Đằng Ưu Nhi", "confidence": 0.6, "source": "regex"}}
        merged = merge_attribution(parser, regex)
        self.assertEqual(merged[0]["speaker"], "Y Đằng Ưu Nhi")

    def test_parser_partial_unresolved(self):
        parser = {0: {"speaker": "MaybeSomeone", "confidence": 0.3, "source": "parser"}}
        merged = merge_attribution(parser, {})
        self.assertIsNone(merged[0]["speaker"])
        self.assertEqual(merged[0]["source"], "parser")


# ── compute_stats ─────────────────────────────────────────────────────────


class TestComputeStats(unittest.TestCase):
    def test_basic_counts(self):
        paragraphs = _paragraphs([(i, "x") for i in range(5)])
        attribution = {
            0: {"speaker": "A", "source": "parser"},
            1: {"speaker": "A", "source": "regex"},
            2: {"speaker": "A", "source": "llm"},
            3: {"speaker": "A", "source": "conversation"},
            4: {"speaker": None, "source": "default"},
        }
        stats = compute_stats(paragraphs, attribution)
        self.assertEqual(stats["parserHits"], 1)
        self.assertEqual(stats["regexHits"], 1)
        self.assertEqual(stats["llmHits"], 1)
        self.assertEqual(stats["conversationHits"], 1)
        self.assertEqual(stats["defaults"], 1)
        self.assertEqual(stats["totalParagraphs"], 5)

    def test_source_drift_counted(self):
        paragraphs = _paragraphs([(0, "x")])
        attribution = {
            0: {
                "speaker": "A",
                "source": "conversation",
                "confidence": 0.9,
                "evidence": [{"source": "regex"}],
            },
        }
        stats = compute_stats(paragraphs, attribution)
        self.assertEqual(stats["sourceDrift"], 1)


# ── update_state_after_paragraph ──────────────────────────────────────────


class TestUpdateStateAfterParagraph(unittest.TestCase):
    def test_speaker_bumps_active_and_history(self):
        ctx = build_context(ROSTER_CHIEM_DOAT)
        state = create_conversation_state()
        mentions = scan_mentions("Y Đằng Long nói.", ctx)
        roles = detect_timeline_roles("Y Đằng Long nói.", mentions)
        update_state_after_paragraph(state, 0, mentions, roles, "Y Đằng Long")
        self.assertEqual(state.current_speaker, "Y Đằng Long")
        self.assertEqual(state.previous_speaker, None)  # was None
        self.assertEqual(len(state.dialogue_history), 1)
        self.assertEqual(state.dialogue_history[0].speaker, "Y Đằng Long")
        self.assertEqual(state.paragraphs_since_dialogue, 0)

    def test_no_speaker_increments_paragraphs_since_dialogue(self):
        from conversation_attribution import TimelineRoles
        state = create_conversation_state()
        state.paragraphs_since_dialogue = 3
        update_state_after_paragraph(state, 1, [], TimelineRoles(), None)
        self.assertEqual(state.paragraphs_since_dialogue, 4)

    def test_history_capped_at_turn_history_cap(self):
        from conversation_attribution import TimelineRoles
        state = create_conversation_state()
        for i in range(15):
            update_state_after_paragraph(
                state, i, [], TimelineRoles(), "Y Đằng Long",
            )
        self.assertEqual(len(state.dialogue_history), 10)  # TURN_HISTORY_CAP


# ── attribute_chapter (end-to-end) ────────────────────────────────────────


class TestAttributeChapter(unittest.TestCase):
    def test_no_roster_short_circuits(self):
        paragraphs = _paragraphs([(0, "Y Đằng Long nói gì đó.")])
        input = ConversationAttributionInput(
            paragraphs=paragraphs,
            characters=[],
        )
        result = attribute_chapter(input)
        self.assertEqual(result.seed_reason, "no-characters")
        self.assertEqual(result.seed_applied, False)

    def test_fresh_run_no_seed(self):
        paragraphs = _paragraphs([
            (0, "Y Đằng Long nói: \"Xin chào.\""),
        ])
        input = ConversationAttributionInput(
            paragraphs=paragraphs,
            characters=ROSTER_CHIEM_DOAT,
        )
        result = attribute_chapter(input)
        self.assertEqual(result.seed_reason, "fresh")
        self.assertFalse(result.seed_applied)
        # Y Đằng Long attributed via regex (subject with speech verb).
        self.assertIn(0, result.attribution)

    def test_paragraph_without_quote_just_updates_state(self):
        paragraphs = _paragraphs([
            (0, "Pure narration, no dialogue at all here."),
            (1, "Y Đằng Long nói: \"Xin chào.\""),
        ])
        input = ConversationAttributionInput(
            paragraphs=paragraphs,
            characters=ROSTER_CHIEM_DOAT,
        )
        result = attribute_chapter(input)
        # Paragraph 0 has no quote → not in attribution map.
        self.assertNotIn(0, result.attribution)
        self.assertIn(1, result.attribution)

    def test_novel_name_detected(self):
        paragraphs = _paragraphs([
            (0, "Dũng Chi Trợ nói gì đó. \"Xin chào.\""),
        ])
        input = ConversationAttributionInput(
            paragraphs=paragraphs,
            characters=ROSTER_CHIEM_DOAT,
        )
        result = attribute_chapter(input)
        self.assertIn("Dũng Chi Trợ", result.potential_new_characters)

    def test_seed_applied_marks_reason(self):
        paragraphs = _paragraphs([
            (0, "Y Đằng Long nói: \"Xin chào.\""),
        ])
        seed = empty_state_snapshot()
        seed.activeCharacters = ["Y Đằng Long"]
        input = ConversationAttributionInput(
            paragraphs=paragraphs,
            characters=ROSTER_CHIEM_DOAT,
            seedState=seed,
        )
        result = attribute_chapter(input)
        self.assertTrue(result.seed_applied)
        self.assertEqual(result.seed_reason, "seed-applied")

    def test_two_speaker_alternation_picks_other(self):
        # Two active males, scene alternates — implicit turn should
        # bump the OTHER speaker.  Paragraph 2 has an actor mention
        # (Nhâm Thiếu Hoài) followed by an implicit turn quote, so the
        # timeline+history scoring adds up enough to cross the 0.42
        # threshold.
        paragraphs = _paragraphs([
            (0, "Y Đằng Long nói: \"Anh đi rồi.\""),
            (1, "Nhâm Thiếu Hoài nói: \"Được.\""),
            (2, "Nhâm Thiếu Hoài nhìn anh. \"Còn lâu mới đi.\""),
        ])
        seed = empty_state_snapshot()
        seed.activeCharacters = ["Y Đằng Long", "Nhâm Thiếu Hoài"]
        input = ConversationAttributionInput(
            paragraphs=paragraphs,
            characters=ROSTER_CHIEM_DOAT,
            seedState=seed,
        )
        result = attribute_chapter(input)
        # Paragraph 2 should be attributed — actor mention gives
        # timeline weight + history gives alternation weight.
        self.assertIn(2, result.attribution)


if __name__ == "__main__":
    unittest.main(verbosity=2)