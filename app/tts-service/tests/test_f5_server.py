"""
Tests for app/tts-service/F5-TTS/f5_server.py.

Mirrors tests/test_vieneu_server.py: stdlib unittest, monkey-patch `get_tts`
to a deterministic fake, then assert on the returned WAV's structure and the
synthesize() function's voice/text handling.

We do NOT touch the real model here. Loading f5-tts-mlx takes ~30s and the
goal of these tests is the HTTP contract + emotion stripping + voice
resolution, not the diffusion. End-to-end synthesis is covered by the
shell-script gate in app/tts-service/scripts/ and the go/no-go verification
in the plan.
"""
from __future__ import annotations

import io
import sys
import tempfile
import unittest
import wave
from pathlib import Path
from unittest.mock import patch

import numpy as np

_TTS_ROOT = Path(__file__).resolve().parent.parent
_F5_DIR = _TTS_ROOT / "F5-TTS"
for _p in (_F5_DIR, _TTS_ROOT):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

import f5_server  # noqa: E402


class _FakeWave:
    """Stand-in for the MLX array returned by F5TTS.sample(). Wraps a real
    numpy array so np.asarray() just works (the server's
    `np.asarray(wave, dtype=np.float32)` would otherwise blow up on a
    duck-typed object). Slicing returns another _FakeWave of the right
    length — we never inspect the values, just .shape[0]."""

    def __init__(self, length: int):
        self._arr = np.zeros(length, dtype=np.float32)

    @property
    def shape(self):
        return self._arr.shape

    def __getitem__(self, idx):
        if isinstance(idx, slice):
            start, stop, _ = idx.indices(self._arr.shape[0])
            return _FakeWave(max(0, stop - start))
        raise TypeError("FakeWave only supports slicing in tests")

    def __array__(self, dtype=None, copy=None):
        # np.asarray(wave) goes through here. Returning a copy keeps the
        # fake isolated from accidental mutation in the SUT.
        return self._arr.astype(dtype or np.float32, copy=True)

    def __len__(self):
        return self._arr.shape[0]


class _FakeTts:
    """Stand-in for f5_tts_mlx.cfm.F5TTS. Records the positional `text` arg
    AND the kwargs separately so tests can assert on both."""

    def __init__(self, gen_samples: int = 48_000):
        self.gen_samples = gen_samples
        self.last_text = None
        self.last_kwargs = None
        self.calls = 0

    def sample(self, cond, text, **kwargs):
        self.last_text = text
        self.last_kwargs = kwargs
        self.calls += 1
        return _FakeWave(self.gen_samples), None


def _patch_fake_tts(fake: _FakeTts):
    return patch.object(f5_server, "get_tts", return_value=fake)


def _patch_ref_audio(samples: np.ndarray, sr: int = 24_000):
    """Patch _load_ref_audio so we never touch the filesystem."""
    import mlx.core as mx

    def _fake(path):
        return mx.array(samples.astype(np.float32)), sr

    return patch.object(f5_server, "_load_ref_audio", _fake)


class _VoiceFixture:
    """Create a temp voice directory with two prepared voices and a third
    half-prepared one. Returns the temp Path so the test cleans it up."""

    @staticmethod
    def create():
        tmp = Path(tempfile.mkdtemp(prefix="f5-voices-test-"))
        for slug, transcript in [
            ("hong-dao", "Xin chào, tôi là Hồng Đào."),
            ("ngoc-ngan", "Xin chào, tôi là Ngọc Ngân."),
        ]:
            d = tmp / slug
            d.mkdir()
            (d / "clip.wav").write_bytes(b"RIFF")  # path is read, not opened
            (d / "transcript.txt").write_text(transcript, encoding="utf-8")
        # Half-prepared: clip only, no transcript.
        broken = tmp / "broken"
        broken.mkdir()
        (broken / "clip.wav").write_bytes(b"RIFF")
        return tmp


class TestF5WavContract(unittest.TestCase):
    """The HTTP response is raw 24 kHz mono 16-bit PCM in a RIFF/WAVE."""

    def setUp(self):
        self._voices_tmp = _VoiceFixture.create()
        # Also patch F5_VOICES_DIR so _resolve_voice resolves against the
        # temp dir rather than the empty app/tts-service/F5-TTS/voices/.
        self._voices_patch = patch.object(f5_server, "F5_VOICES_DIR", self._voices_tmp)
        self._voices_patch.start()
        self.addCleanup(self._voices_patch.stop)

    def test_synthesize_returns_valid_24khz_mono_wav(self):
        fake = _FakeTts(gen_samples=48_000)
        ref = np.zeros(24_000, dtype=np.float32)
        with _patch_fake_tts(fake), _patch_ref_audio(ref):
            wav_bytes = f5_server.synthesize("Xin chào.", voice="hong-dao")

        with wave.open(io.BytesIO(wav_bytes), "rb") as wav:
            self.assertEqual(wav.getframerate(), 24_000)
            self.assertEqual(wav.getnchannels(), 1)
            self.assertEqual(wav.getsampwidth(), 2)
            self.assertGreater(wav.getnframes(), 0)

    def test_speed_post_resample_halves_frame_count(self):
        fake = _FakeTts(gen_samples=48_000)
        ref = np.zeros(24_000, dtype=np.float32)
        # Patch _apply_speed so the test is deterministic — we don't care
        # about the exact resample math, only that speed != 1 routes through it.
        # Wave flow: sample() → 48000 samples → trim ref (24000) → 24000 →
        # _apply_speed(2.0) → 12000 → written to WAV.
        with _patch_fake_tts(fake), _patch_ref_audio(ref), \
             patch("f5_server._apply_speed", lambda w, s: _FakeWave(int(w.shape[0] / s))):
            wav_bytes = f5_server.synthesize("Xin chào.", voice="hong-dao", speed=2.0)
        with wave.open(io.BytesIO(wav_bytes), "rb") as wav:
            self.assertEqual(wav.getframerate(), 24_000)
            self.assertEqual(wav.getnframes(), 12_000)


