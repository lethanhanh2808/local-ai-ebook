# tests/test_inject_emotions.py
#
# Tests for the permission allow-list / denylist sweep added to
# audiobook_generator.py (BACKLOG-11, eval-8 §6.6 "permissionDenylist
# for emotion markers").
#
# The sweep keeps only markers in PERMITTED_EMOTION_MARKERS. Tests
# pin both the positive path (on-list markers preserved) and the
# negative path (off-list markers stripped before reaching the TTS
# engine).
#
# Uses stdlib `unittest` (no pytest dependency) so it runs in any
# Python env that can import audiobook_generator.
#
# Run: python3 -m unittest tests/test_inject_emotions.py -v

from __future__ import annotations

import sys
import unittest
from pathlib import Path

# Make the tts-service root importable so `import audiobook_generator`
# resolves without an installed package.
_TTS_ROOT = Path(__file__).resolve().parent.parent
if str(_TTS_ROOT) not in sys.path:
    sys.path.insert(0, str(_TTS_ROOT))

import audiobook_generator as ag  # noqa: E402


# ── _strip_off_list_markers — defensive sweep ────────────────────────────


class TestStripOffListMarkers(unittest.TestCase):
    def test_keeps_on_list_marker_verbatim(self):
        # [cười] is in PERMITTED_EMOTION_MARKERS — must be preserved
        # with its surrounding whitespace.
        self.assertEqual(
            ag._strip_off_list_markers("hello [cười] world"),
            "hello [cười] world",
        )

    def test_strips_off_list_marker(self):
        # [angry] is NOT in the allow-list — must be removed entirely
        # along with its surrounding whitespace.
        result = ag._strip_off_list_markers("hello [angry] world")
        self.assertNotIn("[angry]", result)
        self.assertIn("hello", result)
        self.assertIn("world", result)
        # And the result must not have a double space where the marker was.
        self.assertNotIn("  ", result)

    def test_keeps_all_three_on_list_markers(self):
        text = "[cười] [thở dài] [hắng giọng]"
        self.assertEqual(ag._strip_off_list_markers(text), text)

    def test_strips_unknown_marker(self):
        # A plausible off-list marker like [whisper] or [scream] must
        # be stripped even though it's a single word in brackets.
        self.assertNotIn("[whisper]", ag._strip_off_list_markers("a [whisper] line"))
        self.assertNotIn("[scream]", ag._strip_off_list_markers("[scream] help"))

    def test_does_not_touch_long_prose_brackets(self):
        # Anything longer than 16 chars inside the brackets is treated
        # as source-text prose, NOT a marker — it must pass through.
        prose = "see [chapter 12 footnote with citations] for details"
        self.assertEqual(ag._strip_off_list_markers(prose), prose)

    def test_treats_short_prose_brackets_as_markers(self):
        # A short bracketed token like [cite] is at the boundary.
        # Policy: short bracketed tokens (<=16 chars) are markers, so
        # off-list ones get stripped. This pins the boundary at the
        # documented length cap.
        result = ag._strip_off_list_markers("see [cite] for more")
        self.assertNotIn("[cite]", result)

    def test_handles_multiple_markers_in_one_segment(self):
        # Mix of on-list and off-list markers in the same segment.
        result = ag._strip_off_list_markers("[cười] oh [angry] no [thở dài]")
        self.assertIn("[cười]", result)
        self.assertIn("[thở dài]", result)
        self.assertNotIn("[angry]", result)

    def test_idempotent(self):
        # Running the sweep twice produces the same result as running
        # it once — important because future code might pass already-
        # cleaned text through the sweep again.
        text = "[cười] hello [angry] world [thở dài]"
        once = ag._strip_off_list_markers(text)
        twice = ag._strip_off_list_markers(once)
        self.assertEqual(once, twice)

    def test_preserves_diacritics(self):
        # Vietnamese diacritics in marker inner content must be matched
        # correctly — [thở dài] has 4 inner chars including a space
        # and a diacritic on "ở" + "à".
        result = ag._strip_off_list_markers("anh ta [thở dài] buông xuống")
        self.assertIn("[thở dài]", result)

    def test_handles_empty_string(self):
        self.assertEqual(ag._strip_off_list_markers(""), "")

    def test_handles_no_brackets(self):
        self.assertEqual(
            ag._strip_off_list_markers("plain prose without markers"),
            "plain prose without markers",
        )


# ── PERMITTED_EMOTION_MARKERS — allow-list ───────────────────────────────


