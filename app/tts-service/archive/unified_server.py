"""
Unified TTS server – supports VieNeu-TTS (Vietnamese-native), Piper (legacy),
and MOSS-TTS-Nano ONNX CPU (voice cloning for English etc).

Run:  .venv-moss-nano/bin/python unified_server.py

Endpoints:
  GET  /backends                    – list available backends
  POST /synthesize                  – { text, backend?, voice?, language?, speed?, reference_path? }
  GET  /health
"""
import io
import os
import struct
import sys
import wave
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

SCRIPT_DIR = Path(__file__).parent
sys.path.insert(0, str(SCRIPT_DIR / "MOSS-TTS-Nano"))

PIPER_URL = os.environ.get("PIPER_URL", "http://127.0.0.1:5002")
VIENEU_URL = os.environ.get("VIENEU_URL", "http://127.0.0.1:5020")
MODELS_DIR = SCRIPT_DIR / "models"
NANO_TTS_DIR = MODELS_DIR / "MOSS-TTS-Nano-100M-ONNX"
NANO_CODEC_DIR = MODELS_DIR / "MOSS-Audio-Tokenizer-Nano-ONNX"

app = FastAPI(title="Ebook TTS Unified")

_nano = None


def get_nano():
    global _nano
    if _nano is not None:
        return _nano
    if not NANO_TTS_DIR.exists() or not NANO_CODEC_DIR.exists():
        raise HTTPException(503, "MOSS-TTS-Nano ONNX weights not installed")
    from onnx_tts_runtime import OnnxTtsRuntime
    _nano = OnnxTtsRuntime(model_dir=str(MODELS_DIR), execution_provider="cpu")
    return _nano


def synthesize_piper(text: str, model: str = "vi_VN-vais1000-medium",
                    speaker: Optional[int] = None, length_scale: float = 1.0,
                    noise_scale: float = 0.667, noise_w: float = 0.8) -> bytes:
    import httpx
    body = {"text": text, "model": model, "length_scale": length_scale,
            "noise_scale": noise_scale, "noise_w": noise_w}
    if speaker is not None: body["speaker"] = speaker
    try:
        with httpx.Client(timeout=60.0) as client:
            r = client.post(f"{PIPER_URL}/synthesize", json=body)
        if r.status_code != 200:
            raise HTTPException(502, f"Piper {r.status_code}: {r.text[:200]}")
        return r.content
    except httpx.RequestError as e:
        raise HTTPException(503, f"Piper unreachable: {e}")


def synthesize_vieneu(text: str, voice: Optional[str] = None,
                     ref_audio: Optional[str] = None, ref_text: Optional[str] = None,
                     speed: float = 1.0) -> bytes:
    import httpx
    body = {"text": text, "speed": speed}
    if voice: body["voice"] = voice
    if ref_audio: body["ref_audio"] = ref_audio
    if ref_text: body["ref_text"] = ref_text
    try:
        with httpx.Client(timeout=180.0) as client:
            r = client.post(f"{VIENEU_URL}/synthesize", json=body)
        if r.status_code != 200:
            raise HTTPException(502, f"VieNeu {r.status_code}: {r.text[:200]}")
        return r.content
    except httpx.RequestError as e:
        raise HTTPException(503, f"VieNeu unreachable at {VIENEU_URL}: {e}")


def synthesize_moss_nano(text: str, reference_path: Optional[str] = None) -> bytes:
    runtime = get_nano()
    out_path = SCRIPT_DIR / "models" / "_tmp_synth.wav"
    out_path.parent.mkdir(exist_ok=True, parents=True)
    try:
        result = runtime.synthesize(
            text=text, prompt_audio_path=reference_path,
            output_audio_path=str(out_path),
            enable_wetext=False, enable_normalize_tts_text=True,
            streaming=False, sample_mode="fixed", do_sample=False,
        )
        with wave.open(str(out_path), "rb") as w:
            sr = w.getframerate(); ch = w.getnchannels(); sw = w.getsampwidth()
            nframes = w.getnframes(); pcm = w.readframes(nframes)
        import numpy as np
        if sw == 2:
            arr = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
        else:
            arr = np.frombuffer(pcm, dtype=f"<i{sw*8}").astype(np.float32) / (2 ** (sw * 8 - 1))
        if ch > 1: arr = arr.reshape(-1, ch).mean(axis=1)
        pcm16 = (arr * 32767.0).astype("<i2").tobytes()
        buf = io.BytesIO()
        data_len = len(pcm16)
        buf.write(b"RIFF"); buf.write(struct.pack("<I", 36 + data_len))
        buf.write(b"WAVE"); buf.write(b"fmt ")
        buf.write(struct.pack("<IHHIIHH", 16, 1, 1, sr, sr * 2, 2, 16))
        buf.write(b"data"); buf.write(struct.pack("<I", data_len)); buf.write(pcm16)
        return buf.getvalue()
    except Exception as e:
        raise HTTPException(500, f"MOSS-TTS-Nano synthesis failed: {e}")


