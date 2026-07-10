# tests/test_pronoun_resolution.py
#
# Phase B.4 of D3 (BACKLOG-9) — pronoun-resolver parity pins.
#
# Pins:
#   - best_active_by_gender: weighted score with role bonuses
#   - resolve_narrative_pronoun_cue: pre/between-quote pronoun scan,
#     object-pronoun suppression, picks best active by gender
#   - resolve_pronoun_from_state: leading-pronoun scan, single-candidate
#     weight 0.48, multi-candidate 0.38
#
# Mirrors the JS code in src/lib/attribution.ts lines 1216-1330.

from __future__ import annotations

import sys
import unittest
from pathlib import Path

_TTS_ROOT = Path(__file__).resolve().parent.parent
if str(_TTS_ROOT) not in sys.path:
    sys.path.insert(0, str(_TTS_ROOT))

from conversation_attribution import (  # noqa: E402
    TURN_WEIGHT_AMBIGUOUS,
    TURN_WEIGHT_UNIQUE,
    NARRATIVE_PRONOUN_WEIGHT,
    ActiveCharacter,
    ConversationContext,
    ConversationState,
    PronounResolution,
    _find_quote_spans,
    best_active_by_gender,
    build_context,
    create_conversation_state,
    resolve_narrative_pronoun_cue,
    resolve_pronoun_from_state,
)


ROSTER_GENDERED = [
    {"name": "Y Đằng Long", "aliases": ["Đằng Long"], "gender": "male"},
    {"name": "Y Đằng Ưu Nhi", "aliases": ["Ưu Nhi"], "gender": "female"},
    {"name": "Nhâm Thiếu Hoài", "aliases": ["Thiếu Hoài"], "gender": "male"},
]


def _seed_state(
    ctx: ConversationContext,
    *,
    active: dict[str, float] | None = None,
    last_subject: str | None = None,
    last_action: str | None = None,
    current_speaker: str | None = None,
    current_focus: str | None = None,
) -> ConversationState:
    """Build a ConversationState with the given active-character scores
    and role flags.  Defaults to a fresh state."""
    state = create_conversation_state()
    for name, score in (active or {}).items():
        state.active_characters[name] = ActiveCharacter(
            score=score,
            last_mention_paragraph=0,
            spoken_count=0,
        )
    state.last_subject = last_subject
    state.last_action_character = last_action
    state.current_speaker = current_speaker
    state.current_focus_character = current_focus
    return state


class TestBestActiveByGender(unittest.TestCase):
    """Pins the per-gender scoring."""

    def test_picks_highest_score(self):
        ctx = build_context(ROSTER_GENDERED)
        state = _seed_state(
            ctx,
            active={"Y Đằng Long": 0.5, "Nhâm Thiếu Hoài": 0.9},
        )
        self.assertEqual(
            best_active_by_gender("male", state, ctx),
            "Nhâm Thiếu Hoài",
        )

    def test_last_subject_bonus(self):
        # Score 0.5 vs 0.4 — without bonus, Long wins.  But last_subject
        # = Hoài adds +0.45 → 0.85 > 0.5.
        ctx = build_context(ROSTER_GENDERED)
        state = _seed_state(
            ctx,
            active={"Y Đằng Long": 0.5, "Nhâm Thiếu Hoài": 0.4},
            last_subject="Nhâm Thiếu Hoài",
        )
        self.assertEqual(
            best_active_by_gender("male", state, ctx),
            "Nhâm Thiếu Hoài",
        )

    def test_filters_by_gender(self):
        # Female-only state: male query returns None.
        ctx = build_context(ROSTER_GENDERED)
        state = _seed_state(ctx, active={"Y Đằng Ưu Nhi": 0.9})
        self.assertIsNone(best_active_by_gender("male", state, ctx))

    def test_empty_state_returns_none(self):
        ctx = build_context(ROSTER_GENDERED)
        state = _seed_state(ctx)
        self.assertIsNone(best_active_by_gender("female", state, ctx))


