# tests/test_proper_name_re.py
#
# Phase A.4 of D3 (BACKLOG-9) — Vietnamese proper-noun regex parity pin.
#
# Pins the Python `PROPER_NAME_RE` in `vncorenlp_attribution.py` to
# match the JS regex in `src/lib/attribution.ts` (line 1131):
#
#   /(?:^|[^\p{L}\p{N}_])(\p{Lu}[\p{L}]*(?:\s+\p{Lu}[\p{L}]*){1,5})(?=\s|[,.:;!?…]|$)/gu
#
# The Python side uses `[A-ZÀ-Ỹ]` / `[^\W\d_]` / `[^\w]` because stdlib
# `re` doesn't support `\p{Lu}` / `\p{L}` / `\p{N}`.  These tests pin
# that the approximation matches the JS output on a Vietnamese fixture
# corpus.
#
# Run: python3 -m unittest tests.test_proper_name_re -v
#
# If a row below fails: the divergence is in `vncorenlp_attribution.py`
# `PROPER_NAME_RE`.  Update the regex (not the test) — but first verify
# the expected output matches the JS regex behaviour by running the
# equivalent in Node.

from __future__ import annotations

import sys
import unittest
from pathlib import Path

_TTS_ROOT = Path(__file__).resolve().parent.parent
if str(_TTS_ROOT) not in sys.path:
    sys.path.insert(0, str(_TTS_ROOT))

from vncorenlp_attribution import PROPER_NAME_RE  # noqa: E402


def _matches(text: str) -> list[str]:
    """Helper: return the captured group 1 from every match in `text`."""
    return [m.group(1) for m in PROPER_NAME_RE.finditer(text)]


