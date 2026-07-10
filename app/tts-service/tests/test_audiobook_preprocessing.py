from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import sys

_TTS_ROOT = Path(__file__).resolve().parent.parent
if str(_TTS_ROOT) not in sys.path:
    sys.path.insert(0, str(_TTS_ROOT))

import audiobook_generator as ag  # noqa: E402


CMAP = {
    "characters": [
        {"name": "Lan", "aliases": [], "gender": "female", "voiceId": "character"},
    ],
    "voices_by_id": {
        "narrator": {"name": "Bình An", "isBuiltinVieNeu": True},
        "character": {"name": "Ngọc Lan", "isBuiltinVieNeu": True},
    },
    "default_voice_id": "narrator",
}


class TestHtmlPreprocessing(unittest.TestCase):
    def test_preserves_blocks_and_decodes_entities(self):
        plain = ag.strip_html(
            '<html><head><style>p{color:red}</style></head><body>'
            '<p>Lan &amp; Minh.</p><p>&quot;Xin chào.&quot;</p></body></html>'
        )
        self.assertEqual(plain, 'Lan & Minh.\n\n"Xin chào."')
        self.assertEqual(
            [row[2] for row in ag.split_paragraphs_with_offsets(plain)],
            ['Lan & Minh.', '"Xin chào."'],
        )

    def test_long_fallback_does_not_duplicate_mega_paragraph(self):
        plain = ("Một câu văn khá dài để kiểm tra. " * 70).strip()
        rows = ag.split_paragraphs_with_offsets(plain)
        self.assertGreater(len(rows), 1)
        self.assertFalse(any(row[2] == plain for row in rows))


class TestSpokenVsNonSpokenQuotes(unittest.TestCase):
    def setUp(self):
        self.engine = ag.ATTRIBUTION_ENGINE
        ag.ATTRIBUTION_ENGINE = "legacy"

    def tearDown(self):
        ag.ATTRIBUTION_ENGINE = self.engine

    def _quoted(self, html: str) -> dict:
        segments = ag.split_into_segments(html, CMAP)
        return next(s for s in segments if s["text"] in {"Ừ", "Mình phải đi.", "Hẹn gặp lại.", "Đi thôi."})

    def test_one_character_answer_is_dialogue(self):
        seg = self._quoted('<p>Lan nói: “Ừ”</p>')
        self.assertEqual((seg["kind"], seg["character"], seg["voice_id"]),
                         ("dialogue", "Lan", "character"))

    def test_silent_thought_uses_narrator(self):
        seg = self._quoted('<p>Lan nghĩ thầm: “Mình phải đi.”</p>')
        self.assertEqual((seg["kind"], seg["character"], seg["voice_id"]),
                         ("narration", None, "narrator"))
        self.assertEqual(seg["attribution_source"], "narrator-non-spoken-quote")

    def test_written_letter_uses_narrator(self):
        seg = self._quoted('<p>Lan đọc bức thư “Hẹn gặp lại.”</p>')
        self.assertEqual((seg["kind"], seg["character"], seg["voice_id"]),
                         ("narration", None, "narrator"))

    def test_later_speech_verb_overrides_thought_cue(self):
        seg = self._quoted('<p>Lan nghĩ một lúc rồi nói: “Đi thôi.”</p>')
        self.assertEqual((seg["kind"], seg["character"]), ("dialogue", "Lan"))

    def test_quote_delimiters_are_not_emitted_as_narration(self):
        segments = ag.split_into_segments('<p>Lan nói: “Ừ”</p>', CMAP)
        self.assertFalse(any(s["text"] in {"“", "”", '"'} for s in segments))


class TestChapterCompleteness(unittest.TestCase):
    def test_any_segment_failure_discards_chapter(self):
        segments = [
            {"kind": "narration", "text": "Một", "character": None,
             "voice_id": "narrator", "voice_name": "Bình An"},
            {"kind": "narration", "text": "Hai", "character": None,
             "voice_id": "narrator", "voice_name": "Bình An"},
        ]
        with tempfile.TemporaryDirectory() as tmp, \
             patch.object(ag, "_load_character_map", return_value=CMAP), \
             patch.object(ag, "split_into_segments", return_value=segments), \
             patch.object(ag, "synthesize_segment", side_effect=RuntimeError("backend down")) as synth:
            with self.assertRaisesRegex(RuntimeError, "chapter output discarded"):
                ag.generate_chapter("book", "chapter.xhtml", "<p>x</p>", Path(tmp))
            self.assertEqual(synth.call_count, 1)
            self.assertEqual(list(Path(tmp).glob("*.wav")), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