class TestResolveNarrativePronounCue(unittest.TestCase):
    """Pins the pre/between-quote narrative pronoun detector."""

    def test_no_quotes_returns_none(self):
        ctx = build_context(ROSTER_GENDERED)
        state = _seed_state(ctx, active={"Nhâm Thiếu Hoài": 0.9})
        result = resolve_narrative_pronoun_cue(
            "Anh nói gì đó.",
            quotes=[],
            state=state,
            ctx=ctx,
        )
        self.assertIsNone(result)

    def test_male_pronoun_before_first_quote(self):
        # "Anh nhìn cô" — narration BEFORE the first quote ("Xin chào").
        # 'Anh' is male → picks the highest-scoring male.
        ctx = build_context(ROSTER_GENDERED)
        state = _seed_state(
            ctx,
            active={"Y Đằng Long": 0.5, "Nhâm Thiếu Hoài": 0.9},
        )
        text = "Anh nhìn cô ái ngại. \"Xin chào.\""
        quotes = _find_quote_spans(text)
        result = resolve_narrative_pronoun_cue(text, quotes, state, ctx)
        self.assertIsNotNone(result)
        self.assertEqual(result.speaker, "Nhâm Thiếu Hoài")
        self.assertEqual(result.weight, NARRATIVE_PRONOUN_WEIGHT)
        self.assertIn("Anh", result.detail)

    def test_female_pronoun_between_quotes(self):
        # Between two quotes: "Cô nhìn anh" resolves to active female.
        ctx = build_context(ROSTER_GENDERED)
        state = _seed_state(ctx, active={"Y Đằng Ưu Nhi": 0.9})
        text = "\"Anh là ai?\" Cô nhìn anh im lặng. \"Em không biết.\""
        quotes = _find_quote_spans(text)
        result = resolve_narrative_pronoun_cue(text, quotes, state, ctx)
        self.assertIsNotNone(result)
        self.assertEqual(result.speaker, "Y Đằng Ưu Nhi")

    def test_object_pronoun_suppression(self):
        # JS parity pin: a pronoun preceded by an object marker
        # (của|cho|với|nhìn|thấy|gặp) within 12 chars is filtered as
        # "object, not actor".  The "Anh của cô nói..." pattern matches
        # "Anh" with no preceding marker (it's at start of window), so
        # the FIRST "Anh" still fires.  To test suppression we need a
        # SECOND pronoun preceded by an object marker.
        ctx = build_context(ROSTER_GENDERED)
        state = _seed_state(ctx, active={"Nhâm Thiếu Hoài": 0.9})
        # Two windows — first fires ("Anh nói..."), second is suppressed
        # ("nhìn anh" = "Anh" preceded by "nhìn" object marker).
        text = 'Anh nói gì đó. "Xin chào." Nhìn anh im lặng. "Vâng."'
        quotes = _find_quote_spans(text)
        result = resolve_narrative_pronoun_cue(text, quotes, state, ctx)
        # The first window "Anh nói gì đó." — "Anh" at start, no preceding
        # marker → fires.  We don't assert on speaker; we just check that
        # the suppression correctly rejects the SECOND "Anh" candidate
        # (which is preceded by "nhìn").  The function picks the LATEST
        # match per window, so we don't get a definitive "suppressed"
        # signal here — instead, run two separate calls.
        ctx2 = build_context(ROSTER_GENDERED)
        state2 = _seed_state(ctx2, active={"Nhâm Thiếu Hoài": 0.9})
        text_only_obj = 'Nhìn anh im lặng. "Vâng."'
        quotes_only_obj = _find_quote_spans(text_only_obj)
        result_obj = resolve_narrative_pronoun_cue(
            text_only_obj, quotes_only_obj, state2, ctx2,
        )
        self.assertIsNone(result_obj, "object pronoun 'nhìn Anh' should be suppressed")

    def test_no_active_gender_returns_none(self):
        # Pronoun cue found but no active character of that gender.
        ctx = build_context(ROSTER_GENDERED)
        state = _seed_state(ctx, active={"Y Đằng Ưu Nhi": 0.9})  # only female
        text = "Anh nhìn quanh. \"...\""
        quotes = _find_quote_spans(text)
        result = resolve_narrative_pronoun_cue(text, quotes, state, ctx)
        self.assertIsNone(result)

    def test_picks_last_match_within_window(self):
        # Two pronoun+verb cues in the same window — picks the LATER one.
        ctx = build_context(ROSTER_GENDERED)
        state = _seed_state(
            ctx,
            active={"Y Đằng Long": 0.5, "Nhâm Thiếu Hoài": 0.9},
        )
        # "Anh gật đầu. Anh nói." — last match should win.
        text = "Anh gật đầu. Anh nói nhỏ. \"Xin chào.\""
        quotes = _find_quote_spans(text)
        result = resolve_narrative_pronoun_cue(text, quotes, state, ctx)
        self.assertEqual(result.speaker, "Nhâm Thiếu Hoài")  # highest male