class TestF5VoiceResolution(unittest.TestCase):
    """Voice slug → clip + transcript, OR ref_audio + ref_text. Anything else
    is a 400. F5 has no built-in voices (no catalog fallback)."""

    def setUp(self):
        self._voices_tmp = _VoiceFixture.create()
        self._voices_patch = patch.object(f5_server, "F5_VOICES_DIR", self._voices_tmp)
        self._voices_patch.start()
        self.addCleanup(self._voices_patch.stop)

    def test_missing_voice_and_ref_audio_is_400(self):
        fake = _FakeTts()
        with _patch_fake_tts(fake):
            with self.assertRaises(Exception) as ctx:
                f5_server.synthesize("Xin chào.")
            self.assertEqual(ctx.exception.status_code, 400)

    def test_unknown_voice_slug_is_400(self):
        fake = _FakeTts()
        with _patch_fake_tts(fake):
            with self.assertRaises(Exception) as ctx:
                f5_server.synthesize("Xin chào.", voice="does-not-exist")
            self.assertEqual(ctx.exception.status_code, 400)

    def test_ref_audio_without_ref_text_is_400(self):
        fake = _FakeTts()
        with _patch_fake_tts(fake):
            with self.assertRaises(Exception) as ctx:
                f5_server.synthesize("Xin chào.", ref_audio="/tmp/anything.wav")
            self.assertEqual(ctx.exception.status_code, 400)

    def test_half_prepared_voice_is_400(self):
        fake = _FakeTts()
        with _patch_fake_tts(fake):
            with self.assertRaises(Exception) as ctx:
                f5_server.synthesize("Xin chào.", voice="broken")
            self.assertEqual(ctx.exception.status_code, 400)


class TestF5TextHandling(unittest.TestCase):
    """Emotion markers are stripped. Otherwise text passes through unchanged."""

    def setUp(self):
        self._voices_tmp = _VoiceFixture.create()
        self._voices_patch = patch.object(f5_server, "F5_VOICES_DIR", self._voices_tmp)
        self._voices_patch.start()
        self.addCleanup(self._voices_patch.stop)

    def test_emotion_markers_are_stripped(self):
        fake = _FakeTts()
        ref = np.zeros(24_000, dtype=np.float32)
        with _patch_fake_tts(fake), _patch_ref_audio(ref):
            f5_server.synthesize("Xin chào [cười] bạn", voice="hong-dao")
        pinyin_text = fake.last_text
        self.assertNotIn("[", pinyin_text)
        self.assertNotIn("cười", pinyin_text)

    def test_tho_dai_marker_is_stripped(self):
        fake = _FakeTts()
        ref = np.zeros(24_000, dtype=np.float32)
        with _patch_fake_tts(fake), _patch_ref_audio(ref):
            f5_server.synthesize("Mệt quá [thở dài] rồi", voice="hong-dao")
        self.assertNotIn("thở", fake.last_text)

    def test_empty_text_after_strip_is_400(self):
        fake = _FakeTts()
        with _patch_fake_tts(fake):
            with self.assertRaises(Exception) as ctx:
                f5_server.synthesize("[cười]", voice="hong-dao")
            self.assertEqual(ctx.exception.status_code, 400)


class TestF5Catalog(unittest.TestCase):
    """The /voices catalog should be a {voices: [{id, label}]} list. It only
    includes dirs that have BOTH clip.wav and transcript.txt."""

    def setUp(self):
        self._voices_tmp = _VoiceFixture.create()
        self._voices_patch = patch.object(f5_server, "F5_VOICES_DIR", self._voices_tmp)
        self._voices_patch.start()
        f5_server._VOICES_CACHE = None
        self.addCleanup(self._voices_patch.stop)
        self.addCleanup(setattr, f5_server, "_VOICES_CACHE", None)

    def test_voices_endpoint_shape(self):
        result = f5_server.get_voices()
        ids = [v["id"] for v in result["voices"]]
        # broken has clip.wav but not transcript.txt → must be excluded.
        self.assertIn("hong-dao", ids)
        self.assertIn("ngoc-ngan", ids)
        self.assertNotIn("broken", ids)
        for v in result["voices"]:
            self.assertIn("id", v)
            self.assertIn("label", v)


if __name__ == "__main__":
    unittest.main(verbosity=2)