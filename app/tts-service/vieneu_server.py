"""
VieNeu-TTS FastAPI server — Vietnamese-native TTS with built-in voices
and instant voice cloning (3-5s reference).

Run:  cd VieNeu-TTS && uv run python vieneu_server.py

Endpoints:
  GET  /voices                     – list built-in Vietnamese voices
  POST /synthesize                 – synthesize { text, voice?, ref_audio?, emotion? }
  POST /clone_test                 – synthesize with custom reference audio
  GET  /health

Note: this server is the Vietnamese-specific path. The unified_server.py
on :5010 may proxy to this one for Vietnamese content.
"""
import os
import io
import re
import sys
import struct
import wave
from pathlib import Path
from typing import Optional

# VieNeu-TTS lives in app/tts-service/VieNeu-TTS
VIENEU_DIR = Path(__file__).parent / "VieNeu-TTS"
if str(VIENEU_DIR) not in sys.path:
    sys.path.insert(0, str(VIENEU_DIR))

# Use VieNeu's own venv python (uv-managed) by spawning a worker.
# But for FastAPI we run inside that venv directly.
# (caller must `uv run` or activate the venv before launching)

from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

app = FastAPI(title="VieNeu-TTS Server")

_tts = None
_VOICES_CACHE = None


def get_tts():
    global _tts
    if _tts is None:
        from vieneu import Vieneu
        _tts = Vieneu()
    return _tts


@app.get("/health")
async def health():
    return {"status": "ok", "engine": "vieneu-v3-turbo"}


@app.get("/voices")
async def voices():
    global _VOICES_CACHE
    if _VOICES_CACHE is None:
        tts = get_tts()
        _VOICES_CACHE = [{"id": vid, "label": label} for label, vid in tts.list_preset_voices()]
    return {"voices": _VOICES_CACHE}


# Inline emotion markers VieNeu understands: [cười] [thở dài] [hắng giọng]
EMOTION_RE = re.compile(r"\[(cười|thở dài|hắng giọng)\]", re.IGNORECASE)


def synthesize(text: str, voice: Optional[str] = None, ref_audio: Optional[str] = None,
               ref_text: Optional[str] = None, speed: float = 1.0) -> bytes:
    tts = get_tts()
    # VieNeu's infer returns a numpy array. Sample rate is typically 24 kHz
    # for v2 and 48 kHz for v3-turbo.
    kwargs = {}
    if voice:
        kwargs["voice"] = voice
    if ref_audio:
        kwargs["ref_audio"] = ref_audio
        if ref_text:
            kwargs["ref_text"] = ref_text

    # Detect any inline emotion tags and pass them through
    has_emotion = bool(EMOTION_RE.search(text))

    try:
        audio = tts.infer(text, **kwargs)
    except Exception as e:
        raise RuntimeError(f"VieNeu synthesis failed: {e}")

    # Determine sample rate
    sr = 48000  # default for v3-turbo
    try:
        cfg = getattr(tts, "config", None) or {}
        sr = int(cfg.get("sampling_rate", sr))
    except Exception:
        pass
    # Some versions expose sr on the result
    if hasattr(audio, "sampling_rate"):
        sr = int(audio.sampling_rate)

    # Convert to mono 16-bit WAV
    import numpy as np
    if hasattr(audio, "cpu"):
        audio = audio.cpu().numpy()
    audio = np.asarray(audio, dtype=np.float32)
    if audio.ndim == 2:
        audio = audio[0]
    audio = np.clip(audio, -1.0, 1.0)

    # Apply speed scaling via resampling if not 1.0
    if speed and abs(speed - 1.0) > 0.01:
        try:
            import soxr
            audio = soxr.resample(audio, sr, int(sr / speed))
            sr = int(sr / speed)
        except ImportError:
            pass  # soxr not available, return at original speed

    pcm = (audio * 32767.0).astype("<i2").tobytes()
    buf = io.BytesIO()
    data_len = len(pcm)
    buf.write(b"RIFF")
    buf.write(struct.pack("<I", 36 + data_len))
    buf.write(b"WAVE")
    buf.write(b"fmt ")
    buf.write(struct.pack("<IHHIIHH", 16, 1, 1, sr, sr * 2, 2, 16))
    buf.write(b"data")
    buf.write(struct.pack("<I", data_len))
    buf.write(pcm)
    return buf.getvalue()


class SynthesizeRequest(BaseModel):
    text: str
    voice: Optional[str] = None            # built-in voice id, e.g. "Bình An"
    ref_audio: Optional[str] = None        # path on disk for voice cloning
    ref_text: Optional[str] = None
    speed: Optional[float] = 1.0


@app.post("/synthesize")
async def synthesize_endpoint(req: SynthesizeRequest):
    text = (req.text or "").strip()
    if not text:
        raise HTTPException(400, "text is required")
    try:
        wav = synthesize(text, req.voice, req.ref_audio, req.ref_text, req.speed or 1.0)
    except Exception as e:
        raise HTTPException(500, str(e))
    return Response(
        content=wav,
        media_type="audio/wav",
        headers={"X-TTS-Engine": "vieneu", "Cache-Control": "no-cache",
                 "Access-Control-Allow-Origin": "*"},
    )


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("VIENEU_PORT", "5020"))
    print(f"[vieneu] Pre-loading model (first inference may take 10-30s)...")
    get_tts()  # warm up
    print(f"[vieneu] Ready on http://127.0.0.1:{port}")
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")