class TestProperNameRe(unittest.TestCase):
    """Pins the novel-name regex to the JS-side behaviour."""

    # ── single-word names (regex requires MIN 2 cap-led words) ────────────

    def test_single_cap_letter_word(self):
        # "Y" alone doesn't match — the regex needs at least 2 cap-led
        # words (1 + 1 from the inner `{1,5}` group).
        # But "Y Đằng Long" in the same paragraph IS matched (3 words).
        self.assertEqual(_matches("Y Đằng Long nói"), ["Y Đằng Long"])

    def test_single_capitalised_word_only(self):
        # Only ONE cap-led word in the input — below the minimum.
        self.assertEqual(_matches("Long nói"), [])

    def test_single_vietnamese_capitalised_word_only(self):
        # "Đằng" alone — only one cap-led word.
        self.assertEqual(_matches("Đằng gật đầu"), [])

    def test_lowercase_word_does_not_match(self):
        # All-lowercase input — no cap-led words at all.
        self.assertEqual(_matches("long nói"), [])

    # ── multi-word names (2-6 words) ───────────────────────────────────────

    def test_two_word_name_minimum(self):
        # The minimum valid match: exactly 2 cap-led words.
        self.assertEqual(_matches("Y Đằng bước vào"), ["Y Đằng"])

    def test_three_word_name(self):
        self.assertEqual(_matches("Y Đằng Long nhìn cô"), ["Y Đằng Long"])

    def test_four_word_name(self):
        # After "Tử" the next word is "đứng" (lowercase `đ` U+0111) —
        # must NOT be picked up as a cap-led word.  The dynamic
        # uppercase class excludes `đ`.
        self.assertEqual(
            _matches("Y Đằng Chân Lí Tử đứng dậy"),
            ["Y Đằng Chân Lí Tử"],
        )

    def test_six_word_name_upper_bound(self):
        # Max length is 1 + 5 = 6 cap-led words.  This case has exactly 6.
        self.assertEqual(
            _matches("Nguyễn Trần Minh Tuấn Anh Khoa bước vào"),
            ["Nguyễn Trần Minh Tuấn Anh Khoa"],
        )

    def test_seven_word_name_truncated(self):
        # 7 cap-led words: regex takes the first 6 (5 inner matches is
        # the cap).  After "Khoa" comes "Nam đi" — "Nam" alone is below
        # the min-2-words threshold so no second match.
        self.assertEqual(
            _matches("Nguyễn Trần Minh Tuấn Anh Khoa Nam đi"),
            ["Nguyễn Trần Minh Tuấn Anh Khoa"],
        )

    def test_lowercase_does_not_join_a_match(self):
        # Regression pin for the bug the dynamic uppercase class fixes:
        # the old `[A-ZÀ-Ỹ]` codepoint range picked up lowercase `đ`,
        # `ơ`, `ư` because they share Latin Extended-A codepoints with
        # their uppercase counterparts.  Now `đứng` is excluded.
        self.assertEqual(
            _matches("Y Đằng Trợ đứng dậy"),
            ["Y Đằng Trợ"],
        )

    def test_lowercase_u_with_horn_does_not_join(self):
        # `ư` (U+01B0) is lowercase but in Latin Extended-A.  Same
        # bug as `đ` — pin the fix.
        self.assertEqual(
            _matches("Y Đằng Long ư"),  # "ư" alone should not extend the match
            ["Y Đằng Long"],
        )

    def test_lowercase_o_with_horn_does_not_join(self):
        # `ơ` (U+01A1) — same Latin Extended-A case.
        self.assertEqual(
            _matches("Y Đằng Long ơ hay"),
            ["Y Đằng Long"],
        )

    # ── boundary handling ──────────────────────────────────────────────────

    def test_leading_boundary_punctuation(self):
        # Comma before "Y" — the `[^\w]` boundary catches it.
        self.assertEqual(_matches(",Y Đằng Long nói"), ["Y Đằng Long"])

    def test_leading_boundary_parenthesis(self):
        # ")" is NOT in the lookahead list (`\s|[,.:;!?…]|$`), so the
        # regex stops at the longest valid match — "Y Đằng" (2 words).
        # This is a pre-existing gap in the JS regex; both engines
        # behave the same way.  Pin so we notice if either side drifts.
        self.assertEqual(_matches("(Y Đằng Long)"), ["Y Đằng"])

    def test_no_boundary_within_word(self):
        # "YĐằng" has no word boundary before "Y" is meaningless
        # because the regex requires the boundary at position 0 OR
        # before the first cap letter.  Here "Y" is at position 0 so
        # `^` matches.  Then `[A-Z][^\W\d_]*` matches "Y".  But we
        # need at least 2 cap-led words — "Đằng" follows with no
        # space, so the inner group fails.  No match.
        self.assertEqual(_matches("YĐằng"), [])

    def test_trailing_punctuation_lookahead(self):
        # The lookahead `(?=\s|[,.:;!?…]|$)` lets punctuation terminate
        # the name without being consumed.
        self.assertEqual(_matches("Y Đằng Long, đứng dậy"), ["Y Đằng Long"])
        self.assertEqual(_matches("Y Đằng Long."), ["Y Đằng Long"])
        self.assertEqual(_matches("Y Đằng Long!"), ["Y Đằng Long"])

    def test_end_of_string_terminator(self):
        self.assertEqual(_matches("Y Đằng Long"), ["Y Đằng Long"])

    # ── pronouns (regex does NOT match — single cap-led word is below min) ─

    def test_single_pronoun_does_not_match(self):
        # "Anh" is a single cap-led word — below the regex's min-2
        # threshold.  The JS regex and Python regex behave identically.
        # The upstream `isKnownSurfaceName` filter is what excludes
        # pronouns from `potentialNewCharacters`, not the regex.
        self.assertEqual(_matches("Anh đánh nhẹ cô"), [])

    def test_two_cap_pronouns_match_but_filtered_upstream(self):
        # Two cap-led words DOES match the regex — but the upstream
        # roster filter (Phase B) handles pronoun exclusion.  Pin the
        # raw regex output so the upstream filter is the only gate.
        self.assertEqual(_matches("Anh Cô nói chuyện"), ["Anh Cô"])

    # ── should NOT match ───────────────────────────────────────────────────

    def test_no_match_plain_text(self):
        self.assertEqual(_matches("trời đang mưa"), [])

    def test_no_match_quoted_text_alone(self):
        # Capital letters inside quote brackets are not at a `[^\w]`
        # boundary, so they don't match.
        self.assertEqual(_matches('"Anh nói gì?"'), [])

    def test_no_match_sentence_with_no_proper_nouns(self):
        self.assertEqual(_matches("cô ấy nhìn anh"), [])

    # ── chapter-level corpus ───────────────────────────────────────────────

    def test_chapter_004_chiem_doat_vo_yeu(self):
        # Empirical pin from the live corpus.  The JS regex matched these
        # exact names against chapter004 (per ACTION_ITEMS_V3.md §D10).
        text = (
            "Y Đằng Long quay đầu lại. Dũng Chi Trợ đứng bên cạnh. "
            "Tiểu Mai nhìn họ. Y Đằng Ưu Nhi bước vào phòng."
        )
        self.assertEqual(
            _matches(text),
            [
                "Y Đằng Long",
                "Dũng Chi Trợ",
                "Tiểu Mai",
                "Y Đằng Ưu Nhi",
            ],
        )

    def test_multiple_matches_same_name_dedup_by_caller(self):
        # The regex itself doesn't dedup; that's done by the consuming
        # `find_potential_new_characters` (Phase B).  Pin raw output.
        self.assertEqual(
            _matches("Y Đằng Long nói. Y Đằng Long quay đầu."),
            ["Y Đằng Long", "Y Đằng Long"],
        )