class TestResolvePronounFromState(unittest.TestCase):
    """Pins the leading-pronoun resolver."""

    def test_leading_male_pronoun_long_sentence(self):
        # JS parity pin: the function uses an 80-char trailing window.
        # When the period falls within the window, the trailing-delimiter
        # check (`[,….\-—:!?]+\s*$`) triggers and the match is skipped.
        # Real Vietnamese paragraphs are usually > 80 chars long before
        # the period, so we exercise that path here.
        ctx = build_context(ROSTER_GENDERED)
        state = _seed_state(
            ctx,
            active={"Y Đằng Long": 0.5, "Nhâm Thiếu Hoài": 0.9},
        )
        text = (
            "Anh gật đầu nhìn quanh phòng rồi đi tới bên cạnh cô ấy "
            "một cách chậm rãi để không làm phiền ai cả."
        )
        result = resolve_pronoun_from_state(text, state, ctx)
        self.assertIsNotNone(result)
        self.assertEqual(result.speaker, "Nhâm Thiếu Hoài")
        # Multi-candidate → AMBIGUOUS weight.
        self.assertEqual(result.weight, TURN_WEIGHT_AMBIGUOUS)

    def test_unique_candidate_uses_unique_weight(self):
        # Only one male active → UNIQUE weight (0.48).
        ctx = build_context(ROSTER_GENDERED)
        state = _seed_state(ctx, active={"Nhâm Thiếu Hoài": 0.9})
        text = (
            "Anh gật đầu nhìn quanh phòng rồi đi tới bên cạnh cô ấy "
            "một cách chậm rãi để không làm phiền ai cả."
        )
        result = resolve_pronoun_from_state(text, state, ctx)
        self.assertIsNotNone(result)
        self.assertEqual(result.weight, TURN_WEIGHT_UNIQUE)
        self.assertIn("only active", result.detail)

    def test_short_sentence_trailing_period_skipped(self):
        # JS parity pin: short sentences where the period falls inside
        # the 80-char trailing window are skipped by the
        # `[,….\-—:!?]+\s*$` guard.  This is JS-side behaviour.
        ctx = build_context(ROSTER_GENDERED)
        state = _seed_state(ctx, active={"Nhâm Thiếu Hoài": 0.9})
        result = resolve_pronoun_from_state("Anh gật đầu.", state, ctx)
        self.assertIsNone(result)

    def test_no_pronoun_returns_none(self):
        ctx = build_context(ROSTER_GENDERED)
        state = _seed_state(ctx, active={"Nhâm Thiếu Hoài": 0.9})
        result = resolve_pronoun_from_state(
            "Y Đằng Long gật đầu nhìn quanh phòng rồi đi tới bên cạnh cô ấy "
            "một cách chậm rãi để không làm phiền ai cả.",
            state, ctx,
        )
        self.assertIsNone(result)

    def test_pronoun_after_quote_anchor(self):
        # "\"Ai đó?\". Anh hỏi nhìn quanh..." — leading quote anchor
        # before pronoun.  Long sentence so trailing period falls outside
        # the 80-char window.
        ctx = build_context(ROSTER_GENDERED)
        state = _seed_state(ctx, active={"Nhâm Thiếu Hoài": 0.9})
        text = (
            '"Ai đó?" Anh hỏi nhìn quanh phòng rồi đi tới bên cạnh cô ấy '
            "một cách chậm rãi để không làm phiền ai cả."
        )
        result = resolve_pronoun_from_state(text, state, ctx)
        self.assertIsNotNone(result)
        self.assertEqual(result.speaker, "Nhâm Thiếu Hoài")

    def test_female_pronoun_long_sentence(self):
        ctx = build_context(ROSTER_GENDERED)
        state = _seed_state(ctx, active={"Y Đằng Ưu Nhi": 0.9})
        text = (
            "Cô nhìn anh lặng lẽ rồi quay đầu sang bên kia cửa sổ "
            "để không phải đối mặt với người đàn ông mà cô đã từng yêu."
        )
        result = resolve_pronoun_from_state(text, state, ctx)
        self.assertIsNotNone(result)
        self.assertEqual(result.speaker, "Y Đằng Ưu Nhi")


if __name__ == "__main__":
    unittest.main(verbosity=2)