class TestPermittedEmotionMarkers(unittest.TestCase):
    def test_contains_exactly_three_markers(self):
        # Pin the size — adding a marker requires updating this test
        # AND adding a corresponding entry to KEYWORD_EMOTIONS /
        # TONE_TO_EMOTION / LLM_EMOTION_TO_MARKER.
        self.assertEqual(len(ag.PERMITTED_EMOTION_MARKERS), 3)

    def test_contains_known_markers(self):
        # These are the three markers the injection tables emit.
        self.assertIn("[cười]", ag.PERMITTED_EMOTION_MARKERS)
        self.assertIn("[thở dài]", ag.PERMITTED_EMOTION_MARKERS)
        self.assertIn("[hắng giọng]", ag.PERMITTED_EMOTION_MARKERS)

    def test_is_immutable(self):
        # frozenset — accidental mutation would silently let off-list
        # markers through. Pin it.
        self.assertIsInstance(ag.PERMITTED_EMOTION_MARKERS, frozenset)


# ── inject_emotions — end-to-end via the public API ──────────────────────


class TestInjectEmotionsSweepIntegration(unittest.TestCase):
    """Verify the sweep actually runs at the end of `inject_emotions`,
    not just at the `_strip_off_list_markers` helper level. This is the
    regression pin: if a future refactor removes the final sweep call,
    these tests fail."""

    def test_keyword_injection_then_sweep(self):
        # KEYWORD_EMOTIONS is supposed to emit on-list markers only.
        # We confirm the round-trip: keyword match → inject on-list
        # marker → sweep preserves it.
        text = "anh ta phá lên cười"  # matches the "phá lên cười" pattern
        result = ag.inject_emotions(text, "dialogue")
        self.assertIn("[cười]", result)

    def test_dialogue_falls_back_to_tone_marker(self):
        # A dialogue segment with NO Tier-1 keyword match but with a
        # tone set should get the tone's marker (which is on-list).
        result = ag.inject_emotions("nói gì đi", "dialogue", character_tone="angry")
        # Tone=angry → "[hắng giọng]" (on-list)
        self.assertIn("[hắng giọng]", result)

    def test_narration_does_not_get_tone_marker(self):
        # Narration must NOT receive tone fallback (per the function's
        # own contract: "Only dialogue gets the tier-2/tone fallback;
        # narration stays neutral so the narrator doesn't get emotions
        # injected on every line.").
        result = ag.inject_emotions("trời đang mưa", "narration", character_tone="angry")
        self.assertNotIn("[hắng giọng]", result)

    def test_llm_marker_off_list_would_be_stripped(self):
        # Simulate a future LLM taxonomy that emits an off-list
        # marker. Even if that path bypassed the tone fallback and
        # injected `[whisper]` directly, the final sweep must catch it.
        result = ag.inject_emotions("nói nhỏ", "dialogue", llm_marker="[whisper]")
        self.assertNotIn("[whisper]", result)

    def test_returns_string(self):
        # Type pin — sweeps that accidentally return None or list
        # would break downstream synthesize calls.
        result = ag.inject_emotions("hello world", "narration")
        self.assertIsInstance(result, str)


# ── Documentation drift pin ──────────────────────────────────────────────


class TestInjectionTablesMatchAllowList(unittest.TestCase):
    """Defensive pin: every non-empty marker emitted by KEYWORD_EMOTIONS,
    TONE_TO_EMOTION, or LLM_EMOTION_TO_MARKER must be in
    PERMITTED_EMOTION_MARKERS. If a future contributor adds an on-the-
    fly marker to one of the tables without updating the allow-list,
    this test fails — and the synthesized audio silently degrades."""

    def test_permitted_markers_match_injection_tables(self):
        emitted = set()
        # Tier 1 — extract the marker strings from each tuple. The
        # marker always has the form ' [something] ' (with surrounding
        # spaces); we trim to recover the canonical token.
        for _pattern, marker in ag.KEYWORD_EMOTIONS:
            if marker and marker.strip():
                emitted.add(marker.strip())
        for marker in ag.TONE_TO_EMOTION.values():
            if marker and marker.strip():
                emitted.add(marker.strip())
        for marker in ag.LLM_EMOTION_TO_MARKER.values():
            if marker and marker.strip():
                emitted.add(marker.strip())

        # Everything emitted must be in the allow-list. The reverse
        # direction (allow-list entry with no emitter) is allowed — a
        # marker might be reserved for future use.
        missing = emitted - ag.PERMITTED_EMOTION_MARKERS
        self.assertEqual(
            missing, set(),
            f"injection tables emit markers not in PERMITTED_EMOTION_MARKERS: "
            f"{sorted(missing)}. Add them to the allow-list or remove from "
            f"the injection tables.",
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)