class TestProperNameReEdgeCases(unittest.TestCase):
    """Pin edge cases that the upstream `isKnownSurfaceName` filter
    depends on.  If any of these change, re-check the roster filter."""

    def test_acronyms_dont_match_when_no_lowercase(self):
        # "NASA" alone is one cap-led word — below min-2.  Empty result.
        self.assertEqual(_matches("NASA phóng tàu"), [])

    def test_acronym_followed_by_cap_word_matches(self):
        # "NASA ABC" — two cap-led words.  The inner word has no
        # lowercase continuation either.  Matches as 2-word phrase.
        self.assertEqual(_matches("NASA ABC phóng tàu"), ["NASA ABC"])

    def test_does_not_match_inside_word(self):
        # "fooLong" — "Long" has no preceding word boundary, and "foo"
        # provides no other cap word.  Below min-2.
        self.assertEqual(_matches("fooLong"), [])

    def test_does_not_match_when_followed_by_lowercase_word(self):
        # "Long long" — second "long" is lowercase so only 1 cap word.
        # Below min-2.
        self.assertEqual(_matches("Long long ago"), [])

    def test_unicode_uppercase_class_is_case_aware(self):
        # Sanity check on the dynamic class itself: it must NOT include
        # lowercase Latin Extended-A letters.
        from vncorenlp_attribution import _UPPER_VI_CHARS, _CAP_LETTER_CLASS
        # Should include Đ (U+0110) — uppercase Đ
        self.assertIn("Đ", _UPPER_VI_CHARS)
        # Should NOT include đ (U+0111) — lowercase đ (the bug we fixed)
        self.assertNotIn("đ", _UPPER_VI_CHARS)
        # Should NOT include ư (U+01B0) — lowercase ư
        self.assertNotIn("ư", _UPPER_VI_CHARS)
        # Should NOT include ơ (U+01A1) — lowercase ơ
        self.assertNotIn("ơ", _UPPER_VI_CHARS)
        # Should include Ư (U+01AF) — uppercase Ư
        self.assertIn("Ư", _UPPER_VI_CHARS)
        # Should include Ơ (U+01A0) — uppercase Ơ
        self.assertIn("Ơ", _UPPER_VI_CHARS)
        # Class is a proper character class
        self.assertTrue(_CAP_LETTER_CLASS.startswith("["))
        self.assertTrue(_CAP_LETTER_CLASS.endswith("]"))


if __name__ == "__main__":
    unittest.main(verbosity=2)