async def _vieneu_alive() -> bool:
    try:
        import httpx
        async with httpx.AsyncClient(timeout=2.0) as client:
            r = await client.get(f"{VIENEU_URL}/health")
            return r.status_code == 200
    except Exception:
        return False


def has_vietnamese(s: str) -> bool:
    return any("\u0100" <= c <= "\u017f" or "\u1e00" <= c <= "\u1eff" for c in s)


def pick_backend(req_backend: Optional[str], req_lang: Optional[str],
                 text: str, voice: Optional[str], ref_audio: Optional[str]) -> str:
    if req_backend: return req_backend
    if ref_audio: return "vieneu"
    if req_lang == "vi" or has_vietnamese(text): return "vieneu"
    return "moss-nano" if NANO_TTS_DIR.exists() else "vieneu"


class SynthesizeRequest(BaseModel):
    text: str
    backend: Optional[str] = None
    voice: Optional[str] = None
    model: Optional[str] = None
    language: Optional[str] = None
    speed: Optional[float] = 1.0
    noise_scale: Optional[float] = 0.667
    noise_w: Optional[float] = 0.8
    speaker: Optional[int] = None
    reference_path: Optional[str] = None
    ref_text: Optional[str] = None


@app.get("/backends")
async def list_backends():
    vieneu_ok = await _vieneu_alive()
    return {
        "backends": [
            {"id": "vieneu", "name": "VieNeu-TTS v3 Turbo (Vietnamese-native, 10 voices, 48 kHz, voice cloning)",
             "ready": vieneu_ok, "languages": ["vi", "en"]},
            {"id": "piper", "name": "Piper (Vietnamese legacy, 22 kHz)",
             "ready": True, "languages": ["vi", "en"]},
            {"id": "moss-nano", "name": "MOSS-TTS-Nano (voice cloning, NO Vietnamese)",
             "ready": NANO_TTS_DIR.exists(), "languages": ["en", "zh", "ja", "ko", "fr", "de", "es"]},
        ],
        "default_backend": "vieneu" if vieneu_ok else "piper",
    }


@app.get("/health")
async def health():
    vieneu_ok = await _vieneu_alive()
    return {
        "status": "ok", "piper": PIPER_URL, "vieneu": VIENEU_URL,
        "vieneu_alive": vieneu_ok, "nano_installed": NANO_TTS_DIR.exists(),
    }


@app.post("/synthesize")
async def synthesize(req: SynthesizeRequest):
    text = (req.text or "").strip()
    if not text:
        raise HTTPException(400, "text required")
    backend = pick_backend(req.backend, req.language, text, req.voice, req.reference_path)
    length_scale = round(1.0 / max(0.5, min(3.0, req.speed or 1.0)), 3)

    if backend == "vieneu":
        wav = synthesize_vieneu(text, req.voice, req.reference_path, req.ref_text, req.speed or 1.0)
    elif backend == "piper":
        wav = synthesize_piper(text, req.model or "vi_VN-vais1000-medium",
                              req.speaker, length_scale,
                              req.noise_scale or 0.667, req.noise_w or 0.8)
    elif backend == "moss-nano":
        wav = synthesize_moss_nano(text, req.reference_path)
    else:
        raise HTTPException(400, f"unknown backend: {backend}")

    return Response(
        content=wav,
        media_type="audio/wav",
        headers={"X-TTS-Backend": backend, "Cache-Control": "no-cache",
                 "Access-Control-Allow-Origin": "*"},
    )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("PORT", "5010")), log_level="info")
