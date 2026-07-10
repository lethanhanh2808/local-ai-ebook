from __future__ import annotations

import io
import sys
import types
import unittest
import wave
from pathlib import Path
from unittest.mock import patch

import numpy as np

_TTS_ROOT = Path(__file__).resolve().parent.parent
if str(_TTS_ROOT) not in sys.path:
    sys.path.insert(0, str(_TTS_ROOT))

import vieneu_server  # noqa: E402


class _FakeTts:
    config = {"sampling_rate": 48_000}

    def __init__(self):
        self.kwargs = None

    def infer(self, _text, **kwargs):
        self.kwargs = kwargs
        return np.zeros(48_000, dtype=np.float32)


class TestVieNeuDelivery(unittest.TestCase):
    def test_story_style_and_speed_change_are_applied(self):
        fake = _FakeTts()
        fake_soxr = types.SimpleNamespace(
            resample=lambda audio, _input_rate, output_rate: audio[::2]
            if output_rate == 24_000 else audio,
        )
        with patch.object(vieneu_server, "get_tts", return_value=fake), \
             patch.dict(sys.modules, {"soxr": fake_soxr}):
            wav_bytes = vieneu_server.synthesize("Xin chào.", voice="Bình An", speed=2.0)

        self.assertEqual(fake.kwargs["style"], "doc_truyen")
        with wave.open(io.BytesIO(wav_bytes), "rb") as wav:
            self.assertEqual(wav.getframerate(), 48_000)
            self.assertEqual(wav.getnframes(), 24_000)
            self.assertAlmostEqual(wav.getnframes() / wav.getframerate(), 0.5, places=2)

    def test_invalid_style_falls_back_to_story_reading(self):
        fake = _FakeTts()
        with patch.object(vieneu_server, "get_tts", return_value=fake):
            vieneu_server.synthesize("Xin chào.", style="unsupported")
        self.assertEqual(fake.kwargs["style"], "doc_truyen")


if __name__ == "__main__":
    unittest.main(verbosity=2)
